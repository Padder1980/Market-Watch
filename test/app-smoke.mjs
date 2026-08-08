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
  // Equity Discover fixture: a share not on the default (crypto-only) watchlist, so nothing here
  // gets filtered out — the exclusion behaviour is already proven by the crypto fixture above.
  function fakeEquityRating(id, symbol, name, stars, composite) {
    return {
      id, symbol, name, kind: "equity", stars, composite,
      trend: fakePillar(composite), analyst: fakePillar(72), fundamentals: fakePillar(65),
      network: fakePillar(null), flows: fakePillar(null),
      risk: { band: "moderate", annualisedVol: 0.25, maxDrawdown: 0.08, worstDay: 0.04, reasons: ["fixture risk reason"] },
      caveats: [], missing: [],
    };
  }
  const discoverSharesJson = {
    asOf: new Date().toISOString().slice(0, 10),
    entries: [
      {
        id: "AAPL", symbol: "AAPL", name: "Apple", price: 190, currency: "USD",
        move1: 0.008, move30: 0.03, deltaComposite: null, isNew: true,
        rating: fakeEquityRating("AAPL", "AAPL", "Apple", 4, 68),
      },
    ],
  };
  // A month of USD closes for a fake equity, so the currency-conversion tests have a real
  // cross-currency price to work with — the default watchlist/display currency in this app is GBP.
  const equityValues = [];
  let ev = 118.5;
  for (let i = 0; i < 40; i++) {
    ev += (i % 5 === 0 ? 1 : -0.3);
    const d = new Date(Date.now() - (39 - i) * 86400000).toISOString().slice(0, 10);
    equityValues.push({ datetime: d, close: ev.toFixed(2) });
  }
  const fxRates = { amount: 1, base: "USD", date: new Date().toISOString().slice(0, 10), rates: { GBP: 0.79, EUR: 0.92 } };
  window.fetch = async (url) => {
    const u = String(url);
    if (u.includes("frankfurter")) {
      return { ok: true, status: 200, json: async () => fxRates };
    }
    if (u.includes("twelvedata.com")) {
      return {
        ok: true, status: 200,
        json: async () => ({ status: "ok", meta: { currency: "USD", symbol: "AAPL" }, values: equityValues }),
      };
    }
    if (u.includes("data/discover-shares.json")) {
      return { ok: true, status: 200, json: async () => discoverSharesJson };
    }
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
  // ⚠️ NO `localStorage.clear()` HERE, DELIBERATELY — it was here, and it was wrong. `addInitScript`
  // reruns before EVERY navigation of this page, including every `page.reload()` later in this file,
  // so a clear() living inside it wiped localStorage on every one of them — silently defeating any
  // "survives a reload" check in this whole suite. `browser.newPage()` already starts from a fresh,
  // storage-isolated context, so a clean start never needed this call in the first place; it only
  // ever mattered on reload, where it was actively harmful. Found because a NEW reload-persistence
  // check (the watchlist one) failed outright where an OLDER one ("holdings persist across a
  // reload") had been silently passing on a false positive the whole time — see that check's own
  // comment for how its regex matched the empty state too.
});

await page.goto(page_url);
await page.waitForSelector(".card", { timeout: 15000 });

check("the engine bundle inlined and exposed MK", await page.evaluate(() => typeof window.MK === "object" && typeof window.MK.rateAsset === "function"));

// ⚠️ THE ICON LINKS ARE EASY TO LOSE SILENTLY. Nothing else in this app depends on them, so a
// future <head> edit that accidentally drops one would build clean, typecheck clean, and pass every
// other check — the only way to notice is a phone screenshot showing a screenshot-icon instead of
// the real one. Checked here once so that regression is loud instead of silent.
const headLinks = await page.evaluate(() => ({
  manifest: document.querySelector('link[rel="manifest"]')?.getAttribute("href") || null,
  appleTouchIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute("href") || null,
  favicon32: document.querySelector('link[rel="icon"][sizes="32x32"]')?.getAttribute("href") || null,
}));
check(
  "the home-screen icon and manifest are wired into <head>",
  headLinks.manifest === "manifest.webmanifest" &&
    headLinks.appleTouchIcon === "icons/apple-touch-icon.png" &&
    headLinks.favicon32 === "icons/favicon-32.png",
  JSON.stringify(headLinks),
);

// ⚠️ SCOPED TO #list, NOT A BARE ".card". Education's own guide cards are rendered at boot (they're
// static, local content — no reason to lazy-load them) and reuse the `.card` class for its styling,
// so they sit in the DOM, just hidden behind `#viewEducation`, the same trap Discover's cards already
// taught this file once (see the later sort-check comment). An unscoped count here read 12, not 2.
const cards = await page.locator("#list .card").count();
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
// ⚠️ NOT "/Worth now/i" — the EMPTY state's own copy ("...this page will show what it is worth
// now") matches that regex too, case-insensitively, so the check would report success whether or
// not anything actually survived the reload. "against what you paid" only ever appears once a real
// position is being valued (see the "a gain is shown against what was paid" check above), so it
// can't be satisfied by the empty state by accident.
check(
  "holdings persist across a reload",
  /against what you paid/i.test(await page.locator("#holdings").innerText()),
);

await page.locator("#tabRatings").click();

// ---------------------------------------------------------------------------------------------
// Education
// ---------------------------------------------------------------------------------------------

await page.locator("#tabEducation").click();
check(
  "the education tab swaps the view",
  await page.locator("#viewEducation").isVisible() && !(await page.locator("#viewRatings").isVisible()),
);

const eduNotice = await page.locator("#viewEducation .notice").innerText();
check(
  "the education notice is short, not a wall of text",
  eduNotice.length > 0 && eduNotice.length < 300,
  `${eduNotice.length} chars`,
);

const guideCards = await page.locator("#eduGuide .card").count();
check("the guide renders its full set of bite-sized cards", guideCards === 10, `got ${guideCards}`);

// ⚠️ THE TL;DR MUST BE READABLE WITHOUT OPENING ANYTHING. The whole design point for someone who
// finds long passages hard going is that the short answer is already on screen — "A bit more" is an
// optional extra layer, never the only place the basic idea lives. This asserts it stays short too,
// so a future edit can't quietly turn the always-visible line into a paragraph.
const firstTldr = await page.locator("#eduGuide .edu-tldr").first().innerText();
check(
  "a guide card's short answer is visible without expanding anything",
  firstTldr.length > 0 && firstTldr.length < 200,
  `${firstTldr.length} chars: ${firstTldr.slice(0, 80)}`,
);

// ⚠️ "guaranteed returns" is deliberately NOT in this list — the safety card has to be able to name
// that exact scam phrase to warn against it. These are phrasings the app itself would only ever use
// to tell the reader what to do with money, which nothing in Education, or this whole project, may do.
const eduText = await page.locator("#viewEducation").innerText();
check(
  "education content never crosses into advice",
  !/\b(buy now|you should invest|time to buy|we recommend buying)\b/i.test(eduText),
  eduText.slice(0, 200),
);

// ---- glossary ----
await page.locator("#eduTabGlossary").click();
check(
  "the glossary tab swaps the inner view",
  await page.locator("#eduGlossary").isVisible() && !(await page.locator("#eduGuide").isVisible()),
);

const glossCount = await page.locator("#glossList .gloss-item").count();
check("the full glossary lists every term", glossCount === 24, `got ${glossCount}`);

await page.locator("#glossSearch").fill("wallet");
const filtered = await page.locator("#glossList .gloss-item").allTextContents();
check(
  "searching the glossary filters to matching terms",
  filtered.length > 0 && filtered.length < glossCount && filtered.some((t) => /wallet/i.test(t)),
  `got ${filtered.length} of ${glossCount}`,
);

await page.locator("#glossSearch").fill("xyznonsense");
const noMatch = await page.locator("#glossList").innerText();
check(
  "an unmatched search says so rather than showing a blank list",
  /no terms match/i.test(noMatch),
  noMatch.slice(0, 100),
);

await page.locator("#glossSearch").fill("");
await page.locator("#eduTabGuide").click();
await page.locator("#tabRatings").click();

// ⚠️ REDUCED MOTION MUST ACTUALLY REMOVE THE ANIMATIONS, NOT JUST BE ASKED TO. SMIL <animate> tags
// ignore CSS `animation-play-state`, so the only real off switch is never emitting them — this
// proves that branch on a fresh load, rather than trusting the code path was taken. Reusing `page`
// (not a new page) matters: the fetch stub was installed via `page.addInitScript`, which reruns on
// every navigation of THIS page, but a brand-new page would hit the real, sandbox-blocked network
// and its cards would never render at all — that was the first version's actual failure.
await page.emulateMedia({ reducedMotion: "reduce" });
await page.reload();
await page.waitForSelector(".card", { timeout: 15000 });
const animatedTags = await page.evaluate(() =>
  document.querySelectorAll("#eduGuide animate, #eduGuide animateTransform").length,
);
check("reduced motion strips the icon animations entirely", animatedTags === 0, `got ${animatedTags}`);
await page.emulateMedia({ reducedMotion: "no-preference" });

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

// ---- the shares sub-tab ----
await page.locator("#discTabShares").click();
const sharesCards = await page.locator("#discover .card").count();
check("switching to Shares loads the equity scan", sharesCards === 1, `got ${sharesCards}`);

const sharesText = await page.locator("#discover").innerText();
check("the share entry shows", /Apple/i.test(sharesText), sharesText.slice(0, 200));
// ⚠️ THIS IS THE ONE THAT MATTERS MOST IN THIS SECTION. Crypto candidates are ranked by a real,
// live, external market-cap ordering; the share universe is a hand-picked list (see
// tools/discover-round-shares.ts). Saying "ranked by market size" for both would quietly claim an
// objectivity the share side does not have — this asserts the methodology note actually differs.
check(
  "the share scan admits it is curated, not size-ranked",
  /curated list of well-known large companies/i.test(sharesText) && !/ranked by market size/i.test(sharesText),
  sharesText.slice(0, 300),
);

const sharesBarLabels = await page.locator("#discover .card").first().locator(".bar .lbl").allTextContents();
check(
  "a share is shown Forecasts and Business, not Flows and Network",
  sharesBarLabels.some((t) => /forecasts/i.test(t)) && sharesBarLabels.some((t) => /business/i.test(t)) &&
    !sharesBarLabels.some((t) => /flows|network/i.test(t)),
  JSON.stringify(sharesBarLabels),
);

// Switching back to Crypto must restore its own scan, not the shares one left behind.
await page.locator("#discTabCrypto").click();
const backToCrypto = await page.locator("#discover").innerText();
check(
  "switching back to Crypto shows the crypto scan again",
  /Dogecoin/i.test(backToCrypto) && !/Apple/i.test(backToCrypto),
  backToCrypto.slice(0, 200),
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

// ⚠️ REGRESSION: a watchlist addition must survive WITHOUT ever tapping "Save and refresh". Before
// this fix, adding an item only lived in memory until that separate button (below the key fields,
// easy to miss) was pressed — closing the sheet via "Close" discarded it silently on the next
// reload, which is exactly what this reproduces: close, not save.
await page.locator("#closeBtn").click();
await page.reload();
await page.waitForSelector(".card", { timeout: 15000 });
await page.locator("#setBtn").click();
const wlRowsAfterReload = await page.locator("#wl .wl-row").count();
check(
  "a watchlist addition survives a reload without ever tapping Save",
  wlRowsAfterReload === 3,
  `got ${wlRowsAfterReload}`,
);
await page.locator("#closeBtn").click();
await page.locator("#tabHoldings").click();
await page.locator("#addTxBtn").click();
const txOptions = await page.locator("#txAsset option").allTextContents();
check(
  "the auto-saved addition reaches the holdings asset picker",
  txOptions.some((t) => /solana/i.test(t)),
  JSON.stringify(txOptions),
);
await page.locator("#txCancel").click();
await page.locator("#tabRatings").click();

// ⚠️ REGRESSION: a GitHub token typed into Settings must survive a save. The previous code set
// `state.keys.github` and then immediately replaced the whole object with `state.keys = {}` on the
// very next line, discarding it on every single save.
await page.locator("#setBtn").click();
await page.locator("#ghKey").fill("github_pat_regression_check");
await page.locator("#saveBtn").click();
await page.locator("#setBtn").click();
const ghKeyAfterSave = await page.locator("#ghKey").inputValue();
check(
  "a GitHub token survives Save and refresh, not just Add",
  ghKeyAfterSave === "github_pat_regression_check",
  `got ${JSON.stringify(ghKeyAfterSave)}`,
);
await page.locator("#closeBtn").click();

// ---------------------------------------------------------------------------------------------
// Currency conversion and "type what I spent" — a cross-currency share on a GBP-display account
// ---------------------------------------------------------------------------------------------

await page.locator("#setBtn").click();
await page.locator("#tdKey").fill("fake-twelve-data-key");
await page.locator("#addId").fill("AAPL");
await page.locator("#addKind").selectOption("equity");
await page.locator("#addBtn").click();
await page.locator("#saveBtn").click();
// `refresh()` re-renders the Ratings list; wait for the newly added share to actually appear rather
// than assuming a fixed delay — this app's default display currency is GBP, and Twelve Data always
// reports a USD price for this fixture, so AAPL is a genuine cross-currency case from here on.
await page.locator("#list").getByText("AAPL", { exact: false }).first().waitFor({ timeout: 15000 });

await page.locator("#tabHoldings").click();
await page.locator("#addTxBtn").click();
await page.locator("#txAsset").selectOption("AAPL");
const curNote = await page.locator("#txCurNote").innerText();
check(
  "the transaction sheet names the asset's own currency",
  /USD/.test(curNote),
  curNote,
);

// "Total invested" must back-compute units, inverting the same maths updateSpend uses forward.
await page.locator("#txPrice").fill("100");
await page.locator("#txTotal").fill("500");
const autoQty = await page.locator("#txQty").inputValue();
check(
  "typing a total works out the units (500 / 100 = 5)",
  autoQty === "5",
  `got ${JSON.stringify(autoQty)}`,
);

// Editing the amount directly must hand control back — typing over the auto-filled units is the
// "I know the units" flow, and it must not be silently overwritten by a stale total on the next edit.
await page.locator("#txQty").fill("3");
const totalAfterManualEdit = await page.locator("#txTotal").inputValue();
check(
  "editing the amount directly clears the total, so the two stop fighting each other",
  totalAfterManualEdit === "",
  `got ${JSON.stringify(totalAfterManualEdit)}`,
);

// Put it back to the total-derived entry and save for real.
await page.locator("#txTotal").fill("500");
await page.locator("#txDate").fill("2026-08-01");
await page.locator("#txSave").click();

const heldText = await page.locator("#holdings").innerText();
check(
  "a USD holding is valued in the account's own GBP display currency",
  /£/.test(heldText) && !/\$/.test(heldText),
  heldText.slice(0, 400),
);
check(
  "conversion actually succeeded — no 'couldn't convert' fallback warning shown",
  !/couldn't convert/i.test(heldText),
  heldText.slice(0, 400),
);

// The audit trail is the one place that must show what was actually typed, in the currency it was
// typed in — NOT converted, unlike the summary above it.
await page.locator("#holdings .more summary").click();
const auditText = await page.locator("#holdings .more").innerText();
check(
  "the transaction history shows the original USD price, not a converted one",
  /\$100(\.00)?/.test(auditText),
  auditText.slice(0, 300),
);

await page.locator("#tabRatings").click();

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
