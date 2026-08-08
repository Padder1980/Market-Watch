// The nightly Discover scan for shares — the equity counterpart to tools/discover-round.ts. Scores
// a fixed universe of well-known large-cap US companies with the SAME rateAsset() the app uses for
// the owner's own watchlist, so the "widen what gets noticed" idea works for shares too, not just
// crypto.
//
// ⚠️ A SEPARATE SCRIPT AND A SEPARATE WORKFLOW FROM CRYPTO DISCOVER, DELIBERATELY — same reasoning
// CLAUDE.md already records for keeping the paper round and crypto Discover apart: a rate-limited or
// misconfigured run here (a missing key, Twelve Data having a bad day) must never be able to block
// the crypto scan's commit, and vice versa. Writes its own file, data/discover-shares.json.
//
// ⚠️ THIS UNIVERSE IS CURATED, NOT RANKED — AND THAT IS A REAL, DELIBERATE DIFFERENCE FROM CRYPTO
// DISCOVER, NOT AN OVERSIGHT TO FIX LATER. `discover-round.ts` ranks its candidates by CoinGecko's
// live, objective, third-party market-cap ordering — nobody chose which coins appear, the numbers
// did. There is no equivalent free, keyless "rank ~10,000 US-listed companies by market cap" source:
// Twelve Data and Finnhub's free tiers both charge one call per symbol just to read a market cap, so
// ranking the whole market would burn the daily quota before scoring a single company. SHARE_UNIVERSE
// below is therefore a hand-picked list of large, broadly-known companies across sectors — a
// genuinely curatorial choice, the exact kind of judgement call crypto Discover's design note warns
// against making. It is accepted here as the honest trade-off for a free source existing at all,
// on the condition that it is NEVER described to the user as size-ranked or as "the market" — only
// as what it is.
//
// Run:  TWELVE_DATA_KEY=... FINNHUB_KEY=... node tools/discover-round-shares.ts [--dry]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { diffAgainstPrevious, type DiscoverComposite } from "../src/discover.ts";
import { fetchConsensus, fetchEquityHistory, fetchFundamentals } from "../src/providers.ts";
import { rateAsset } from "../src/score.ts";
import type { AnalystConsensus, AssetSnapshot, DiscoverEntry, Fundamentals } from "../src/types.ts";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "data", "discover-shares.json");
const DRY = process.argv.includes("--dry");

const TWELVE_DATA_KEY = process.env.TWELVE_DATA_KEY ?? "";
const FINNHUB_KEY = process.env.FINNHUB_KEY ?? "";

/**
 * ⚠️ 8 SECONDS, NOT A NEW GUESS. This is the exact gap `loadWatchlist` already uses in the browser
 * for the identical reason (Twelve Data's free tier is 8 requests/minute) — reusing a figure this
 * app has already run against the real API beats inventing a second number for the same limit.
 */
const REQUEST_GAP_MS = 8000;
/**
 * Half the universe. A starting point, not a measured constant (unlike crypto Discover's, which is
 * calibrated against a real failed run) — there IS no failed run yet for this script, because it
 * cannot run at all without the owner's own keys as GitHub secrets (see the README note this script
 * prints when they're absent). Revisit against a real log once one exists, the same way crypto
 * Discover's constants were.
 */
const MIN_SUCCESSFUL_FRACTION = 0.5;

/**
 * Large, well-known US companies spanning sectors — see the file header for why this is a curated
 * list and not a ranked one. Not exhaustive, not "the S&P 500," just recognisable names a reader
 * would nod at. Refresh occasionally by hand; there is no live feed driving this.
 */
const SHARE_UNIVERSE: { id: string; name: string }[] = [
  { id: "AAPL", name: "Apple" },
  { id: "MSFT", name: "Microsoft" },
  { id: "GOOGL", name: "Alphabet" },
  { id: "AMZN", name: "Amazon" },
  { id: "NVDA", name: "NVIDIA" },
  { id: "META", name: "Meta Platforms" },
  { id: "TSLA", name: "Tesla" },
  { id: "AVGO", name: "Broadcom" },
  { id: "ORCL", name: "Oracle" },
  { id: "ADBE", name: "Adobe" },
  { id: "CRM", name: "Salesforce" },
  { id: "CSCO", name: "Cisco" },
  { id: "INTC", name: "Intel" },
  { id: "AMD", name: "Advanced Micro Devices" },
  { id: "IBM", name: "IBM" },
  { id: "QCOM", name: "Qualcomm" },
  { id: "JPM", name: "JPMorgan Chase" },
  { id: "BAC", name: "Bank of America" },
  { id: "WFC", name: "Wells Fargo" },
  { id: "GS", name: "Goldman Sachs" },
  { id: "MS", name: "Morgan Stanley" },
  { id: "V", name: "Visa" },
  { id: "MA", name: "Mastercard" },
  { id: "AXP", name: "American Express" },
  { id: "BLK", name: "BlackRock" },
  { id: "UNH", name: "UnitedHealth Group" },
  { id: "JNJ", name: "Johnson & Johnson" },
  { id: "LLY", name: "Eli Lilly" },
  { id: "PFE", name: "Pfizer" },
  { id: "ABBV", name: "AbbVie" },
  { id: "MRK", name: "Merck" },
  { id: "TMO", name: "Thermo Fisher Scientific" },
  { id: "ABT", name: "Abbott Laboratories" },
  { id: "PG", name: "Procter & Gamble" },
  { id: "KO", name: "Coca-Cola" },
  { id: "PEP", name: "PepsiCo" },
  { id: "WMT", name: "Walmart" },
  { id: "HD", name: "Home Depot" },
  { id: "MCD", name: "McDonald's" },
  { id: "NKE", name: "Nike" },
  { id: "DIS", name: "Walt Disney" },
  { id: "COST", name: "Costco Wholesale" },
  { id: "XOM", name: "ExxonMobil" },
  { id: "CVX", name: "Chevron" },
  { id: "CAT", name: "Caterpillar" },
  { id: "BA", name: "Boeing" },
  { id: "GE", name: "General Electric" },
  { id: "HON", name: "Honeywell" },
  { id: "NFLX", name: "Netflix" },
  { id: "CMCSA", name: "Comcast" },
  { id: "T", name: "AT&T" },
  { id: "VZ", name: "Verizon" },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fraction change over the last `days` sessions — same shape as crypto Discover's `moveOver`. */
function moveOver(history: { close: number }[], days: number): number | null {
  if (history.length < days + 1) return null;
  const from = history[history.length - 1 - days]?.close;
  const to = history[history.length - 1]?.close;
  if (from == null || !(from > 0) || to == null) return null;
  return to / from - 1;
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

async function main(): Promise<void> {
  if (!TWELVE_DATA_KEY) {
    // ⚠️ REFUSE TO RUN RATHER THAN FAIL 52 TIMES IN A CONFUSING WAY. Price history is the
    // load-bearing fetch for a share (same rule as the browser's loadWatchlist), so with no key
    // there is nothing to do at all. One clear line beats fifty identical ProviderErrors.
    console.log(
      "No TWELVE_DATA_KEY set — add it as a GitHub Actions repository secret " +
        "(Settings -> Secrets and variables -> Actions) with a free key from twelvedata.com. " +
        "Nothing was fetched.",
    );
    process.exit(1);
  }
  if (!FINNHUB_KEY) {
    console.log(
      "No FINNHUB_KEY set — analyst and business data will be skipped for every share tonight " +
        "(prices and trend still work). Add a free key from finnhub.io as a repository secret to fill it in.",
    );
  }

  console.log("Discover scan (shares):");
  const results: Omit<DiscoverEntry, "deltaComposite" | "isNew">[] = [];

  for (let i = 0; i < SHARE_UNIVERSE.length; i++) {
    const c = SHARE_UNIVERSE[i] as { id: string; name: string };
    try {
      const { history, currency } = await fetchEquityHistory(c.id, TWELVE_DATA_KEY);
      const lastCandle = history[history.length - 1];
      if (!lastCandle) throw new Error("Empty price history.");

      let consensus: AnalystConsensus | null = null;
      let fundamentals: Fundamentals | null = null;
      if (FINNHUB_KEY) {
        consensus = await fetchConsensus(c.id, FINNHUB_KEY);
        fundamentals = await fetchFundamentals(c.id, FINNHUB_KEY);
      }

      const snap: AssetSnapshot = {
        id: c.id,
        symbol: c.id,
        name: c.name,
        kind: "equity",
        currency,
        price: lastCandle.close,
        history,
        consensus,
        fundamentals,
        sources: ["Twelve Data (price history)"],
      };
      if (consensus) snap.sources?.push("Finnhub (analyst recommendations)");
      if (fundamentals) snap.sources?.push("Finnhub (company financials)");

      const rating = rateAsset(snap);
      results.push({
        id: c.id,
        symbol: c.id,
        name: c.name,
        price: snap.price,
        currency: snap.currency,
        move1: moveOver(snap.history, 1),
        move30: moveOver(snap.history, 30),
        rating,
      });
      console.log(`  ${c.id} -> ok, ${rating.stars} stars, composite ${Math.round(rating.composite)}`);
    } catch (err) {
      // ⚠️ ONE BAD TICKER MUST NOT SINK THE WHOLE SCAN — same reasoning as crypto Discover. A single
      // delisted symbol or a momentary Twelve Data hiccup is logged and skipped, not fatal to the
      // other 51.
      if (isRateLimitError(err)) {
        console.log(`  ${c.id} -> rate limited, skipping tonight (the ${REQUEST_GAP_MS}ms gap should prevent this in practice)`);
      } else {
        console.log(`  ${c.id} -> FAILED: ${String(err).slice(0, 150)}`);
      }
    }
    if (i < SHARE_UNIVERSE.length - 1) await sleep(REQUEST_GAP_MS);
  }

  const minSuccessful = Math.ceil(SHARE_UNIVERSE.length * MIN_SUCCESSFUL_FRACTION);
  if (results.length < minSuccessful) {
    console.log(`\nOnly ${results.length} of ${SHARE_UNIVERSE.length} shares scored successfully — refusing to publish a thin scan.`);
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
    console.log(`\nWrote ${OUT} (${entries.length} shares)`);
  }
}

try {
  await main();
} catch (err) {
  console.log(`\nDiscover scan (shares) failed: ${String(err).slice(0, 300)}`);
  process.exit(1);
}
