// The nightly Discover scan. Runs on GitHub's servers, NOT in the browser, for the same reason the
// paper round does: keeping a wide scan off the owner's own connection and cached once a day beats
// making the app do ~25 sequential requests every time the tab is opened.
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

/** How many coins end up in the published list, after stablecoins are filtered out. */
const TARGET_COUNT = 25;
/** Fetched over-large so filtering stablecoins still leaves enough to reach TARGET_COUNT. */
const FETCH_COUNT = 40;
/** A courteous gap between per-coin history requests — same spirit as the paper round's pacing. */
const REQUEST_GAP_MS = 1500;
/** Below this many successfully-scored coins, refuse to publish rather than commit a thin scan. */
const MIN_SUCCESSFUL = 10;

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
      const snap = await fetchCrypto(c.id, "usd");
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
      // ⚠️ ONE BAD COIN MUST NOT SINK THE WHOLE SCAN. Twenty-five independent network requests WILL
      // occasionally include one that times out or 404s (a delisted id, a momentary CoinGecko hiccup)
      // — that coin is skipped and logged, not treated as a reason to discard the other twenty-four.
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
