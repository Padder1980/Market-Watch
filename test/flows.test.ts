// The paper round's two risky halves: reading somebody else's HTML, and deciding what a flow means.
//
// ⚠️ THE PARSER TESTS RUN AGAINST FIXTURE HTML, NOT THE LIVE SITE. A test that fetches Farside would
// fail on their outage and pass on our bug, which is precisely backwards. What these lock down is
// the behaviour that must hold whatever the page says: summary rows never enter the series,
// accounting negatives keep their sign, and an unrecognised page yields null rather than a guess.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkFlowSanity,
  flowStatsFor,
  mergeDaily,
  parseFarsideFlows,
  parseFlowNumber,
  parseTableDate,
  parseTreasuriesTotal,
  treasuriesDebugSample,
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

// ---------------------------------------------------------------------------------------------
// The sanity gate — fixed 2026-08-07 after its first real run deadlocked on real data
// ---------------------------------------------------------------------------------------------

test("a small but real day-one scrape is ACCEPTED, not rejected", () => {
  // ⚠️ THIS IS THE LITERAL REGRESSION. The first version demanded >=100 rows, assuming the "all
  // data" page would always be reachable. On 2026-08-07 that page returned HTTP 403 (bot-blocking)
  // and the short "current" page's real 14-row scrape was rejected — which meant NOTHING could ever
  // be accepted, because a rejection never lets the merge take effect, so day two started from zero
  // stored history and hit the identical rejection. Forever.
  const fourteenDays: [string, number][] = [];
  const today = new Date();
  for (let i = 0; i < 14; i++) {
    const d = new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    fourteenDays.push([d, 40 + 10 * Math.sin(i)]);
  }
  fourteenDays.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const bad = checkFlowSanity(fourteenDays);
  assert.equal(bad, null, bad ?? "");
});

test("a near-empty scrape is still rejected — the floor moved, it did not disappear", () => {
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(checkFlowSanity([]) != null);
  assert.ok(checkFlowSanity([[today, 40]]) != null);
  assert.ok(checkFlowSanity([[today, 40], [today, 41]]) != null);
});

test("the gate still catches a stale, implausible or all-zero table", () => {
  const days = (n: number, v: (i: number) => number): [string, number][] => {
    const out: [string, number][] = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
      out.push([d, v(i)]);
    }
    return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  };
  const stale = days(10, () => 10).map(([, v], i, arr) =>
    [new Date(Date.now() - (i + 30) * 86_400_000).toISOString().slice(0, 10), v] as [string, number]
  );
  assert.ok(checkFlowSanity(stale) != null, "a 30-day-old newest row must be rejected");
  const wildColumn = days(10, () => 999_999);
  assert.ok(checkFlowSanity(wildColumn) != null, "an implausible magnitude must be rejected");
  const allZero = days(10, () => 0);
  assert.ok(checkFlowSanity(allZero) != null, "an all-zero table must be rejected");
});

// ---------------------------------------------------------------------------------------------
// Treasuries diagnostics — turns a bare byte count into something actionable
// ---------------------------------------------------------------------------------------------

test("the treasuries debug sample shows what IS there, even out of band", () => {
  // A figure that exists but sits outside the accepted 600k-3,000k band (a single company's
  // holding, not the grand total) must still show up in the diagnostic sample — the whole point is
  // to see what the page has, not to repeat the same strict filter that already found nothing usable.
  const page = "<p>MicroStrategy holds 640,031 BTC.</p><p>A single fund owns 12,000 BTC.</p>";
  const sample = treasuriesDebugSample(page);
  assert.ok(sample.some((s) => s.includes("640,031")), sample.join(" | "));
  assert.ok(sample.some((s) => s.includes("12,000")), sample.join(" | "));
});

test("the treasuries debug sample is empty when the page has nothing BTC-shaped at all", () => {
  // This is the signal that the number is likely rendered by client-side JS rather than present in
  // the fetched HTML — a different problem from a formatting mismatch, and the log should say so.
  assert.deepEqual(treasuriesDebugSample("<p>Loading holdings…</p>"), []);
});

// ---------------------------------------------------------------------------------------------
// Reading the committed file back out, per asset — shared by the browser and the Discover scan
// ---------------------------------------------------------------------------------------------

test("each asset in the file gets its own flow stats, keyed correctly", () => {
  const file = {
    assets: {
      bitcoin: { etfDaily: [["2026-08-05", 100], ["2026-08-06", -40]] as [string, number][] },
      ethereum: { etfDaily: [["2026-08-06", 12]] as [string, number][] },
    },
    corpHoldingsBtc: 1_262_540,
    corpChangeBtc: 28_000,
    corpChangeDays: 30,
    fetchedAt: "2026-08-06",
  };
  const btc = flowStatsFor(file, "bitcoin");
  assert.ok(btc);
  assert.deepEqual(btc?.etfDailyUsdM, [100, -40]);
  assert.equal(btc?.etfAsOf, "2026-08-06");

  const eth = flowStatsFor(file, "ethereum");
  assert.ok(eth);
  assert.deepEqual(eth?.etfDailyUsdM, [12]);

  // ⚠️ THE ETH FIGURES MUST NEVER LEAK INTO BTC'S ROW, OR VICE VERSA. Two assets sharing one file is
  // new; a lookup keyed on the wrong id would silently hand one coin's flows to another's card.
  assert.notDeepEqual(btc?.etfDailyUsdM, eth?.etfDailyUsdM);
});

test("corporate holdings attach ONLY to bitcoin, never to another asset sharing the file", () => {
  const file = {
    assets: { ethereum: { etfDaily: [["2026-08-06", 12]] as [string, number][] } },
    corpHoldingsBtc: 1_262_540,
    corpChangeBtc: 28_000,
    corpChangeDays: 30,
  };
  const eth = flowStatsFor(file, "ethereum");
  assert.ok(eth);
  assert.equal(eth?.corpHoldingsBtc, null, "Ethereum must not inherit Bitcoin's treasury figure");
});

test("an asset absent from the file entirely reads as null, not an empty-but-present object", () => {
  const file = { assets: { bitcoin: { etfDaily: [["2026-08-06", 12]] as [string, number][] } } };
  assert.equal(flowStatsFor(file, "solana"), null);
});

test("bitcoin still returns a stats object even with zero ETF rows, so corp holdings can show", () => {
  // ⚠️ THE ASYMMETRY IS DELIBERATE. Bitcoin can have something useful to say (corporate holdings)
  // even when its OWN ETF scrape came back empty that run; every other asset has nothing else this
  // file could tell it, so it is correctly null rather than an object with every field empty.
  const file = { assets: {}, corpHoldingsBtc: 1_262_540 };
  const btc = flowStatsFor(file, "bitcoin");
  assert.ok(btc, "bitcoin must not read as null just because its ETF rows are empty this run");
  assert.equal(btc?.corpHoldingsBtc, 1_262_540);
  assert.equal(btc?.etfDailyUsdM, null);
});

test("a genuinely empty file (before the robot's first run) is null for other assets", () => {
  // ⚠️ BITCOIN IS THE ONE EXCEPTION, AND DELIBERATELY SO — same as the case above, it may still
  // have a corporate-holdings figure worth reporting even with zero ETF rows, so it always gets an
  // object back (every field simply null) and `scoreFlows` is what decides there is nothing useful
  // in it. Every other asset genuinely has nothing else this file could ever say about it.
  const btc = flowStatsFor({}, "bitcoin");
  assert.ok(btc, "bitcoin must still get a (mostly empty) stats object, not null");
  assert.equal(btc?.etfDailyUsdM, null);
  assert.equal(btc?.corpHoldingsBtc, null);
  assert.equal(flowStatsFor({}, "ethereum"), null);
});
