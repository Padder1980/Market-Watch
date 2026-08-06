// The rating engine.
//
// Four questions, asked separately and answered from data that can be pointed at:
//   1. TREND        — is the price actually climbing, and is the climb orderly?
//   2. ANALYST      — do the people who publish forecasts expect growth from here?
//   3. FUNDAMENTALS — does the underlying business support it?
//   4. RISK         — and how badly could this hurt?
//
// ⚠️ RISK IS NOT AVERAGED IN. It caps the stars instead. Averaging risk into a composite is exactly
// how a violently volatile asset ends up wearing the same badge as a boring index fund: a 90 on
// trend and a 20 on risk averages to a comfortable-looking 55, and the number that mattered most to
// somebody deciding what they can afford to lose has been quietly cancelled out by the number that
// excited them. A cap cannot be cancelled out.
//
// ⚠️ NO PILLAR MAY SCORE ZERO FOR BEING ABSENT. Bitcoin has no revenue growth and no analyst
// coverage; a scorer that reads those as 0 ranks it beneath a mediocre listed company for the crime
// of being a different kind of asset. Absent pillars are `null` and the composite renormalises over
// what is present, with `missing` naming them so the UI can say so out loud.
//
// ⚠️ THIS IS NOT A PREDICTION AND MUST NEVER BE PRESENTED AS ONE. Every number below is a summary of
// what has ALREADY happened plus what other people have ALREADY published. Momentum is a real and
// well-documented market factor; it is also the mechanism by which people buy tops. The stars say
// "these measurable signals currently line up", never "this will go up".

import type {
  AnalystConsensus,
  AssetSnapshot,
  Fundamentals,
  NetworkStats,
  Pillar,
  Rating,
  RiskBand,
  RiskProfile,
} from "./types.ts";
import {
  annualisedVol,
  belowHigh,
  clamp,
  logTrend,
  maxDrawdown,
  ramp,
  returnOver,
  rsi,
  sma,
  stretchPercentile,
  worstDay,
} from "./indicators.ts";

/**
 * Pillar weights in the composite. Trend is heaviest because it is the question asked first.
 *
 * ⚠️ `network` CARRIES EXACTLY THE SAME WEIGHT AS `fundamentals`, AND THAT IS LOAD-BEARING. The two
 * are mutually exclusive — a company has accounts and no chain, a crypto asset has a chain and no
 * accounts — so they occupy one slot between them. Equal weights keep the applicable total at 1.0
 * for both kinds, which means the confidence denominator does not silently change with asset type.
 */
export const WEIGHTS = { trend: 0.45, analyst: 0.25, fundamentals: 0.3, network: 0.3 } as const;

/**
 * Star thresholds on the 0–100 composite, before caps.
 * Deliberately mean: 5 stars needs 78, which requires more than one pillar to be strong.
 */
export const STAR_THRESHOLDS = [36, 50, 64, 78] as const;

/**
 * ⚠️ Analyst price targets are SYSTEMATICALLY OPTIMISTIC — across the market, the average published
 * 12-month target sits roughly 10–15% above spot at all times, in bull markets and bear ones alike.
 * So scoring raw implied upside against zero would hand almost every covered stock a bullish mark
 * for being ordinary. `TARGET_NEUTRAL` is where the middle of the distribution actually sits, and
 * implied upside is scored RELATIVE TO IT.
 */
export const TARGET_NEUTRAL = 0.12;

/**
 * Same problem in the ratings themselves: buy ratings vastly outnumber sells, so a genuinely
 * average stock carries a consensus near 3.8 on a 1–5 scale, not 3.0. That is the point mapped to 50.
 */
export const CONSENSUS_NEUTRAL = 3.8;

/** Bayesian shrinkage constant — a score from 2 analysts is mostly noise, one from 25 is a view. */
const COVERAGE_K = 6;

/** Pull `score` toward 50 in proportion to how thin the evidence `n` behind it is. */
function shrink(score: number, n: number, k = COVERAGE_K): number {
  if (n <= 0) return 50;
  return 50 + (score - 50) * (n / (n + k));
}

/** Average of the defined entries, or null when every one was absent. */
function meanOf(parts: (number | null)[]): number | null {
  const present = parts.filter((p): p is number => p != null && Number.isFinite(p));
  if (present.length === 0) return null;
  return present.reduce((a, b) => a + b, 0) / present.length;
}

function pct(x: number): string {
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;
}

// ---------------------------------------------------------------------------------------------
// Pillar 1 — TREND
// ---------------------------------------------------------------------------------------------

/**
 * Is it climbing, and is the climb orderly?
 *
 * Six components, each on the same 0–100 ruler, then averaged over whichever could be computed:
 *   • price against its 50-session average    — the short trend
 *   • 50-session average against the 200      — the long trend
 *   • 3-month return                          — recent momentum
 *   • 6-month return                          — sustained momentum
 *   • R² of a log-price regression            — is it a climb or a scramble that ended high
 *   • RSI, as a PENALTY at the extremes       — see below
 *
 * ⚠️ RSI ENTERS AS A PENALTY, NOT A REWARD, AND THAT IS THE WHOLE POINT. "The ones trending upwards"
 * is at its most seductive precisely when an asset is most extended, which is also when the next
 * move is most often a sharp reversion. An RSI above 75 subtracts; it never adds. The engine will
 * therefore sometimes rank a steady climber above a screaming one, which is the intended behaviour
 * and not a bug to tune out.
 */
export function scoreTrend(history: number[]): Pillar {
  const reasons: string[] = [];
  const last = history[history.length - 1];
  if (history.length < 30 || last == null) {
    return { score: null, confidence: 0, reasons: ["Not enough price history to judge a trend."] };
  }

  const parts: (number | null)[] = [];

  const ma50 = sma(history, 50);
  if (ma50 != null && ma50 > 0) {
    const gap = last / ma50 - 1;
    parts.push(ramp(gap, -0.12, 0.12));
    // ⚠️ `pct` already carries the sign, so the direction word must take the ABSOLUTE value or the
    // sentence contradicts itself: "Price is -1.4% below its 50-day average" states the opposite of
    // what it means, and reads as a rise to anyone skimming.
    reasons.push(
      `Price is ${(Math.abs(gap) * 100).toFixed(1)}% ${gap >= 0 ? "above" : "below"} its 50-day average.`,
    );
  }

  const ma200 = sma(history, 200);
  if (ma50 != null && ma200 != null && ma200 > 0) {
    const gap = ma50 / ma200 - 1;
    parts.push(ramp(gap, -0.1, 0.1));
    reasons.push(
      gap >= 0
        ? "The 50-day average sits above the 200-day — a long-term uptrend."
        : "The 50-day average sits below the 200-day — a long-term downtrend.",
    );
  }

  const r3 = returnOver(history, 63);
  if (r3 != null) {
    parts.push(ramp(r3, -0.2, 0.3));
    reasons.push(`Three-month return ${pct(r3)}.`);
  }

  const r6 = returnOver(history, 126);
  if (r6 != null) {
    parts.push(ramp(r6, -0.3, 0.5));
    reasons.push(`Six-month return ${pct(r6)}.`);
  }

  const fit = logTrend(history, Math.min(history.length, 126));
  if (fit != null) {
    // Only reward tidiness when the line is actually rising. A beautifully consistent decline is a
    // high R² and must not be read as trend quality.
    const quality = fit.slope > 0 ? ramp(fit.r2, 0.1, 0.8) : ramp(-fit.r2, -0.8, -0.1);
    parts.push(quality);
    if (fit.slope > 0) {
      // ⚠️ SAY "DIRECTION", NOT "STEADY". R² measures how closely the path tracks a rising line —
      // consistency of direction, not calmness. Printed as "the rise has been steady" it sat
      // directly above "annualised volatility 47%" in the risk section and invited the reader to
      // conclude the asset was placid. A high R² and a terrifying volatility coexist happily.
      reasons.push(
        fit.r2 >= 0.6
          ? `Direction has been consistent — the six-month path tracks a rising line closely (R² ${fit.r2.toFixed(2)}). That is about direction, not calmness; see risk.`
          : `Rising overall, but the path is erratic (R² ${fit.r2.toFixed(2)}) — a less reliable trend.`,
      );
    } else {
      reasons.push("The underlying direction over six months is down.");
    }
  }

  let score = meanOf(parts);
  if (score == null) {
    return { score: null, confidence: 0, reasons: ["Not enough price history to judge a trend."] };
  }

  // ⚠️ The overextension penalty is driven by `stretchPercentile`, NOT by RSI — see the note on that
  // function. RSI is reported below as familiar colour, but it never moves the score.
  const stretch = stretchPercentile(history, 50);
  if (stretch != null && stretch > 0.9) {
    const penalty = clamp((stretch - 0.9) * 220, 0, 22);
    score = clamp(score - penalty, 0, 100);
    reasons.push(
      `Stretched further above its own 50-day average than it has been ${(stretch * 100).toFixed(0)}% of this year. ` +
        "Scored down: a run this extended has more room to snap back than to continue.",
    );
  }

  const r = rsi(history, 14);
  if (r != null) {
    if (r >= 75) reasons.push(`RSI ${r.toFixed(0)} — in overbought territory.`);
    else if (r <= 25) reasons.push(`RSI ${r.toFixed(0)} — heavily sold off, which cuts both ways.`);
  }

  const below = belowHigh(history, 252);
  if (below != null && below > 0.001) {
    reasons.push(`${(below * 100).toFixed(1)}% below its 12-month high.`);
  } else if (below != null) {
    reasons.push("Sitting at its 12-month high.");
  }

  // Confidence is about how much of the window we actually have, not how good the score is.
  const confidence = clamp(history.length / 200, 0, 1);
  return { score, confidence, reasons };
}

// ---------------------------------------------------------------------------------------------
// Pillar 2 — ANALYST / PUBLISHED FORECASTS
// ---------------------------------------------------------------------------------------------

/**
 * What the people who publish forecasts currently expect.
 *
 * ⚠️ THIS IS THE HONEST VERSION OF "WHAT RESPECTED NEWS OUTLETS PREDICT", AND THE DIFFERENCE MATTERS.
 * Reputable outlets — the FT, Reuters, Bloomberg — overwhelmingly do NOT publish price predictions;
 * they report events. What actually exists in machine-readable form is sell-side analyst
 * recommendations and price targets, which is what this scores. Scraping headlines for optimistic
 * adjectives would produce a number that looks like the same thing and means nothing, so it is not
 * done here.
 *
 * Both inputs are calibrated against where the middle of the distribution really sits (see
 * `TARGET_NEUTRAL` and `CONSENSUS_NEUTRAL`) and then shrunk toward neutral by how many analysts
 * stand behind them.
 */
export function scoreAnalyst(consensus: AnalystConsensus | null | undefined, price: number): Pillar {
  if (!consensus) {
    return { score: null, confidence: 0, reasons: ["No analyst coverage available."] };
  }
  const reasons: string[] = [];
  const parts: (number | null)[] = [];

  const n =
    consensus.strongBuy + consensus.buy + consensus.hold + consensus.sell + consensus.strongSell;

  if (n > 0) {
    const weighted =
      (consensus.strongBuy * 5 +
        consensus.buy * 4 +
        consensus.hold * 3 +
        consensus.sell * 2 +
        consensus.strongSell * 1) /
      n;
    // 3.8 is the market's typical consensus, so it maps to 50. A full point above is strong.
    const raw = ramp(weighted - CONSENSUS_NEUTRAL, -1.0, 0.8);
    parts.push(shrink(raw, n));
    reasons.push(
      `${n} analyst${n === 1 ? "" : "s"} covering, averaging ${weighted.toFixed(1)}/5 ` +
        `(${consensus.strongBuy + consensus.buy} positive, ${consensus.hold} neutral, ` +
        `${consensus.sell + consensus.strongSell} negative).`,
    );
    if (n < 5) {
      reasons.push("Thin coverage — this has been pulled toward neutral.");
    }
  }

  if (consensus.targetMean != null && price > 0) {
    const upside = consensus.targetMean / price - 1;
    const raw = ramp(upside - TARGET_NEUTRAL, -0.25, 0.25);
    const count = consensus.targetCount ?? n;
    parts.push(shrink(raw, count));
    reasons.push(
      `Mean 12-month price target implies ${pct(upside)} from here ` +
        `(the market-wide average target sits about ${pct(TARGET_NEUTRAL)} above spot, so this is ` +
        `${upside > TARGET_NEUTRAL ? "above" : "below"} typical).`,
    );
  }

  const score = meanOf(parts);
  if (score == null) {
    return { score: null, confidence: 0, reasons: ["No analyst coverage available."] };
  }
  return { score, confidence: clamp(n / 15, 0, 1), reasons };
}

// ---------------------------------------------------------------------------------------------
// Pillar 3 — FUNDAMENTALS
// ---------------------------------------------------------------------------------------------

/**
 * Does the underlying business support the story the price is telling?
 *
 * Each metric that is present contributes one 0–100 sub-score; absent ones simply do not vote, and
 * `confidence` reports how much of the picture was actually available.
 */
export function scoreFundamentals(f: Fundamentals | null | undefined): Pillar {
  if (!f) {
    return { score: null, confidence: 0, reasons: ["No company fundamentals available."] };
  }
  const reasons: string[] = [];
  const parts: (number | null)[] = [];
  let fields = 0;
  const total = 6;

  if (f.revenueGrowthYoY != null && Number.isFinite(f.revenueGrowthYoY)) {
    fields++;
    parts.push(ramp(f.revenueGrowthYoY, -0.05, 0.25));
    reasons.push(`Revenue ${pct(f.revenueGrowthYoY)} year on year.`);
  }
  if (f.epsGrowthYoY != null && Number.isFinite(f.epsGrowthYoY)) {
    fields++;
    parts.push(ramp(f.epsGrowthYoY, -0.1, 0.3));
    reasons.push(`Earnings per share ${pct(f.epsGrowthYoY)} year on year.`);
  }
  if (f.netMargin != null && Number.isFinite(f.netMargin)) {
    fields++;
    parts.push(ramp(f.netMargin, 0, 0.25));
    reasons.push(`Net margin ${(f.netMargin * 100).toFixed(1)}%.`);
  }
  if (f.returnOnEquity != null && Number.isFinite(f.returnOnEquity)) {
    fields++;
    parts.push(ramp(f.returnOnEquity, 0, 0.25));
    reasons.push(`Return on equity ${(f.returnOnEquity * 100).toFixed(1)}%.`);
  }
  if (f.debtToEquity != null && Number.isFinite(f.debtToEquity)) {
    fields++;
    // Lower is better. Beyond ~3x the score is floored rather than going negative.
    parts.push(100 - ramp(f.debtToEquity, 0, 3));
    reasons.push(`Debt to equity ${f.debtToEquity.toFixed(2)}×.`);
  }
  if (f.peRatio != null && Number.isFinite(f.peRatio)) {
    fields++;
    if (f.peRatio <= 0) {
      // ⚠️ A negative P/E is not "cheap" — it means the company is losing money. Feeding it into a
      // lower-is-better ramp would score a loss-maker as the best value on the list.
      parts.push(20);
      reasons.push("Currently loss-making, so the P/E is not meaningful.");
    } else {
      parts.push(100 - ramp(f.peRatio, 8, 45));
      reasons.push(`Price/earnings ${f.peRatio.toFixed(1)}×.`);
    }
  }

  const score = meanOf(parts);
  if (score == null) {
    return { score: null, confidence: 0, reasons: ["No company fundamentals available."] };
  }
  if (fields < 3) {
    reasons.push("Only part of the financial picture was available.");
  }
  return { score, confidence: clamp(fields / total, 0, 1), reasons };
}

// ---------------------------------------------------------------------------------------------
// Pillar 3b — NETWORK (crypto's answer to fundamentals)
// ---------------------------------------------------------------------------------------------

/**
 * Is the chain actually being used, and are miners still committing capital to it?
 *
 * This is the crypto equivalent of reading a company's accounts: it looks past the price at whether
 * the thing underneath it is doing more business than it was. Three measurements, each a change over
 * the window, each contributing one 0–100 sub-score; absent ones do not vote.
 *
 * ⚠️ THE BANDS ARE ASYMMETRIC ON PURPOSE, AND HASH RATE IS THE ASYMMETRIC ONE. Hash rate grows
 * almost monotonically across cycles as hardware improves, so "up 5%" over a quarter is unremarkable
 * while ANY sustained fall means miners are switching machines off — a genuine signal that costs
 * real money to send. Scoring it symmetrically would read routine growth as strength.
 *
 * ⚠️ IT IS SCORED ON A SMOOTHED WINDOW, NOT ON TWO DAYS. Daily transaction counts swing wildly with
 * fee spikes, exchange batching and a single busy weekend. `fetchBitcoinNetwork` compares 30-day
 * averages for that reason; if you ever feed this raw endpoints, smooth them first or the pillar
 * becomes a noise generator with a confident-looking bar beside it.
 */
export function scoreNetwork(n: NetworkStats | null | undefined): Pillar {
  if (!n) {
    return { score: null, confidence: 0, reasons: ["No on-chain network data available."] };
  }
  const reasons: string[] = [];
  const parts: (number | null)[] = [];
  let fields = 0;
  const total = 3;
  const win = n.windowDays != null && Number.isFinite(n.windowDays)
    ? `over the last ${Math.round(n.windowDays)} days`
    : "over the measurement window";

  if (n.hashRateChange != null && Number.isFinite(n.hashRateChange)) {
    fields++;
    parts.push(ramp(n.hashRateChange, -0.1, 0.2));
    reasons.push(
      `Network hash rate ${pct(n.hashRateChange)} ${win} — ` +
        (n.hashRateChange < 0
          ? "miners are switching capacity off, which costs them money to do."
          : "miners are still committing hardware to it."),
    );
  }
  if (n.txCountChange != null && Number.isFinite(n.txCountChange)) {
    fields++;
    parts.push(ramp(n.txCountChange, -0.15, 0.15));
    reasons.push(`Daily transactions ${pct(n.txCountChange)} ${win}.`);
  }
  if (n.activeAddressChange != null && Number.isFinite(n.activeAddressChange)) {
    fields++;
    parts.push(ramp(n.activeAddressChange, -0.15, 0.15));
    reasons.push(`Daily active addresses ${pct(n.activeAddressChange)} ${win}.`);
  }

  const score = meanOf(parts);
  if (score == null) {
    return { score: null, confidence: 0, reasons: ["No on-chain network data available."] };
  }
  if (fields < total) {
    reasons.push("Only part of the on-chain picture was available.");
  }
  // ⚠️ This line is not decoration. Network health is the input most likely to be misread as a price
  // call, because it is the one that sounds like inside knowledge.
  reasons.push(
    "Network activity describes how the chain is being used. It is not a price forecast, and a busy " +
      "chain has been cheap before.",
  );
  return { score, confidence: clamp(fields / total, 0, 1), reasons };
}

// ---------------------------------------------------------------------------------------------
// Pillar 4 — RISK (a cap, not an average)
// ---------------------------------------------------------------------------------------------

const VOL_BANDS: [number, RiskBand][] = [
  [0.18, "low"],
  [0.32, "moderate"],
  [0.55, "high"],
];
const DD_BANDS: [number, RiskBand][] = [
  [0.15, "low"],
  [0.3, "moderate"],
  [0.5, "high"],
];
const BAND_ORDER: RiskBand[] = ["low", "moderate", "high", "very-high"];

function bandFor(value: number, bands: [number, RiskBand][]): RiskBand {
  for (const [limit, band] of bands) if (value < limit) return band;
  return "very-high";
}

/**
 * How badly could this hurt?
 *
 * ⚠️ THE TWO MEASURES ARE COMBINED BY TAKING THE WORSE, NOT THE AVERAGE. An asset with modest
 * day-to-day volatility that has nonetheless halved at some point in the window is a dangerous
 * asset, and averaging its calm days against its catastrophe is how that gets hidden.
 */
export function profileRisk(history: number[]): RiskProfile {
  const vol = annualisedVol(history);
  const dd = maxDrawdown(history);
  const worst = worstDay(history);
  const reasons: string[] = [];

  // ⚠️ VOLATILITY IS THE GATE, AND `dd == null` IS NOT ENOUGH TO DETECT AN UNMEASURED ASSET.
  // `maxDrawdown` happily returns a real number from two data points — and for anything that has
  // only ever risen, that number is 0%, i.e. the safest possible reading. So a brand-new listing
  // with three days of history sailed past the "no data" branch and was banded LOW, ranking as
  // safer than a gilt fund. A drawdown over a handful of points is not a measurement of risk; it is
  // the absence of one wearing a number. Volatility needs 20 sessions, so it is the honest gate.
  if (vol == null) {
    return {
      band: "very-high",
      annualisedVol: null,
      maxDrawdown: dd,
      worstDay: worst,
      reasons: [
        "Not enough history to measure risk. Treated as the highest band until it can be measured — " +
          "an unmeasured risk is not a low one.",
      ],
    };
  }

  let band: RiskBand = "low";
  if (vol != null) {
    const b = bandFor(vol, VOL_BANDS);
    if (BAND_ORDER.indexOf(b) > BAND_ORDER.indexOf(band)) band = b;
    reasons.push(`Annualised volatility ${(vol * 100).toFixed(0)}%.`);
  }
  if (dd != null) {
    const b = bandFor(dd, DD_BANDS);
    if (BAND_ORDER.indexOf(b) > BAND_ORDER.indexOf(band)) band = b;
    reasons.push(`Fell ${(dd * 100).toFixed(0)}% from a peak at its worst point in this window.`);
  }
  if (worst != null) {
    reasons.push(`Worst single day ${pct(-worst)}.`);
  }

  return { band, annualisedVol: vol, maxDrawdown: dd, worstDay: worst, reasons };
}

// ---------------------------------------------------------------------------------------------
// Composite + stars
// ---------------------------------------------------------------------------------------------

/** The most stars each risk band may carry, whatever the composite says. */
export const RISK_STAR_CAP: Record<RiskBand, number> = {
  low: 5,
  moderate: 5,
  high: 4,
  "very-high": 3,
};

/**
 * Turn a 0–100 composite into 1–5 stars, then apply the caps.
 *
 * Two caps, and both exist because a number this compact is read as a verdict however it is
 * labelled:
 *   • RISK — a very volatile asset tops out at 3 stars however hard it is trending.
 *   • CONFIDENCE — you cannot earn 5 stars off one pillar and 40 days of history. Thin evidence
 *     caps the result, so "we don't know much about this" can never present as "this looks great".
 */
export function starsFor(
  composite: number,
  risk: RiskBand,
  confidence: number,
): { stars: number; caveats: string[] } {
  let stars = 1;
  for (const t of STAR_THRESHOLDS) if (composite >= t) stars++;

  const caveats: string[] = [];
  const riskCap = RISK_STAR_CAP[risk];
  if (stars > riskCap) {
    caveats.push(
      `Capped at ${riskCap} star${riskCap === 1 ? "" : "s"} because the risk band is ` +
        `${risk.replace("-", " ")} — the signals look better than ${riskCap}, but this one can move violently.`,
    );
    stars = riskCap;
  }

  const confCap = confidence < 0.25 ? 2 : confidence < 0.45 ? 3 : 5;
  if (stars > confCap) {
    caveats.push(
      `Capped at ${confCap} stars because there was not much data to go on. ` +
        "Sparse evidence is not the same as good news.",
    );
    stars = confCap;
  }

  return { stars, caveats };
}

/** Score one asset end to end. */
export function rateAsset(snap: AssetSnapshot): Rating {
  const closes = snap.history.map((c) => c.close).filter((c) => Number.isFinite(c) && c > 0);

  const trend = scoreTrend(closes);
  const analyst = scoreAnalyst(snap.consensus, snap.price);
  const isCrypto = snap.kind === "crypto";
  const fundamentals = isCrypto
    ? { score: null, confidence: 0, reasons: ["Crypto has no company financials to assess."] }
    : scoreFundamentals(snap.fundamentals);
  // ⚠️ NOT APPLICABLE IS NOT THE SAME AS MISSING, and only one of the two belongs in `missing`.
  // An equity has no chain to measure, so saying its network data is absent would put a permanent
  // "the picture is partial" caveat on every share in the list for a pillar that could never exist.
  const network = isCrypto
    ? scoreNetwork(snap.network)
    : { score: null, confidence: 0, reasons: ["Network activity applies to crypto only."] };
  const risk = profileRisk(closes);

  // Renormalise the weights over whichever pillars produced a score.
  const entries: [number, number, number][] = [];
  if (trend.score != null) entries.push([trend.score, WEIGHTS.trend, trend.confidence]);
  if (analyst.score != null) entries.push([analyst.score, WEIGHTS.analyst, analyst.confidence]);
  if (fundamentals.score != null) {
    entries.push([fundamentals.score, WEIGHTS.fundamentals, fundamentals.confidence]);
  }
  if (network.score != null) entries.push([network.score, WEIGHTS.network, network.confidence]);

  const missing: string[] = [];
  if (trend.score == null) missing.push("price trend");
  if (analyst.score == null) missing.push("analyst forecasts");
  if (!isCrypto && fundamentals.score == null) missing.push("company fundamentals");
  if (isCrypto && network.score == null) missing.push("on-chain network activity");

  let composite = 0;
  let confidence = 0;
  if (entries.length > 0) {
    const wSum = entries.reduce((a, [, w]) => a + w, 0);
    composite = entries.reduce((a, [s, w]) => a + s * w, 0) / wSum;
    // Overall confidence is the weighted confidence of what we have, scaled by how much of the
    // intended weight was available at all — one strong pillar out of three is still one out of three.
    const cWeighted = entries.reduce((a, [, w, c]) => a + c * w, 0) / wSum;
    // ⚠️ The denominator is the weight that COULD have applied to this KIND of asset, not the sum of
    // every weight that exists. Dividing a crypto asset by trend+analyst+fundamentals+network would
    // cap its confidence at 70% of the truth for owning no company accounts, and the confidence cap
    // in `starsFor` would then dock its stars for a gap that is not a gap. Because `network` and
    // `fundamentals` carry equal weight, this total is 1.0 for both kinds.
    const applicable = WEIGHTS.trend + WEIGHTS.analyst +
      (isCrypto ? WEIGHTS.network : WEIGHTS.fundamentals);
    confidence = cWeighted * (wSum / applicable);
  }

  const { stars, caveats } = starsFor(composite, risk.band, confidence);
  if (missing.length > 0) {
    caveats.push(
      `Scored without ${missing.join(" or ")} — not counted against it, but the picture is partial.`,
    );
  }

  return {
    id: snap.id,
    symbol: snap.symbol,
    name: snap.name,
    kind: snap.kind,
    stars,
    composite,
    trend,
    analyst,
    fundamentals,
    network,
    risk,
    caveats,
    missing,
  };
}

/** Sort key options, in the priority order the app presents them. */
export type SortKey = "stars" | "trend" | "analyst" | "fundamentals" | "risk";

/**
 * Rank a scored list. Ties break on trend, because "the ones trending upwards" is the first
 * question the tracker exists to answer.
 */
export function rankRatings(ratings: Rating[], by: SortKey = "stars"): Rating[] {
  const val = (r: Rating): number => {
    switch (by) {
      case "trend":
        return r.trend.score ?? -1;
      case "analyst":
        return r.analyst.score ?? -1;
      case "fundamentals":
        return r.fundamentals.score ?? -1;
      case "risk":
        // Lowest risk first, so invert the band index.
        return -BAND_ORDER.indexOf(r.risk.band);
      default:
        return r.stars * 1000 + r.composite;
    }
  };
  return [...ratings].sort((a, b) => {
    const d = val(b) - val(a);
    if (d !== 0) return d;
    return (b.trend.score ?? -1) - (a.trend.score ?? -1);
  });
}
