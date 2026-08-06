// The paper round's two risky halves: reading somebody else's HTML, and deciding what a flow means.
//
// ⚠️ THE PARSER TESTS RUN AGAINST FIXTURE HTML, NOT THE LIVE SITE. A test that fetches Farside would
// fail on their outage and pass on our bug, which is precisely backwards. What these lock down is
// the behaviour that must hold whatever the page says: summary rows never enter the series,
// accounting negatives keep their sign, and an unrecognised page yields null rather than a guess.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  mergeDaily,
  parseFarsideFlows,
  parseFlowNumber,
  parseTableDate,
  parseTreasuriesTotal,
} from "../src/flows-parse.ts";
import { FLOWS_STALE_DAYS, scoreFlows } from "../src/score.ts";

// ---------------------------------------------------------------------------------------------
// Reading the table
// ---------------------------------------------------------------------------------------------

test("dates and accounting numbers are read the way the table writes them", () => {
  assert.equal(parseTableDate("11 Jan 2024"), "2024-01-11");
  assert.equal(parseTableDate("05 August 2026"), "2026-08-05");
  assert.equal(parseTableDate("Total"), null);
  assert.equal(parseTableDate("Average"), null);

  // ⚠️ Parentheses are a MINUS SIGN in this table. Read as a positive, a day of heavy selling
  // becomes a day of heavy buying — the single most damaging misread available here.
  assert.equal(parseFlowNumber("(21.5)"), -21.5);
  assert.equal(parseFlowNumber("1,234.5"), 1234.5);
  assert.equal(parseFlowNumber("-"), 0);
  assert.equal(parseFlowNumber("n/a"), null);
});

const FIXTURE = `
<table>
 <tr><th>Date</th><th>IBIT</th><th>FBTC</th><th>Total</th></tr>
 <tr><td>01 Aug 2026</td><td>170.4</td><td>19.6</td><td>190.0</td></tr>
 <tr><td>04 Aug 2026</td><td>170.4</td><td>19.6</td><td>211.5</td></tr>
 <tr><td>05 Aug 2026</td><td>(30.1)</td><td>10.0</td><td>(20.1)</td></tr>
 <tr><td>Total</td><td>61,000.0</td><td>12,000.0</td><td>98,765.4</td></tr>
 <tr><td>Average</td><td>90.1</td><td>30.2</td><td>140.3</td></tr>
</table>`;

test("summary rows never enter the daily series", () => {
  const parsed = parseFarsideFlows(FIXTURE);
  assert.ok(parsed);
  // ⚠️ THE DEFECT THIS GUARDS. The table ends with Total / Average / Maximum / Minimum rows whose
  // last cell is also a number. Take rows by position and the history gains a "day" worth two and a
  // half years of flows, which would swamp every rolling window it touched.
  assert.equal(parsed.daily.length, 3);
  assert.deepEqual(parsed.daily.map(([d]) => d), ["2026-08-01", "2026-08-04", "2026-08-05"]);
  assert.equal(parsed.asOf, "2026-08-05");
  assert.equal(parsed.daily[2]?.[1], -20.1);
  assert.ok(!parsed.daily.some(([, v]) => v > 50000));
});

test("an unrecognised page yields null, never a creative match", () => {
  assert.equal(parseFarsideFlows("<html><body><p>We have moved.</p></body></html>"), null);
  assert.equal(parseFarsideFlows(""), null);
  // A table with no date-led rows is a redesign, not data.
  assert.equal(parseFarsideFlows("<table><tr><td>Fund</td><td>12.3</td></tr></table>"), null);
});

test("the treasuries total is taken in band, and refuses nonsense", () => {
  const page = `<p>MicroStrategy 640,031 BTC</p><p>Total public companies: 1,262,540 BTC</p>`;
  assert.equal(parseTreasuriesTotal(page), 1_262_540);
  // Out-of-band figures are rejected rather than accepted as a total: a market cap or a satoshi
  // count matching loosely is how a wrong number inherits the trust of a right one.
  assert.equal(parseTreasuriesTotal("<p>21,000,000 BTC will ever exist</p>"), null);
  assert.equal(parseTreasuriesTotal("<p>no numbers here</p>"), null);
});

test("merging keeps history rather than replacing it with the short table", () => {
  const stored: [string, number][] = [["2026-07-01", 10], ["2026-07-02", 20]];
  const fresh: [string, number][] = [["2026-07-02", 25], ["2026-07-03", 30]];
  const merged = mergeDaily(stored, fresh);
  assert.deepEqual(merged, [["2026-07-01", 10], ["2026-07-02", 25], ["2026-07-03", 30]]);
  // ⚠️ Replacing instead of merging would silently discard the history the rolling windows
  // self-calibrate against, and the pillar would go quiet for weeks with nothing to explain it.
  assert.equal(mergeDaily(undefined, fresh).length, 2);
});

// ---------------------------------------------------------------------------------------------
// Scoring the flows
// ---------------------------------------------------------------------------------------------

const NOW = Date.parse("2026-08-06T12:00:00Z");

/** `n` days of flows averaging `mean`, with enough variation to give the scale something to bite. */
function series(n: number, mean: number, swing = 120): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(mean + swing * Math.sin(i / 2.5));
  return out;
}

function stats(daily: number[], asOf = "2026-08-05"): Parameters<typeof scoreFlows>[0] {
  return { etfDailyUsdM: daily, etfAsOf: asOf, fetchedAt: asOf };
}

test("absent flow data scores null, not zero", () => {
  assert.equal(scoreFlows(null, NOW).score, null);
  assert.equal(scoreFlows({}, NOW).score, null);
  assert.equal(scoreFlows({ etfDailyUsdM: [], etfAsOf: null }, NOW).score, null);
});

test("money coming in outscores money going out", () => {
  const inflow = scoreFlows(stats([...series(120, 0), ...series(20, 400, 40)]), NOW);
  const outflow = scoreFlows(stats([...series(120, 0), ...series(20, -400, 40)]), NOW);
  assert.ok(inflow.score != null && outflow.score != null);
  assert.ok(
    (inflow.score as number) > (outflow.score as number) + 30,
    `inflow ${inflow.score} vs outflow ${outflow.score}`,
  );
});

test("the sign is preserved by construction — an outflow can never score above neutral", () => {
  // ⚠️ THE DIRECTION-INVERSION TRAP. A plain percentile rank would score "less bad than usual" high
  // in a year dominated by outflows, telling the reader money was flowing IN while it flowed out.
  // Here a negative rolling sum is mathematically incapable of clearing 50.
  const grim = [...series(200, -300, 50)];
  const r = scoreFlows(stats(grim), NOW);
  assert.ok(r.score != null);
  assert.ok((r.score as number) < 50, `net outflows scored ${r.score}`);

  const good = scoreFlows(stats([...series(200, 300, 50)]), NOW);
  assert.ok(good.score != null && (good.score as number) > 50);
});

test("the yardstick is the market's OWN history, not a hardcoded threshold", () => {
  // The same $200m week is unremarkable in a market whose typical week is ±$900m, and large in one
  // whose typical week is ±$60m. A constant threshold would rot as the ETFs grow; this must not.
  const calm = scoreFlows(stats([...series(200, 0, 20), ...series(5, 40, 2)]), NOW);
  const busy = scoreFlows(stats([...series(200, 0, 900), ...series(5, 40, 2)]), NOW);
  assert.ok(calm.score != null && busy.score != null);
  assert.ok(
    (calm.score as number) > (busy.score as number),
    `the same flow scored ${calm.score} in a calm market and ${busy.score} in a busy one`,
  );
});

test("stale data is refused, not quietly believed", () => {
  const daily = [...series(200, 400, 50)];
  const fresh = scoreFlows(stats(daily, "2026-08-05"), NOW);
  const old = scoreFlows(stats(daily, "2026-06-01"), NOW);
  assert.ok(fresh.score != null, "a current snapshot must score");
  // ⚠️ THE SCRAPER'S FAILURE MODE IS GOING QUIET. Without this gate, June's inflow keeps earning
  // August's stars for as long as nobody notices the robot stopped delivering.
  assert.equal(old.score, null);
  assert.ok(old.reasons.some((r) => /too old to trust/i.test(r)), old.reasons.join(" | "));
  assert.ok(FLOWS_STALE_DAYS >= 3 && FLOWS_STALE_DAYS <= 14);
});

test("a single treasury snapshot is a level, not a movement, and says so", () => {
  const r = scoreFlows({ corpHoldingsBtc: 1_262_540, fetchedAt: "2026-08-05" }, NOW);
  // One reading cannot be a change. Scoring it would invent a direction from nothing.
  assert.equal(r.score, null);
  assert.ok(r.reasons.some((t) => /becomes measurable once/i.test(t)), r.reasons.join(" | "));

  const withChange = scoreFlows({
    corpHoldingsBtc: 1_262_540,
    corpChangeBtc: 30_000,
    corpChangeDays: 30,
    fetchedAt: "2026-08-05",
  }, NOW);
  assert.ok(withChange.score != null && (withChange.score as number) > 50);
});

test("the flows pillar never presents itself as a price forecast", () => {
  const r = scoreFlows(stats([...series(200, 800, 50)]), NOW);
  const text = r.reasons.join(" ");
  assert.ok(/not a price forecast/i.test(text));
  assert.ok(/near tops before/i.test(text), "the honest caveat about heavy inflows must survive");
  assert.ok(!/will rise|going up|buy now|guaranteed/i.test(text), text);
});
