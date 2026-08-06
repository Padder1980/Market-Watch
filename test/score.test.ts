import { test } from "node:test";
import assert from "node:assert/strict";

import type { AssetSnapshot, Candle } from "../src/types.ts";
import { returnOver } from "../src/indicators.ts";
import {
  CONSENSUS_NEUTRAL,
  TARGET_NEUTRAL,
  profileRisk,
  rankRatings,
  rateAsset,
  scoreAnalyst,
  scoreFundamentals,
  scoreNetwork,
  scoreTrend,
  starsFor,
} from "../src/score.ts";

const DAY = 86_400_000;

function candles(closes: number[]): Candle[] {
  const start = Date.UTC(2024, 0, 1);
  return closes.map((close, i) => ({ t: start + i * DAY, close }));
}

function ramping(n: number, start = 100, daily = 0.002): number[] {
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < n; i++) {
    out.push(v);
    v *= 1 + daily;
  }
  return out;
}

/** A rise with noise on top, so RSI does not pin to 100 and swamp everything else. */
function noisyRamp(n: number, daily: number, amplitude: number): number[] {
  const base = ramping(n, 100, daily);
  return base.map((v, i) => v * (1 + amplitude * Math.sin(i / 3)));
}

function snapshot(over: Partial<AssetSnapshot> = {}): AssetSnapshot {
  const closes = over.history ? over.history.map((c) => c.close) : noisyRamp(250, 0.0015, 0.02);
  return {
    id: "TEST",
    symbol: "TEST",
    name: "Test Asset",
    kind: "equity",
    currency: "USD",
    price: closes[closes.length - 1] as number,
    history: candles(closes),
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// The rule the whole engine turns on: absent is not bad
// ---------------------------------------------------------------------------------------------

test("a missing pillar scores null, and does NOT drag the composite toward zero", () => {
  const closes = noisyRamp(250, 0.0015, 0.02);
  const withAll = rateAsset(
    snapshot({
      history: candles(closes),
      consensus: {
        strongBuy: 6, buy: 8, hold: 4, sell: 0, strongSell: 0,
        targetMean: (closes[closes.length - 1] as number) * 1.3, targetCount: 18,
      },
      fundamentals: { revenueGrowthYoY: 0.18, epsGrowthYoY: 0.22, netMargin: 0.2, peRatio: 20 },
    }),
  );
  const trendOnly = rateAsset(snapshot({ history: candles(closes) }));

  assert.equal(trendOnly.analyst.score, null);
  assert.equal(trendOnly.fundamentals.score, null);
  // The composite must equal the trend pillar exactly — renormalised, not diluted with zeros.
  assert.ok(
    Math.abs(trendOnly.composite - (trendOnly.trend.score as number)) < 1e-9,
    `composite ${trendOnly.composite} should equal trend ${trendOnly.trend.score}`,
  );
  assert.ok(
    trendOnly.composite > 40,
    "an asset with only price data must not be punished for the absence",
  );
  assert.deepEqual(withAll.missing, []);
  assert.ok(trendOnly.missing.includes("analyst forecasts"));
  assert.ok(trendOnly.missing.includes("company fundamentals"));
});

test("crypto is never scored on company fundamentals, even if some are passed in", () => {
  const r = rateAsset(
    snapshot({
      kind: "crypto",
      // A caller merging data sources sloppily could attach these; the kind must win.
      fundamentals: { revenueGrowthYoY: 0.5, netMargin: 0.4, peRatio: 10 },
    }),
  );
  assert.equal(r.fundamentals.score, null);
  // ⚠️ NOT LISTED AS MISSING, AND THAT IS THE POINT. Bitcoin will never have company accounts, so
  // reporting them as absent puts a permanent "the picture is partial" caveat on every crypto row
  // for a gap that can never be filled. Not applicable and missing are different states; only the
  // second one is a caveat. The pillar that CAN apply to crypto is the network one, below.
  assert.ok(!r.missing.includes("company fundamentals"));
  assert.ok(r.missing.includes("on-chain network activity"));
});

// ---------------------------------------------------------------------------------------------
// Risk caps rather than averages
// ---------------------------------------------------------------------------------------------

test("a violently volatile asset cannot reach 5 stars however strong the signals", () => {
  const { stars, caveats } = starsFor(95, "very-high", 1);
  assert.equal(stars, 3);
  assert.ok(caveats.some((c) => c.includes("very high")), caveats.join(" | "));

  assert.equal(starsFor(95, "high", 1).stars, 4);
  assert.equal(starsFor(95, "moderate", 1).stars, 5);
});

test("the risk cap survives a perfect composite — averaging would have cancelled it", () => {
  const wild: number[] = [];
  let v = 100;
  for (let i = 0; i < 250; i++) {
    wild.push(v);
    // Strong uptrend carried on enormous daily swings: exactly the profile that must be capped.
    v *= 1 + (i % 2 === 0 ? 0.09 : -0.06);
  }
  const r = rateAsset(snapshot({ history: candles(wild) }));
  assert.equal(r.risk.band, "very-high");
  assert.ok(r.stars <= 3, `capped, got ${r.stars} stars on composite ${r.composite}`);
});

test("risk takes the WORSE of volatility and drawdown, never the average", () => {
  // Calm day to day, but it halved once. Averaging the two readings would call this moderate.
  const closes: number[] = [];
  for (let i = 0; i < 120; i++) closes.push(100 * (1 + 0.001 * Math.sin(i)));
  for (let i = 0; i < 5; i++) closes.push(100 * (1 - 0.12 * (i + 1)));
  for (let i = 0; i < 120; i++) closes.push(40 * (1 + 0.001 * Math.sin(i)));

  const risk = profileRisk(closes);
  assert.ok(risk.maxDrawdown != null && risk.maxDrawdown > 0.55);
  assert.ok(
    risk.band === "very-high",
    `a 60% collapse is very-high whatever the quiet days say, got ${risk.band}`,
  );
});

test("unmeasurable risk is treated as the highest band, not the lowest", () => {
  const risk = profileRisk([100, 101]);
  assert.equal(risk.band, "very-high");
  assert.ok(risk.reasons.join(" ").includes("unmeasured risk is not a low one"));
});

// ---------------------------------------------------------------------------------------------
// Trend
// ---------------------------------------------------------------------------------------------

test("a steady climber outscores a jagged one with IDENTICAL returns", () => {
  // ⚠️ Scaling a series does not change its returns, so "match the endpoints by multiplying" does
  // not produce two paths with the same performance — it produces two paths with the same last
  // price and different returns, which tests nothing. The modulation below is zero at every
  // multiple of 63, so the 3-month and 6-month returns are identical by construction and the ONLY
  // difference left is the character of the path.
  const n = 253; // last index 252 = 4 x 63
  const steady = ramping(n, 100, 0.0015);
  const jagged = steady.map((v, i) => v * (1 + 0.2 * Math.sin((Math.PI * i) / 63)));

  const near = (a: number | null, b: number | null) =>
    a != null && b != null && Math.abs(a - b) < 1e-9;
  assert.ok(near(returnOver(steady, 63), returnOver(jagged, 63)), "3-month returns must match");
  assert.ok(near(returnOver(steady, 126), returnOver(jagged, 126)), "6-month returns must match");

  const a = scoreTrend(steady).score;
  const b = scoreTrend(jagged).score;
  assert.ok(a != null && b != null);
  assert.ok(a > b, `steady ${a} should beat jagged ${b} at identical returns`);
});

test("a steady low-volatility climber is NOT penalised as overextended", () => {
  // The regression that motivated `stretchPercentile`: a constant-rate riser sits at RSI 85+ forever
  // and an RSI-driven penalty docked it every day. Its gap to its own average is constant, so the
  // self-calibrating measure correctly finds nothing unusual.
  // ~35% over the year: a good result, deliberately not a maximal one — the return components are
  // calibrated so a genuinely exceptional performer still has somewhere to go above this.
  const grinder = ramping(253, 100, 0.0012);
  const t = scoreTrend(grinder);
  assert.ok(t.score != null && t.score > 70, `a clean uptrend should score well, got ${t.score}`);
  assert.ok(
    !t.reasons.some((r) => r.includes("Scored down")),
    "a steady climb is not an overextended one",
  );
});

test("a blow-off top IS penalised, and the reason says so", () => {
  // Two hundred sessions of ordinary progress, then a vertical final stretch — the gap to the
  // 50-day average ends wider than anything else in the window.
  const parabolic = ramping(200, 100, 0.001);
  let v = parabolic[parabolic.length - 1] as number;
  for (let i = 0; i < 53; i++) {
    v *= 1.025;
    parabolic.push(v);
  }
  const p = scoreTrend(parabolic);
  assert.ok(p.score != null);
  assert.ok(
    p.reasons.some((r) => r.includes("Scored down")),
    `the penalty must fire and be visible: ${p.reasons.join(" | ")}`,
  );
  assert.ok(p.score < 100, "the penalty must keep a parabola off a perfect score");
});

test("a tidy DECLINE is not rewarded for being tidy", () => {
  const falling = ramping(250, 100, -0.002);
  const t = scoreTrend(falling);
  assert.ok(t.score != null && t.score < 25, `a steady fall must score low, got ${t.score}`);
  assert.ok(t.reasons.some((r) => r.includes("down")));
});

test("too little history yields a null trend, not a confident guess", () => {
  const t = scoreTrend([100, 101, 102, 103]);
  assert.equal(t.score, null);
  assert.equal(t.confidence, 0);
});

// ---------------------------------------------------------------------------------------------
// Analyst calibration — the part most likely to mislead if scored naively
// ---------------------------------------------------------------------------------------------

test("a price target implying the market-average upside scores NEUTRAL, not bullish", () => {
  const price = 100;
  const typical = scoreAnalyst(
    { strongBuy: 5, buy: 5, hold: 5, sell: 0, strongSell: 0, targetMean: price * (1 + TARGET_NEUTRAL), targetCount: 20 },
    price,
  );
  assert.ok(typical.score != null);
  // Ratings here average 4.0, a shade above the 3.8 norm, so the pillar sits just over 50 — but the
  // target half must not be inflating it.
  const targetOnly = scoreAnalyst(
    { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0, targetMean: price * (1 + TARGET_NEUTRAL), targetCount: 20 },
    price,
  );
  assert.ok(
    targetOnly.score != null && Math.abs(targetOnly.score - 50) < 6,
    `an average target must land near 50, got ${targetOnly.score}`,
  );
});

test("an unusually high target does score above neutral", () => {
  const hot = scoreAnalyst(
    { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0, targetMean: 145, targetCount: 20 },
    100,
  );
  assert.ok(hot.score != null && hot.score > 70, `got ${hot.score}`);
});

test("thin coverage is shrunk toward neutral", () => {
  const one = scoreAnalyst(
    { strongBuy: 1, buy: 0, hold: 0, sell: 0, strongSell: 0, targetMean: null, targetCount: null },
    100,
  );
  const many = scoreAnalyst(
    { strongBuy: 25, buy: 0, hold: 0, sell: 0, strongSell: 0, targetMean: null, targetCount: null },
    100,
  );
  assert.ok(one.score != null && many.score != null);
  assert.ok(
    many.score > one.score + 15,
    `25 analysts (${many.score}) must count for far more than 1 (${one.score})`,
  );
  assert.ok(one.reasons.some((r) => r.includes("Thin coverage")));
});

test("a consensus at the market norm lands at neutral, not at 'buy'", () => {
  // CONSENSUS_NEUTRAL exists because buy ratings hugely outnumber sells market-wide, so the
  // arithmetic middle of the 1-5 scale is NOT where an average stock sits.
  assert.ok(CONSENSUS_NEUTRAL > 3.5, "the neutral point must be above the arithmetic middle");
  // 5 strong buys, 6 buys, 8 holds, 1 sell averages 3.75 — a genuinely ordinary book.
  const norm = scoreAnalyst(
    { strongBuy: 5, buy: 6, hold: 8, sell: 1, strongSell: 0, targetMean: null, targetCount: null },
    100,
  );
  assert.ok(
    norm.score != null && Math.abs(norm.score - 50) < 10,
    `an ordinary book must read as ordinary, got ${norm.score}`,
  );
  // And a book that really is bullish must clear it comfortably.
  const bullish = scoreAnalyst(
    { strongBuy: 14, buy: 5, hold: 1, sell: 0, strongSell: 0, targetMean: null, targetCount: null },
    100,
  );
  assert.ok(bullish.score != null && bullish.score > 70, `got ${bullish.score}`);
});

test("no consensus at all is null, not zero", () => {
  assert.equal(scoreAnalyst(null, 100).score, null);
  assert.equal(scoreAnalyst(undefined, 100).score, null);
});

// ---------------------------------------------------------------------------------------------
// Fundamentals
// ---------------------------------------------------------------------------------------------

test("a negative P/E is not scored as cheap", () => {
  const lossMaking = scoreFundamentals({ peRatio: -12 });
  const cheap = scoreFundamentals({ peRatio: 9 });
  assert.ok(lossMaking.score != null && cheap.score != null);
  assert.ok(
    lossMaking.score < cheap.score,
    `loss-making ${lossMaking.score} must not beat genuinely cheap ${cheap.score}`,
  );
  assert.ok(lossMaking.reasons.some((r) => r.includes("loss-making")));
});

test("fundamentals confidence reflects how many metrics were actually present", () => {
  const thin = scoreFundamentals({ netMargin: 0.2 });
  const full = scoreFundamentals({
    revenueGrowthYoY: 0.1, epsGrowthYoY: 0.1, netMargin: 0.2,
    returnOnEquity: 0.2, debtToEquity: 0.5, peRatio: 18,
  });
  assert.ok(thin.confidence < full.confidence);
  assert.ok(thin.reasons.some((r) => r.includes("part of the financial picture")));
});

test("an empty fundamentals object is null, not a zero score", () => {
  assert.equal(scoreFundamentals({}).score, null);
  assert.equal(scoreFundamentals(null).score, null);
});

// ---------------------------------------------------------------------------------------------
// Stars, confidence and ranking
// ---------------------------------------------------------------------------------------------

test("sparse evidence caps the stars — 'we don't know' cannot present as 'looks great'", () => {
  assert.equal(starsFor(95, "low", 0.2).stars, 2);
  assert.equal(starsFor(95, "low", 0.35).stars, 3);
  assert.equal(starsFor(95, "low", 0.9).stars, 5);
  assert.ok(starsFor(95, "low", 0.2).caveats.some((c) => c.includes("not much data")));
});

test("stars span the full range and 5 is genuinely hard", () => {
  assert.equal(starsFor(10, "low", 1).stars, 1);
  assert.equal(starsFor(40, "low", 1).stars, 2);
  assert.equal(starsFor(55, "low", 1).stars, 3);
  assert.equal(starsFor(70, "low", 1).stars, 4);
  assert.equal(starsFor(80, "low", 1).stars, 5);
  assert.equal(starsFor(77.9, "low", 1).stars, 4, "just under the bar is not 5 stars");
});

test("ranking orders by the requested pillar and breaks ties on trend", () => {
  const a = rateAsset(snapshot({ id: "A", history: candles(noisyRamp(250, 0.003, 0.01)) }));
  const b = rateAsset(snapshot({ id: "B", history: candles(noisyRamp(250, -0.002, 0.01)) }));
  const byStars = rankRatings([b, a], "stars");
  assert.equal(byStars[0]?.id, "A", "the riser must outrank the faller");

  const byTrend = rankRatings([b, a], "trend");
  assert.equal(byTrend[0]?.id, "A");

  const byRisk = rankRatings([a, b], "risk");
  assert.ok(byRisk.length === 2, "risk sort returns everything, lowest risk first");
});

test("a rating always explains itself — no silent numbers", () => {
  const r = rateAsset(
    snapshot({
      consensus: { strongBuy: 3, buy: 2, hold: 1, sell: 0, strongSell: 0, targetMean: 200, targetCount: 6 },
      fundamentals: { revenueGrowthYoY: 0.15, netMargin: 0.18, peRatio: 22 },
    }),
  );
  assert.ok(r.trend.reasons.length > 0);
  assert.ok(r.analyst.reasons.length > 0);
  assert.ok(r.fundamentals.reasons.length > 0);
  assert.ok(r.risk.reasons.length > 0);
  assert.ok(r.stars >= 1 && r.stars <= 5);
});

// ---------------------------------------------------------------------------------------------
// The network pillar — crypto's answer to fundamentals
// ---------------------------------------------------------------------------------------------

test("absent on-chain data scores null, not zero", () => {
  assert.equal(scoreNetwork(null).score, null);
  assert.equal(scoreNetwork({}).score, null);
  // The all-null shape is the one a half-failed fetch produces, and it must not read as a bad chain.
  assert.equal(
    scoreNetwork({ hashRateChange: null, txCountChange: null, activeAddressChange: null }).score,
    null,
  );
});

test("a growing chain outscores a shrinking one, and neither is scored 0 or 100", () => {
  const growing = scoreNetwork({
    hashRateChange: 0.15,
    txCountChange: 0.12,
    activeAddressChange: 0.1,
    windowDays: 120,
  });
  const shrinking = scoreNetwork({
    hashRateChange: -0.12,
    txCountChange: -0.2,
    activeAddressChange: -0.18,
    windowDays: 120,
  });
  assert.ok(growing.score != null && shrinking.score != null);
  assert.ok((growing.score as number) > (shrinking.score as number) + 30);
  assert.equal(growing.confidence, 1);
});

test("hash rate is banded asymmetrically — routine growth is not strength", () => {
  // Hash rate rises across cycles as hardware improves, so +5% over a quarter is unremarkable while
  // ANY sustained fall means miners are powering machines down. Scored symmetrically, the first
  // would read as a bullish signal. Compare like with like: same magnitude, opposite sign.
  const up = scoreNetwork({ hashRateChange: 0.05 });
  const down = scoreNetwork({ hashRateChange: -0.05 });
  assert.ok(up.score != null && down.score != null);
  assert.ok((up.score as number) < 60, `routine growth read as ${up.score}, should be middling`);
  assert.ok((down.score as number) < 30, `a hash rate fall read as ${down.score}, too forgiving`);
});

test("thin on-chain data lowers confidence rather than the score", () => {
  // ⚠️ COMPARE THE SAME FIELD, NOT THE SAME NUMBER. The first version of this test set all three
  // fields to +10% and expected the partial and full scores to match — but hash rate is banded
  // asymmetrically on purpose, so +10% is a middling 67 there and a strong 83 on the activity
  // measures. The gap it caught was the deliberate asymmetry two tests above, not a dilution bug.
  const twoFields = scoreNetwork({ txCountChange: 0.1, activeAddressChange: 0.1 });
  const oneField = scoreNetwork({ txCountChange: 0.1 });
  assert.ok(twoFields.score != null && oneField.score != null);
  // The contract: dropping a measurement must not drag the score toward zero. It is the same
  // "absent is not bad" rule the whole engine turns on, applied inside one pillar.
  assert.ok(
    Math.abs((twoFields.score as number) - (oneField.score as number)) < 1,
    `one field scored ${oneField.score}, two scored ${twoFields.score} — absence diluted the score`,
  );
  assert.ok(oneField.confidence < twoFields.confidence);
  assert.ok(oneField.reasons.some((r) => /part of the on-chain picture/i.test(r)));
});

test("the network pillar never presents itself as a price forecast", () => {
  const p = scoreNetwork({ hashRateChange: 0.3, txCountChange: 0.3, activeAddressChange: 0.3 });
  const text = p.reasons.join(" ");
  assert.ok(/not a price forecast/i.test(text));
  // The whole app's contract. A pillar that sounds like inside knowledge is the likeliest place to
  // break it, so the ban is asserted here as well as in the copy.
  assert.ok(!/will rise|going up|buy now|expect(ed)? to reach/i.test(text), text);
});

test("crypto is scored on its network where a share is scored on its accounts", () => {
  const withChain = rateAsset(
    snapshot({
      kind: "crypto",
      network: { hashRateChange: 0.18, txCountChange: 0.15, activeAddressChange: 0.14 },
    }),
  );
  const withoutChain = rateAsset(snapshot({ kind: "crypto" }));
  assert.ok(withChain.network.score != null);
  assert.equal(withoutChain.network.score, null);
  // A healthy chain has to actually move the composite, or the pillar is decoration.
  assert.ok(withChain.composite > withoutChain.composite);
  // And an equity must never be judged on a chain it does not have.
  const share = rateAsset(snapshot({ kind: "equity" }));
  assert.equal(share.network.score, null);
  assert.ok(!share.missing.includes("on-chain network activity"));
});

test("a crypto asset is not docked confidence for having no company accounts", () => {
  // The confidence denominator is the weight that COULD apply to this KIND. Divide crypto by every
  // weight that exists and its confidence caps at 70% of the truth, and `starsFor`'s confidence cap
  // then takes stars off it for a gap that is not a gap.
  const chain = rateAsset(
    snapshot({
      kind: "crypto",
      network: { hashRateChange: 0.18, txCountChange: 0.15, activeAddressChange: 0.14 },
    }),
  );
  const noCapForThinData = chain.caveats.every((c) => !/not much data to go on/i.test(c));
  assert.ok(noCapForThinData, chain.caveats.join(" | "));
});
