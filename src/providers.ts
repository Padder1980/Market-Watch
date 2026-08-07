// Data adapters. These run in the BROWSER, against APIs that send CORS headers — there is no
// server in this app and no key ever leaves the device except to the API it belongs to.
//
// ⚠️ PROVIDER CHOICE IS CONSTRAINED BY CORS, NOT BY QUALITY. Plenty of better free sources exist
// (Stooq's CSV, Yahoo's chart endpoint, the FT and Reuters RSS feeds) and every one of them is
// unusable from a page like this because they send no `Access-Control-Allow-Origin`. Reaching them
// would need a proxy server, which would mean somewhere to host it and a key sitting on it. The
// three below were picked because they work from a static page with a key the user holds.
//
// ⚠️ EVERY FETCH HERE CAN FAIL, AND A FAILURE MUST NOT LOOK LIKE A BAD SCORE. Adapters return
// partial snapshots and record what was missing; the scorer treats absent inputs as `null`, never 0.

import type {
  AnalystConsensus,
  AssetSnapshot,
  Candle,
  FlowStats,
  Fundamentals,
  NetworkStats,
} from "./types.ts";
import { flowStatsFor, type FlowsFile } from "./flows-parse.ts";

export interface Keys {
  /** twelvedata.com — free tier covers daily price history. */
  twelveData?: string;
  /** finnhub.io — free tier covers analyst recommendations and basic financials. */
  finnhub?: string;
}

export interface WatchItem {
  kind: "equity" | "etf" | "crypto";
  /** Ticker for equities/ETFs ("AAPL", "VUSA.LON"); CoinGecko id for crypto ("bitcoin"). */
  id: string;
  label?: string;
}

/** Thrown with a readable message so the UI can show WHY a row is missing rather than a blank. */
export class ProviderError extends Error {
  // ⚠️ NOT a constructor parameter property (`readonly provider: string` in the parameter list).
  // esbuild transpiles that shorthand fine, so it was invisible as long as this file was only ever
  // consumed through the browser bundle — but `tools/discover-round.ts` is the first thing to
  // import providers.ts directly into a Node-executed .ts file (the same `node tools/x.ts`, no
  // build step, this whole project runs on), and Node's native TS "strip only" mode throws on the
  // syntax outright: `TypeScript parameter property is not supported in strip-only mode`. Declaring
  // the field and assigning it in the body is the version both toolchains can read.
  readonly provider: string;
  constructor(message: string, provider: string) {
    super(message);
    this.provider = provider;
    this.name = "ProviderError";
  }
}

async function getJson(url: string, provider: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new ProviderError(`Could not reach ${provider}. Check the connection.`, provider);
  }
  if (res.status === 429) {
    throw new ProviderError(`${provider} rate limit hit — wait a minute and refresh.`, provider);
  }
  if (!res.ok) {
    throw new ProviderError(`${provider} returned ${res.status}.`, provider);
  }
  return (await res.json()) as unknown;
}

/** Normalise to UTC midnight so series from different providers align on the same day boundary. */
function utcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function sortDedupe(candles: Candle[]): Candle[] {
  const byDay = new Map<number, number>();
  for (const c of candles) {
    if (Number.isFinite(c.close) && c.close > 0) byDay.set(utcDay(c.t), c.close);
  }
  return [...byDay.entries()].sort((a, b) => a[0] - b[0]).map(([t, close]) => ({ t, close }));
}

// ---------------------------------------------------------------------------------------------
// CoinGecko — crypto, no key required
// ---------------------------------------------------------------------------------------------

const CG = "https://api.coingecko.com/api/v3";

/**
 * ⚠️ `interval=daily` is requested explicitly. Without it CoinGecko switches to 5-minute or hourly
 * granularity for short ranges, and a "200-day moving average" computed over 200 five-minute bars
 * is a moving average of the last sixteen hours wearing the wrong label.
 */
export async function fetchCrypto(id: string, vs: string): Promise<AssetSnapshot> {
  const chart = (await getJson(
    `${CG}/coins/${encodeURIComponent(id)}/market_chart?vs_currency=${encodeURIComponent(vs)}&days=365&interval=daily`,
    "CoinGecko",
  )) as { prices?: [number, number][] };

  const raw = Array.isArray(chart.prices) ? chart.prices : [];
  const history = sortDedupe(raw.map(([t, close]) => ({ t, close })));
  const lastCandle = history[history.length - 1];
  if (!lastCandle) throw new ProviderError(`CoinGecko returned no prices for "${id}".`, "CoinGecko");

  return {
    id,
    symbol: id.toUpperCase(),
    name: id.replace(/-/g, " ").replace(/\b\w/g, (m) => m.toUpperCase()),
    kind: "crypto",
    currency: vs.toUpperCase(),
    price: lastCandle.close,
    history,
    consensus: null,
    fundamentals: null,
    sources: ["CoinGecko (price history)"],
  };
}

// ---------------------------------------------------------------------------------------------
// Blockchain.com charts — Bitcoin on-chain activity, no key required
// ---------------------------------------------------------------------------------------------

const BC = "https://api.blockchain.info/charts";

/**
 * ⚠️ `&cors=true` IS THE WHOLE REASON THIS SOURCE IS USABLE. Without it the endpoint sends no
 * `Access-Control-Allow-Origin` header and the browser discards the response before this code sees
 * it — the same wall that rules out Stooq, Yahoo and the RSS feeds. It is not an optimisation and it
 * must not be dropped as noise.
 *
 * ⚠️ THIS IS A BITCOIN-ONLY SOURCE. Blockchain.com indexes the Bitcoin chain and nothing else, so
 * calling it for any other asset returns Bitcoin's numbers under that asset's name — a wrong answer
 * that looks exactly like a right one. `fetchBitcoinNetwork` is gated on the CoinGecko id.
 */
async function chartSeries(chart: string, days: number): Promise<number[] | null> {
  try {
    const data = (await getJson(
      `${BC}/${chart}?timespan=${days}days&format=json&cors=true`,
      "Blockchain.com",
    )) as { values?: { x: number; y: number }[] };
    const vals = Array.isArray(data.values) ? data.values : [];
    const ys = vals.map((v) => Number(v.y)).filter((y) => Number.isFinite(y) && y > 0);
    return ys.length > 0 ? ys : null;
  } catch {
    // ⚠️ A network pillar that cannot load must degrade to ABSENT, never to a bad score, and must
    // never take the whole row down with it. The price history is the load-bearing fetch; this is
    // an enrichment, and an asset the user can still see beats a spinner that failed on an extra.
    return null;
  }
}

/** Window used for both halves of the comparison. 30 days each side, 90 days apart end to end. */
const NET_WIN = 30;

/**
 * Compare the mean of the most recent `NET_WIN` days against the mean of the `NET_WIN` days at the
 * start of the window.
 *
 * ⚠️ NOT A POINT-TO-POINT CHANGE. Daily transaction counts routinely swing 30% on a single busy
 * weekend or one exchange changing its batching, so first-vs-last would report a quarter's trend
 * from two arbitrary days — and it would do it with a confident bar beside it.
 */
function windowChange(series: number[] | null, span: number): number | null {
  if (!series || series.length < span + NET_WIN * 2) return null;
  const recent = series.slice(-NET_WIN);
  const base = series.slice(0, NET_WIN);
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;
  const b = mean(base);
  if (!Number.isFinite(b) || b <= 0) return null;
  const change = mean(recent) / b - 1;
  return Number.isFinite(change) ? change : null;
}

/**
 * Bitcoin on-chain activity: miner commitment and settlement demand over the last quarter.
 *
 * Covers two of the owner's stated signals — on-chain activity and miner behaviour — from a free,
 * keyless, browser-readable source. The higher-priority signals (ETF flows, exchange reserves) are
 * NOT here: every provider of them is a paid subscription, which is recorded in CLAUDE.md rather
 * than approximated with something cheaper that would answer a different question.
 */
export async function fetchBitcoinNetwork(id: string): Promise<NetworkStats | null> {
  if (id !== "bitcoin") return null;
  const days = 120;
  // Sequential, not parallel: same reasoning as the equity loader — three simultaneous requests to a
  // free endpoint is the fastest way to be rate-limited on all three at once.
  const hash = await chartSeries("hash-rate", days);
  const tx = await chartSeries("n-transactions", days);
  const addr = await chartSeries("n-unique-addresses", days);
  if (!hash && !tx && !addr) return null;

  // The series arrive at different sampling rates, so the span is derived per series rather than
  // assumed from `days`.
  const stats: NetworkStats = {
    hashRateChange: windowChange(hash, 0),
    txCountChange: windowChange(tx, 0),
    activeAddressChange: windowChange(addr, 0),
    windowDays: days,
  };
  if (
    stats.hashRateChange == null && stats.txCountChange == null &&
    stats.activeAddressChange == null
  ) {
    return null;
  }
  return stats;
}

// ---------------------------------------------------------------------------------------------
// The paper round — institutional flows, read from our own origin
// ---------------------------------------------------------------------------------------------

/**
 * Institutional flow data, fetched from `data/flows.json` NEXT TO THE PAGE.
 *
 * ⚠️ THIS IS THE WHOLE WORKAROUND, AND IT IS WORTH UNDERSTANDING BEFORE CHANGING IT. Farside and the
 * treasuries pages publish these numbers freely but send no CORS header, so a browser cannot read
 * them — the same wall that rules out Stooq and the RSS feeds. The CORS rule only exists INSIDE
 * browsers, so a GitHub Action reads those pages server-side once a day and commits the result into
 * this repo. The page then reads its own file, from its own origin, where no permission is needed.
 * The app still scrapes nothing, still holds no key, and still has no server.
 *
 * ⚠️ A RELATIVE URL IS LOAD-BEARING. `./data/flows.json` resolves against wherever the page is
 * served from — GitHub Pages, a local file, a phone's Home Screen copy — so the app keeps working
 * from all three. An absolute URL to the Pages site would make every local copy phone home, and
 * would reintroduce the cross-origin problem this design exists to avoid.
 *
 * A 404 is the NORMAL case before the robot's first run, and is not an error.
 *
 * ⚠️ ANY ASSET THE FILE HAS AN ENTRY FOR, NOT JUST BITCOIN. `data/flows.json` keys `assets` by
 * CoinGecko id (Ethereum joined 2026-08-08, via the same Farside table format on its own page),
 * so this function no longer gates on the id itself — `flowStatsFor` does, by looking the id up in
 * the file and returning null when it genuinely has nothing for that coin. The shape-reading logic
 * is shared with the nightly Discover scan (`tools/discover-round.ts`), which reads the same
 * committed file from disk rather than over HTTP — see `flowStatsFor`'s own comment for why one
 * function serves both.
 */
export async function fetchFlows(id: string): Promise<FlowStats | null> {
  try {
    const res = await fetch("./data/flows.json", { cache: "no-cache" });
    if (!res.ok) return null;
    const raw = (await res.json()) as FlowsFile;
    return flowStatsFor(raw, id);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Twelve Data — daily price history for equities and ETFs
// ---------------------------------------------------------------------------------------------

const TD = "https://api.twelvedata.com";

export async function fetchEquityHistory(
  symbol: string,
  key: string,
): Promise<{ history: Candle[]; currency: string; name: string }> {
  const data = (await getJson(
    `${TD}/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=400&apikey=${encodeURIComponent(key)}`,
    "Twelve Data",
  )) as {
    status?: string;
    message?: string;
    meta?: { currency?: string; symbol?: string };
    values?: { datetime: string; close: string }[];
  };

  // ⚠️ Twelve Data reports errors with HTTP 200 and a `status: "error"` body. Trusting `res.ok`
  // alone yields an empty series that the scorer would read as "no history", hiding a bad key or a
  // mistyped ticker behind a generic "not enough data" message for as long as the user cared to look.
  if (data.status === "error") {
    throw new ProviderError(data.message ?? `Twelve Data rejected "${symbol}".`, "Twelve Data");
  }

  const values = Array.isArray(data.values) ? data.values : [];
  const history = sortDedupe(
    values.map((v) => ({ t: Date.parse(`${v.datetime}T00:00:00Z`), close: Number(v.close) })),
  );
  if (history.length === 0) {
    throw new ProviderError(`No price history returned for "${symbol}".`, "Twelve Data");
  }
  return {
    history,
    currency: data.meta?.currency ?? "USD",
    name: data.meta?.symbol ?? symbol,
  };
}

// ---------------------------------------------------------------------------------------------
// Finnhub — analyst recommendations and basic financials
// ---------------------------------------------------------------------------------------------

const FH = "https://finnhub.io/api/v1";

/** Never throws: analyst data is a bonus pillar and its absence must not sink the whole row. */
export async function fetchConsensus(
  symbol: string,
  key: string,
): Promise<AnalystConsensus | null> {
  try {
    const rows = (await getJson(
      `${FH}/stock/recommendation-trends?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`,
      "Finnhub",
    )) as {
      period?: string;
      strongBuy?: number;
      buy?: number;
      hold?: number;
      sell?: number;
      strongSell?: number;
    }[];
    if (!Array.isArray(rows) || rows.length === 0) return null;

    // Rows come newest-first, but sort rather than assume — an ordering change upstream would
    // silently start scoring year-old recommendations as current.
    const latest = [...rows].sort((a, b) => (b.period ?? "").localeCompare(a.period ?? ""))[0];
    if (!latest) return null;

    const consensus: AnalystConsensus = {
      strongBuy: latest.strongBuy ?? 0,
      buy: latest.buy ?? 0,
      hold: latest.hold ?? 0,
      sell: latest.sell ?? 0,
      strongSell: latest.strongSell ?? 0,
      targetMean: null,
      targetCount: null,
    };

    // Price targets are a paid endpoint on the free tier. Try, and shrug if refused.
    try {
      const pt = (await getJson(
        `${FH}/stock/price-target?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`,
        "Finnhub",
      )) as { targetMean?: number; numberOfAnalysts?: number };
      if (typeof pt.targetMean === "number" && pt.targetMean > 0) {
        consensus.targetMean = pt.targetMean;
        consensus.targetCount = pt.numberOfAnalysts ?? null;
      }
    } catch {
      /* free tier — no targets, and that is fine */
    }

    return consensus;
  } catch {
    return null;
  }
}

/** Never throws, for the same reason as `fetchConsensus`. */
export async function fetchFundamentals(
  symbol: string,
  key: string,
): Promise<Fundamentals | null> {
  try {
    const data = (await getJson(
      `${FH}/stock/metric?symbol=${encodeURIComponent(symbol)}&metric=all&token=${encodeURIComponent(key)}`,
      "Finnhub",
    )) as { metric?: Record<string, unknown> };
    const m = data.metric;
    if (!m || typeof m !== "object") return null;

    const num = (k: string): number | null => {
      const v = m[k];
      return typeof v === "number" && Number.isFinite(v) ? v : null;
    };
    /** Finnhub publishes growth and margins as PERCENTAGES; the scorer wants fractions. */
    const frac = (k: string): number | null => {
      const v = num(k);
      return v == null ? null : v / 100;
    };

    const f: Fundamentals = {
      revenueGrowthYoY: frac("revenueGrowthTTMYoy"),
      epsGrowthYoY: frac("epsGrowthTTMYoy"),
      netMargin: frac("netProfitMarginTTM"),
      returnOnEquity: frac("roeTTM"),
      debtToEquity: num("totalDebt/totalEquityQuarterly"),
      peRatio: num("peTTM"),
    };
    const any = Object.values(f).some((v) => v != null);
    return any ? f : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------------------------

export interface LoadResult {
  snapshots: AssetSnapshot[];
  /** One line per item that could not be loaded, ready to show. */
  failures: { id: string; message: string }[];
}

/**
 * Load every watchlist item.
 *
 * ⚠️ SEQUENTIAL, WITH A GAP, ON PURPOSE. The free tiers here are 8 requests/minute (Twelve Data) and
 * 60/minute (Finnhub). Firing a watchlist off in parallel is the fastest possible way to get every
 * row rate-limited at once and show a screen of errors that looks like the app is broken.
 */
export async function loadWatchlist(
  items: WatchItem[],
  keys: Keys,
  vsCurrency: string,
  onProgress?: (done: number, total: number, label: string) => void,
): Promise<LoadResult> {
  const snapshots: AssetSnapshot[] = [];
  const failures: { id: string; message: string }[] = [];
  let done = 0;

  for (const item of items) {
    onProgress?.(done, items.length, item.label ?? item.id);
    try {
      if (item.kind === "crypto") {
        const snap = await fetchCrypto(item.id, vsCurrency);
        // Enrichment, and it is allowed to fail silently — `fetchBitcoinNetwork` returns null both
        // for a non-Bitcoin asset and for an unreachable endpoint, and the scorer reads null as
        // "not measured" rather than as a bad result.
        const network = await fetchBitcoinNetwork(item.id);
        if (network) {
          snap.network = network;
          snap.sources = [...(snap.sources ?? []), "Blockchain.com (on-chain activity)"];
        }
        const flows = await fetchFlows(item.id);
        if (flows) {
          snap.flows = flows;
          snap.sources = [
            ...(snap.sources ?? []),
            "Farside Investors via daily snapshot (ETF flows)",
          ];
        }
        snapshots.push(snap);
      } else {
        if (!keys.twelveData) {
          throw new ProviderError(
            "No Twelve Data key set — add one in Settings to track shares and funds.",
            "Twelve Data",
          );
        }
        const { history, currency, name } = await fetchEquityHistory(item.id, keys.twelveData);
        const lastCandle = history[history.length - 1];
        if (!lastCandle) throw new ProviderError("Empty price history.", "Twelve Data");

        const sources = ["Twelve Data (price history)"];
        let consensus: AnalystConsensus | null = null;
        let fundamentals: Fundamentals | null = null;
        if (keys.finnhub) {
          consensus = await fetchConsensus(item.id, keys.finnhub);
          fundamentals = await fetchFundamentals(item.id, keys.finnhub);
          if (consensus) sources.push("Finnhub (analyst recommendations)");
          if (fundamentals) sources.push("Finnhub (company financials)");
        }

        snapshots.push({
          id: item.id,
          symbol: item.id,
          name: item.label ?? name,
          kind: item.kind,
          currency,
          price: lastCandle.close,
          history,
          consensus,
          fundamentals,
          sources,
        });
      }
    } catch (err) {
      failures.push({
        id: item.label ?? item.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }
    done++;
    onProgress?.(done, items.length, item.label ?? item.id);
    // Spacing for the 8/min free tier. Crypto is keyless and generous, so it does not need it.
    if (item.kind !== "crypto" && done < items.length) {
      await new Promise((r) => setTimeout(r, 8000));
    }
  }

  return { snapshots, failures };
}
