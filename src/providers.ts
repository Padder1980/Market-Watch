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

import type { AnalystConsensus, AssetSnapshot, Candle, Fundamentals } from "./types.ts";

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
  constructor(
    message: string,
    readonly provider: string,
  ) {
    super(message);
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
        snapshots.push(await fetchCrypto(item.id, vsCurrency));
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
