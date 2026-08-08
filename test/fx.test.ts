import { test } from "node:test";
import assert from "node:assert/strict";

import { convertAmount, type FxRates } from "../src/fx.ts";

const usdBase: FxRates = { base: "USD", rates: { GBP: 0.79, EUR: 0.92 }, asOf: "2026-08-08" };

test("same currency is an exact no-op, even with no rate table at all", () => {
  assert.equal(convertAmount(121.42, "USD", "USD", null), 121.42);
  assert.equal(convertAmount(121.42, "usd", "USD", null), 121.42);
});

test("converts from the base currency directly", () => {
  const gbp = convertAmount(100, "USD", "GBP", usdBase);
  assert.ok(gbp != null && Math.abs(gbp - 79) < 1e-9, `got ${gbp}`);
});

test("converts to the base currency directly", () => {
  const usd = convertAmount(79, "GBP", "USD", usdBase);
  assert.ok(usd != null && Math.abs(usd - 100) < 1e-9, `got ${usd}`);
});

test("converts between two non-base currencies via the base", () => {
  // £79 -> $100 (via base) -> €92
  const eur = convertAmount(79, "GBP", "EUR", usdBase);
  assert.ok(eur != null && Math.abs(eur - 92) < 1e-9, `got ${eur}`);
});

test("round-trips back to the original amount within floating-point tolerance", () => {
  const gbp = convertAmount(500, "USD", "GBP", usdBase)!;
  const back = convertAmount(gbp, "GBP", "USD", usdBase)!;
  assert.ok(Math.abs(back - 500) < 1e-9, `got ${back}`);
});

test("a currency the table doesn't cover returns null, never a wrong number", () => {
  assert.equal(convertAmount(100, "USD", "JPY", usdBase), null);
  assert.equal(convertAmount(100, "JPY", "USD", usdBase), null);
});

// ⚠️ THIS IS THE ONE THAT MATTERS MOST. A missing rate table must never make the caller fall back to
// treating the raw number as already being in the target currency — that silent relabelling (a $121
// price wearing a £ sign with no arithmetic behind it) is the exact bug this module exists to remove.
test("no rate table at all returns null for a real cross-currency conversion, never the raw amount", () => {
  assert.equal(convertAmount(121.42, "USD", "GBP", null), null);
});

test("is case-insensitive on currency codes", () => {
  const gbp = convertAmount(100, "usd", "gbp", usdBase);
  assert.ok(gbp != null && Math.abs(gbp - 79) < 1e-9, `got ${gbp}`);
});
