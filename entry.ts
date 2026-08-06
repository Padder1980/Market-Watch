// Browser bundle entry point. esbuild bundles this into a single IIFE exposed as `window.MK`, so
// the page runs the real engine client-side — same arrangement as the running app's `RC`.
// Keep this surface minimal: just what the page calls.

export {
  rateAsset,
  rankRatings,
  scoreTrend,
  scoreAnalyst,
  scoreFundamentals,
  scoreNetwork,
  scoreFlows,
  profileRisk,
  starsFor,
  WEIGHTS,
  STAR_THRESHOLDS,
  RISK_STAR_CAP,
  TARGET_NEUTRAL,
  CONSENSUS_NEUTRAL,
  FLOWS_STALE_DAYS,
} from "./src/score.ts";
export type { SortKey } from "./src/score.ts";

export {
  fetchBitcoinNetwork,
  fetchCrypto,
  fetchFlows,
  fetchEquityHistory,
  loadWatchlist,
  ProviderError,
} from "./src/providers.ts";
export type { Keys, WatchItem, LoadResult } from "./src/providers.ts";

export type {
  AssetKind,
  AssetSnapshot,
  Candle,
  FlowStats,
  NetworkStats,
  Pillar,
  Rating,
  RiskBand,
  RiskProfile,
} from "./src/types.ts";
