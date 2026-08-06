import { test } from "node:test";
import assert from "node:assert/strict";

import type { Lot } from "../src/holdings.ts";
import { assetsHeld, portfolioTotals, positionFor } from "../src/holdings.ts";

let seq = 0;
function buy(qty: number, price: number, date = "2026-01-01", fee = 0): Lot {
  return { id: `b${seq++}`, assetId: "bitcoin", side: "buy", dateIso: date, quantity: qty, unitPrice: price, fee };
}
function sell(qty: number, price: number, date = "2026-06-01", fee = 0): Lot {
  return { id: `s${seq++}`, assetId: "bitcoin", side: "sell", dateIso: date, quantity: qty, unitPrice: price, fee };
}

const near = (a: number | null, b: number, tol = 1e-6) =>
  a != null && Math.abs(a - b) < tol;

test("a single buy values at today's price", () => {
  const p = positionFor([buy(0.5, 40000)], "bitcoin", 50000);
  assert.equal(p.quantity, 0.5);
  assert.ok(near(p.costBasis, 20000));
  assert.ok(near(p.averageCost, 40000));
  assert.ok(near(p.value, 25000));
  assert.ok(near(p.unrealised, 5000));
  assert.ok(near(p.unrealisedPct, 0.25));
});

test("two buys pool at their average cost", () => {
  const p = positionFor([buy(1, 30000, "2026-01-01"), buy(1, 50000, "2026-02-01")], "bitcoin", 40000);
  assert.equal(p.quantity, 2);
  assert.ok(near(p.averageCost, 40000));
  // Bought either side of today's price: the position is exactly flat, and must print as flat.
  assert.ok(near(p.unrealised, 0));
});

test("fees go in on the way in and come off on the way out", () => {
  // ⚠️ Ignoring fees flatters every position by exactly what the platform charged — the one error a
  // holdings page has no excuse for.
  const p = positionFor([buy(1, 40000, "2026-01-01", 100)], "bitcoin", 40000);
  assert.ok(near(p.costBasis, 40100));
  assert.ok(near(p.unrealised, -100), `a fee must show as being behind, got ${p.unrealised}`);

  const sold = positionFor(
    [buy(1, 40000, "2026-01-01", 0), sell(1, 40000, "2026-06-01", 250)],
    "bitcoin",
    40000,
  );
  assert.ok(near(sold.realised, -250), `sell fee must reduce the realised result, got ${sold.realised}`);
});

test("a sell reduces the cost basis PROPORTIONALLY, not by its proceeds", () => {
  // ⚠️ THE DEFECT THIS GUARDS, AND IT IS THE WHOLE REASON THIS MODULE POOLS. Subtract the proceeds
  // instead of a share of the pool and the survivors carry a cost unrelated to what was paid: here
  // 2 BTC cost £60k, half is sold at £60k, and proceeds-subtraction leaves the remaining 1 BTC
  // holding a cost basis of £0 — printing as an infinite gain on a coin that cost £30,000.
  const lots = [buy(2, 30000, "2026-01-01"), sell(1, 60000, "2026-06-01")];
  const p = positionFor(lots, "bitcoin", 60000);
  assert.equal(p.quantity, 1);
  assert.ok(near(p.costBasis, 30000), `remaining coin should still cost 30000, got ${p.costBasis}`);
  assert.ok(near(p.averageCost, 30000));
  assert.ok(near(p.realised, 30000), `realised profit should be 30000, got ${p.realised}`);
  assert.ok(near(p.unrealised, 30000));
  assert.ok(p.costBasis > 0, "a proportional reduction can never leave a zero or negative basis");
});

test("selling everything leaves nothing behind — no crumbs, no ghost cost", () => {
  const p = positionFor([buy(0.1, 30000), buy(0.2, 40000), sell(0.3, 50000)], "bitcoin", 50000);
  assert.equal(p.quantity, 0);
  assert.equal(p.costBasis, 0);
  assert.equal(p.value, 0);
  assert.equal(p.averageCost, null);
  // Floating point leaves 1e-17 units behind if this is not handled; a residue must not print as a
  // holding, and must not drag a cost basis along with it.
  assert.ok(near(p.realised, 0.1 * 20000 + 0.2 * 10000));
});

test("selling more than is held is corrected and reported, never allowed to go short", () => {
  const p = positionFor([buy(1, 30000, "2026-01-01"), sell(3, 50000, "2026-06-01")], "bitcoin", 50000);
  // ⚠️ A negative quantity is a short position the owner never took, and it poisons every total
  // below it while looking like an ordinary row.
  assert.equal(p.quantity, 0);
  assert.ok(p.quantity >= 0);
  assert.ok(p.warnings.some((w) => /more than was held/i.test(w)), p.warnings.join(" | "));
  assert.ok(near(p.realised, 20000), "only the coin actually held can be sold");
});

test("transactions are pooled in DATE order, not entry order", () => {
  // Typing yesterday's trade in after today's must not change the answer.
  const inOrder = positionFor([buy(1, 30000, "2026-01-01"), sell(1, 50000, "2026-06-01")], "bitcoin", 50000);
  const jumbled = positionFor([sell(1, 50000, "2026-06-01"), buy(1, 30000, "2026-01-01")], "bitcoin", 50000);
  assert.equal(jumbled.quantity, inOrder.quantity);
  assert.ok(near(jumbled.realised, inOrder.realised));
  assert.equal(jumbled.warnings.length, 0, jumbled.warnings.join(" | "));
});

test("an unknown price leaves value null rather than reporting zero", () => {
  const p = positionFor([buy(1, 30000)], "bitcoin", null);
  assert.equal(p.value, null);
  assert.equal(p.unrealised, null);
  assert.equal(p.unrealisedPct, null);
  // The holding itself is still known; only its worth is not.
  assert.equal(p.quantity, 1);
  assert.ok(near(p.costBasis, 30000));
});

test("a zero cost basis never prints as an infinite gain", () => {
  const p = positionFor([{ id: "g", assetId: "bitcoin", side: "buy", dateIso: "2026-01-01", quantity: 1, unitPrice: 0 }], "bitcoin", 50000);
  assert.equal(p.costBasis, 0);
  assert.ok(near(p.unrealised, 50000));
  assert.equal(p.unrealisedPct, null, "a percentage of nothing is not a number to print");
});

test("unreadable rows are skipped and named, not silently dropped", () => {
  const bad: Lot = { id: "x", assetId: "bitcoin", side: "buy", dateIso: "2026-03-03", quantity: Number.NaN, unitPrice: 100 };
  const p = positionFor([buy(1, 30000), bad], "bitcoin", 30000);
  assert.equal(p.quantity, 1);
  assert.ok(p.warnings.some((w) => /unreadable/i.test(w)), p.warnings.join(" | "));
});

test("an unpriced holding makes the total PARTIAL rather than counting as a loss", () => {
  const btc = positionFor([buy(1, 30000)], "bitcoin", 50000);
  const eth = positionFor(
    [{ id: "e", assetId: "ethereum", side: "buy", dateIso: "2026-01-01", quantity: 10, unitPrice: 2000 }],
    "ethereum",
    null,
  );
  const t = portfolioTotals([btc, eth]);
  // ⚠️ Counting the unpriced holding as worth 0 would report a portfolio that has just lost £20,000.
  // Same "absent is not bad" rule as the scoring engine, where breaking it looks most like disaster.
  assert.ok(t.partial, "the total must admit it is incomplete");
  assert.ok(near(t.value, 50000));
  assert.ok(near(t.costBasis, 30000), "the unpriced holding's cost is excluded from the comparison too");
  assert.ok(near(t.unrealised, 20000));
});

test("realised profit is counted even after a position is closed", () => {
  const closed = positionFor([buy(1, 30000), sell(1, 50000)], "bitcoin", 50000);
  const t = portfolioTotals([closed]);
  assert.equal(t.value, 0);
  assert.ok(near(t.realised, 20000), "a closed winner must not vanish from the record");
  assert.ok(!t.partial);
});

test("assetsHeld names every asset in the book, once", () => {
  const lots = [
    buy(1, 30000),
    { id: "e", assetId: "ethereum", side: "buy" as const, dateIso: "2026-01-01", quantity: 5, unitPrice: 2000 },
    buy(1, 40000, "2026-02-02"),
  ];
  assert.deepEqual(assetsHeld(lots).sort(), ["bitcoin", "ethereum"]);
});
