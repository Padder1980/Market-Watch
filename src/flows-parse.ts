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
