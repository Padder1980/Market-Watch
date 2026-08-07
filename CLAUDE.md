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
  flows-parse.ts   pure parsers for the paper round's HTML — no fetch, so they are unit-testable
  holdings.ts      the transaction book: average-cost pooling, value, gain
  types.ts         shared types
tools/           NOT shipped to the browser
  paper-round.ts   the daily robot: reads free pages server-side, writes data/flows.json
data/flows.json  committed by the robot; the page fetches it from its own origin
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
node --test "test/*.test.ts"   # 67 engine tests
node test/app-smoke.mjs        # 33 browser checks against the BUILT page
node tools/paper-round.ts --dry  # the daily robot, without writing anything
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
**67 engine tests** passing, **33 browser smoke checks** passing.

Since the move: a **Network pillar** (Bitcoin on-chain activity and miner behaviour, from
Blockchain.com) and a **Flows pillar** fed by the **paper round** (US spot ETF flows and
public-company holdings, via a daily GitHub Action). Together those cover four of the owner's eight
stated signals — ETF flows, institutional purchases, on-chain activity and miner behaviour.

⚠️ **THE PAPER ROUND HAS NOT YET RUN AGAINST THE REAL PAGES.** This sandbox's proxy blocks those
hosts, so the parsers are proved only against fixture HTML. **Watch the first scheduled Action run**
(21:40 UTC, Mon–Sat) or trigger it by hand from the Actions tab. If it goes red with "table not
recognised", read the logged byte count, fix the parser against what the page really says, and do
not loosen `saneFlows` to make it pass.

Not built: exchange reserves (the owner's #3) — see the paper-round section for why, and for the
shape a fix would take.

Update this section as you go.
