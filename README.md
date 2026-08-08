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

**Trend and Risk work for any coin** you add — thousands of them, whatever CoinGecko lists. **Flows
now covers Bitcoin and Ethereum**, the two coins with a real US spot ETF. **Network is Bitcoin
only** and stays that way: Ethereum has had no hash rate to measure since it stopped mining in 2022,
and no free source publishes a working substitute (Etherscan's own historical activity data is
locked behind a paid plan) — this is a wall, not a queue. Every other coin shows `n/a` for both
rather than being handed another coin's numbers under its own name.

## Discover — coins you didn't think to add

A third tab, alongside Ratings and My holdings. Once a night, a robot on GitHub scores a wide,
**market-cap-ranked** set of coins with the exact same arithmetic your own watchlist gets, and shows
you whichever of them you haven't already added.

**This is not a "what's pumping" list.** It is ranked by the same composite score and star rating as
everything else here — never by raw price change, which is the single easiest way to walk someone
into buying a top. A coin earns a badge for *"evidence changed"* only when its underlying score moved
meaningfully since yesterday; a coin new to the top ranks is labelled *new*, not handed a fabricated
jump from nowhere. Well-known stablecoins are left out — not a judgement on them, just that a coin
whose entire design is to not move has nothing for a trend engine to say.

Nothing here is a recommendation. It is the same "show your working" screen, applied to coins you
never thought to look at.

### Shares, too

Discover has a **Crypto / Shares** toggle. Shares get the same treatment — the same arithmetic, the
same evidence-only rule — but the underlying list is different, and it's worth being honest about the
difference: crypto's list comes from a live, third-party, objective ranking by market size; there's no
free equivalent for ranking every US-listed company that way, so the share list is a hand-picked set
of around 50 well-known large companies across sectors instead. The app says this on screen, in the
line above the list, rather than pretending both lists were built the same way.

⚠️ **Setup needed before this one works.** Unlike crypto Discover (which needs no key at all), the
nightly share scan needs two free API keys — the same Twelve Data and Finnhub keys used for tracking
individual shares — but as **GitHub Actions secrets**, not in the app itself, since the scan runs on
GitHub's servers overnight:

1. Get a free key from [twelvedata.com](https://twelvedata.com) and one from [finnhub.io](https://finnhub.io).
2. In the repo: **Settings → Secrets and variables → Actions → New repository secret**.
3. Add `TWELVE_DATA_KEY` (required) and `FINNHUB_KEY` (optional — without it, shares still get
   scored on Trend and Risk, just not Forecasts or Business).

Until that's done, the Shares tab shows its normal "hasn't run yet" message — nothing breaks, it just
has nothing to show.

### All, Stocks & shares, Cryptocurrency — and tapping into a detail screen

Discover opens on **All** by default: crypto and shares merged into one list, ranked together by the
same evidence-based score, rather than two separate lists you have to check individually. Tap either
tab to narrow it to just Stocks & shares or just Cryptocurrency instead.

Tap any card — here, or on your own Ratings tab — and it opens a full detail screen: the current
price, a real price chart, and the same trend/risk breakdown as the card, with **"Show the working"**
still one tap away. The chart offers **1M / 3M / 1Y / Max** — deliberately not shorter ranges, because
the free data sources behind this app only ever provide one price per day. A "1D" button over
once-a-day data would draw a chart that looks more detailed than the numbers actually are, so it isn't
offered.

From that screen, **"Add to my holdings"** takes you straight into the ordinary "add a transaction"
form with the asset already selected. It does not buy anything — this app has no connection to a
broker and never will; it is a shortcut for recording a purchase you already made elsewhere.

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

It runs at **21:40 UTC** (after the US evening publication) with a **retry at 08:10** so a night when
the site was slow heals itself by breakfast. **Settings → "Fetch the latest flows now"** runs it on
demand: with no token that opens the workflow's page on GitHub for you to press Run; paste an
optional fine-grained token and it becomes one tap. See *Running it on demand* below.

## My holdings

A second tab: write down what you bought and sold, and it shows what those units are worth at
today's price, what you paid, and the difference.

**It is a record, not advice.** Nothing on that page suggests buying, selling or holding — the ban on
position sizing in this project is a ban on the app telling you what to *do* with money, not on
writing down what you already own.

- Purchases pool at **average cost**, and a sale removes the same fraction of the pool as the
  fraction of units sold. Subtracting sale *proceeds* instead is the classic error: sell into a rise
  and the coins you kept end up with a zero or negative cost, printing an infinite gain.
- **Fees count** — added on a buy, deducted on a sale. Leaving them out flatters every position by
  exactly what the platform charged.
- Realised profit from closed positions is kept and shown separately from unrealised.
- If an asset's price fails to load, its holding is left **out** of the total rather than counted as
  worthless, and the total says it is incomplete.
- ⚠️ **The gain shown is not a tax figure.** UK capital gains has its own matching rules (Section 104
  pooling plus same-day and 30-day rules), and quietly approximating them would be worse than not
  offering the number at all.
- **Type how much you invested, and it works out the units** — an optional "Total invested" field on
  the add-transaction sheet back-calculates the amount for you. Fill it and the units are computed;
  edit the units directly instead and it steps out of the way.
- **Currency is converted properly, not just relabelled.** Buy a US share while your account shows
  GBP, and the value/gain figures are genuinely converted at today's rate (free rates from the
  European Central Bank, via Frankfurter) — never a number silently wearing whatever currency symbol
  happens to be selected. The transaction history underneath still shows exactly what you typed, in
  the currency you typed it in — that's the record of what you actually did; the summary above it is
  where the converted total lives. If a conversion genuinely can't be done right now, that position is
  shown honestly in its own currency with a note, rather than guessed at.

## Education

A fourth tab: a plain-English guide to crypto and a glossary, built to be readable at a glance —
short cards, one idea each, nothing you have to read a paragraph to get the gist of.

- **Guide** — ten short cards (what's a blockchain, a wallet, a private key, why prices swing so
  much, what to watch out for, and so on), each with a small looping animated icon and a one- or
  two-sentence answer that's visible straight away. Tap "A bit more" only if you want the extra
  layer — you never have to.
- **Glossary** — 24 terms explained in one line each, written simply, with a search box to jump
  straight to a word.

Like everything else here, it's just plain HTML and JS baked into the page — nothing to load, no
network call, nothing that can go stale.

### Running the flow snapshot on demand

The app cannot start the robot by itself — asking GitHub to run a workflow needs a credential, and
this page is public, so anything baked into it would be published to everyone. Two honest routes,
and the button picks whichever applies:

1. **No token** (default): it opens the workflow's page on GitHub, where you press *Run workflow*.
2. **Your own token**: paste a **fine-grained** personal access token, limited to this repository,
   with **Actions: read and write** and nothing else. Then the button asks GitHub directly. It is
   stored in this browser like the other keys and sent only to `api.github.com`.

⚠️ **Do not use a classic token here.** A classic token can push code to your repositories; a
fine-grained one scoped as above can do nothing but run this workflow.

---

### Things it deliberately does not do

- **No price predictions, no "buy now", no trading signals.** Same reasoning as the chat reply that
  started this: any answer to those is a guess dressed up as analysis.
- **No headline sentiment scraping.** Your point 2 was "the most respected news outlets predicting
  growth". The honest version of that is in here — but note that the FT, Reuters and Bloomberg
  overwhelmingly *don't* publish price predictions; they report events. What actually exists in
  machine-readable form is sell-side analyst recommendations and price targets, so that is what the
  Forecasts pillar reads. Counting optimistic adjectives in headlines would produce a number that
  looked like the same thing and meant nothing.
- **No position sizing, and no "how much should I put in".** That is a conversation, not a number.
  Note the line this draws: *My holdings* records what you already bought and prices it, which is a
  statement of fact. Telling you what to do with that money is the part that stays out.

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
node --test "test/*.test.ts"   # 91 engine tests
node test/app-smoke.mjs        # 74 browser checks against the BUILT page
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
| **Finnhub** | Free key | Company financials. Analyst forecasts too, in principle — see below. |

So: **crypto works immediately with no signup** — price, on-chain activity and flows all arrive with
no key at all. Shares need one free key; the Forecasts and Business pillars need the second. Paste them into ⚙ Settings. Anything missing is scored as *absent*, never
as *bad* — you'll see `n/a` on that bar and a note saying the picture is partial.

⚠️ **Analyst forecasts specifically aren't coming through right now (found 2026-08-08).**
Finnhub's `recommendation-trends` endpoint returns HTTP 200 with their own marketing site's HTML
instead of data — not a 401/403 (that would mean a plan restriction, and the app already handles
that gracefully). It looks like the endpoint itself has moved or stopped resolving on their end.
Business (company financials, a *different* Finnhub endpoint) is confirmed still working. Nothing
to fix on this end until Finnhub's current documentation says where analyst data actually lives now.

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
  score.ts         the pillars, the composite, the caps
  providers.ts     API adapters (browser fetch)
  flows-parse.ts   pure parsers for the paper round's HTML (no fetch, so they are testable)
  discover.ts      pure diffing/filtering for the nightly market scan
  holdings.ts      the transaction book: average-cost pooling, value, gain
  types.ts         shared types
tools/           NOT shipped to the browser — run with `node tools/x.ts`
  paper-round.ts     the daily robot: reads free ETF-flow pages, writes data/flows.json
  discover-round.ts  the nightly market scan: writes data/discover.json
data/            committed by the two robots above; the page reads these from its own origin
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
