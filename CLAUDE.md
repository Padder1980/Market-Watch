# CLAUDE.md — Market Watch project guide

This file is the shared memory for this project. **Any new Claude session reads it automatically**,
so it exists to bring a cold session fully up to speed. Read it and `README.md` before changing
anything.

## Working across two Claude accounts (read this first)

The owner switches between **two Claude accounts** (a personal one and a company Max one) when one
runs low on usage. Consequences:

- **A new session has no memory of prior chats.** This file + `README.md` + the git history ARE the
  memory. There is no other shared context.
- **The source of truth is this GitHub repo — not any Claude account.** Everything that matters is
  committed.
- **Always `git pull` before starting**, and only work from one account at a time, so two sessions
  never edit at once.

## What this is

**Market Watch** — a daily market tracker that ranks a watchlist and rates each asset out of 5
stars, **with the arithmetic behind every star visible on the same screen**. One self-contained HTML
page, no server, no runtime dependencies. Keys live in the browser and are sent only to the API they
belong to.

⚠️ **This is not Inte-Run.** It was built inside the `Padder1980/Inte-Run` repo by accident of which
repo that session was attached to, and moved here on 2026-08-06 (Inte-Run PR #2 was the holding pen;
it was closed and its branch deleted as part of the move). The two share no code, no build, no
storage keys and no tests. If you find yourself reading running-training rules, you are in the wrong
repo.

## Architecture

```
src/             pure TypeScript engine, no runtime dependencies, fully unit-tested
  indicators.ts    moving averages, RSI, drawdown, volatility, trend fit
  score.ts         the four pillars, the composite, the caps
  providers.ts     API adapters (browser fetch)
  types.ts         shared types
entry.ts         the engine's public surface, bundled to the browser global `MK`
shell.html       the page: markup, CSS, and all the UI code
build.ts         esbuild bundles `entry.ts` and inlines it into shell.html -> index.html
index.html       GENERATED — committed so it can be opened directly. Never hand-edit it.
test/            engine tests (node --test) + a browser smoke test (Playwright)
```

**The page template is a separate file (`shell.html`) on purpose.** Inte-Run's `web/app.ts` holds
its whole runtime inside one giant JS template literal, so no backtick may appear anywhere in its
runtime code — not even in a comment — on pain of a *silent* build failure. That rule fired at least
six times over there, twice hiding behind a stale build that still passed its checks. Here the HTML
lives in its own file, so the app's JavaScript is just JavaScript. **Do not "simplify" this by
moving the markup into a template literal in `build.ts`.**

## Commands

```bash
npm ci                         # once
node build.ts                  # rebuild index.html — run after ANY edit to src/, entry.ts or shell.html
npx tsc --noEmit               # typecheck (must be clean)
node --test "test/*.test.ts"   # 35 engine tests
node test/app-smoke.mjs        # 16 browser checks against the BUILT page
npm run check                  # all four, in that order
```

⚠️ **Check the build's EXIT CODE before trusting any check after it.** A failed build leaves the
previous `index.html` in place, and the typecheck, the tests and the smoke test all then pass on the
stale file. This has burned the sibling project repeatedly; there is nothing clever about it, you
just have to look.

⚠️ **The smoke test runs against the BUILT page, not the source.** It exists for the wiring unit
tests structurally cannot see. Rebuild before running it or it tests the previous build.

Playwright is global in this sandbox: `/opt/node22/lib/node_modules/playwright`, Chromium at
`/opt/pw-browsers/chromium-1194/chrome-linux/chrome`. Both paths are hardcoded in
`test/app-smoke.mjs`; on a different machine they need changing.

## The design decision worth defending: RISK CAPS, IT DOES NOT AVERAGE

`RISK_STAR_CAP` in `src/score.ts`. Very-high risk tops out at **3 stars**, high at **4**, however
strong everything else looks. The other three pillars combine into a 0–100 composite
(`WEIGHTS` = trend 0.45, analyst 0.25, fundamentals 0.30); risk is applied afterwards as a ceiling.

If risk were averaged in like the others, a 90-on-trend and a 20-on-risk would blend to a
comfortable-looking 55 — and the number that matters most to someone deciding what they can afford
to lose would be cancelled out by the number that excited them. **A cap cannot be cancelled out.**
On realistic test data Bitcoin scores 84 on trend, which is 5-star territory, and comes out at 4.

The owner's stated position is that he will not invest money he cannot afford to lose. This
mechanism is that sentence expressed in arithmetic. Do not turn it into a fourth weighted input.

## Two calibrations, without which everything scores well

Both in `src/score.ts`, both load-bearing:

- ⚠️ **`TARGET_NEUTRAL = 0.12`.** Analyst 12-month price targets sit roughly **10–15% above spot
  permanently**, in good markets and bad. Implied upside is scored against that baseline, not
  against zero, so a target implying +12% reads as *ordinary* rather than bullish.
- ⚠️ **`CONSENSUS_NEUTRAL = 3.8`.** Buy ratings hugely outnumber sells, so a genuinely average stock
  carries a consensus near 3.8 on the 1–5 scale. Mapping 3.0 to neutral would flatter almost
  everything an analyst covers.

Without these two the Forecasts pillar scores nearly every covered asset well and the ranking is
worthless.

## Rules in the engine, each of which cost a real defect

- ⚠️ **A missing signal is `null`, NEVER `0`.** Bitcoin has no revenue growth and no analyst
  coverage; scoring those as zero ranks it below a mediocre listed company for being a different
  kind of asset. The composite renormalises over whatever is present.
- ⚠️ **The UI must honour that too.** An unavailable pillar renders hatched and italic as `n/a` —
  never as an empty bar, which reads as a score of zero and would undo the whole null-handling
  contract at the last possible moment. The smoke test asserts this.
- ⚠️ **An UNMEASURABLE risk is the HIGHEST band, and volatility is the gate.** `profileRisk` banded
  an unknown asset LOW: `maxDrawdown` happily returns a real number from two data points, and for
  anything that has only ever risen that number is 0% — the safest possible reading. A three-day-old
  listing ranked safer than a gilt fund. Exactly the "absent reads as good" trap this module exists
  to prevent, reintroduced inside it. Volatility needs 20 sessions, so volatility decides.
- ⚠️ **Overextension is measured against the asset's OWN history (`stretchPercentile`), not by RSI.**
  RSI measures "has it been rising", not "is it overextended", and those come apart badly: a
  low-volatility steady climber sits at RSI 85+ permanently and was docked every single day for
  trending reliably. Measured, a steady riser scored 58 against a violently choppy one on 77 at
  *identical* six-month returns. `stretchPercentile` self-calibrates and needs no per-asset
  constants.
- ⚠️ **A tidy decline is not rewarded for being tidy** — trend quality only counts when the slope is
  positive. And **R² measures direction consistency, not calmness**: "the rise has been steady
  rather than erratic" once printed directly above "annualised volatility 47%". The copy now says
  what R² actually measures.
- ⚠️ **A negative P/E is not "cheap"** — it means the company is losing money. Fed into a
  lower-is-better ramp it scored as the best value on the list.
- ⚠️ **Thin evidence caps the stars.** Five stars cannot be earned off one pillar and 40 days of
  history. "We don't know much about this" must never present as "this looks great".
- ⚠️ **The cache stores SNAPSHOTS, not verdicts.** Re-scoring on load costs nothing and means an
  engine change takes effect immediately; cached verdicts would leave yesterday's arithmetic on
  screen with no way to tell it from today's.
- ⚠️ **Assert RENDERED GEOMETRY, not attributes.** Every pillar bar shipped rendering *empty* in the
  first build: `.fill` sits inside a grid item rather than being one, so it stayed `display: inline`
  and both width and height were ignored. The markup was right, the inline style said `width: 82%`,
  and the bar was invisible. Unit tests could not see it and the smoke test checked the number
  beside it — only a screenshot showed it. The smoke test now measures the drawn box.
- ⚠️ **`pct()` already carries the sign**, so a direction word beside it needs the absolute value or
  you print "Price is -1.4% below its 50-day average", which states the opposite of what it means.

## Deliberately not built — do not add these

- **No price predictions, no "buy now", no trading signals.** Any answer to those is a guess dressed
  up as analysis.
- **No headline sentiment scraping.** The FT, Reuters and Bloomberg overwhelmingly do not publish
  price predictions — they report events. What exists in machine-readable form is sell-side analyst
  data, which is what the Forecasts pillar reads. Counting optimistic adjectives in headlines would
  produce a number that looked like the same thing and meant nothing.
- **No portfolio, no position sizing, no "how much should I put in".** That is a conversation, not a
  number.

## Data

Everything is fetched in the browser, straight from the API. No server in the middle; no key leaves
the device except to the API it belongs to. Keys live in `localStorage` under `mkt_*`.

| Source | Key needed? | Gives |
|---|---|---|
| CoinGecko | No | Crypto price history — works with no signup |
| Twelve Data | Free key | Daily price history for shares and funds |
| Finnhub | Free key | Analyst recommendations and company financials |

⚠️ **Provider choice was forced by CORS, not quality.** Stooq's CSV, Yahoo's chart endpoint and the
FT/Reuters RSS feeds all refuse to be read from a page — no `Access-Control-Allow-Origin`. Reaching
them needs a proxy server holding a key, which this deliberately does not have.

⚠️ **Free tiers are tight** — Twelve Data allows 8 requests a minute. The loader is therefore
deliberately **sequential with an 8-second gap between shares**, and results are cached. Do not
"optimise" it into parallel requests: that rate-limits every row at once and the screen looks broken.

## THE OWNER'S BITCOIN RESEARCH HIERARCHY (supplied 2026-08-06) — the intended direction

He supplied a ranked source list and an evidence hierarchy for Bitcoin. **None of it is implemented
yet.** It is recorded here verbatim in substance because it is the clearest statement of what he
wants this app to become, and because a cold session would otherwise rebuild the wrong thing.

⚠️ **IT SPLITS INTO THREE PILES AND THEY ARE NOT INTERCHANGEABLE.** Treating it as one wish-list is
the mistake to avoid — two thirds of it cannot be, or should not be, code in this app.

**Pile 1 — news outlets. NOT BUILDABLE HERE, AND HE ALREADY AGREES.**
Tier 1: CoinDesk, The Block, Blockworks, Bitcoin Magazine, Decrypt. Tier 2: Bloomberg, FT, Reuters,
WSJ, CNBC. Every one is CORS-blocked from a static page (the same wall documented above), and
scoring their headlines is the "no sentiment scraping" decision this app was built on. His own list
says the same thing twice — *"Ignore: headlines lacking on-chain or macro support"* and *"Ignore:
price predictions without methodology"*. Do not build a sentiment pillar. If news is ever wanted it
is as a **linked reading list**, not as a number.

**Pile 2 — the data. THIS IS THE REAL WORK, and it is the one he asked to prototype.**
His Tier 3 and his `SignalPriority`, in his order of importance:

1. ETF inflows/outflows
2. Institutional purchases
3. Exchange reserves
4. On-chain activity
5. Macro (rates, USD, liquidity)
6. Regulation
7. Corporate adoption
8. Miner behaviour

Named sources: Glassnode, CryptoQuant, Messari (on-chain/flows); Ark Invest, Fidelity Digital
Assets, Bitwise (research, PDF — not machine-readable, treat as reading, not as a feed).

⚠️ **These are FACTS WITH DATES, which is the only kind of input this engine accepts.** They fit the
existing architecture: a new pillar, scored `null` when absent, renormalised over what is present.
⚠️ **Whatever is added must clear the same two gates as everything else** — reachable from a browser
without a proxy, and free enough for a real watchlist. Check both before designing around a source.

**Pile 3 — the method. ALREADY THE APP'S DESIGN, and partly not code at all.**
*"Weight evidence over opinions."* Evidence hierarchy: on-chain data > institutional flows > macro >
regulation > news > social sentiment. Forecasts must state assumptions, cite data, carry uncertainty
and avoid certainty language.

That hierarchy is **already what `WEIGHTS` and the pillar design express**, and the "avoid certainty
language" rule is already enforced by the no-predictions decision. His `OutputRule` (summarise
consensus, bullish vs bearish, rate evidence 1–10, estimate probability, separate fact from opinion,
cite the source) is written **for an assistant in conversation, not for a static page** — a page
cannot read the FT and form a view. ⚠️ Do not try to make the app emit that report; it would have to
fabricate the inputs. The one piece that DOES belong in the app is **citing the original source
beside every number**, which the working-shown design already does.

## Storage keys

`mkt_watchlist_v*`, `mkt_keys_v*`, `mkt_currency_v*`, `mkt_sort_v*`, `mkt_cache_v*`, `mkt_theme_v*`.
Renaming any of them orphans the user's watchlist and settings.

## Known limits — stated in the README, keep them stated

- **Momentum ranking buys tops.** Sorting by what went up recently is a real market factor and also
  how people arrive late to a run. The overextension penalty and the risk cap push back; they do not
  eliminate it.
- Everything is backward-looking.
- Fundamentals are six metrics from one free provider with **no sector comparison** — a P/E of 30
  means different things for a utility and a software company, and the engine does not know which it
  is looking at.
- **There is no correlation view.** Five 5-star holdings that all move together is one bet, not five,
  and nothing here would say so.
- UK tax, fees and platform choice are out of scope.

**Not advice, not a forecast, and no substitute for a regulated UK adviser.** Nothing in this app may
be phrased as a recommendation to buy or sell.

## Current status

Migrated from Inte-Run and standing on its own: build clean, `tsc --noEmit` clean, 35 engine tests
passing, 16 browser smoke checks passing. Nothing has changed functionally since the original build —
the move restructured `market/engine/*` to `src/*`, lifted the rest to the repo root, repointed the
relative imports, and gave the project its own `package.json`, `tsconfig.json` and `.gitignore`.

Update this section as you go.
