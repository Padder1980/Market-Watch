// What you actually own, and what it is worth now.
//
// ⚠️ THIS IS A RECORD, NOT ADVICE, AND THE DISTINCTION IS THE REASON IT IS ALLOWED TO EXIST. The
// README rules out "no portfolio, no position sizing, no how-much-should-I-put-in" — that ban is on
// the app telling you what to DO with your money. Writing down what you already bought and
// multiplying it by today's price tells you what IS. Nothing in this file may cross back over that
// line: no "time to take profits", no targets, no rebalancing suggestions.
//
// ⚠️ AND NOTHING HERE IS A TAX CALCULATION. UK capital gains uses Section 104 pooling plus the
// same-day and 30-day matching rules, and getting those subtly wrong for someone filing a return is
// worse than not offering it. Average cost is used because it is the honest way to answer "what did
// mine cost me", and the UI says in as many words that it is not a tax figure.

/** One transaction the owner typed in. `quantity` is always positive; `side` carries the direction. */
export interface Lot {
  /** Stable id so a row can be edited or removed without depending on its position. */
  id: string;
  /** Matches `AssetSnapshot.id` — "bitcoin", "AAPL". */
  assetId: string;
  side: "buy" | "sell";
  /** ISO date, YYYY-MM-DD. */
  dateIso: string;
  /** Units bought or sold. Bitcoin is divisible, so this is fractional. */
  quantity: number;
  /** Price per unit in the account currency at the time of the trade. */
  unitPrice: number;
  /** Commission or spread, in the account currency. Optional; treated as 0 when absent. */
  fee?: number | null;
  note?: string | null;
}

export interface Position {
  assetId: string;
  /** Units currently held. */
  quantity: number;
  /** What those units cost, including fees on the buys still held. */
  costBasis: number;
  /** costBasis / quantity, or null when nothing is held. */
  averageCost: number | null;
  /** Value at the price passed in, or null when no current price is known. */
  value: number | null;
  /** value - costBasis, or null without a price. */
  unrealised: number | null;
  /** unrealised / costBasis as a fraction, or null. */
  unrealisedPct: number | null;
  /** Profit or loss already crystallised by sells, net of fees. */
  realised: number;
  /** Total cash put in and taken out, for the "am I ahead overall" line. */
  invested: number;
  withdrawn: number;
  /** Problems with the entered data, in plain English. Never thrown — shown. */
  warnings: string[];
}

function round(x: number, dp = 10): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

/**
 * Walk one asset's transactions oldest-first, maintaining an average-cost pool.
 *
 * ⚠️ SELLS MUST REDUCE THE COST BASIS PROPORTIONALLY, NOT BY THE SALE PROCEEDS. Subtracting what you
 * received leaves the remaining coins carrying a cost that has nothing to do with what you paid for
 * them — sell into a rise and the leftovers can end up with a NEGATIVE cost basis, which then prints
 * as an infinite percentage gain on the row below. Take out the same fraction of the pool as the
 * fraction of units sold, and the survivors keep their true average.
 *
 * ⚠️ FEES GO IN ON THE WAY IN AND COME OFF ON THE WAY OUT. A buy fee is part of what the holding
 * cost; a sell fee is money you did not receive. Ignoring them flatters every position by exactly
 * the amount the platform charged, which is the one error a holdings page has no excuse for.
 */
export function positionFor(
  lots: Lot[],
  assetId: string,
  currentPrice: number | null | undefined,
): Position {
  const mine = lots
    .filter((l) => l.assetId === assetId)
    .slice()
    .sort((a, b) => (a.dateIso < b.dateIso ? -1 : a.dateIso > b.dateIso ? 1 : 0));

  let quantity = 0;
  let costBasis = 0;
  let realised = 0;
  let invested = 0;
  let withdrawn = 0;
  const warnings: string[] = [];

  for (const l of mine) {
    const qty = Number(l.quantity);
    const price = Number(l.unitPrice);
    const fee = Number(l.fee ?? 0) || 0;
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0) {
      warnings.push(`A ${l.side} dated ${l.dateIso} has an unreadable amount or price and was skipped.`);
      continue;
    }

    if (l.side === "buy") {
      quantity += qty;
      costBasis += qty * price + fee;
      invested += qty * price + fee;
      continue;
    }

    // ⚠️ A sell of more than is held is a typo, and the honest response is to sell what there is and
    // SAY SO. Letting the quantity go negative silently produces a short position the owner never
    // took, and every number below it — value, gain, the whole-portfolio total — is then wrong with
    // nothing on screen to suggest it.
    let sellQty = qty;
    if (sellQty > quantity + 1e-12) {
      warnings.push(
        `A sell dated ${l.dateIso} is for more than was held at the time. ` +
          `Counted as selling the ${round(quantity, 8)} available — check the entry.`,
      );
      sellQty = quantity;
    }
    if (sellQty <= 0) continue;

    const fraction = quantity > 0 ? sellQty / quantity : 0;
    const costOut = costBasis * fraction;
    const proceeds = sellQty * price - fee;
    realised += proceeds - costOut;
    withdrawn += proceeds;
    quantity -= sellQty;
    costBasis -= costOut;
  }

  quantity = round(quantity, 10);
  costBasis = round(costBasis, 6);
  // Floating point leaves crumbs when a position is fully sold; a residual of 1e-15 units must not
  // print as a holding, nor leave a cost basis behind for it.
  if (Math.abs(quantity) < 1e-9) {
    quantity = 0;
    costBasis = 0;
  }

  const price = currentPrice != null && Number.isFinite(currentPrice) && currentPrice > 0
    ? currentPrice
    : null;
  const value = price != null ? quantity * price : null;
  const unrealised = value != null ? value - costBasis : null;
  // ⚠️ Guard the divisor. A position given away, or one whose fees exactly offset it, has a zero
  // cost basis — and "Infinity%" beside a real holding reads as a bug in the whole page.
  const unrealisedPct = unrealised != null && costBasis > 0 ? unrealised / costBasis : null;

  return {
    assetId,
    quantity,
    costBasis,
    averageCost: quantity > 0 ? costBasis / quantity : null,
    value,
    unrealised,
    unrealisedPct,
    realised: round(realised, 6),
    invested: round(invested, 6),
    withdrawn: round(withdrawn, 6),
    warnings,
  };
}

export interface PortfolioTotals {
  costBasis: number;
  /** Sum of the positions we could price. */
  value: number;
  unrealised: number;
  unrealisedPct: number | null;
  realised: number;
  /** True when at least one held position had no current price, so `value` is incomplete. */
  partial: boolean;
}

/**
 * Add the positions up.
 *
 * ⚠️ AN UNPRICED HOLDING MAKES THE TOTAL PARTIAL, AND THE TOTAL MUST SAY SO. If one asset failed to
 * load, treating its value as 0 reports a portfolio that has just lost that entire holding — the
 * "absent is not bad" rule from the scoring engine, in the place where breaking it looks most like
 * a catastrophe. Its cost is left out of the comparison too, so the percentage stays honest about
 * the part it could actually measure.
 */
export function portfolioTotals(positions: Position[]): PortfolioTotals {
  let costBasis = 0;
  let value = 0;
  let realised = 0;
  let partial = false;

  for (const p of positions) {
    realised += p.realised;
    if (p.quantity <= 0) continue;
    if (p.value == null) {
      partial = true;
      continue;
    }
    costBasis += p.costBasis;
    value += p.value;
  }

  const unrealised = value - costBasis;
  return {
    costBasis: round(costBasis, 6),
    value: round(value, 6),
    unrealised: round(unrealised, 6),
    unrealisedPct: costBasis > 0 ? unrealised / costBasis : null,
    realised: round(realised, 6),
    partial,
  };
}

/** Every asset id that appears in the book, so the page knows what to price. */
export function assetsHeld(lots: Lot[]): string[] {
  return [...new Set(lots.map((l) => l.assetId))];
}
