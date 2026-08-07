// What the paper round's bytes mean. Pure functions, no fetch — the GitHub Action does the
// fetching, this file decides what came back, so the half that can be wrong is unit-testable
// offline against fixture HTML.
//
// ⚠️ A SCRAPER'S FAILURE MODE IS SILENCE, AND SILENCE MUST BECOME ABSENCE, NEVER A WRONG NUMBER.
// When a site changes its layout these parsers return null / empty rather than a guess; the script
// then refuses to commit, the JSON goes stale, and `scoreFlows`'s staleness gate turns the pillar
// to n/a. Broken looks broken at every step. Do not "improve" a parser by making it more forgiving
// about what counts as a match — a wrong total that sails the sanity checks is the one failure this
// design cannot catch.

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/** Strip tags and collapse the entities that actually occur in these tables. */
function cellText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8211;|&ndash;|&#8722;|&minus;/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** "11 Jan 2024" → "2024-01-11"; null for anything that is not a date. */
export function parseTableDate(text: string): string | null {
  const m = /^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const mon = MONTHS[(m[2] as string).slice(0, 3).toLowerCase()];
  if (!mon) return null;
  return `${m[3]}-${mon}-${(m[1] as string).padStart(2, "0")}`;
}

/**
 * "(21.5)" → -21.5 (accounting negatives), "1,234.5" → 1234.5, "-" alone → 0 (Farside's zero-flow
 * mark), anything else non-numeric → null.
 */
export function parseFlowNumber(text: string): number | null {
  const t = text.trim();
  if (t === "" ) return null;
  if (t === "-" || t === "–" || t === "—") return 0;
  const paren = /^\((.+)\)$/.exec(t);
  const body = (paren ? "-" + (paren[1] as string) : t).replace(/,/g, "");
  const n = Number(body);
  return Number.isFinite(n) ? n : null;
}

export interface EtfFlowTable {
  /** ISO date of the newest row. */
  asOf: string;
  /** [isoDate, totalNetFlowUsdM] ascending by date, deduped. */
  daily: [string, number][];
}

/**
 * Farside's Bitcoin ETF flow table: one row per trading day, first cell the date, last cell the
 * total across every fund in US$ millions.
 *
 * ⚠️ ONLY ROWS WHOSE FIRST CELL IS A DATE COUNT. The table ends with Total / Average / Maximum /
 * Minimum summary rows whose last cell is also a number — sum a summary row into the series and the
 * history gains a day worth two and a half years of flows. The date test is the filter, not the
 * row's position.
 */
export function parseFarsideFlows(html: string): EtfFlowTable | null {
  const byDate = new Map<string, number>();
  const rows = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) ?? [];
  for (const row of rows) {
    const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/gi) ?? []).map(cellText);
    if (cells.length < 2) continue;
    const iso = parseTableDate(cells[0] as string);
    if (!iso) continue;
    const total = parseFlowNumber(cells[cells.length - 1] as string);
    if (total == null) continue;
    byDate.set(iso, total);
  }
  if (byDate.size === 0) return null;
  const daily = [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return { asOf: (daily[daily.length - 1] as [string, number])[0], daily };
}

/**
 * A labelled public-company Bitcoin total from a treasuries page.
 *
 * ⚠️ DELIBERATELY STRICT, AND ALLOWED TO FAIL. It wants a number with thousands separators sitting
 * within a few words of "BTC" near treasury language, inside a sanity band (600k–3,000k BTC — the
 * real figure is ~1,260k in mid-2026). A page redesign should produce null and a logged sample, not
 * a creative match: the corporate component simply stays absent until the parser is updated against
 * the observed page. Loosening this to "first big number on the page" is how a market-cap figure
 * becomes a holdings figure with nobody noticing.
 */
export function parseTreasuriesTotal(html: string): number | null {
  const text = cellText(html);
  const candidates: number[] = [];
  const re = /([\d]{1,3}(?:,\d{3})+(?:\.\d+)?)\s*(?:BTC|₿)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = Number((m[1] as string).replace(/,/g, ""));
    if (Number.isFinite(n) && n >= 600_000 && n <= 3_000_000) candidates.push(n);
  }
  if (candidates.length === 0) return null;
  // The grand total is the largest figure in band — every per-company holding sits far below it.
  return Math.max(...candidates);
}

/**
 * Merge freshly scraped daily flows into the stored history, newest scrape winning on conflicts.
 * This is what lets the short recent-days table keep the history growing if the all-data page is
 * ever unreachable — the robot never throws away what earlier rounds collected.
 */
export function mergeDaily(
  stored: [string, number][] | undefined,
  fresh: [string, number][],
): [string, number][] {
  const byDate = new Map<string, number>(stored ?? []);
  for (const [d, v] of fresh) byDate.set(d, v);
  return [...byDate.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

/** Below this many rows, a parse is not "a small real table" — it is a broken one. */
const MIN_PLAUSIBLE_ROWS = 5;
/** No real single-day US spot Bitcoin ETF net flow has approached this. Wrong column, not real. */
const MAX_PLAUSIBLE_DAILY_USDM = 6000;
const MAX_STALE_DAYS = 14;

/**
 * ⚠️ THE SANITY GATE, AND IT IS DELIBERATELY SUSPICIOUS OF ITS OWN INPUT.
 *
 * A parser that has quietly started matching the wrong column still returns numbers, and numbers
 * flow straight into a star rating. So the shape is checked before the value is believed: a real
 * table (not a near-empty one), a plausible newest date, and per-day magnitudes inside a band no
 * real daily net flow has approached. Each rejection names what it saw, because "the robot stopped
 * working" is only actionable if it says why.
 *
 * ⚠️ THE FIRST VERSION OF THIS GATE DEMANDED ≥100 ROWS, AND IT COULD NEVER BE SATISFIED. That
 * number assumed the "all data" page — which genuinely returns hundreds of rows — would always be
 * reachable. On 2026-08-06/07 it started returning HTTP 403 (bot-blocking, not a parser fault), so
 * every run fell back to the short "current" table, which legitimately has a few dozen rows. Since
 * the gate runs on the MERGED total and a rejection never lets the merge take effect, day one's 14
 * rows were rejected, day two started from zero stored history and got the same 14 rows and the
 * same rejection — forever. The design already accounts for exactly this ("this is what lets the
 * short recent-days table keep the history growing if the all-data page is ever unreachable" —
 * `mergeDaily`'s own comment) but the gate silently defeated it. `MIN_PLAUSIBLE_ROWS` checks that a
 * real table was parsed at all, not that decades of history arrived in one request; the daily/
 * weekly rolling windows in `scoreFlows` gate on having ENOUGH accumulated history separately.
 */
export function checkFlowSanity(daily: [string, number][]): string | null {
  if (daily.length < MIN_PLAUSIBLE_ROWS) {
    return `only ${daily.length} row${daily.length === 1 ? "" : "s"} parsed — too few to be a real table`;
  }
  const last = daily[daily.length - 1] as [string, number];
  const ageDays = (Date.now() - Date.parse(`${last[0]}T00:00:00Z`)) / 86_400_000;
  if (!Number.isFinite(ageDays)) return `newest row has an unparseable date: ${last[0]}`;
  if (ageDays > MAX_STALE_DAYS) return `newest row is ${Math.round(ageDays)} days old (${last[0]})`;
  if (ageDays < -2) return `newest row is in the future: ${last[0]}`;
  const worst = Math.max(...daily.map(([, v]) => Math.abs(v)));
  if (worst > MAX_PLAUSIBLE_DAILY_USDM) {
    return `a daily flow of ${worst} US$m is implausible — wrong column?`;
  }
  const allZero = daily.every(([, v]) => v === 0);
  if (allZero) return "every row parsed as zero — the value column has probably moved";
  return null;
}

/**
 * The shape `data/flows.json` is committed in. `assets` is keyed by CoinGecko id so more than one
 * coin's ETF flows can live in one file — added 2026-08-08 when Ethereum joined Bitcoin. Corporate
 * treasury holdings stay a single top-level field: it is a Bitcoin-only signal (the phenomenon of
 * public companies holding a coin on the balance sheet barely exists yet for anything else), not a
 * per-asset one.
 */
export interface FlowsFile {
  assets?: Record<string, {
    etfDaily?: [string, number][] | null;
    etfAsOf?: string | null;
  }>;
  corpHoldingsBtc?: number | null;
  corpChangeBtc?: number | null;
  corpChangeDays?: number | null;
  fetchedAt?: string | null;
}

/**
 * Turn the committed file into one asset's `FlowStats`, or null if that asset has none.
 *
 * ⚠️ ONE FUNCTION, TWO CALLERS, BOTH READING BYTES THEY GOT DIFFERENTLY. The browser calls this
 * after `fetch("./data/flows.json")`; the nightly Discover scan (`tools/discover-round.ts`) calls
 * it after `readFileSync` on the same committed file from its own checkout — no HTTP round trip
 * needed when the file is already sitting on the same disk. Parsing "what does this JSON mean for
 * asset X" is shape logic, not network logic, so it lives here once rather than being written twice
 * and drifting the way the two would inevitably drift if kept separate.
 *
 * Corporate holdings are attached ONLY for `"bitcoin"` — the same restriction the data actually
 * has, not an arbitrary one added here.
 */
export function flowStatsFor(raw: FlowsFile, id: string): {
  etfDailyUsdM?: number[] | null;
  etfAsOf?: string | null;
  corpHoldingsBtc?: number | null;
  corpChangeBtc?: number | null;
  corpChangeDays?: number | null;
  fetchedAt?: string | null;
} | null {
  const asset = raw.assets?.[id];
  const rows = Array.isArray(asset?.etfDaily) ? asset.etfDaily : [];
  const clean = rows
    .filter((r) => Array.isArray(r) && typeof r[0] === "string" && Number.isFinite(r[1]))
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const last = clean[clean.length - 1];

  const isBitcoin = id === "bitcoin";
  if (clean.length === 0 && !isBitcoin) return null;

  return {
    etfDailyUsdM: clean.length > 0 ? clean.map((r) => r[1]) : null,
    etfAsOf: last ? last[0] : (asset?.etfAsOf ?? null),
    corpHoldingsBtc: isBitcoin ? (raw.corpHoldingsBtc ?? null) : null,
    corpChangeBtc: isBitcoin ? (raw.corpChangeBtc ?? null) : null,
    corpChangeDays: isBitcoin ? (raw.corpChangeDays ?? null) : null,
    fetchedAt: raw.fetchedAt ?? null,
  };
}

/**
 * Diagnostic only — never feeds a score. When `parseTreasuriesTotal` finds nothing in band, this
 * shows what number-like text the page DOES contain near "BTC"/"₿" so a failed run's log explains
 * itself instead of just reporting a byte count. Unbounded by the 600k–3,000k band on purpose: the
 * question this answers is "is the real figure there in a different shape, or not there at all?"
 */
export function treasuriesDebugSample(html: string, max = 8): string[] {
  const text = cellText(html);
  const re = /([\d]{1,3}(?:,\d{3})+(?:\.\d+)?)\s*(?:BTC|₿)/gi;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null && out.length < max) {
    out.push((m[1] as string) + " BTC");
  }
  return out;
}
