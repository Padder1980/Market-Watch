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
  // A growing chain: hash rate, transactions and active addresses all rising across the window, so
  // the Network pillar has something real to score. `windowChange` compares 30-day means at each
  // end, so the series has to be long enough to contain two of them.
  const chart = (from, to) => {
    const values = [];
    for (let i = 0; i < 120; i++) {
      values.push({
        x: Math.round((start + i * 86400000) / 1000),
        y: from + (to - from) * (i / 119),
      });
    }
    return { values };
  };
  // The paper round's output, as the page will find it next to itself. Two hundred days of modest
  // flows then a strong recent week, so the Flows pillar has a real, positive verdict to draw.
  const etfDaily = [];
  for (let i = 0; i < 210; i++) {
    const d = new Date(start + (i + 150) * 86400000).toISOString().slice(0, 10);
    etfDaily.push([d, i < 190 ? 120 * Math.sin(i / 2.5) : 400 + 30 * Math.sin(i)]);
  }
  // ⚠️ Dated TODAY. The staleness gate refuses anything older than a week, so a fixture with a
  // hardcoded past date would test the refusal path while appearing to test the happy one.
  etfDaily[etfDaily.length - 1][0] = new Date().toISOString().slice(0, 10);
  // ⚠️ THE "assets" SHAPE, NOT THE OLD FLAT ONE. data/flows.json moved to keying flows by CoinGecko
  // id (2026-08-08, when Ethereum joined Bitcoin) — a stub still shaped like the pre-migration file
  // reads as "no data for this asset" to flowStatsFor and every flows-pillar check below goes n/a
  // silently rather than failing loudly, which is worse than a wrong assertion.
  const flowsJson = {
    assets: { bitcoin: { etfDaily, etfAsOf: etfDaily[etfDaily.length - 1][0] } },
    corpHoldingsBtc: 1262540,
    corpChangeBtc: 28000,
    corpChangeDays: 30,
    fetchedAt: new Date().toISOString().slice(0, 10),
  };
  // A minimal but shape-correct Discover snapshot: one coin already on the default watchlist
  // (must be filtered OUT) and one that is not (must be shown).
  function fakePillar(score) {
    return { score, confidence: 1, reasons: ["fixture reason"] };
  }
  function fakeRating(id, symbol, name, stars, composite) {
    return {
      id, symbol, name, kind: "crypto", stars, composite,
      trend: fakePillar(composite), analyst: fakePillar(null), fundamentals: fakePillar(null),
      network: fakePillar(null), flows: fakePillar(null),
      risk: { band: "moderate", annualisedVol: 0.3, maxDrawdown: 0.1, worstDay: 0.05, reasons: ["fixture risk reason"] },
      caveats: [], missing: ["on-chain network activity", "institutional flows"],
    };
  }
  const discoverJson = {
    asOf: new Date().toISOString().slice(0, 10),
    entries: [
      {
        id: "bitcoin", symbol: "BTC", name: "Bitcoin", price: 60000, currency: "USD",
        move1: 0.01, move30: 0.1, deltaComposite: 3, isNew: false,
        rating: fakeRating("bitcoin", "BTC", "Bitcoin", 4, 70),
      },
      {
        id: "dogecoin", symbol: "DOGE", name: "Dogecoin", price: 0.2, currency: "USD",
        move1: 0.02, move30: -0.05, deltaComposite: null, isNew: true,
        rating: fakeRating("dogecoin", "DOGE", "Dogecoin", 3, 55),
      },
    ],
  };
  window.fetch = async (url) => {
    const u = String(url);
    if (u.includes("data/discover.json")) {
      return { ok: true, status: 200, json: async () => discoverJson };
    }
    if (u.includes("data/flows.json")) {
      return { ok: true, status: 200, json: async () => flowsJson };
    }
    if (u.includes("coingecko")) {
      return { ok: true, status: 200, json: async () => ({ prices }) };
    }
    if (u.includes("blockchain.info/charts")) {
      // ⚠️ Assert the CORS parameter here, not just the host. Without `&cors=true` the real browser
      // discards the response before the app ever sees it — so dropping it would leave the pillar
      // permanently absent in real use while every stubbed check carried on passing.
      if (!u.includes("cors=true")) return { ok: false, status: 403, json: async () => ({}) };
      if (u.includes("hash-rate")) {
        return { ok: true, status: 200, json: async () => chart(600, 720) };
      }
      if (u.includes("n-transactions")) {
        return { ok: true, status: 200, json: async () => chart(400000, 460000) };
      }
      if (u.includes("n-unique-addresses")) {
        return { ok: true, status: 200, json: async () => chart(800000, 900000) };
      }
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

// ⚠️ WITH BOTH CRYPTO PILLARS FED, THE FIRST CARD SHOULD HAVE NO n/a BARS AT ALL. Crypto used to
// show two empty pillars it could never fill (analyst coverage, company accounts); it now shows the
// two it can (Flows, Network). The SECOND card is Ethereum, which has neither — that is where the
// n/a rendering is still proved, and it must stay proved somewhere or the whole absent-is-not-bad
// contract loses its only visual test.
const naFirst = await page.locator(".card").first().locator(".bar.na").count();
check("a fully-fed crypto row has no empty pillars", naFirst === 0, `got ${naFirst}`);

const naLabels = await page.locator(".card").nth(1).locator(".bar.na .num").allTextContents();
check(
  "unavailable pillars render as n/a, never as an empty bar",
  naLabels.length === 2 && naLabels.every((t) => t.trim() === "n/a"),
  JSON.stringify(naLabels),
);

const barLabels = await page.locator(".card").first().locator(".bar .lbl").allTextContents();
check(
  "crypto is offered Flows and Network, not the two pillars it can never have",
  barLabels.some((t) => /flows/i.test(t)) && barLabels.some((t) => /network/i.test(t)) &&
    !barLabels.some((t) => /business|forecasts/i.test(t)),
  JSON.stringify(barLabels),
);

// End to end: the robot's file reaches a drawn bar. This is the one check that would catch the
// paper round being wired to a path the page never asks for.
const flowGeom = await page.locator(".card").first().locator(".bar").nth(1).evaluate((el) => {
  const num = el.querySelector(".num");
  const fill = el.querySelector(".fill");
  const r = fill ? fill.getBoundingClientRect() : null;
  return { num: num ? num.textContent.trim() : null, w: r ? r.width : 0, h: r ? r.height : 0 };
});
check(
  "the flows pillar scores the snapshot and draws it",
  /^\d+$/.test(flowGeom.num || "") && Number(flowGeom.num) > 50 && flowGeom.w > 1 && flowGeom.h > 1,
  JSON.stringify(flowGeom),
);

// End-to-end proof that the on-chain fetch reaches the screen: the Network bar must carry a real
// number AND real pixels. A pillar wired up but rendering empty is the exact defect this file exists
// for, and it would be invisible in the unit tests, which never touch the DOM.
const netGeom = await page.locator(".card").first().locator(".bar").nth(2).evaluate((el) => {
  const num = el.querySelector(".num");
  const fill = el.querySelector(".fill");
  const r = fill ? fill.getBoundingClientRect() : null;
  return { label: (el.querySelector(".lbl") || {}).textContent, num: num ? num.textContent.trim() : null, w: r ? r.width : 0, h: r ? r.height : 0 };
});
check(
  "the network pillar scores a growing chain and draws it",
  /^\d+$/.test(netGeom.num || "") && Number(netGeom.num) > 50 && netGeom.w > 1 && netGeom.h > 1,
  JSON.stringify(netGeom),
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
// ⚠️ THE "WHAT WAS MISSING" CAVEAT MOVED CARDS, AND THAT IS THE CORRECT OUTCOME. Bitcoin now has
// every applicable pillar fed, so it should carry NO partial-picture caveat — asserting one here
// would force the app to apologise for a complete answer. Ethereum has neither flows nor on-chain
// data, so it is where the caveat belongs and where it is now proved.
check(
  "a fully-fed row does not apologise for a complete picture",
  !/picture is partial/i.test(working),
  working.slice(0, 200),
);
await page.locator(".card").nth(1).locator(".more summary").click();
const workingEth = await page.locator(".card").nth(1).locator(".working").innerText();
check(
  "the working states what was missing",
  /without .*(flows|network)/i.test(workingEth) && /picture is partial/i.test(workingEth),
  workingEth.slice(0, 300),
);
// ⚠️ Read this AFTER the summary click. `innerText` on a collapsed <details> returns an empty
// string, which every one of these regexes would fail against — a real failure and a hidden panel
// are indistinguishable from the assertion's point of view.
check(
  "the network working shows its evidence",
  /hash rate/i.test(working) && /active addresses/i.test(working),
  working.slice(0, 200),
);
check(
  "the flows working names its numbers and its source",
  /spot Bitcoin ETFs/i.test(working) && /Public companies/i.test(working),
  working.slice(0, 300),
);
check(
  "the flows working refuses to sound like a forecast",
  /already moved/i.test(working) && /near tops before/i.test(working),
  working.slice(0, 300),
);
check(
  "the network working refuses to sound like a forecast",
  /not a price forecast/i.test(working),
  working.slice(0, 200),
);

// ---------------------------------------------------------------------------------------------
// The holdings page
// ---------------------------------------------------------------------------------------------

await page.locator("#tabHoldings").click();
check(
  "the holdings tab swaps the view",
  await page.locator("#viewHoldings").isVisible() && !(await page.locator("#viewRatings").isVisible()),
);
check(
  "an empty book invites the first entry rather than showing a broken total",
  /Nothing recorded yet/i.test(await page.locator("#holdings").innerText()),
);

// Enter a real purchase through the actual form — the point of a browser test is to prove the
// wiring, and a localStorage seed would bypass every control being checked here.
await page.locator("#addTxBtn").click();
await page.locator("#txQty").fill("0.5");
await page.locator("#txPrice").fill("30000");
check(
  "the sheet totals the spend as you type",
  /Total spent/i.test(await page.locator("#txSpend").innerText()),
  await page.locator("#txSpend").innerText(),
);
await page.locator("#txSave").click();

const held = await page.locator("#holdings").innerText();
// The stubbed price series ends around 34,000, so half a coin bought at 30,000 must show a gain.
check("the holding is priced at today's number", /Worth now/i.test(held), held.slice(0, 120));
check(
  "a gain is shown against what was paid",
  /against what you paid/i.test(held) && /\+/.test(held),
  held.slice(0, 260),
);
const gainClass = await page.locator("#holdings .hsum div.up, #holdings .hsum div.down").count();
check("the gain is coloured, not just signed", gainClass > 0);

// ⚠️ A holding must survive a reload. This is the whole promise of the page — it is a record, and a
// record that evaporates when the tab is closed is worse than no record at all.
await page.reload();
await page.waitForSelector(".card", { timeout: 15000 });
await page.locator("#tabHoldings").click();
check(
  "holdings persist across a reload",
  /Worth now/i.test(await page.locator("#holdings").innerText()),
);

await page.locator("#tabRatings").click();

// ---------------------------------------------------------------------------------------------
// Discover
// ---------------------------------------------------------------------------------------------

await page.locator("#tabDiscover").click();
check(
  "the discover tab swaps the view",
  await page.locator("#viewDiscover").isVisible() && !(await page.locator("#viewRatings").isVisible()),
);

const discoverNotice = await page.locator("#viewDiscover .notice").innerText();
check(
  "discover states plainly that it is not a buy list",
  /not a list of what to buy/i.test(discoverNotice),
  discoverNotice.slice(0, 200),
);

const discoverCards = await page.locator("#discover .card").count();
check(
  "a coin already on the watchlist is excluded from Discover",
  discoverCards === 1,
  `got ${discoverCards} cards — Bitcoin (on the watchlist) must not reappear here`,
);

const discoverText = await page.locator("#discover").innerText();
check(
  "the surfaced coin shows, and the excluded one does not",
  /Dogecoin/i.test(discoverText) && !/Bitcoin/i.test(discoverText),
  discoverText.slice(0, 200),
);
check(
  "a coin new to the scan is labelled new, not given a fabricated delta",
  /new to this list/i.test(discoverText),
  discoverText.slice(0, 300),
);

await page.locator("#tabRatings").click();

// Sorting must re-render without throwing.
// ⚠️ SCOPED TO #list, NOT A BARE ".card". Discover renders its own .card elements into #discover,
// left in the DOM (just hidden) after the tab is switched away from — an unscoped count here would
// include Discover's leftover card and report 3, not 2, for reasons that have nothing to do with
// sorting actually working.
await page.locator('.chip[data-sort="trend"]').click();
check("sorting by trend keeps the list rendered", (await page.locator("#list .card").count()) === 2);
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
