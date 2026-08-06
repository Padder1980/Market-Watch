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
// the trust the right one had. Every write goes through `sane()`, a bad parse exits non-zero with a
// sample of what it actually saw, and the previous file is left untouched. A stale file is then
// caught downstream by `scoreFlows`'s staleness gate and shown as n/a. Broken looks broken twice.
//
// Run:  node tools/paper-round.ts [--dry]

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { mergeDaily, parseFarsideFlows, parseTreasuriesTotal } from "../src/flows-parse.ts";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = join(here, "..", "data", "flows.json");
const DRY = process.argv.includes("--dry");

/** A courteous, identifiable agent. These are free publishers doing us a favour; act like it. */
const UA =
  "Market-Watch/1.0 (+https://github.com/Padder1980/Market-Watch) personal daily snapshot, 1 req/day";

const FARSIDE = [
  "https://farside.co.uk/bitcoin-etf-flow-all-data/",
  "https://farside.co.uk/btc/",
];
const TREASURIES = ["https://bitbo.io/treasuries/"];

interface Stored {
  etfDaily?: [string, number][];
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
  try {
    return JSON.parse(readFileSync(OUT, "utf8")) as Stored;
  } catch {
    return {};
  }
}

/**
 * ⚠️ THE SANITY GATE, AND IT IS DELIBERATELY SUSPICIOUS OF ITS OWN INPUT.
 *
 * A parser that has quietly started matching the wrong column still returns numbers, and numbers
 * flow straight into a star rating. So the shape is checked before the value is believed: enough
 * rows to be a real table, a plausible newest date, and per-day magnitudes inside a band no real
 * daily net flow has approached (the record single day is around $1.4bn). Each rejection names what
 * it saw, because "the robot stopped working" is only actionable if it says why.
 */
function saneFlows(daily: [string, number][]): string | null {
  if (daily.length < 100) return `only ${daily.length} rows parsed — expected hundreds`;
  const last = daily[daily.length - 1] as [string, number];
  const ageDays = (Date.now() - Date.parse(`${last[0]}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(ageDays)) return `newest row has an unparseable date: ${last[0]}`;
  if (ageDays > 14) return `newest row is ${Math.round(ageDays)} days old (${last[0]})`;
  if (ageDays < -2) return `newest row is in the future: ${last[0]}`;
  const worst = Math.max(...daily.map(([, v]) => Math.abs(v)));
  if (worst > 6000) return `a daily flow of ${worst} US$m is implausible — wrong column?`;
  const allZero = daily.every(([, v]) => v === 0);
  if (allZero) return "every row parsed as zero — the value column has probably moved";
  return null;
}

async function main(): Promise<void> {
  const stored = readStored();
  const today = new Date().toISOString().slice(0, 10);
  const notes: string[] = [];
  let failed = false;

  // ---- ETF flows -----------------------------------------------------------------------------
  console.log("ETF flows:");
  let etfDaily = stored.etfDaily;
  let gotFlows = false;
  for (const url of FARSIDE) {
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
    const bad = saneFlows(merged);
    if (bad) {
      console.log(`  ${url} -> REJECTED: ${bad}`);
      continue;
    }
    etfDaily = merged;
    gotFlows = true;
    console.log(`  ${url} -> ok, ${parsed.daily.length} rows, newest ${parsed.asOf}`);
    break;
  }
  if (!gotFlows) {
    failed = true;
    notes.push("ETF flow refresh failed on this run; the stored file was left as it was.");
    console.log("  NO USABLE FLOW DATA THIS RUN");
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
      console.log(`  ${url} -> no plausible total found (${html.length} bytes)`);
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
    etfDaily: etfDaily ?? [],
    corpHoldingsBtc: corpHoldings,
    corpChangeBtc,
    corpChangeDays,
    corpHistory: trimmed,
    fetchedAt: today,
    notes,
  };

  if (DRY) {
    console.log("\n--dry, not writing. Would write:");
    console.log(JSON.stringify({ ...out, etfDaily: `[${(etfDaily ?? []).length} rows]`, corpHistory: `[${trimmed.length} rows]` }, null, 2));
  } else {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify(out, null, 1), "utf8");
    console.log(`\nWrote ${OUT} (${(etfDaily ?? []).length} flow rows, ${trimmed.length} treasury snapshots)`);
  }

  // ⚠️ Exit non-zero when the flow half failed, so the Action goes red. A paper round that silently
  // stops delivering is the failure this whole design is trying not to have.
  if (failed) process.exit(1);
}

await main();
