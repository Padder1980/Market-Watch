// Discover: scanning a wider universe of coins than the owner's own watchlist, so something they
// never thought to type in can still surface. Pure logic only — no fetch — so the risky half (does
// "changed since yesterday" mean what it claims to mean) is unit-testable offline, same pattern as
// `flows-parse.ts` and `holdings.ts`.
//
// ⚠️ THIS RANKS BY EVIDENCE, NEVER BY "WILL THIS GO UP". `rateAsset` already refuses to be a
// forecast; Discover's whole job is to widen WHICH coins get that same honest arithmetic applied,
// never to add a second, looser standard for coins outside the watchlist. A "top picks" list built
// from raw price gainers is how people are walked into buying tops — the exact mechanism this
// project's own README warns about. Rank by `composite`/`stars` (the SAME fields Ratings sorts by),
// never by 24h or 7d price change alone.

/**
 * Well-known stablecoins, by CoinGecko id. Excluded from Discover, not hidden from the app
 * generally — a stablecoin can still be added to the ordinary watchlist and scored like anything
 * else; it is simply never something to "notice" here.
 *
 * ⚠️ WHY THIS EXCLUSION IS NOT A JUDGEMENT CALL ABOUT WHETHER TO OWN ONE. Trend and Risk exist to
 * ask "is this climbing, and how violently does it move?" — a stablecoin's entire design point is
 * to answer "no" and "barely" by construction. Scoring it through this engine doesn't inform
 * anything; it just prints a permanently dull card that crowds out the coins the engine actually
 * has something to say about. This is a scope filter, not a quality judgement.
 */
export const STABLECOIN_IDS: ReadonlySet<string> = new Set([
  "tether",
  "usd-coin",
  "dai",
  "true-usd",
  "paxos-standard",
  "gemini-dollar",
  "first-digital-usd",
  "paypal-usd",
  "ethena-usde",
  "usdd",
  "frax",
  "binance-usd",
]);

export function isStablecoinId(id: string): boolean {
  return STABLECOIN_IDS.has(id);
}

export interface DiscoverComposite {
  id: string;
  composite: number;
}

export interface DiscoverDelta {
  /** `today.composite - yesterday.composite`, or null when there is nothing to compare against. */
  delta: number | null;
  /** True when this id was not present in the previous snapshot at all — genuinely new to the list. */
  isNew: boolean;
}

/**
 * Compare today's scan against yesterday's stored one, coin by coin.
 *
 * ⚠️ "NEW TO THE LIST" AND "SCORE ROSE" ARE DIFFERENT FACTS, AND MUST NOT BE CONFLATED. A coin
 * absent from yesterday's snapshot has no baseline — giving it `delta = todayComposite - 0` would
 * report every fresh entrant as a massive, exciting jump, when the truth is just "the app has no
 * memory of this coin yet". `isNew` is a separate flag for exactly that case, and `delta` stays
 * `null` rather than being filled in with a number that would mislead by construction.
 */
export function diffAgainstPrevious(
  today: DiscoverComposite[],
  previous: DiscoverComposite[] | null | undefined,
): Map<string, DiscoverDelta> {
  const prevById = new Map((previous ?? []).map((p) => [p.id, p.composite]));
  const out = new Map<string, DiscoverDelta>();
  for (const t of today) {
    const prev = prevById.get(t.id);
    if (prev == null) {
      out.set(t.id, { delta: null, isNew: true });
    } else {
      out.set(t.id, { delta: t.composite - prev, isNew: false });
    }
  }
  return out;
}
