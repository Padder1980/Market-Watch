// Price-series maths. Pure functions over `number[]` of closes, oldest first.
//
// Every function returns `null` rather than a plausible-looking number when it has too little data.
// A moving average computed from 3 of the 200 points it needs is not a 200-day moving average, and
// a scorer that cannot tell the difference will rank a brand-new listing against a decade-old one
// as though both were measured the same way.

/** Simple moving average of the LAST `n` values. Null when there are fewer than `n`. */
export function sma(values: number[], n: number): number | null {
  if (n <= 0 || values.length < n) return null;
  let sum = 0;
  for (let i = values.length - n; i < values.length; i++) sum += values[i] as number;
  return sum / n;
}

/** Percentage change over the last `lookback` sessions, as a fraction: 0.08 = +8%. */
export function returnOver(values: number[], lookback: number): number | null {
  if (lookback <= 0 || values.length < lookback + 1) return null;
  const from = values[values.length - 1 - lookback] as number;
  const to = values[values.length - 1] as number;
  if (!(from > 0)) return null;
  return to / from - 1;
}

/** Daily log returns. Length is `values.length - 1`. */
export function logReturns(values: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1] as number;
    const cur = values[i] as number;
    if (prev > 0 && cur > 0) out.push(Math.log(cur / prev));
  }
  return out;
}

/**
 * Annualised volatility of daily log returns, as a fraction (0.45 = 45%).
 * 252 trading sessions a year for equities; crypto trades 365, but the series we receive for it is
 * daily either way, so the constant is a convention for comparability, not a claim about calendars.
 */
export function annualisedVol(values: number[], periodsPerYear = 252): number | null {
  const r = logReturns(values);
  if (r.length < 20) return null;
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(variance) * Math.sqrt(periodsPerYear);
}

/** Worst peak-to-trough fall in the window, as a POSITIVE fraction: 0.62 = fell 62% from a peak. */
export function maxDrawdown(values: number[]): number | null {
  if (values.length < 2) return null;
  let peak = values[0] as number;
  let worst = 0;
  for (const v of values) {
    if (v > peak) peak = v;
    if (peak > 0) {
      const dd = 1 - v / peak;
      if (dd > worst) worst = dd;
    }
  }
  return worst;
}

/** Largest single-session fall, as a positive fraction. */
export function worstDay(values: number[]): number | null {
  if (values.length < 2) return null;
  let worst = 0;
  for (let i = 1; i < values.length; i++) {
    const prev = values[i - 1] as number;
    const cur = values[i] as number;
    if (!(prev > 0)) continue;
    const change = cur / prev - 1;
    if (change < -worst) worst = -change;
  }
  return worst;
}

/**
 * Wilder's RSI over `n` sessions. 0–100. Needs `n + 1` points minimum, but we ask for a full
 * `2n` so the smoothing has settled — a 14-period RSI seeded from exactly 15 points is dominated
 * by whichever direction the first bar happened to move.
 */
export function rsi(values: number[], n = 14): number | null {
  if (values.length < n * 2) return null;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= n; i++) {
    const diff = (values[i] as number) - (values[i - 1] as number);
    if (diff >= 0) gain += diff;
    else loss -= diff;
  }
  let avgGain = gain / n;
  let avgLoss = loss / n;
  for (let i = n + 1; i < values.length; i++) {
    const diff = (values[i] as number) - (values[i - 1] as number);
    const g = diff > 0 ? diff : 0;
    const l = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (n - 1) + g) / n;
    avgLoss = (avgLoss * (n - 1) + l) / n;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Least-squares fit of log(price) against session index over the last `lookback` points.
 *
 * `r2` is the point of this: it separates a steady climb from a violent one that happens to end
 * higher. Two assets can post the same 6-month return with completely different characters, and
 * "trending upwards" should mean the former. Slope is per-session in log space.
 */
export function logTrend(
  values: number[],
  lookback: number,
): { slope: number; r2: number } | null {
  if (values.length < lookback || lookback < 10) return null;
  const slice = values.slice(values.length - lookback);
  const ys: number[] = [];
  for (const v of slice) {
    if (!(v > 0)) return null;
    ys.push(Math.log(v));
  }
  const n = ys.length;
  const meanX = (n - 1) / 2;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - meanX;
    const dy = (ys[i] as number) - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const r2 = syy === 0 ? 0 : (sxy * sxy) / (sxx * syy);
  return { slope, r2 };
}

/**
 * How stretched above its own moving average the price is TODAY, expressed as the fraction of the
 * asset's own history it currently exceeds. 0 = the most compressed it has been, 1 = the most
 * stretched it has ever been in this window.
 *
 * ⚠️ THIS REPLACED A RAW RSI PENALTY, AND THE REASON MATTERS. RSI measures "has it been rising",
 * not "is it overextended", and those come apart badly for a low-volatility steady climber: an index
 * fund grinding upward sits at RSI 85+ permanently, so an RSI-driven penalty docked it every single
 * day for the crime of trending reliably — measured, a steady riser scored 58 against a violently
 * choppy one on 77 with the same six-month return. Self-calibrating against the asset's OWN history
 * has no such bias: a constant-rate climb has a constant gap to its average and therefore scores 0
 * here, while a genuine blow-off — where the gap widens beyond anything the asset has done before —
 * scores 1. It also needs no per-asset constants, which is what let one threshold misjudge both a
 * gilt fund and a memecoin.
 */
export function stretchPercentile(values: number[], maLen = 50): number | null {
  if (values.length < maLen * 2) return null;
  const gaps: number[] = [];
  for (let i = maLen; i <= values.length; i++) {
    const window = values.slice(i - maLen, i);
    const avg = window.reduce((a, b) => a + b, 0) / maLen;
    const last = window[maLen - 1] as number;
    if (avg > 0) gaps.push(last / avg - 1);
  }
  const current = gaps[gaps.length - 1];
  if (gaps.length < 20 || current == null) return null;
  // Fraction STRICTLY below, so a perfectly constant gap scores 0 rather than an arbitrary tie rank.
  let below = 0;
  for (const g of gaps) if (g < current) below++;
  return below / gaps.length;
}

/** How far below the window's highest close we are now, as a positive fraction. 0 = at the high. */
export function belowHigh(values: number[], lookback: number): number | null {
  if (values.length < 2) return null;
  const slice = values.slice(Math.max(0, values.length - lookback));
  let high = 0;
  for (const v of slice) if (v > high) high = v;
  const last = slice[slice.length - 1] as number;
  if (!(high > 0)) return null;
  return 1 - last / high;
}

/** Clamp to a range. */
export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Map a value onto 0–100 by linear interpolation between `lo` (→0) and `hi` (→100), clamped.
 * Used everywhere in the scorer so that every sub-score is on one comparable ruler.
 */
export function ramp(value: number, lo: number, hi: number): number {
  if (hi === lo) return 50;
  return clamp(((value - lo) / (hi - lo)) * 100, 0, 100);
}
