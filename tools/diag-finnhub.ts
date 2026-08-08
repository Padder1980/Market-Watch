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

async function check(label: string, url: string, headers?: Record<string, string>): Promise<void> {
  console.log(`\n${label}`);
  console.log(`  ${url.replace(key, "***")}`);
  if (headers) console.log(`  headers: ${JSON.stringify(headers).replace(key, "***")}`);
  try {
    const res = await fetch(url, headers ? { headers } : undefined);
    console.log(`  status: ${res.status}`);
    console.log(`  content-type: ${res.headers.get("content-type")}`);
    console.log(`  x-ratelimit headers: ${JSON.stringify([...res.headers.entries()].filter(([k]) => /ratelimit|finnhub|cf-|server/i.test(k)))}`);
    const body = await res.text();
    console.log(`  body: ${body.slice(0, 300)}`);
  } catch (err) {
    console.log(`  threw: ${String(err).slice(0, 300)}`);
  }
}

// Query-param auth, exactly as the app's own code does it.
await check(
  "recommendation-trends, query-param token (as the app sends it)",
  `https://finnhub.io/api/v1/stock/recommendation-trends?symbol=AAPL&token=${key}`,
);
// Header auth instead — Finnhub's docs show BOTH forms historically; if the query-param form has
// stopped being honoured for this specific endpoint while the header form still works, that would
// explain a 200 with the website's own HTML (a router falling through on an unrecognised request)
// rather than a proper API error.
await check(
  "recommendation-trends, X-Finnhub-Token header instead of query param",
  `https://finnhub.io/api/v1/stock/recommendation-trends?symbol=AAPL`,
  { "X-Finnhub-Token": key },
);
await check(
  "price-target",
  `https://finnhub.io/api/v1/stock/price-target?symbol=AAPL&token=${key}`,
);
await check(
  "stock/metric (fundamentals — known working, as a control), same query-param style",
  `https://finnhub.io/api/v1/stock/metric?symbol=AAPL&metric=all&token=${key}`,
);
