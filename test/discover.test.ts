// Discover's own risky half: telling "new to the list" apart from "score changed", and keeping
// stablecoins out of a scan built to notice something worth a glance.

import { test } from "node:test";
import assert from "node:assert/strict";

import { diffAgainstPrevious, isStablecoinId, STABLECOIN_IDS } from "../src/discover.ts";

test("a coin absent from yesterday is NEW, not a delta computed against zero", () => {
  // ⚠️ THE DEFECT THIS GUARDS. Treating an absent baseline as 0 would report every fresh entrant
  // to the scan as a massive score jump — "composite rose 71 points!" — when the truth is simply
  // that the app has no memory of this coin yet. That is a materially different, and misleading, fact.
  const today = [{ id: "solana", composite: 71 }];
  const out = diffAgainstPrevious(today, []);
  const s = out.get("solana");
  assert.ok(s);
  assert.equal(s?.isNew, true);
  assert.equal(s?.delta, null, "a new coin must not be handed a fabricated delta");
});

test("an unchanged coin gets a genuine, signed delta against yesterday", () => {
  const today = [{ id: "bitcoin", composite: 68 }, { id: "ethereum", composite: 40 }];
  const yesterday = [{ id: "bitcoin", composite: 50 }, { id: "ethereum", composite: 52 }];
  const out = diffAgainstPrevious(today, yesterday);
  assert.equal(out.get("bitcoin")?.delta, 18);
  assert.equal(out.get("bitcoin")?.isNew, false);
  assert.equal(out.get("ethereum")?.delta, -12, "a fall must keep its sign, not just its size");
  assert.equal(out.get("ethereum")?.isNew, false);
});

test("diffing against no previous snapshot at all marks everything new", () => {
  // Day one of the scan, or a run where yesterday's file failed to load — every coin is
  // legitimately new-to-the-app in that case, not a silent crash or a fabricated zero baseline.
  const today = [{ id: "bitcoin", composite: 60 }];
  assert.equal(diffAgainstPrevious(today, null).get("bitcoin")?.isNew, true);
  assert.equal(diffAgainstPrevious(today, undefined).get("bitcoin")?.isNew, true);
});

test("a coin that drops OUT of today's scan produces no entry at all", () => {
  // diffAgainstPrevious is keyed by TODAY's list — something present only in yesterday's snapshot
  // (fell out of the top ranks, or was delisted) must not appear in the output pretending to still
  // be scanned today.
  const today = [{ id: "bitcoin", composite: 60 }];
  const yesterday = [{ id: "bitcoin", composite: 55 }, { id: "dogecoin", composite: 40 }];
  const out = diffAgainstPrevious(today, yesterday);
  assert.equal(out.size, 1);
  assert.equal(out.has("dogecoin"), false);
});

test("well-known stablecoins are recognised for exclusion, ordinary coins are not", () => {
  assert.ok(isStablecoinId("tether"));
  assert.ok(isStablecoinId("usd-coin"));
  assert.ok(!isStablecoinId("bitcoin"));
  assert.ok(!isStablecoinId("ethereum"));
  assert.ok(!isStablecoinId("dogecoin"));
});

test("the stablecoin list is a set, not a doc comment — every id in it round-trips", () => {
  // Cheap but real: catches a typo'd id sitting in the Set that would silently never match anything,
  // which is exactly the kind of "looks like a guard, isn't one" bug this codebase watches for.
  for (const id of STABLECOIN_IDS) {
    assert.ok(isStablecoinId(id), `"${id}" is in STABLECOIN_IDS but isStablecoinId rejects it`);
  }
});
