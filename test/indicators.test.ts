import { test } from "node:test";
import assert from "node:assert/strict";

import {
  annualisedVol,
  belowHigh,
  logTrend,
  maxDrawdown,
  ramp,
  returnOver,
  rsi,
  sma,
  worstDay,
} from "../src/indicators.ts";

/** A geometric series rising `daily` per session — the cleanest possible uptrend. */
function ramping(n: number, start = 100, daily = 0.002): number[] {
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < n; i++) {
    out.push(v);
    v *= 1 + daily;
  }
  return out;
}

test("sma averages the last n and refuses when there are fewer", () => {
  assert.equal(sma([1, 2, 3, 4], 2), 3.5);
  assert.equal(sma([1, 2, 3, 4], 4), 2.5);
  assert.equal(sma([1, 2, 3], 4), null, "must not average 3 points and call it a 4-point average");
  assert.equal(sma([], 1), null);
});

test("returnOver measures the right span and rejects a short series", () => {
  const near = (a: number | null, b: number) => a != null && Math.abs(a - b) < 1e-9;
  assert.ok(near(returnOver([100, 110], 1), 0.1));
  assert.ok(near(returnOver([100, 105, 110], 2), 0.1), "spans the full lookback, not the last step");
  assert.ok(near(returnOver([100, 105, 110], 1), 110 / 105 - 1));
  assert.equal(returnOver([100, 110], 5), null);
});

test("maxDrawdown is the worst peak-to-trough, not the first-to-last fall", () => {
  // Ends higher than it started, but halved along the way. A last-vs-first reading says 0.
  const series = [100, 200, 100, 300];
  assert.equal(maxDrawdown(series), 0.5);
  assert.equal(maxDrawdown([100, 100, 100]), 0);
});

test("worstDay finds the largest single-session fall", () => {
  const w = worstDay([100, 90, 95, 80]);
  assert.ok(w != null && Math.abs(w - 0.157894) < 1e-4, `got ${w}`);
});

test("rsi saturates high on a pure rise and low on a pure fall", () => {
  const up = rsi(ramping(60), 14);
  const down = rsi(ramping(60, 100, -0.002), 14);
  assert.ok(up != null && up > 95, `rising series should be overbought, got ${up}`);
  assert.ok(down != null && down < 5, `falling series should be oversold, got ${down}`);
});

test("rsi needs a settled window, not the bare minimum", () => {
  // n + 1 points is arithmetically enough and statistically worthless — the first bar dominates.
  assert.equal(rsi(ramping(15), 14), null);
  assert.notEqual(rsi(ramping(28), 14), null);
});

test("logTrend separates a steady climb from a jagged one that ends in the same place", () => {
  const steady = ramping(120, 100, 0.003);
  const jagged: number[] = [];
  for (let i = 0; i < 120; i++) {
    const base = (steady[i] as number);
    jagged.push(base * (i % 2 === 0 ? 0.82 : 1.18));
  }
  const a = logTrend(steady, 120);
  const b = logTrend(jagged, 120);
  assert.ok(a != null && b != null);
  assert.ok(a.slope > 0 && b.slope > 0, "both are rising overall");
  assert.ok(a.r2 > 0.99, `steady climb should fit tightly, got ${a.r2}`);
  assert.ok(b.r2 < a.r2 - 0.2, `jagged series must fit worse: ${b.r2} vs ${a.r2}`);
});

test("logTrend reports a negative slope for a decline", () => {
  const fit = logTrend(ramping(120, 100, -0.003), 120);
  assert.ok(fit != null && fit.slope < 0);
});

test("annualisedVol scales with the size of the wobble", () => {
  const calm: number[] = [];
  const wild: number[] = [];
  for (let i = 0; i < 200; i++) {
    calm.push(100 * (1 + (i % 2 === 0 ? 0.002 : -0.002)));
    wild.push(100 * (1 + (i % 2 === 0 ? 0.05 : -0.05)));
  }
  const a = annualisedVol(calm);
  const b = annualisedVol(wild);
  assert.ok(a != null && b != null);
  assert.ok(b > a * 5, `wild ${b} should dwarf calm ${a}`);
});

test("annualisedVol refuses a series too short to mean anything", () => {
  assert.equal(annualisedVol([100, 101, 102]), null);
});

test("belowHigh reports distance from the window high, zero when at it", () => {
  assert.equal(belowHigh([100, 200, 100], 10), 0.5);
  assert.equal(belowHigh([100, 150, 200], 10), 0);
});

test("ramp clamps at both ends", () => {
  assert.equal(ramp(-5, 0, 10), 0);
  assert.equal(ramp(15, 0, 10), 100);
  assert.equal(ramp(5, 0, 10), 50);
  assert.equal(ramp(1, 1, 1), 50, "a zero-width range is neutral, not a divide-by-zero");
});
