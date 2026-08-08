// One-off diagnostic: fetchConsensus() in src/providers.ts swallows every error (by design — an
// analyst pillar failing must never take the whole row down), which means the real HTTP status and
// body from Finnhub's recommendation-trends endpoint were never visible anywhere, including in the
// 2026-08-08 discover-shares run that scored 52/52 companies but got a null analyst pillar for every
// single one — including AAPL, which obviously has real analyst coverage. This script bypasses the
// swallowing to see the actual response, once, so the cause can be confirmed rather than guessed at.
// Deleted immediately after use — this is not meant to ship.
//
// Run:  FINNHUB_KEY=... node tools/diag-finnhub.ts

const key = process.env.FINNHUB_KEY ?? "";
if (!key) {
  console.log("No FINNHUB_KEY set.");
  process.exit(1);
}

async function check(label: string, url: string): Promise<void> {
  console.log(`\n${label}`);
  console.log(`  ${url.replace(key, "***")}`);
  try {
    const res = await fetch(url);
    console.log(`  status: ${res.status}`);
    const body = await res.text();
    console.log(`  body: ${body.slice(0, 500)}`);
  } catch (err) {
    console.log(`  threw: ${String(err).slice(0, 300)}`);
  }
}

await check(
  "recommendation-trends (analyst consensus)",
  `https://finnhub.io/api/v1/stock/recommendation-trends?symbol=AAPL&token=${key}`,
);
await check(
  "price-target",
  `https://finnhub.io/api/v1/stock/price-target?symbol=AAPL&token=${key}`,
);
await check(
  "stock/metric (fundamentals — known working, as a control)",
  `https://finnhub.io/api/v1/stock/metric?symbol=AAPL&metric=all&token=${key}`,
);
