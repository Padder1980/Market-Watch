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
  score.ts         the pillars, the composite, the caps
  providers.ts     API adapters (browser fetch)
  flows-parse.ts   pure parsers for the paper round's HTML, + flowStatsFor (shared file reader)
  discover.ts      pure diffing/filtering for the nightly market scan
  holdings.ts      the transaction book: average-cost pooling, value, gain
  types.ts         shared types
tools/           NOT shipped to the browser, run directly via `node tools/x.ts`
  paper-round.ts          the daily robot: reads free pages server-side, writes data/flows.json
  discover-round.ts       the nightly market-cap scan (crypto): writes data/discover.json
  discover-round-shares.ts  the nightly curated-list scan (shares): writes data/discover-shares.json
data/flows.json          committed by the paper round; the page fetches it from its own origin
data/discover.json       committed by the crypto discover round; same relative-URL pattern
data/discover-shares.json  committed by the shares discover round; same pattern, needs its own
  TWELVE_DATA_KEY/FINNHUB_KEY GitHub Actions secrets to run at all — see the Discover-for-shares
  section below
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
npx tsc --noEmit               # typecheck (must be clean — covers tools/ too, not just the browser bundle)
node --test "test/*.test.ts"   # 83 engine tests
node test/app-smoke.mjs        # 56 browser checks against the BUILT page
node tools/paper-round.ts --dry     # the daily flows robot, without writing anything
node tools/discover-round.ts --dry  # the nightly market scan, without writing anything
npm run check                  # build + typecheck + tests + smoke, in that order
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
(`WEIGHTS` = trend 0.45, then two paired slots: analyst/flows 0.25 and fundamentals/network 0.30);
risk is applied afterwards as a ceiling.

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

### THE PAPER ROUND — how pile 2's "unreachable" data is reached (2026-08-06)

⚠️ **"IT NEEDS A PAID SUBSCRIPTION" WAS TOO QUICK, AND THE OWNER WAS RIGHT TO PUSH BACK.** Farside
publishes the full daily US spot ETF flow table free, and the treasuries pages publish holdings free.
What costs money is the *machine-readable API*, not the numbers. What blocks the app from reading the
free pages is CORS — **and the CORS rule exists only inside browsers.**

So: `.github/workflows/paper-round.yml` runs `tools/paper-round.ts` on GitHub's servers once a day,
reads those pages server-side, and commits `data/flows.json` into this repo. The page fetches
`./data/flows.json` **from its own origin**, where no permission is needed. The app still scrapes
nothing, holds no key, and has no server. Cost: £0.

⚠️ **A RELATIVE URL IS LOAD-BEARING.** `./data/flows.json` resolves against wherever the page is
served from — Pages, a local file, a Home Screen copy — so all three keep working. An absolute URL
would make every local copy phone home AND reintroduce the cross-origin problem this design exists
to avoid.

⚠️ **THE ROBOT MUST REFUSE TO WRITE RATHER THAN WRITE A GUESS.** A scraper's failure mode is not an
error, it is a plausible wrong number inheriting the trust the right one had. Hence
`checkFlowSanity()` (in `src/flows-parse.ts`, moved there 2026-08-07 so it is finally unit-tested):
row count, newest-date age, and a magnitude band no real daily net flow has approached. A rejection
names what it saw and exits non-zero so the Action goes red; the previous file is left untouched.

⚠️ **THE GATE'S OWN FIRST VERSION COULD NEVER BE SATISFIED, AND IT TOOK FIVE STUCK RUNS PLUS TWO REAL
ONES TO FIND OUT.** It demanded ≥100 rows in the merged total, on the assumption the "all data" page
would always supply hundreds in one request. On 2026-08-07 that page started returning **HTTP 403**
(bot-blocking — the shorter "current" page on the same domain answered fine, so it is not a parser
fault). Every run then fell back to the short table's real ~14–15 rows — and because a REJECTION
never lets `mergeDaily` take effect, day one's rows were rejected, day two started from zero stored
history and hit the identical rejection. Forever. The floor is now 5 rows: enough to know a real
table was parsed, not a demand that a decade of history arrive in one request.

⚠️ **DELIBERATELY NOT SPOOFING A BROWSER TO GET PAST THE 403.** The identifiable, courteous
User-Agent below is a stated design choice; evading a site's own bot-blocking after it has said no
is the opposite of that. The merge-based accumulation from the short page is the honest fallback,
and fixing the gate above is what makes it actually work.

⚠️ **THE COMMIT STEP HAD ITS OWN BUG, INVISIBLE UNTIL THE PARSER FINALLY SUCCEEDED.**
`git diff --quiet -- data/flows.json` is blind to a file git has never tracked — untracked files
are outside plain `git diff` entirely, so a BRAND NEW file reads as "no difference" and the step
exits without committing. The first fully-successful run (2026-08-07, 15 real flow rows, exit 0,
"Wrote ... (15 flow rows...)") still logged "No change to data/flows.json" and pushed nothing,
because `data/flows.json` did not exist in the repo yet. Fixed by `git add` BEFORE the check, then
`git diff --cached --quiet` — staging makes a new file visible to the diff. A guard that only proves
itself on a MODIFIED file, never on a file's first appearance, is not proven at all; this bug could
not have been caught by re-running against the same already-existing fixture-committed file.

⚠️ **AND THE APP MUST NOT TRUST A STALE FILE EITHER.** `FLOWS_STALE_DAYS` (7) makes `scoreFlows`
refuse data older than a week. Without it, June's inflow keeps earning August's stars for as long as
nobody notices the robot stopped delivering. Broken looks broken twice: red Action, then `n/a`.

⚠️ **MERGE, NEVER REPLACE.** The short table carries only recent days. Replacing with it would throw
away the history the rolling windows self-calibrate against, and the pillar would go quiet for weeks
with nothing in the logs to explain it.

⚠️ **THE CORPORATE CHANGE IS DERIVED FROM OUR OWN SNAPSHOT LOG, NOT FROM THE PAGE.** One reading is a
level, not a movement, and nobody publishes "BTC added this month" machine-readably. The robot logs a
level a day and the change appears once two readings sit ≥14 days apart. **It is empty on day one by
design**, and `scoreFlows` says so on screen rather than scoring a number it does not have.

⚠️ **PARSER RULES.** Only rows whose FIRST cell is a date enter the series — the table ends with
Total / Average / Maximum / Minimum rows whose last cell is also a number, and taking rows by
position gains a "day" worth two and a half years of flows. Parentheses are a MINUS SIGN; read as
positive, a day of heavy selling becomes a day of heavy buying. `parseTreasuriesTotal` is
deliberately strict and allowed to fail (600k–3,000k BTC band) — loosening it to "first big number
on the page" is how a market cap becomes a holdings figure with nobody noticing.

⚠️ **THE ETF PARSER NOW WORKS AGAINST THE REAL PAGE (verified 2026-08-07). THE TREASURIES ONE
DOESN'T, AND HERE IS WHAT IS ACTUALLY KNOWN, NOT GUESSED.** `treasuriesDebugSample` — added
specifically so a failure explains itself instead of needing another blind guess-and-redeploy round
— found **zero** "`<number> BTC`"-shaped text anywhere in bitbo.io/treasuries/'s 462,808 bytes. That
is a different failure from a formatting mismatch (which would show candidates, just out of band or
oddly punctuated): it means the total is most likely rendered by client-side JavaScript that a plain
server-side `fetch()` never executes, so the number the browser shows you was never in the HTML this
robot receives. **Do not "fix" this by loosening the regex** — there is nothing of the right shape
on the page to loosen the regex onto. If this is ever revisited, it needs either a different source
that serves the figure as static HTML, or a headless-browser fetch (a materially bigger dependency
than this project has taken on anywhere else). Left as `n/a`, honestly, rather than guessed at.

⚠️ **BE A GOOD CITIZEN.** These are free publishers doing us a favour. One request a day, an
identifying User-Agent naming the repo, and if any of them object the paid API is the proper route.

### The Flows pillar

`scoreFlows` reads what the paper round delivers. Two components: rolling 5-day and 20-day net ETF
flow, and the change in public-company holdings.

⚠️ **IT SITS IN THE ANALYST SLOT ON MERIT.** Both answer "what do the professionals think?" —
analysts by stating a view, allocators by moving money. `WEIGHTS.flows` therefore equals
`WEIGHTS.analyst` exactly, the same pairing rule as network/fundamentals, which keeps the applicable
total at 1.0 for both asset kinds so the confidence denominator does not shift with type.

⚠️ **SELF-CALIBRATING AGAINST ITS OWN HISTORY, like `stretchPercentile`.** "Is $626m a lot?" has no
constant answer — it depends what this market's ordinary week looks like, and any hardcoded threshold
would rot as the ETFs grow. The yardstick is the median absolute rolling sum across the whole
history, scored against ±3× that.

⚠️ **THE SIGN IS PRESERVED BY CONSTRUCTION — a net outflow can NEVER score above 50.** A plain
percentile rank would break this: in a year dominated by outflows, "less bad than usual" ranks high
while money is actually leaving. Same direction-inversion trap the running app's flags engine
documents, in a new place. A test asserts it.

⚠️ **Crypto's `missing` list changed again**, consistently: analysts do not cover crypto and never
will, so for a crypto asset the absent thing in that slot is the FLOW data, not analyst forecasts.

### What is BUILT of pile 2 (prototype, 2026-08-06): the Network pillar

`scoreNetwork` + `fetchBitcoinNetwork` cover **signals 4 and 8** — on-chain activity and miner
behaviour — from Blockchain.com's charts API: free, no key, and browser-readable via `&cors=true`.
Three inputs: hash rate, daily transactions, daily active addresses.

⚠️ **`&cors=true` IS WHY THIS SOURCE IS USABLE AT ALL.** Without it the endpoint sends no
`Access-Control-Allow-Origin` and the browser discards the response before the app sees it. The
smoke test asserts the parameter is on the URL, not just the host — drop it and the pillar goes
permanently absent in real use while every stubbed check keeps passing.

⚠️ **BITCOIN ONLY, AND THE GATE IS LOAD-BEARING.** Blockchain.com indexes the Bitcoin chain and
nothing else, so calling it for Ethereum returns *Bitcoin's* numbers under Ethereum's name — a wrong
answer indistinguishable from a right one. `fetchBitcoinNetwork` returns null for any other id.

⚠️ **`network` AND `fundamentals` ARE ONE SLOT, AT EQUAL WEIGHT (0.30 each).** A company has accounts
and no chain; a crypto asset has a chain and no accounts. Equal weights keep the applicable total at
1.0 for both kinds, so the **confidence denominator does not change with asset type** — and the
denominator is per-kind for the same reason. Divide crypto by every weight that exists and its
confidence caps at 70% of the truth, at which point `starsFor`'s confidence cap docks its stars for a
gap that is not a gap.

⚠️ **NOT APPLICABLE IS NOT MISSING, and only one of the two is a caveat.** Crypto no longer reports
"company fundamentals" as missing — Bitcoin will never have accounts, and a permanent "the picture is
partial" note for an unfillable gap trains the reader to ignore the caveat that matters. Equities
likewise never report the network pillar as missing. `test/score.test.ts` locks both directions.

⚠️ **USD MINER REVENUE IS DELIBERATELY EXCLUDED**, and it is the obvious fourth input. It is block
reward × price, so it rises whenever the price rises — add it and the Network pillar silently
re-scores what Trend has already scored, and the composite double-counts one signal while looking
like it averaged two.

⚠️ **HASH RATE IS BANDED ASYMMETRICALLY** (`ramp(-0.10, 0.20)` against `±0.15` for the activity
measures). Hash rate grows across cycles as hardware improves, so routine growth is unremarkable
while any sustained fall means miners are powering machines down — a signal that costs real money to
send. Scored symmetrically, ordinary growth reads as strength.

⚠️ **SMOOTHED, NOT POINT-TO-POINT.** `windowChange` compares 30-day means at each end of the window.
Daily transaction counts swing 30% on one busy weekend or one exchange changing its batching;
first-vs-last would report a quarter's trend from two arbitrary days, with a confident bar beside it.

⚠️ **A FAILED ENRICHMENT MUST NOT TAKE THE ROW DOWN.** `chartSeries` swallows its errors and returns
null; the price fetch is the load-bearing one. An asset the user can still see beats a row that
failed on an extra.

**Still NOT built: exchange reserves (his #3).** ETF flows (#1) and institutional purchases
(#2) are now delivered by the paper round above. Reserves are the one that resisted: the free views
live inside chart pages (CryptoQuant, CoinGlass) rather than in an HTML table, so there is nothing
for a parser of this kind to read, and the APIs are paid — Glassnode's is a Professional-plan add-on
(historically ~$999/month; the $49 Advanced tier allows 50 calls a DAY and the free tier has no API
key at all). **Do not approximate it with something free that answers a different question** — a
cheaper proxy for "are coins leaving exchanges?" that really measures something else is worse than
the honest `n/a`. A same-shaped paper-round parser is the route if a readable free source is found.

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

## My holdings — a record, and why it does not break the no-advice rule

`src/holdings.ts` + the second tab. The owner asked to track what he bought and how its value moves.

⚠️ **THE README RULES OUT "no portfolio, no position sizing" AND THIS DOES NOT BREACH IT.** That ban
is on the app telling him what to DO with money. Writing down what he already bought and multiplying
it by today's price is a statement of fact. Nothing on that page may cross back: no "time to take
profits", no targets, no rebalancing, no alerts framed as prompts to act.

⚠️ **A SELL REDUCES THE COST BASIS PROPORTIONALLY, NEVER BY ITS PROCEEDS.** Subtract what was
received and the surviving units carry a cost unrelated to what was paid — measured in the test: 2
BTC at £30k, half sold at £60k, proceeds-subtraction leaves the remaining coin with a cost basis of
**£0**, printing as an infinite gain on a coin that cost £30,000. Take out the same fraction of the
pool as the fraction of units sold.

⚠️ **FEES IN ON THE WAY IN, OFF ON THE WAY OUT.** Omitting them flatters every position by exactly
what the platform charged — the one error a holdings page has no excuse for.

⚠️ **A SELL LARGER THAN THE HOLDING IS A TYPO: sell what exists and SAY SO.** Letting the quantity go
negative invents a short position the owner never took and poisons every total below it while looking
like an ordinary row.

⚠️ **AN UNPRICED HOLDING MAKES THE TOTAL PARTIAL — it is never counted as zero.** The same
absent-is-not-bad rule as the scoring engine, in the one place where breaking it looks like a
catastrophe: a failed price fetch would report a portfolio that had just lost that holding outright.

⚠️ **NOT A TAX FIGURE, AND THE UI SAYS SO.** UK CGT uses Section 104 pooling plus same-day and 30-day
matching. Average cost is the honest answer to "what did mine cost me"; quietly approximating HMRC's
rules for someone filing a return would be worse than not offering the number.

Other guards: transactions pool in DATE order not entry order (typing yesterday's trade in after
today's must not change the answer); a zero cost basis yields a null percentage rather than
`Infinity%`; fully-sold positions clear their floating-point crumbs so 1e-17 units do not print as a
holding. Stored in `mkt_holdings_v1`.

## Running the paper round on demand

⚠️ **THE APP STRUCTURALLY CANNOT START THE ROBOT ON ITS OWN, and that is not a limitation to
engineer around.** Asking GitHub to run a workflow needs a credential; this page is public, so
anything baked in is published to everyone. Two honest routes, and `runPaperRound` picks whichever
applies:

1. **No token** — opens the workflow's page on GitHub, where the owner presses Run. Zero secrets.
2. **His own fine-grained token**, stored in `keys.github` beside the market-data keys and sent only
   to `api.github.com`. The settings copy insists on **fine-grained, this repo only, Actions: read
   and write**. ⚠️ **A classic token must never be used here** — it could push code; a fine-grained
   one scoped that way can do nothing but run this workflow. Do not relax that copy.

⚠️ **204 No Content IS THE SUCCESS RESPONSE** and carries no body. Checking for 200, or for JSON,
reports a working trigger as a failure every single time.

The workflow also has a **08:10 UTC retry** alongside the 21:40 run. It is a retry, not a second
reading: the commit step only commits an actual change, so a successful evening makes it a no-op,
and a night when the site was slow heals by breakfast instead of leaving the pillar stale all day.

## Ethereum joined Bitcoin (2026-08-08)

The owner asked to widen coverage to "all cryptocurrency" and to invest something himself: he wants
"the intelligence that brings all the relevant information to my attention," not a system that names
winners. See the next section for the feature that answered THAT half of the request; this one
covers the more literal "add more coins" half.

**What actually generalised, and what didn't — decided by what genuinely exists to be measured, not
by ambition:**
- **Trend + Risk already worked for any CoinGecko-listed coin.** No change needed — anything added to
  the watchlist via Settings was already scored on these two. Worth saying out loud: the owner did
  not know this was already true.
- **Flows now covers Ethereum too**, because it genuinely has a US spot ETF and Farside genuinely
  publishes `farside.co.uk/eth/` in the identical table shape to Bitcoin's page. `ETF_ASSETS` in
  `tools/paper-round.ts` is the whole change — add a coin's id + its two Farside URLs and the
  existing parser, sanity gate and merge logic apply unchanged.
- **Network stays Bitcoin-only, and this is a wall, not a gap to close later.** Ethereum has had no
  hash rate since the 2022 Merge to proof-of-stake, so there is no equivalent to measure the same
  way. Etherscan's daily transaction-count history — the obvious substitute — is gated behind their
  paid Standard plan, confirmed by search before writing any code. **Do not force a weaker or paid
  signal in to fill this gap**; same rule as the corporate-treasuries dead end.

⚠️ **`data/flows.json` IS NOW KEYED BY ASSET, AND ONE FUNCTION READS IT BACK FOR BOTH CALLERS.**
`flowStatsFor(raw, id)` in `src/flows-parse.ts` turns the committed file into one coin's `FlowStats`,
called both by the browser (`fetchFlows`, after a `fetch()`) and by the nightly Discover scan (after
a plain `readFileSync` — no HTTP round trip needed when the file is already on the same disk). Parsing
"what does this JSON mean for asset X" is shape logic, not network logic, and writing it twice is how
the two versions drift. Corporate holdings stay a single top-level field, attached only when
`id === "bitcoin"` — that phenomenon barely exists yet for any other coin.

⚠️ **THE FIRST COMMITTED FILE PREDATES THIS SCHEMA, AND THE ROBOT MIGRATES IT ITSELF.** The real
15-row Bitcoin scrape from 2026-08-07 was written in the old flat shape (`etfDaily` at the top
level). `readStored()` in `tools/paper-round.ts` detects that shape on read and folds it into
`assets.bitcoin` before anything else runs — without this, the very history the accumulation design
exists to build gets thrown away by a schema change instead of a sanity gate, which is the sibling of
the accumulation-deadlock bug from the day before, wearing a different cause.

## Discover — the owner's actual request, and the line drawn to build it responsibly

He said it in as many words: *"I want you to be the intelligence that brings all the relevant
information to my attention so that I can make an informed decision."* That is a real, legitimate
ask and materially different from "tell me what to buy," which was separately and explicitly
declined in the same conversation. The distinction is the entire design brief for this feature:

⚠️ **DISCOVER RANKS BY THE SAME EVIDENCE THE WATCHLIST USES, NEVER BY RAW PRICE MOVEMENT.**
`tools/discover-round.ts` imports `rateAsset` UNCHANGED — there is no second, looser scoring pass for
coins outside the watchlist. A "top gainers" list built from 24h price change is precisely the
mechanism this project's own README already warns about (*"momentum... is also the mechanism by
which people buy tops"*), and building one to answer "surface things I might not notice" would
smuggle the declined recommendation-engine back in wearing a different name. Sorting is by
`stars * 1000 + composite` — the exact fields `rankRatings`'s default sort already uses.

⚠️ **THE UNIVERSE IS RANKED BY MARKET CAP, NOT BY ANY OPINION.** `fetchTopByMarketCap` takes
CoinGecko's `order=market_cap_desc` as-is. Hand-picking which ~20 coins get shown would itself be a
curatorial, semi-advisory act — "we chose to show you these and not those" is a judgement call by
another name. Ranking by an objective, external, already-public number sidesteps that entirely.

⚠️ **STABLECOINS ARE EXCLUDED, AND IT IS A SCOPE FILTER, NOT A QUALITY JUDGEMENT.** `STABLECOIN_IDS`
in `src/discover.ts`. A stablecoin's entire design point is to not move, so Trend/Risk have nothing
to say about one — including it just crowds out coins the engine can actually inform. Do not read
this list as "coins we think are bad"; it is "coins this specific engine cannot evaluate at all."

⚠️ **"NEW TO THE LIST" AND "SCORE ROSE" ARE DIFFERENT FACTS, PROVEN WRONG BEFORE IT SHIPPED.**
`diffAgainstPrevious` in `src/discover.ts` was written test-first specifically because the naive
version — treat an absent yesterday as a baseline of 0 — reports every fresh entrant as a huge score
jump, which is not true, it is just a coin the app has no memory of yet. `isNew` is a separate flag;
`delta` stays `null` rather than being filled with a number that misleads by construction. Six tests
in `test/discover.test.ts` hold this apart, including the case of a coin dropping OUT of today's scan
(must produce no entry at all, not a phantom one).

⚠️ **THE CARD SHOWS "EVIDENCE CHANGED", NOT "PRICE CHANGED", AS ITS OWN SIGNAL.** `discoverCardHtml`
in `shell.html` badges `deltaComposite` (the app's own read of the coin shifting) separately from the
ordinary daily price change already shown above it — repeating a price move as if it were new
information would be exactly the thing this feature is supposed to avoid — dressing up an ordinary
price move as something more than it is. The threshold is ±5 composite points; smaller drift is
noise, not a notice.

⚠️ **COMPUTED SERVER-SIDE, ONCE A DAY, NOT ON EVERY OPEN.** `tools/discover-round.ts` fetches one
`coins/markets` call for the market-cap list, then ~18 sequential `market_chart` calls (paced and
retried against a REAL measured rate limit, not a guess — see the next section) and writes
`data/discover.json` — a compact, PRE-SCORED
`DiscoverEntry[]`, not raw price history. The client fetches this once per session
(`state.discoverEntries`, populated lazily when the tab is first opened) and renders it directly; it
never re-runs `rateAsset` itself for Discover entries, because that already happened server-side.
Sending 365 days of history for ~20 coins just to redraw two percentages the server already knows
would multiply the file size for nothing — `move1`/`move30` are pre-computed too.

⚠️ **ONE BAD COIN MUST NOT SINK THE WHOLE SCAN, AND THE TOP-LEVEL FAILURE MUST STILL FAIL CLEANLY.**
Two separate resilience layers, both found on this file's own first local run: a per-coin `try/catch`
inside the loop (a single delisted id or a momentary timeout is logged and skipped, not fatal to the
other 24), and a top-level `try/catch` around `main()` (the market-cap list call itself failing —
which it did immediately, this sandbox blocks CoinGecko too — produced a raw uncaught stack trace
before this was added; now it logs one clear line and exits 1). Below `MIN_SUCCESSFUL` (10) coins
scored, the run refuses to publish a thin scan at all, same "refuse to write a guess" standard as the
paper round.

⚠️ **A SEPARATE WORKFLOW FILE, DELIBERATELY, EVEN THOUGH IT COULD SHARE ONE JOB WITH THE PAPER
ROUND.** Chaining them as two steps in one job was considered and rejected: a rate-limited or flaky
Discover scan (many more requests, more surface area for a hiccup) would then risk blocking the
Flows commit too, depending on step failure semantics — the exact "a stuck run must never block the
next" lesson from the day before, applied pre-emptively instead of learned the hard way twice.
`discover-round.yml` runs at 22:15 UTC, after the paper round's 21:40, so Bitcoin/Ethereum's Discover
entries CAN pick up the same evening's fresh flow data by reading the just-committed `data/flows.json`
from disk — not guaranteed ordering across two workflows, only likely, and a day's lag if it ever
runs the other way is fine.

⚠️ **NODE'S NATIVE TYPESCRIPT EXECUTION REJECTS A SYNTAX ESBUILD ACCEPTS, AND IT WAS INVISIBLE UNTIL
THIS FEATURE.** `ProviderError`'s constructor used to declare its field with the shorthand
`constructor(message: string, readonly provider: string)`. esbuild transpiles that fine, so it was
silently OK for the entire life of this project — `providers.ts` had only ever been consumed through
the browser bundle. `discover-round.ts` is the first thing to `import` it directly into a script run
via plain `node tools/x.ts` (no build step, the same way `paper-round.ts` has always run), and Node's
"strip only" TypeScript mode throws outright on that syntax:
`TypeScript parameter property is not supported in strip-only mode`. Fixed by declaring the field and
assigning it in the constructor body — plain enough for both toolchains. **Any future `tools/*.ts`
script that imports from `src/` should be treated as a second consumer with its own constraints**,
not assumed to inherit whatever the browser bundle already tolerates.

## Two real bugs found the day the shares secrets went live (2026-08-08)

The owner added the `TWELVE_DATA_KEY`/`FINNHUB_KEY` secrets and reported two things in the same
message: the shares scan (below) worked but Forecasts came back empty everywhere, and "it's not
letting me add anything to my holdings list other than bitcoin and eth." Both were real, both are
fixed, and both are now regression-tested — see the smoke checks named for them.

### Bug 1 — the watchlist only ever saved on a button easy to never reach

`saveTx`/holdings lots have always auto-saved the instant they change (`write(K_LOTS, ...)` inside
the click handler itself). The watchlist editor didn't: `addBtn`'s and the remove button's handlers
only ever mutated `state.watch` **in memory**, and the only thing that ever called
`write(K_WATCH, state.watch)` was the separate "Save and refresh" button at the very bottom of a
scrollable sheet, past both API key fields. Tap **+**, see the new row appear, close the sheet (or
just don't scroll that far) — and the addition is gone on the next reload, with nothing on screen
ever having said so. This is almost certainly what "only bitcoin and eth" was: the default watchlist
is the only thing that was ever actually persisted. `txAssetOptions()` (the "Add a purchase or sale"
dropdown) was never the bug — it faithfully lists whatever is in `state.watch`; there was just never
enough in there to list.

Fixed by writing `K_WATCH` immediately inside both the add and the remove handlers, same as holdings
already does. "Save and refresh" still exists, for currency/key changes and to trigger an actual
price fetch — but the watchlist itself no longer depends on it.

⚠️ **THE TEST THAT SHOULD HAVE CAUGHT THIS HAD ITS OWN BUG, HIDING A SECOND, UNRELATED ONE.** Adding
a genuine "survives a reload without tapping Save" smoke check failed outright — not because the fix
was wrong, but because `test/app-smoke.mjs`'s shared `addInitScript` called `localStorage.clear()` as
its last line, and `addInitScript` **reruns before every navigation of the page, including every
`page.reload()` later in the same test file** — silently wiping any reload-persistence check in the
whole suite. `browser.newPage()` already starts from a fresh, storage-isolated context, so the clear
was never needed for the FIRST load; it was only ever live (and only ever harmful) on a reload.
Removed entirely. This also explains why the pre-existing "holdings persist across a reload" check
had never actually caught anything: its assertion was `/Worth now/i.test(...)`, and `renderHoldings`'s
own **empty-state copy** ("...this page will show what it is worth now") matches that regex too —
so the check passed identically whether or not the holding survived. Reworded to
`/against what you paid/i`, a phrase the empty state cannot produce. Same lesson Inte-Run's CLAUDE.md
already has several entries for, in a new place: a guard that cannot fail on the thing it claims to
guard is not a guard, and here it took a second, correctly-written check right next to it to expose
the first one's blind spot.

### Bug 2 — a GitHub token was discarded on every single save

`saveBtn`'s handler set `state.keys.github = gh` and then, on the very next line, replaced the whole
object with `state.keys = {}` — discarding the assignment that had just been made. A token pasted in
for one-tap "Fetch the latest flows now" never survived past the save that stored it; reopening
Settings always showed the field empty again. Not reported directly, found while reading this exact
code path to fix Bug 1. Fixed by building the new `{twelveData, finnhub, github}` object once, in one
assignment, instead of mutating-then-replacing.

### The Finnhub Forecasts finding — measured with a temporary diagnostic, not guessed

`data/discover-shares.json`'s real first run (52/52 shares scored) had `rating.analyst.score: null`
for every single one, including AAPL — obviously wrong, since AAPL has real analyst coverage. Two
candidate explanations existed: a free-tier paywall (plausible — `price-target` inside the same
`fetchConsensus` call is already known-paywalled and already handled gracefully), or something else.
`fetchConsensus` swallows every error by design, so the real cause was invisible from the committed
data alone.

⚠️ **A ONE-OFF DIAGNOSTIC SCRIPT + WORKFLOW, RUN TWICE AGAINST THE REAL SECRET, THEN DELETED.**
`tools/diag-finnhub.ts` bypassed the swallowing to print the raw status/headers/body of the actual
Finnhub calls. Verified, not assumed:
- **`recommendation-trends`** (query-param token AND `X-Finnhub-Token` header — both tried, both
  identical): **HTTP 200**, `content-type: text/html`, served by Cloudflare with none of the
  `x-ratelimit-*` headers a real API response carries. The body is Finnhub's own marketing-site HTML
  shell. This is **not** a permissions problem — a permissions problem looks like the next line.
- **`price-target`**: HTTP 403, clean JSON `{"error":"You don't have access to this resource."}` —
  exactly what a paywalled endpoint looks like, and exactly what the existing code comment already
  said to expect. Confirmed working as documented; not the bug.
- **`stock/metric`** (fundamentals, the control): HTTP 200, real JSON, real `x-ratelimit-limit: 60`
  header — confirms the key itself is valid and Finnhub's API is reachable in general.

**Conclusion: `recommendation-trends` has moved or stopped resolving on Finnhub's side.** A 200
serving their own website instead of JSON means the request never reaches their API backend — a dead
or renamed route, not a plan restriction. Nothing in this codebase can fix that without knowing where
the data now lives, which needs Finnhub's current docs (unreachable from every fetch path available
in this sandbox — confirmed, not assumed: both raw `curl` and `WebFetch` were refused for
`finnhub.io`, the former with the egress proxy's own 403-at-CONNECT).

⚠️ **`getJson()` (`src/providers.ts`) NOW TELLS THIS APART FROM "GENUINELY NO DATA."** A non-JSON
200 used to throw a generic `SyntaxError` from `res.json()`, caught by every caller's
catch-and-return-null pattern (correct for genuinely absent data) and rendered identically to "AAPL
has no analyst coverage" — which is false. `getJson` now checks `content-type` first and throws a
named `ProviderError` naming the mismatch, so a future endpoint move is diagnosable from a normal log
instead of needing another live diagnostic round. Guarded (`res.headers && typeof res.headers.get
=== "function"`) because the browser smoke test's stubbed `fetch` returns plain objects with no
`Headers` interface — real `fetch()`, in the browser and under Node (which is what `tools/*.ts` runs
under), always provides one, so the guard only ever no-ops against a test double, never against a
real response.

Settings' Finnhub key copy and the README's provider table were both updated to say Business works
and Forecasts currently doesn't, rather than continuing to promise something the app can't presently
deliver. `tools/diag-finnhub.ts` and its one-off workflow were deleted immediately after use — they
were never meant to ship.

## Discover for shares (2026-08-08) — the same idea, a genuinely different honesty problem

He asked for "another section... my companion for stocks and shares" that could "use a rich data set
to provide sound advice." Declined the same way crypto's equivalent ask was declined earlier the
same day — see `AskUserQuestion`'s answer, which he picked: extend Discover to shares, not build a
verdict engine. **This is not a new tab.** The existing Discover tab grew a Crypto/Shares toggle
(`#discTabs`, mirroring Education's inner Guide/Glossary tabs), because the whole point was already
"widen what gets scored the same honest way," which needed a second data source and a UI toggle, not
a second concept.

⚠️ **THE SHARE UNIVERSE IS CURATED, NOT RANKED, AND THAT DIFFERENCE MUST STAY VISIBLE ON SCREEN.**
Crypto Discover's candidates come from CoinGecko's live, third-party, objective market-cap ordering —
nobody at this project chose which coins appear. There is no free, keyless equivalent for ranking
~10,000 US-listed companies: both Twelve Data's and Finnhub's free tiers charge one API call per
symbol just to read a market cap, so ranking the whole market would burn a day's quota before scoring
a single company. `SHARE_UNIVERSE` in `tools/discover-round-shares.ts` is therefore a hand-picked
list of ~52 large, broadly recognisable companies across sectors — a genuinely curatorial choice,
the exact kind of judgement call crypto Discover's own design note warns against making silently.
Accepted as the honest trade-off for a free source existing at all, on condition that the app never
describes it as size-ranked. `renderDiscover()` in `shell.html` prints a DIFFERENT methodology line
per kind ("ranked by market size" vs "a curated list of well-known large companies, not ranked by
size") — asserted by a smoke test specifically checking the share line does NOT contain the crypto
one's wording, because the two claims are easy to accidentally merge in a future copy edit.

⚠️ **A SEPARATE SCRIPT, WORKFLOW AND DATA FILE FROM CRYPTO DISCOVER — same reasoning as keeping the
paper round and crypto Discover apart, applied a third time.** `tools/discover-round-shares.ts` +
`.github/workflows/discover-shares.yml` write `data/discover-shares.json`. A Twelve Data outage or a
missing key must never be able to block the crypto scan's commit, and the reverse.

⚠️ **THIS ROBOT CANNOT RUN WITHOUT THE OWNER'S OWN KEYS, AND THAT IS A REAL SETUP STEP HE HAS TO DO
HIMSELF — NOT SOMETHING THIS SESSION COULD DO FOR HIM.** Twelve Data (price history, required) and
Finnhub (analyst/business data, optional — the scan still runs without it, same degrade-gracefully
rule `loadWatchlist` already follows in the browser) both need a free personal key, and a server-side
robot has nowhere to keep one except a GitHub Actions repository secret
(`TWELVE_DATA_KEY`, `FINNHUB_KEY` — Settings → Secrets and variables → Actions on the repo). There is
no tool available to this session that can set an encrypted repo secret, and pasting a live key into
chat would defeat the point of keeping it a secret anyway — so the workflow is built to **fail
loudly and specifically** when `TWELVE_DATA_KEY` is absent (one clear line naming exactly what to add
and where, then exit 1) rather than crash 52 times confusingly. Until he adds it, `data/discover-shares.json`
simply never gets written, and the Shares tab shows its normal "hasn't run yet" empty state — the
same honest silence the crypto side shows before its first-ever run.

⚠️ **THE RATE-BUDGET MATH IS WRITTEN DOWN, NOT ASSUMED.** 52 companies at the SAME 8000ms gap
`loadWatchlist` already uses for Twelve Data's real 8-req/min free-tier limit (not a new guess — the
one figure this app has already proven safe) costs ~7 minutes of pacing and 52 Twelve Data calls —
comfortably inside its ~800/day cap even if the owner's own browser reuses the same key that day —
and up to ~150 Finnhub calls spread across that same 7 minutes, comfortably inside Finnhub's 60/min
free tier without needing its own separate pacing. `MIN_SUCCESSFUL_FRACTION` (0.5) is a stated
STARTING point, not a calibrated constant — unlike crypto Discover's retry/backoff numbers, which
were measured against one real failed run, there is no real run of this script yet to calibrate
against (it cannot run at all until the keys exist). Revisit it once a real log exists, the same way
the crypto side's constants were, rather than assuming 0.5 is right forever.

⚠️ **`AssetSnapshot`/`DiscoverEntry`/`diffAgainstPrevious` NEEDED NO CHANGES AT ALL.** Every type in
`src/types.ts` and every function in `src/discover.ts` was already generic across `AssetKind` — proof
that keeping Discover's engine plumbing kind-agnostic the first time round (rather than hardcoding
"coin" into field names or logic) was the right call. The only genuinely new code is the fetch loop
(reusing `fetchEquityHistory`/`fetchConsensus`/`fetchFundamentals`, already written for the browser
watchlist) and the UI toggle.

## Education — a plain-English guide and glossary (2026-08-08)

He asked for a fourth tab, by name, after being told this is not a recommendation engine — the
honest alternative to "tell me what to buy" is "help me actually understand this myself." He was
explicit about the constraints: ADHD, finds long passages hard to read, wants a glossary explained
"like I'm a child," and wants visual, moving examples, not more prose.

⚠️ **EVERYTHING IS STATIC AND LOCAL — NO FETCH, NO STORAGE KEY, NO NEW NETWORK CALL.** `EDU_GUIDE`
and `EDU_GLOSSARY` in `shell.html` are plain arrays rendered once at boot (`renderEduGuide()`,
`renderEduGlossary()`), the same way the rest of the page avoids re-deriving static content. There
is nothing here to cache, go stale, or fail to load — the one tab in this app that cannot break from
a bad network day.

⚠️ **THE SHORT ANSWER MUST BE VISIBLE WITHOUT OPENING ANYTHING.** Ten guide cards, each a bolded
one-line question, an always-visible one-or-two-sentence answer (`.edu-tldr`), and an optional
`<details>` "A bit more" for anyone who wants the extra layer. Burying the basic answer behind a tap
would defeat the actual ask — someone who struggles with long text should not have to click to find
out whether a paragraph is worth reading. `test/app-smoke.mjs` asserts the TL;DR is both present and
short (<200 chars), so a future edit can't quietly turn it back into a paragraph.

⚠️ **THE ICONS ARE SMIL, NOT CSS ANIMATION — AND THAT CHOICE HAS A REAL ACCESSIBILITY COST TO MANAGE.**
"Dynamic/moving" visuals were the explicit request, and a self-contained page with no external
assets rules out GIFs or video, so each concept gets a small inline SVG that animates itself
natively (`<animate>`/`<animateTransform>`, no JS animation loop). The cost: SMIL animations **ignore
CSS `animation-play-state`**, so there is no way to pause them after the fact for
`prefers-reduced-motion`. The fix is upstream — `eduIconSvg()` wraps every animate tag in `A(xml)`,
which returns `""` outright when `matchMedia("(prefers-reduced-motion: reduce)").matches`, so a
reduced-motion session never gets the tags in the first place and sees the static base shape only.
The smoke test proves this on a fresh load (`emulateMedia({reducedMotion: "reduce"})` then reload,
then assert zero `<animate>`/`<animateTransform>` elements exist in the DOM) rather than trusting
that the code path was taken — a wrapper that silently stopped firing would look identical to a
correct one in every other check.

⚠️ **THE GLOSSARY IS WRITTEN ALPHABETICALLY BY HAND, NOT SORTED AT RENDER TIME.** Someone who wants
to browse rather than search should be able to scan it top to bottom the same way every time; a
render-time sort would be redundant work for a list that never reorders. The search box
(`#glossSearch`, filtering on term OR definition substring) is for jumping straight to a word, never
required to use the page.

⚠️ **"THIS APP" TERMS ARE MARKED AS SUCH, DELIBERATELY DUPLICATING WORDING ALREADY ON THE RATINGS
CARDS.** Composite score, Network, Risk band and Trend are both general crypto vocabulary and this
app's own pillar names, and the definitions given here describe THIS APP'S specific meaning of each
(e.g. "Risk band (this app) — low, moderate, high or very high," matching `RISK_STAR_CAP`'s bands
exactly) rather than a generic finance definition that might not match what the Ratings tab actually
shows. Two different apps could reasonably use "risk" to mean different things; this glossary is
explicitly not trying to be a general dictionary.

⚠️ **NO ADVICE LANGUAGE, ENFORCED BY THE SAME DISCIPLINE AS EVERYWHERE ELSE IN THIS APP.**
`test/app-smoke.mjs` asserts the Education view's full text never contains "buy now," "you should
invest," "time to buy," or "we recommend buying." Deliberately excluded from that list:
**"guaranteed returns"** — the safety card has to be able to name that exact scam phrase
("guaranteed returns" is one of the three red flags it lists) in order to warn against it, and a
regex naive to context would fail the safety copy for containing the words it exists to warn about.

## Home-screen icon (2026-08-08)

`icons/` holds the app icon set, generated from a single 1254×1254 source
(`icons/logo-source.png`, his own ChatGPT-generated design — metallic ring, bar chart, green trend
arrow, on black) via `Image.resize(..., Image.LANCZOS)`: `apple-touch-icon.png` (180), `icon-192.png`
/ `icon-512.png` / `icon-512-maskable.png` (Android manifest icons — the maskable copy is
byte-identical, since the source art's own margin already serves as the safe zone a circular crop
needs), `favicon-32.png` / `favicon-16.png`. `manifest.webmanifest` (repo root) lists the three
manifest icons plus name/theme/background colour; `shell.html`'s `<head>` links all of it.

⚠️ **GETTING THE FILE ITSELF WAS THE HARD PART, NOT THE RESIZING.** Two paths failed before one
worked, both worth remembering for next time an asset needs pulling in from outside the repo:
- A pasted-into-chat image has no file this environment can read — only the multimodal view of it.
  There is no tool to export chat-attachment pixels to disk.
- A Google Drive link failed at the network layer, not permissions: `drive.google.com` is blocked by
  this sandbox's egress policy outright (`curl` confirmed a 403 at CONNECT, before reaching Google
  at all — checked via `$HTTPS_PROXY/__agentproxy/status`, which logs the exact rejected host).
- `github.com/user-attachments/...` (the URL a drag-into-issue-comment box generates) *also* failed —
  not blocked, but funneled through a git-credential proxy that only serves
  `repos/{owner}/{repo}/...` API paths, and returned a JSON refusal for anything else.
- **What worked: committing the file into the repo itself** (GitHub's web UI, Add file → Upload
  files), then `git pull`. Only the repo-scoped contents API is reachable from here — if an asset
  needs to come from outside the repo again, that is the route, not a chat paste or a third-party
  host.

⚠️ **A SQUARE SOURCE WITH A SMALL BUILT-IN MARGIN, NOT A PRE-ROUNDED ONE.** iOS and Android each
apply their own corner mask (a squircle and a circle respectively) to whatever square you give them;
pre-rounding the art risks a visible double border. This source has a ~6–8% black margin around a
panel that already carries its own metal-ring border as part of the artwork, which reads as
intentional bezel padding under BOTH masks rather than clashing with them — verified by rendering
actual masked previews at real icon sizes (180px squircle, 192px circle) before shipping, not by
assuming it would look fine.

## Storage keys

`mkt_watchlist_v*`, `mkt_keys_v*`, `mkt_currency_v*`, `mkt_sort_v*`, `mkt_cache_v*`, `mkt_theme_v*`,
`mkt_holdings_v*` (the transaction book — losing it loses what he typed in).
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

Standing on its own since the move from Inte-Run (2026-08-06). Build clean, `tsc --noEmit` clean,
**83 engine tests** passing, **56 browser smoke checks** passing.

**The paper round has now run against the real pages and it works.** First real success 2026-08-07:
a genuine 15-row Bitcoin ETF flow scrape committed to `data/flows.json`, verified against the actual
GitHub Action log (not just a green checkmark) and cross-checked against independently-reported
news figures for the same two days. Getting there cost two real, found-not-guessed bugs, both fixed
and documented in place: `checkFlowSanity`'s row-count floor assumed a page that had started
bot-blocking GitHub's requests would always work (fixed, 100→5 rows), and the commit step's
`git diff` was blind to a file it had never tracked before (fixed, stage before diffing). Corporate
holdings remain undeliverable — the diagnostic added specifically to explain this found ZERO
"`<number> BTC`"-shaped text anywhere on the source page, pointing at client-side rendering rather
than a format mismatch. Not built: exchange reserves (the owner's #3) — same shape of dead end.

**Ethereum joined Bitcoin (2026-08-08):** its own real Farside ETF page, generalised into
`data/flows.json`'s new per-asset `assets` shape. Network stays Bitcoin-only — Ethereum has had no
hash rate since 2022, and the free-data search for a substitute came up empty (Etherscan's history
endpoint is paywalled), documented rather than forced.

**Discover shipped the same day** — a nightly market-cap-ranked scan (`tools/discover-round.ts` +
`discover-round.yml`, 22:15 UTC) that surfaces coins the owner never added to his own watchlist,
scored with the identical `rateAsset` engine and ranked by the identical composite/stars fields, never
by raw price movement. Built in direct response to his own words — *"I need you to be the
intelligence that brings all the relevant information to my attention so that I can make an informed
decision"* — held apart from the recommendation engine he separately and explicitly did not get.

**Education shipped 2026-08-08** — a fourth tab: a ten-card plain-English guide (bite-sized, always
a one-line answer visible, animated SVG icon per concept, "A bit more" behind a tap for anyone who
wants it) and a 24-term searchable glossary written for a child. Built for the owner's own stated
ADHD and difficulty with long passages. Entirely static and local — no fetch, no storage key, nothing
that can go stale. Icons use SMIL, not CSS, animation, gated off entirely under
`prefers-reduced-motion` (SMIL ignores `animation-play-state`, so the only real off switch is never
emitting the tags). +10 smoke checks (37 → 47).

**Home-screen icon shipped 2026-08-08** — his own logo, wired as `apple-touch-icon`, a web manifest
with 192/512/maskable sizes, and a favicon. Getting the source file into the repo took two failed
routes (a pasted chat image with no exportable file; a Google Drive link blocked outright by this
sandbox's egress policy) before landing on the one that works: committed into the repo via GitHub's
own upload UI, then `git pull`. +1 smoke check (48 total) proving the `<head>` links survive a build.

**Discover for shares shipped 2026-08-08** — the same Discover tab, extended with a Crypto/Shares
toggle. Shares are a curated list of ~52 well-known large companies (no free market-cap ranking
exists for them, unlike crypto's CoinGecko feed), and the UI says so explicitly rather than
implying an objectivity it doesn't have. **Not yet live**: `tools/discover-round-shares.ts` needs
`TWELVE_DATA_KEY` (required) and `FINNHUB_KEY` (optional) as GitHub Actions repository secrets before
it can run at all — that's the owner's own setup step, not something buildable from a session without
his keys. Until he adds them, the Shares tab shows its normal "hasn't run yet" state. +5 smoke checks
(48 → 53).

**Two real bugs fixed 2026-08-08**, both found the day the shares secrets went live: the watchlist
editor only ever persisted on a button below the key fields, easy to never reach (fixed — add/remove
now auto-save, same as holdings always has); a GitHub token was silently discarded on every single
save (fixed — one-line ordering bug). Also confirmed, via a temporary diagnostic run against the real
key rather than a guess: Finnhub's `recommendation-trends` endpoint now returns their marketing
site's HTML instead of JSON (moved/dead on their end, not a plan restriction — `price-target`'s
genuine 403 paywall still works as documented). `getJson()` now distinguishes a non-JSON response
from genuinely absent data. +3 smoke checks (53 → 56), and two PRE-EXISTING test-harness bugs found
along the way: a shared `localStorage.clear()` was silently defeating every "survives a reload" check
in the suite, and the older holdings-reload check had a regex that matched its own empty state. Both
fixed; see the section above for the full account.

Update this section as you go.
