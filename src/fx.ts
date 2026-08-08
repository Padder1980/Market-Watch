// Currency conversion — pure arithmetic over a rate table fetched once per refresh. No fetch here;
// see `fetchFxRates` in providers.ts. Kept separate from holdings.ts on purpose: the average-cost
// pooling in there is well-tested, load-bearing financial logic, and it has no need to know currency
// exists at all if every number handed to it already arrives in one consistent currency. This module
// is what makes that true — it normalises amounts BEFORE they ever reach `positionFor`.

/** A same-day rate table, quoted as "how many units of X equal 1 unit of `base`". */
export interface FxRates {
  base: string;
  rates: Record<string, number>;
  /** ISO date the rates were published, for the "as of" line — these are daily, not live ticks. */
  asOf: string;
}

/**
 * Converts `amount` from `from` to `to` using a table quoted against `rates.base`.
 *
 * ⚠️ SAME-CURRENCY IS ALWAYS AN EXACT NO-OP, CHECKED BEFORE THE TABLE IS EVEN LOOKED AT. The common
 * case — a GBP holding, shown in GBP — must never depend on a rate table existing at all, let alone
 * a network call having succeeded. A portfolio that never crosses a currency boundary should work
 * identically whether or not `rates` loaded.
 *
 * ⚠️ RETURNS NULL RATHER THAN A GUESS WHEN THE TABLE CAN'T EXPRESS THE CONVERSION — no rates loaded,
 * or a currency this table doesn't cover. The caller must show that as absent (the same "absent is
 * not bad" rule the rest of this app follows), never fall back to treating the raw number as if it
 * were already in the target currency. That silent relabelling — a $121 price wearing a £ sign with
 * no arithmetic behind it — is the exact bug this module exists to remove.
 */
export function convertAmount(
  amount: number,
  from: string,
  to: string,
  rates: FxRates | null,
): number | null {
  const f = from.toUpperCase();
  const t = to.toUpperCase();
  if (f === t) return amount;
  if (!rates) return null;
  const base = rates.base.toUpperCase();

  const fRate = rates.rates[f];
  const toBase = f === base ? amount : fRate != null ? amount / fRate : NaN;
  if (!Number.isFinite(toBase)) return null;

  const tRate = rates.rates[t];
  const result = t === base ? toBase : tRate != null ? toBase * tRate : NaN;
  return Number.isFinite(result) ? result : null;
}
