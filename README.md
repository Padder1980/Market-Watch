# Market Watch

A daily market tracker that ranks a watchlist and rates each thing out of 5 stars — with the
arithmetic behind every star visible on the same screen.

It was originally built inside the Inte-Run repo by accident of which repo the session was attached
to, and moved here on 2026-08-06. It shares no code, no build and no storage keys with that project.

---

## What the stars actually mean

**They are not advice and they are not a forecast.** They count how many measurable signals
currently line up. That is a genuinely useful thing to see at a glance, and it is a different thing
from "this will go up" — which nobody can tell you, and which any app claiming to is guessing.

Five questions, asked separately:

| Pillar | What it reads | Where it comes from |
|---|---|---|
| **Trend** | Is the price climbing, and is the climb orderly? | Price history only |
| **Forecasts** *(shares)* | Do the people who publish forecasts expect growth? | Analyst recommendations + price targets |
| **Flows** *(crypto)* | Are the people who allocate real money moving it in or out? | US spot ETF flows, public-company holdings |
| **Business** *(shares)* | Do the company's financials support it? | Reported revenue, earnings, margin, debt, P/E |
| **Network** *(crypto)* | Is the chain being used, and are miners still committing? | Hash rate, transactions, active addresses |
| **Risk** | How badly could this hurt? | Volatility and worst peak-to-trough fall |

**The pillars are PAIRED into two slots.** A company has accounts and analyst coverage; a crypto
asset has a chain and institutional flows. Each row shows whichever half applies to it, so nothing
sits permanently greyed out for a pillar it could never have. Flows sits opposite Forecasts on merit,
not convenience: both answer "what do the professionals think?" — analysts by saying it, allocators
by moving money.

Flows and Network are **Bitcoin only** so far. Blockchain.com indexes no chain but Bitcoin's, and the
flow snapshot covers the US spot Bitcoin ETFs, so every other coin shows `n/a` rather than being
handed Bitcoin's numbers under its own name.

### Where the flow numbers come from — "the paper round"

Farside publishes the daily ETF flow table free, and the treasuries pages publish holdings free.
Neither will let a *web page* read them (no CORS header) — but that rule only applies inside
browsers. So a GitHub Action runs on GitHub's servers once a day, reads those pages, and commits
`data/flows.json` into this repo. The app then reads its own file, from its own origin.

Still no server, still no key, still £0. The trade is that flows are **yesterday-evening fresh**
rather than live — which is exactly how often they are published anyway.

⚠️ **If the robot stops, the app says so.** Flow data older than a week is refused rather than
believed, and the pillar shows `n/a`. A scraper's failure mode is going quiet, and stale numbers
wearing today's stars is the one thing this design must never do.

Everything except Risk combines into a 0–100 composite (trend weighted heaviest, at 45%). **Risk does
not combine — it caps.** A very-high-risk asset tops out at 3 stars and a high-risk one at 4, however
strong everything else looks.

That cap is the most important design decision in here, and it is there because of the thing you
said: you won't invest money you can't afford to lose. If risk were averaged in like the others, a
90-on-trend and a 20-on-risk would blend to a comfortable-looking 55, and the number that mattered
most to that decision would have been cancelled out by the number that excited you. A cap can't be
cancelled out.

### Things it deliberately does not do

- **No price predictions, no "buy now", no trading signals.** Same reasoning as the chat reply that
  started this: any answer to those is a guess dressed up as analysis.
- **No headline sentiment scraping.** Your point 2 was "the most respected news outlets predicting
  growth". The honest version of that is in here — but note that the FT, Reuters and Bloomberg
  overwhelmingly *don't* publish price predictions; they report events. What actually exists in
  machine-readable form is sell-side analyst recommendations and price targets, so that is what the
  Forecasts pillar reads. Counting optimistic adjectives in headlines would produce a number that
  looked like the same thing and meant nothing.
- **No portfolio, no position sizing, no "how much should I put in".** That is the framework part of
  the chat reply, and it is a conversation, not a number.

### Two calibrations that stop it flattering everything

- **Analyst price targets are systematically optimistic.** Across the market the average published
  12-month target sits roughly 10–15% above the current price, permanently, in good markets and bad.
  So implied upside is scored against that baseline, not against zero. A target implying +12% reads
  as *ordinary*, not bullish.
- **Buy ratings hugely outnumber sells.** A genuinely average stock carries a consensus near 3.8 on
  a 1–5 scale, so 3.8 is the point mapped to "neutral" — not 3.0.

Without those two, almost everything covered by an analyst would score well, and the ranking would
be worthless.

---

## Running it

```bash
npm ci                        # once
node build.ts                 # writes index.html
```

Then open `index.html` in a browser. It is one self-contained file — no server, no build step
at runtime, and it works offline once loaded (it just can't refresh prices).

To put it on your phone: serve the folder over HTTP and add it to the Home Screen, or host
`index.html` anywhere static.

### Checks

```bash
node build.ts                  # rebuild first — every check below reads the BUILT page
npx tsc --noEmit               # typecheck
node --test "test/*.test.ts"   # 54 engine tests
node test/app-smoke.mjs        # 25 browser checks against the BUILT page
```

Or `npm run check`, which runs all four in that order.

⚠️ **Check the build's exit code before trusting anything after it.** A failed build leaves the
previous `index.html` in place, and every check downstream then passes on the stale file.

---

## Data, and what you need for it

Everything is fetched in your browser, straight from the API. There is no server in the middle and
no key ever leaves your device except to the API it belongs to.

| Source | Key needed? | Gives you |
|---|---|---|
| **CoinGecko** | No | Crypto price history. Works out of the box. |
| **Blockchain.com** | No | Bitcoin on-chain activity — hash rate, transactions, active addresses |
| **Farside / treasuries** | No | ETF flows and company holdings, via the daily paper round |
| **Twelve Data** | Free key | Daily price history for shares and funds |
| **Finnhub** | Free key | Analyst recommendations and company financials |

So: **crypto works immediately with no signup** — price, on-chain activity and flows all arrive with
no key at all. Shares need one free key; the Forecasts and Business pillars need the second. Paste them into ⚙ Settings. Anything missing is scored as *absent*, never
as *bad* — you'll see `n/a` on that bar and a note saying the picture is partial.

⚠️ **Provider choice was forced by CORS, not by quality.** Better free sources exist — Stooq's CSV,
Yahoo's chart endpoint, the FT and Reuters RSS feeds — and every one of them refuses to be read from
a web page because they send no `Access-Control-Allow-Origin` header. Reaching those would need a
proxy server somewhere, holding a key. The three above work from a static page with keys you hold.

⚠️ **Free tiers are tight** — Twelve Data allows 8 requests a minute. The loader is therefore
deliberately sequential with an 8-second gap between shares, and results are cached so reopening the
page doesn't refetch. A long watchlist of shares takes a while on purpose; firing them in parallel
is the fastest way to get every row rate-limited at once and see a screen that looks broken.

---

## How it's put together

```
src/             pure TypeScript, no runtime dependencies, fully unit-tested
  indicators.ts    moving averages, RSI, drawdown, volatility, trend fit
  score.ts         the four pillars, the composite, the caps
  providers.ts     API adapters (browser fetch)
  types.ts         shared types
entry.ts         what gets exposed to the page as the global `MK`
shell.html       the page: markup, CSS, and the UI code
build.ts         esbuild bundles the engine and inlines it into shell.html -> index.html
index.html       the built page — generated, committed so it can be opened directly
test/            engine tests + a browser smoke test
```

**⚠️ Never hand-edit `index.html`** — it is generated. Edit `shell.html` or the engine and
re-run `node build.ts`.

**The page template is a separate file on purpose.** The project this was built alongside
(Inte-Run) holds its entire runtime inside one giant JS template literal, which means no backtick
may appear anywhere in the app's own code — not even in a comment — on pain of a silent build
failure. That rule fired at least six times over there, twice hiding behind a stale build that still
passed its checks. Here the HTML lives in `shell.html`, so the app's JavaScript is just JavaScript
and there is nothing to escape.

### Rules in the engine that cost something to learn

- **⚠️ A missing signal is `null`, never `0`.** Bitcoin has no revenue growth and no analyst
  coverage; scoring those as zero ranks it below a mediocre listed company for the crime of being a
  different kind of asset. The composite renormalises over whatever is present.
- **⚠️ And the UI has to honour that too.** An unavailable pillar renders hatched and italic with
  `n/a` — never as an empty bar, which reads as a score of zero and would undo the whole thing at
  the last possible moment.
- **⚠️ Risk is measured on volatility, and an unmeasurable risk is the HIGHEST band.** `maxDrawdown`
  happily returns a number from two data points, and for anything that has only ever risen that
  number is 0% — the safest possible reading. A brand-new listing with three days of history was
  banded *low* and ranked safer than a gilt fund. Volatility needs 20 sessions, so volatility is
  the gate.
- **⚠️ Overextension is measured against the asset's OWN history, not by RSI.** RSI measures "has it
  been rising", not "is it overextended", and those come apart badly: a low-volatility steady
  climber sits at RSI 85+ permanently, so an RSI penalty docked it every single day for trending
  reliably — measured, a steady riser scored 58 against a violently choppy one on 77 with the same
  six-month return. `stretchPercentile` asks how unusual today's gap to the 50-day average is *for
  this asset*, which needs no per-asset constants and does not punish consistency.
- **⚠️ A tidy decline is not rewarded for being tidy.** Trend quality only counts when the slope is
  positive.
- **⚠️ A negative P/E is not "cheap"** — it means the company is losing money. Fed into a
  lower-is-better ramp it scored as the best value on the list.
- **⚠️ Thin evidence caps the stars.** You can't earn 5 stars off one pillar and 40 days of history.
  "We don't know much about this" must never present as "this looks great".
- **⚠️ The cache stores snapshots, not verdicts.** Re-scoring on load costs nothing and means an
  engine change takes effect immediately; cached verdicts would leave yesterday's arithmetic on
  screen with no way to tell it apart from today's.
- **⚠️ Assert rendered geometry, not attributes.** Every pillar bar shipped rendering *empty* in the
  first build: `.fill` sits inside a grid item rather than being one, so it stayed `display: inline`
  and both its width and height were ignored. The markup was right, the inline style said
  `width: 82%`, and the bar was invisible. The unit tests couldn't see it and the smoke test checked
  the number beside it. Only a screenshot showed it.
- **⚠️ `pct()` already carries the sign** — a direction word next to it needs the absolute value, or
  you print "Price is -1.4% below its 50-day average", which states the opposite of what it means.

---

## Known limits, stated plainly

- **Momentum ranking buys tops.** Sorting by "what went up recently" is a real and well-documented
  market factor, and it is also the mechanism by which people arrive late to a run. The
  overextension penalty and the risk cap push back on it; they don't eliminate it.
- **Everything here is backward-looking.** Every number is a summary of what has already happened or
  what someone has already published.
- **Fundamentals are shallow** — six metrics from one free provider, with no sector comparison. A
  P/E of 30 means something different for a utility than for a software company, and the engine
  doesn't know which it's looking at.
- **No sector or correlation view.** Five 5-star holdings that all move together is one bet, not
  five, and nothing here would tell you that.
- **UK tax, fees and platform choice are entirely out of scope.**

None of this replaces a regulated UK financial adviser, and for meaningful money the chat reply was
right that one is worth the fee.
