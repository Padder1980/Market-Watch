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
  risk: RiskProfile;
  /** Why the stars are what they are, including any cap that bit. */
  caveats: string[];
  /** Which pillars were unavailable, named so the UI never implies they scored badly. */
  missing: string[];
}
