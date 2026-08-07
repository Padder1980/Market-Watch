// The paper round. Runs on GitHub's servers once a day, NOT in the browser.
//
// ⚠️ WHY THIS EXISTS AT ALL. Farside publishes the daily US spot Bitcoin ETF flow table, and the
// treasuries pages publish public-company holdings — both free, both readable by anyone with a
// browser. Neither sends an `Access-Control-Allow-Origin` header, so the APP cannot read them: the
// CORS rule blocks it. But that rule only exists INSIDE browsers. A script on a server reads them
// perfectly well, so this one does, once a day, and commits the numbers to `data/flows.json`. The
// page then reads its own file from its own origin, where no permission is required.
//
// The app therefore still scrapes nothing, holds no key, and needs no server.
//
// ⚠️ IT MUST REFUSE TO WRITE RATHER THAN WRITE A GUESS. A scraper's failure mode is a site quietly
// changing its layout, and the danger is not an error — it is a plausible wrong number inheriting
// the trust the right one had. Every write goes through `checkFlowSanity()`, a bad parse exits
// non-zero with a sample of what it actually saw, and the previous file is left untouched. A stale
// file is then caught downstream by `scoreFlows`'s staleness gate and shown as n/a. Broken looks
// broken twice.
//
// ⚠️ FARSIDE'S "ALL DATA" PAGE RETURNED HTTP 403 ON ITS FIRST REAL RUN (2026-08-07), and it looks
// like bot-blocking rather than a parser fault — the shorter "current" page on the same domain
// answered normally. The deliberate response is NOT to spoof a browser identity to get past it: the
// courteous, identifiable User-Agent below is a design choice (see CLAUDE.md), and evading a site's
// own blocking after it has said no is the opposite of that. Instead the design already has a
// fallback for exactly this — `mergeDaily` — so the short page's rows accumulate into real history
// over days even with the long page permanently unreachable. Slower, but honest.
//
// Run:  node tools/paper-round.ts [--dry]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkFlowSanity,
  mergeDaily,
  parseFarsideFlows,
  parseTreasuriesTotal,
  treasuriesDebugSample,
} from "../src/flows-parse.ts";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "data", "flows.json");
const DRY = process.argv.includes("--dry");

/** A courteous, identifiable agent. These are free publishers doing us a favour; act like it. */
const UA =
  "Market-Watch/1.0 (+https://github.com/Padder1980/Market-Watch) personal daily snapshot, 1 req/day";

/**
 * One entry per coin with a real US spot ETF, each with its own pair of Farside pages (the "all
 * data" one, then the short "current" one as the fallback `mergeDaily` was built for). Adding a
 * coin here is the WHOLE change needed when its own ETF launches — everything else generalises.
 */
const ETF_ASSETS: { id: string; label: string; urls: string[] }[] = [
  {
    id: "bitcoin",
    label: "Bitcoin",
    urls: ["https://farside.co.uk/bitcoin-etf-flow-all-data/", "https://farside.co.uk/btc/"],
  },
  {
    id: "ethereum",
    label: "Ethereum",
    urls: ["https://farside.co.uk/ethereum-etf-flow-all-data/", "https://farside.co.uk/eth/"],
  },
];
const TREASURIES = ["https://bitbo.io/treasuries/"];

interface StoredAsset {
  etfDaily?: [string, number][];
  etfAsOf?: string | null;
}

/**
 * ⚠️ `assets` IS KEYED BY COINGECKO ID, NOT A FLAT BITCOIN-SHAPED OBJECT. The original file (before
 * 2026-08-08) assumed one coin; Ethereum's real ETF page meant it needed to hold more than one
 * asset's flow history side by side. `flowStatsFor` (`src/flows-parse.ts`) is the one place that
 * reads this shape back out, for both the browser and the nightly Discover scan.
 */
interface Stored {
  assets?: Record<string, StoredAsset>;
  corpHoldingsBtc?: number | null;
  corpChangeBtc?: number | null;
  corpChangeDays?: number | null;
  /** Rolling log of holdings snapshots, so a CHANGE can be computed without a second source. */
  corpHistory?: [string, number][];
  fetchedAt?: string | null;
  notes?: string[];
}

async function getText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" } });
    if (!res.ok) {
      console.log(`  ${url} -> HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.log(`  ${url} -> ${String(err).slice(0, 120)}`);
    return null;
  }
}

function readStored(): Stored {
  let parsed: (Stored & { etfDaily?: [string, number][] }) | Record<string, never>;
  try {
    parsed = JSON.parse(readFileSync(OUT, "utf8"));
  } catch {
    return {};
  }
  // ⚠️ ONE-TIME MIGRATION FROM THE PRE-2026-08-08 FLAT SHAPE. The very first real committed file
  // (2026-08-07, 15 genuine Bitcoin flow rows) predates the multi-asset `assets` shape and has
  // `etfDaily` at the top level instead. Without this, that file's `assets` reads as undefined, the
  // Bitcoin loop starts from zero stored history, and the first 15 real days this whole design
  // exists to accumulate are silently thrown away on the very next run — the accumulation-deadlock
  // bug's sibling, caused by a schema change instead of a sanity gate this time.
  if (!parsed.assets && Array.isArray(parsed.etfDaily) && parsed.etfDaily.length > 0) {
    const sorted = [...parsed.etfDaily].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    return {
      ...parsed,
      assets: { bitcoin: { etfDaily: sorted, etfAsOf: sorted[sorted.length - 1]?.[0] ?? null } },
    };
  }
  return parsed as Stored;
}

async function main(): Promise<void> {
  const stored = readStored();
  const today = new Date().toISOString().slice(0, 10);
  const notes: string[] = [];
  let failed = false;

  // ---- ETF flows, one coin at a time ----------------------------------------------------------
  const assets: Record<string, StoredAsset> = { ...(stored.assets ?? {}) };
  for (const asset of ETF_ASSETS) {
    console.log(`ETF flows (${asset.label}):`);
    let etfDaily = assets[asset.id]?.etfDaily;
    let gotFlows = false;
    for (const url of asset.urls) {
      const html = await getText(url);
      if (!html) continue;
      const parsed = parseFarsideFlows(html);
      if (!parsed) {
        console.log(`  ${url} -> table not recognised (${html.length} bytes)`);
        continue;
      }
      // ⚠️ Merge, never replace. The short table carries only recent days; replacing with it would
      // throw away the history the rolling windows self-calibrate against, and the pillar would go
      // quiet for weeks with nothing in the logs to explain it.
      const merged = mergeDaily(etfDaily, parsed.daily);
      const bad = checkFlowSanity(merged);
      if (bad) {
        console.log(`  ${url} -> REJECTED: ${bad}`);
        continue;
      }
      etfDaily = merged;
      gotFlows = true;
      console.log(`  ${url} -> ok, ${parsed.daily.length} rows, newest ${parsed.asOf}`);
      break;
    }
    if (gotFlows && etfDaily) {
      assets[asset.id] = { etfDaily, etfAsOf: etfDaily[etfDaily.length - 1]?.[0] ?? null };
    } else {
      failed = true;
      notes.push(`${asset.label} ETF flow refresh failed on this run; its stored data was left as it was.`);
      console.log(`  NO USABLE ${asset.label.toUpperCase()} FLOW DATA THIS RUN`);
    }
  }

  // ---- Corporate holdings --------------------------------------------------------------------
  console.log("Corporate treasuries:");
  const corpHistory: [string, number][] = [...(stored.corpHistory ?? [])];
  let corpHoldings = stored.corpHoldingsBtc ?? null;
  for (const url of TREASURIES) {
    const html = await getText(url);
    if (!html) continue;
    const total = parseTreasuriesTotal(html);
    if (total == null) {
      // ⚠️ NAME WHAT IT SAW, NOT JUST THAT IT FAILED. A byte count alone (measured: 462,806 on
      // 2026-08-07) says the page loaded but tells nobody what to fix. This logs whatever the page
      // DOES have near "BTC"/"₿" — in band or not — so a real failure explains itself in the log
      // instead of needing another blind guess-and-redeploy round.
      const sample = treasuriesDebugSample(html);
      console.log(`  ${url} -> no plausible total found (${html.length} bytes)`);
      console.log(
        sample.length > 0
          ? `    nearby figures seen: ${sample.join(", ")}`
          : `    no "<number> BTC"-shaped text found at all — the total may be rendered by ` +
              `client-side JS, which a server-side fetch never runs`,
      );
      continue;
    }
    corpHoldings = total;
    if (!corpHistory.some(([d]) => d === today)) corpHistory.push([today, total]);
    console.log(`  ${url} -> ok, ${total.toLocaleString("en-GB")} BTC`);
    break;
  }
  if (corpHoldings == null) {
    notes.push("Public-company holdings were not readable on this run.");
    console.log("  NO USABLE TREASURY DATA THIS RUN");
  }

  // ⚠️ THE CHANGE IS DERIVED FROM OUR OWN HISTORY, NOT FROM THE PAGE. Nobody publishes "BTC added
  // this month" in a machine-readable form, and inferring it from a single snapshot is impossible —
  // one reading is a level, not a movement. So the robot logs a level a day and the change appears
  // once there are two readings far enough apart to mean something. It is empty on day one BY
  // DESIGN, and `scoreFlows` says so on screen rather than scoring a number it does not have.
  const trimmed = corpHistory.slice(-400);
  let corpChangeBtc: number | null = null;
  let corpChangeDays: number | null = null;
  const newest = trimmed[trimmed.length - 1];
  if (newest) {
    const target = Date.parse(`${newest[0]}T00:00:00Z`) - 30 * 86_400_000;
    let best: [string, number] | null = null;
    for (const row of trimmed) {
      const t = Date.parse(`${row[0]}T00:00:00Z`);
      if (t <= target) best = row;
    }
    // Fall back to the oldest reading we hold, so the component warms up gradually rather than
    // waiting a full month to say anything at all.
    const baseline = best ?? (trimmed.length > 1 ? (trimmed[0] as [string, number]) : null);
    if (baseline && baseline[0] !== newest[0]) {
      const days = (Date.parse(`${newest[0]}T00:00:00Z`) - Date.parse(`${baseline[0]}T00:00:00Z`)) /
        86_400_000;
      if (days >= 14) {
        corpChangeBtc = newest[1] - baseline[1];
        corpChangeDays = Math.round(days);
      }
    }
  }

  const out: Stored = {
    assets,
    corpHoldingsBtc: corpHoldings,
    corpChangeBtc,
    corpChangeDays,
    corpHistory: trimmed,
    fetchedAt: today,
    notes,
  };

  const rowCounts = Object.entries(assets)
    .map(([id, a]) => `${id}=${a.etfDaily?.length ?? 0}`)
    .join(", ");

  if (DRY) {
    console.log("\n--dry, not writing. Would write:");
    console.log(JSON.stringify(
      { ...out, assets: Object.fromEntries(
        Object.entries(assets).map(([id, a]) => [id, { ...a, etfDaily: `[${a.etfDaily?.length ?? 0} rows]` }]),
      ), corpHistory: `[${trimmed.length} rows]` },
      null,
      2,
    ));
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(out, null, 1), "utf8");
    console.log(`\nWrote ${OUT} (flow rows: ${rowCounts}; ${trimmed.length} treasury snapshots)`);
  }

  // ⚠️ Exit non-zero when the flow half failed, so the Action goes red. A paper round that silently
  // stops delivering is the failure this whole design is trying not to have.
  if (failed) process.exit(1);
}

await main();
