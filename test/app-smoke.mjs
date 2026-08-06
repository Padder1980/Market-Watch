// Browser smoke test for the BUILT page (index.html).
//
// ⚠️ THIS RUNS AGAINST THE BUILD OUTPUT, NOT THE SOURCE. The engine has unit tests; what this
// checks is the wiring that unit tests structurally cannot see — that the bundle actually inlined,
// that `MK` exists on the page, that a rating reaches the DOM, and that an unavailable pillar
// renders as "n/a" rather than as an empty bar (which would read as a score of zero and undo the
// engine's whole null-handling contract at the last possible moment).
//
// `fetch` is stubbed, so this needs no network and no API key. Run:  node test/app-smoke.mjs

import { chromium } from "/opt/node22/lib/node_modules/playwright/index.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const page_url = "file://" + join(here, "..", "index.html");

let failures = 0;
function check(name, ok, detail = "") {
  if (ok) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`);
  }
}

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage();
page.on("pageerror", (err) => {
  failures++;
  console.log(`  FAIL page threw: ${err.message}`);
});

// A synthetic year of daily prices: a steady riser, so the trend pillar has something to say.
await page.addInitScript(() => {
  const prices = [];
  let v = 20000;
  const start = Date.now() - 364 * 86400000;
  for (let i = 0; i < 365; i++) {
    v *= 1 + 0.0015 + 0.004 * Math.sin(i / 9);
    prices.push([start + i * 86400000, v]);
  }
  window.fetch = async (url) => {
    if (String(url).includes("coingecko")) {
      return { ok: true, status: 200, json: async () => ({ prices }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  // Deterministic starting point: default watchlist, no keys, no cache.
  localStorage.clear();
});

await page.goto(page_url);
await page.waitForSelector(".card", { timeout: 15000 });

check("the engine bundle inlined and exposed MK", await page.evaluate(() => typeof window.MK === "object" && typeof window.MK.rateAsset === "function"));

const cards = await page.locator(".card").count();
check("both default watchlist rows rendered", cards === 2, `got ${cards}`);

const stars = await page.locator(".card").first().locator(".stars").count();
check("a star rating is drawn", stars === 1);

// The critical one: crypto has no analyst or fundamentals data, and those bars must say so.
const naLabels = await page.locator(".card").first().locator(".bar.na .num").allTextContents();
check(
  "unavailable pillars render as n/a, never as an empty bar",
  naLabels.length === 2 && naLabels.every((t) => t.trim() === "n/a"),
  JSON.stringify(naLabels),
);

const trendBar = await page.locator(".card").first().locator(".bar:not(.na) .num").first().textContent();
check("the trend pillar shows a real number", /^\d+$/.test((trendBar || "").trim()), trendBar ?? "");

// ⚠️ MEASURE THE RENDERED FILL, NOT THE STYLE ATTRIBUTE. The first version of this file checked the
// number only, and shipped a build where every bar rendered EMPTY: `.fill` sits inside a grid item
// rather than being one, so it stayed `display: inline` and both its width and height were ignored.
// The markup was correct, the inline style said `width: 82%`, and the bar was invisible. Only a
// screenshot showed it. So this asserts actual pixels.
const fillGeom = await page.locator(".card").first().locator(".bar:not(.na) .fill").first().evaluate((el) => {
  const r = el.getBoundingClientRect();
  const track = el.parentElement.getBoundingClientRect();
  return { w: r.width, h: r.height, trackW: track.width };
});
check(
  "the pillar bar is actually filled on screen",
  fillGeom.w > 1 && fillGeom.h > 1 && fillGeom.w < fillGeom.trackW + 1,
  JSON.stringify(fillGeom),
);

// "Show the working" must contain the traceable reasons, not just a number.
await page.locator(".card").first().locator(".more summary").click();
const working = await page.locator(".card").first().locator(".working").innerText();
check("the working names the risk band evidence", /volatility/i.test(working));
check("the working explains the composite", /Composite score \d+\/100/.test(working));
check("the working states what was missing", /without .*(analyst|fundamentals)/i.test(working));

// Sorting must re-render without throwing.
await page.locator('.chip[data-sort="trend"]').click();
check("sorting by trend keeps the list rendered", (await page.locator(".card").count()) === 2);
check("the chip reflects the active sort", (await page.locator('.chip[data-sort="trend"]').getAttribute("aria-pressed")) === "true");

// Settings sheet.
await page.locator("#setBtn").click();
check("the settings sheet opens", await page.locator("#setOv.on").isVisible());
const wlRows = await page.locator("#wl .wl-row").count();
check("the watchlist editor lists the current items", wlRows === 2, `got ${wlRows}`);

await page.locator("#addId").fill("solana");
await page.locator("#addKind").selectOption("crypto");
await page.locator("#addBtn").click();
check("adding to the watchlist works", (await page.locator("#wl .wl-row").count()) === 3);

await page.locator("#addId").fill("SOLANA");
await page.locator("#addBtn").click();
check(
  "a case-different duplicate is not added twice",
  (await page.locator("#wl .wl-row").count()) === 3,
);

// Dark mode must not leave unreadable text.
await page.emulateMedia({ colorScheme: "dark" });
const inkOnSurface = await page.evaluate(() => {
  const s = getComputedStyle(document.documentElement);
  return { ink: s.getPropertyValue("--ink").trim(), bg: s.getPropertyValue("--bg").trim() };
});
check("dark theme resolves its tokens", inkOnSurface.ink !== "" && inkOnSurface.bg !== "", JSON.stringify(inkOnSurface));

await browser.close();
console.log(failures === 0 ? "\nall smoke checks passed" : `\n${failures} smoke check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
