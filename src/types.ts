// Shared types for the market tracker.
//
// Design rule that governs this whole module: a MISSING signal is `null`, never `0`. A crypto asset
// has no revenue growth and no analyst coverage; scoring those as zero would rank it below a
// mediocre stock for the crime of being a different kind of thing. Every pillar is nullable and the
// composite renormalises over whatever is actually present — and says so on screen.

/** What kind of thing this is. Determines which pillars can even be computed. */
export type AssetKind = "equity" | "etf" | "crypto";

/** One daily close. `t` is a UTC midnight epoch-ms so two providers can be merged safely. */
export interface Candle {
  t: number;
  close: number;
}

/** Analyst recommendation counts for one period, as published by the data provider. */
export interface AnalystConsensus {
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
  /** Mean 12-month price target, in the same currency as the price series. */
  targetMean: number | null;
  /** How many analysts contributed the target. Thin coverage is shrunk toward neutral. */
  targetCount: number | null;
}

/** Company fundamentals. Every field optional — providers differ wildly in what the free tier gives. */
export interface Fundamentals {
  /** Year-on-year revenue growth, as a fraction: 0.12 = +12%. */
  revenueGrowthYoY?: number | null;
  /** Year-on-year earnings-per-share growth, as a fraction. */
  epsGrowthYoY?: number | null;
  /** Net margin as a fraction: 0.21 = 21%. */
  netMargin?: number | null;
  /** Total debt / total equity, as a ratio: 1.5 = 150%. */
  debtToEquity?: number | null;
  /** Trailing price/earnings. Negative or absent means loss-making or unknown. */
  peRatio?: number | null;
  /** Return on equity as a fraction. */
  returnOnEquity?: number | null;
}

/**
 * On-chain network measurements for a crypto asset — the "is the network actually being used, and
 * are miners still committing capital to it?" question. Every field is a fractional change over the
 * measurement window: 0.08 = +8%.
 *
 * ⚠️ USD MINER REVENUE IS DELIBERATELY ABSENT. It is the obvious fourth field and it is the wrong
 * one: miner revenue in dollars is block reward × price, so it rises whenever the price rises. Add
 * it and the Network pillar quietly re-scores the price the Trend pillar has already scored, and the
 * composite double-counts a single signal while appearing to average two independent ones.
 *
 * ⚠️ THESE ARE NOT PRICE SIGNALS AND MUST NEVER BE PRESENTED AS ONE. Hash rate follows past
 * profitability; transaction counts move with fee markets and batching habits. They say whether the
 * network is healthy, which is a different question from whether the price will rise.
 */
export interface NetworkStats {
  /** Change in total network hash rate — miner capital commitment. */
  hashRateChange?: number | null;
  /** Change in daily confirmed transactions — settlement demand. */
  txCountChange?: number | null;
  /** Change in daily unique active addresses — how many participants are moving coins. */
  activeAddressChange?: number | null;
  /** Length of the comparison window in days, for the "show your working" panel. */
  windowDays?: number | null;
}

/**
 * Institutional flow measurements for a crypto asset, delivered by the "paper round" — a GitHub
 * Action that reads freely published pages once a day server-side (where the CORS wall does not
 * exist) and commits the numbers as `data/flows.json`, which the page then reads from its own
 * origin. The app itself never scrapes anything.
 *
 * ⚠️ EVERY FIELD CARRIES ITS DATE, AND STALENESS IS A SCORING CONCERN. A scraper breaks silently —
 * the site changes its layout and the robot stops committing — so the file's dates are the only
 * thing standing between "current evidence" and "last month's numbers wearing today's stars".
 * `scoreFlows` refuses data older than its tolerance rather than trusting it quietly.
 */
export interface FlowStats {
  /** Daily net flow into US spot ETFs, US$ millions, chronological, most recent last. */
  etfDailyUsdM?: number[] | null;
  /** ISO date of the last ETF flow row. */
  etfAsOf?: string | null;
  /** Total BTC held by public companies at the latest snapshot. */
  corpHoldingsBtc?: number | null;
  /** Change in that total over `corpChangeDays`. Null until enough snapshots accumulate. */
  corpChangeBtc?: number | null;
  corpChangeDays?: number | null;
  /** ISO date the robot last ran. */
  fetchedAt?: string | null;
}

/** Everything the scorer needs about one asset. Assembled by the providers, consumed by `rateAsset`. */
export interface AssetSnapshot {
  id: string;
  symbol: string;
  name: string;
  kind: AssetKind;
  currency: string;
  /** Most recent price. */
  price: number;
  /** Daily closes, oldest first. The scorer needs ~200 sessions to use every trend signal. */
  history: Candle[];
  consensus?: AnalystConsensus | null;
  fundamentals?: Fundamentals | null;
  network?: NetworkStats | null;
  flows?: FlowStats | null;
  /** Where each part came from, for the "show your working" panel. */
  sources?: string[];
}

/** One scored pillar. `score` is 0–100, higher is more favourable. */
export interface Pillar {
  /** 0–100, or null when the inputs to compute it were absent. */
  score: number | null;
  /** 0–1. How much data stood behind the score — thin inputs are shrunk toward 50. */
  confidence: number;
  /** Plain-English lines describing what drove it. Shown verbatim in the UI. */
  reasons: string[];
}

/** Risk is deliberately NOT a pillar — it caps the stars rather than averaging into them. */
export type RiskBand = "low" | "moderate" | "high" | "very-high";

export interface RiskProfile {
  band: RiskBand;
  /** Annualised volatility of daily log returns, as a fraction: 0.45 = 45%. */
  annualisedVol: number | null;
  /** Worst peak-to-trough fall within the history window, as a positive fraction. */
  maxDrawdown: number | null;
  /** Largest single-day fall in the window, as a positive fraction. */
  worstDay: number | null;
  reasons: string[];
}

export interface Rating {
  id: string;
  symbol: string;
  name: string;
  kind: AssetKind;
  /** 1–5. See `starsFor` — capped by risk and by data sufficiency. */
  stars: number;
  /** 0–100 composite of the available pillars, BEFORE the risk and confidence caps. */
  composite: number;
  trend: Pillar;
  analyst: Pillar;
  fundamentals: Pillar;
  /** Crypto only. Scores `null` for equities, where it is not applicable rather than missing. */
  network: Pillar;
  /** Crypto only — the crypto occupant of the analyst slot (revealed preference vs stated opinion). */
  flows: Pillar;
  risk: RiskProfile;
  /** Why the stars are what they are, including any cap that bit. */
  caveats: string[];
  /** Which pillars were unavailable, named so the UI never implies they scored badly. */
  missing: string[];
}
