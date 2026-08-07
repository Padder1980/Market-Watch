// The nightly Discover scan. Runs on GitHub's servers, NOT in the browser, for the same reason the
// paper round does: keeping a wide scan off the owner's own connection and cached once a day beats
// making the app do ~18 sequential requests every time the tab is opened.
//
// ⚠️ THIS RANKS BY THE SAME EVIDENCE THE WATCHLIST USES, NEVER BY RAW PRICE MOVEMENT. `rateAsset`
// is imported and run UNCHANGED — Discover exists to widen which coins get that scoring applied,
// not to add a second, looser "what's pumping" list. See `src/discover.ts`'s header for why that
// distinction is load-bearing here specifically, not just a style preference.
//
// Run:  node tools/discover-round.ts [--dry]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { diffAgainstPrevious, isStablecoinId, type DiscoverComposite } from "../src/discover.ts";
import { flowStatsFor, type FlowsFile } from "../src/flows-parse.ts";
import { fetchBitcoinNetwork, fetchCrypto } from "../src/providers.ts";
import { rateAsset } from "../src/score.ts";
import type { DiscoverEntry } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "data", "discover.json");
const FLOWS_FILE = join(here, "..", "data", "flows.json");
const DRY = process.argv.includes("--dry");

/**
 * ⚠️ EVERY CONSTANT BELOW IS CALIBRATED AGAINST ONE REAL FAILED RUN (2026-08-07), NOT A DOCUMENTED
 * NUMBER — CoinGecko states only that the fully keyless tier's limits are "significantly lower" than
 * the free Demo plan's 100 req/min, with no figure given. The actual log: 4 successful calls in ~6
 * seconds at a 1.5s gap, then EVERY one of the next 20 calls rate-limited for the rest of the run —
 * a sustained block, not a burst allowance recovering within the observed ~85 seconds. That pattern
 * is consistent with a request-COUNT quota over a rolling window, which no amount of same-minute
 * retrying can out-wait — so the primary defence is fewer total requests and a wider gap, not just a
 * retry. If a scheduled run ever comes back thin again despite this, the honest next step is a free
 * CoinGecko Demo API key as a GitHub Actions secret (same optional-key pattern as Twelve Data and
 * Finnhub already in this app), not a further guess at these numbers.
 */
const TARGET_COUNT = 18;
const FETCH_COUNT = 30;
const REQUEST_GAP_MS = 4000;
/** On a rate-limit specifically (not "coin doesn't exist" or similar), wait this long and retry. */
const RATE_LIMIT_BACKOFF_MS = 45000;
const MAX_ATTEMPTS_PER_COIN = 3;
/** Below this many successfully-scored coins, refuse to publish rather than commit a thin scan. */
const MIN_SUCCESSFUL = 7;

const CG = "https://api.coingecko.com/api/v3";

interface MarketCapRow {
  id: string;
  symbol: string;
  name: string;
}

async function fetchTopByMarketCap(count: number): Promise<MarketCapRow[]> {
  const res = await fetch(
    `${CG}/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${count}&page=1`,
  );
  if (!res.ok) throw new Error(`CoinGecko markets list returned HTTP ${res.status}`);
  const rows = (await res.json()) as { id?: string; symbol?: string; name?: string }[];
  return rows
    .filter((r): r is MarketCapRow => typeof r.id === "string" && typeof r.name === "string")
    .map((r) => ({ id: r.id, symbol: (r.symbol ?? r.id).toUpperCase(), name: r.name }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fraction change over the last `days` sessions. Mirrors `recentMove` in `shell.html` exactly —
 * kept as a separate small copy here rather than shared, because the two run in different
 * languages-of-context (this is a build-time Node script, that is runtime browser JS bundled from
 * `shell.html`, which this project deliberately keeps free of any TypeScript build step of its own).
 */
function moveOver(history: { close: number }[], days: number): number | null {
  if (history.length < days + 1) return null;
  const from = history[history.length - 1 - days]?.close;
  const to = history[history.length - 1]?.close;
  if (from == null || !(from > 0) || to == null) return null;
  return to / from - 1;
}

function readFlowsFile(): FlowsFile {
  try {
    return JSON.parse(readFileSync(FLOWS_FILE, "utf8")) as FlowsFile;
  } catch {
    return {};
  }
}

interface StoredDiscover {
  asOf?: string;
  entries?: DiscoverEntry[];
}

function readPrevious(): StoredDiscover {
  try {
    return JSON.parse(readFileSync(OUT, "utf8")) as StoredDiscover;
  } catch {
    return {};
  }
}

function isRateLimitError(err: unknown): boolean {
  return err instanceof Error && /rate limit/i.test(err.message);
}

/**
 * ⚠️ A RATE LIMIT IS NOT "THIS COIN IS BROKEN" — IT IS "SLOW DOWN", AND DESERVES A DIFFERENT
 * RESPONSE. Treating it the same as a genuinely bad id (skip and move on) is what produced the
 * 2026-08-07 failure: the very first 429 was followed by twenty more, one every 1.5s, because the
 * next request never gave the limit any time to lift. This waits meaningfully longer and tries the
 * SAME coin again — up to `MAX_ATTEMPTS_PER_COIN` — before finally giving up on it specifically.
 */
async function fetchCryptoWithRetry(id: string, vs: string) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_COIN; attempt++) {
    try {
      return await fetchCrypto(id, vs);
    } catch (err) {
      if (!isRateLimitError(err) || attempt === MAX_ATTEMPTS_PER_COIN) throw err;
      const wait = RATE_LIMIT_BACKOFF_MS * attempt;
      console.log(`  ${id} -> rate limited, waiting ${Math.round(wait / 1000)}s (attempt ${attempt}/${MAX_ATTEMPTS_PER_COIN})`);
      await sleep(wait);
    }
  }
  throw new Error("unreachable");
}

async function main(): Promise<void> {
  console.log("Discover scan:");
  const topRows = await fetchTopByMarketCap(FETCH_COUNT);
  const candidates = topRows.filter((r) => !isStablecoinId(r.id)).slice(0, TARGET_COUNT);
  console.log(
    `  ${topRows.length} fetched by market cap, ${topRows.length - candidates.length} stablecoins ` +
      `excluded, scoring ${candidates.length}`,
  );

  const flowsFile = readFlowsFile();
  const results: Omit<DiscoverEntry, "deltaComposite" | "isNew">[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i] as MarketCapRow;
    try {
      const snap = await fetchCryptoWithRetry(c.id, "usd");
      if (c.id === "bitcoin") {
        const network = await fetchBitcoinNetwork(c.id);
        if (network) snap.network = network;
      }
      const flows = flowStatsFor(flowsFile, c.id);
      if (flows) snap.flows = flows;

      const rating = rateAsset(snap);
      results.push({
        id: c.id,
        symbol: c.symbol,
        name: c.name,
        price: snap.price,
        currency: snap.currency,
        move1: moveOver(snap.history, 1),
        move30: moveOver(snap.history, 30),
        rating,
      });
      console.log(`  ${c.id} -> ok, ${rating.stars} stars, composite ${Math.round(rating.composite)}`);
    } catch (err) {
      // ⚠️ ONE BAD COIN MUST NOT SINK THE WHOLE SCAN. Eighteen independent network requests WILL
      // occasionally include one that times out or 404s (a delisted id, a momentary CoinGecko hiccup)
      // — that coin is skipped and logged, not treated as a reason to discard the other seventeen.
      // A rate limit has already had its retries by this point; this is only reached once they are
      // genuinely exhausted.
      console.log(`  ${c.id} -> FAILED: ${String(err).slice(0, 150)}`);
    }
    if (i < candidates.length - 1) await sleep(REQUEST_GAP_MS);
  }

  if (results.length < MIN_SUCCESSFUL) {
    console.log(`\nOnly ${results.length} coins scored successfully — refusing to publish a thin scan.`);
    process.exit(1);
  }

  const previous = readPrevious();
  const deltas = diffAgainstPrevious(
    results.map((r): DiscoverComposite => ({ id: r.id, composite: r.rating.composite })),
    (previous.entries ?? []).map((e): DiscoverComposite => ({ id: e.id, composite: e.rating.composite })),
  );

  const today = new Date().toISOString().slice(0, 10);
  const entries: DiscoverEntry[] = results.map((r) => {
    const d = deltas.get(r.id) ?? { delta: null, isNew: true };
    return { ...r, deltaComposite: d.delta, isNew: d.isNew };
  });

  const out: StoredDiscover = { asOf: today, entries };

  if (DRY) {
    console.log("\n--dry, not writing. Would write:");
    console.log(JSON.stringify({ asOf: today, entryCount: entries.length }, null, 2));
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(out, null, 1), "utf8");
    console.log(`\nWrote ${OUT} (${entries.length} coins)`);
  }
}

try {
  await main();
} catch (err) {
  // ⚠️ THE MARKET-CAP LIST ITSELF FAILING IS FATAL — THERE IS NOTHING TO SCAN — AND IT MUST STILL
  // FAIL CLEANLY. Found on this file's own first local run: an unhandled rejection here printed a
  // raw stack trace and exited non-zero, which does make the Action go red, but a log a human can
  // act on beats a stack trace every time. Same "broken looks broken, and says why" standard as the
  // paper round's own error paths.
  console.log(`\nDiscover scan failed: ${String(err).slice(0, 300)}`);
  process.exit(1);
}
