# Asia Flight Fare Tracker — Scope

Oct 30, 2026. Companion to `~/Downloads/Asia Flight Fare Tracker — Plan.md` (the *what*: trip,
business rules, scrape targets, outputs). This doc is the *how*: architecture, data layout,
cadence, notifications, reuse, and the milestone 1 test plan. Where this doc and the plan
disagree, this doc wins (decisions below were made after the plan).

## Decisions (2026-10-30)

| Topic | Decision |
| --- | --- |
| Repo | **One public repo** (`frontend/` + `worker/` + `scraper/`), meowmap/vessel-tracker style. No separate `-api` repo. Public is acceptable: dates and targets are not sensitive. |
| Compute | **Cloud first.** GitHub Actions does all scraping and computation. lavena is a fallback egress only, used if milestone 1 shows Google blocks every cloud route. |
| Egress | Direct runner IP + ProtonVPN WireGuard (spirit-tracker's `scripts/vpn_up.sh`), rotated per run, retry on the opposite route. |
| Storage | **`data` branch** in the same repo, but history is **explicit append-only files**, NOT git commit history (see Data layout). No D1. |
| Stack | Node 24, CommonJS, zero npm deps, no build step (spirit-tracker conventions). Hand-rolled Google Flights client unless the M1 spike finds a maintained Node lib worth using. |
| Dashboard | GitHub Pages PWA, vanilla ES modules. No login, no sessions. |
| Notifications | **Web Push only** (no email), one subscriber (Brennan), sent immediately at any hour, **one push per deal**. |
| Scraper health | Push after **2 consecutive failed runs**, then silent until recovery. Push-subscription health is dashboard-only. |
| Cadence | Tiered: long-leg business **hourly**; economy and short hops less often (see Cadence). |

## Trip builder and dashboard (decided 2026-10-30, after M1; supersedes Dashboard/Cadence below where they differ)

**Trips are built automatically, driven by business long-haul fares.** Brennan doesn't build trips;
the builder searches every combination and the dashboard shows the best N.

- **Trip shape:** business across the Pacific, out and back, as a round trip OR two one-ways (into one
  city, home from another), from YVR or YYJ. Any number of economy hops within Asia on separate
  tickets, in any order, as long as the trip visits **Da Nang (Hoi An) for ≥ 5 nights**. Multi-day
  stops in other cities are fine (a plus, not a cost).
- **Same cabin on both long legs, always.** Hybrid = business out AND business back (round trip or
  two one-ways), economy only on hops within Asia. Full economy = economy on both long legs. Never
  business one way and economy the other; a trip with any economy long leg is a full-economy trip.
- **Victoria:** a YYJ trip's Victoria–Vancouver flight must be on the **same ticket** as the Pacific
  crossing (Google's YYJ⇄Asia fares). Never a separate YYJ–YVR ticket: in that case Brennan just starts
  from YVR and gets there on their own. So YYJ–YVR is never scraped or used as a hop.
- **Trip length:** any 14–21 days home to home.
- **Connections:** within one ticket, Google's itinerary is taken as-is. Between separate tickets,
  same-day is allowed with **≥ 4 h** between landing and the next departure. The price graph has no
  flight times, so the builder marks same-day connections "times to verify" (⏱ on the dashboard);
  Brennan checks the times when booking.
- **Ranking:** pure cheapest total (no penalty for extra flights).
- **Data needed:** long-leg round trips (J, Y; 132 graphs), long-leg one-ways both directions (J, Y; 88),
  economy hops between all 11 Asia cities (110 one-ways). Hops priced with 1 checked bag (bag-fee
  table where Google omits it).
- **Cadence:** YVR long legs (round trip + one-way) hourly; YYJ long legs every 3 h (Google computes
  YYJ graphs on demand, 5-45 s each, and headline deals come from YVR anyway); hops every 12 h
  (sharded). The Worker cron picks the homes per hour (decided 2026-10-31).
- **Full sweep on demand:** a dashboard button, also pressed automatically when a deal alert is
  opened, so everything refreshes while the deal is being reviewed. Worker `POST /sweep`, public,
  at most one per 30 min.
- **No confirm pass (decided 2026-10-31):** a price Google Flights publishes is good enough to alert
  on and rank by; no airline-direct or booking-page check. `bookingOptions` stays in the code for
  ad hoc checks. This supersedes "confirm", "airline-direct" and "candidate" wording below.

## Decisions (2026-10-31, after the first live week; supersede anything above or below)

**Prices and trips**
- **Listed price wins.** Every leg of every shown trip is searched on Google's results page (plain
  HTTP, ~1 s; `gflights/flights.js`). A ticket with a listed flight takes the **listed** price (the
  graph's is kept as `graph`); the graph can be stale (seen: $4,262 on the graph, gone within an hour,
  $5,012 listed; not a VPN effect, checked).
- **Some searches inline no results** although flights exist (YVR⇄DAD, HAN→DAD…): those are asked
  again in a real page (`browser.shoppingResults`, GetShoppingResults, ~10 s). "Not scheduled yet"
  only when the browser also finds nothing.
- **Trips must connect.** Flights are picked in flying order, each leaving ≥ 4 h after the previous
  lands. A cell walks its candidates (builder keeps fallbacks + the cheapest "safe" trip) up to 10;
  if none connects the **cell is dropped** (never shown as "misses connection"). Known limit: the
  builder plans by date (long haul lands day 1), so many cells drop; fix = plan with real landing
  days (roadmap).
- **The builder is exact over the scraped grid** (DP over day × city × Da Nang done; any hops, any
  order). Its limits are inputs: which cities are scraped, which round-trip lengths.

**Coverage (decided 2026-10-31, being built)**
- **Cities:** 18 **gateways** (long legs + hops): DAD ICN TPE HKG TYO MNL SIN HAN SGN BKK KUL + OSA SHA
  BJS CAN JKT DPS CEB. 23 **hop-only** stops: REP PNH LPQ PQC CXR HUI CNX HKT KBV PEN LGK BKI, FUK CTS
  OKA PUS CJU KHH, JOG LOP PPS MPH IAO.
- **Hops only over real routes:** a discovery pass (plain HTTP, weekly) keeps pairs with a short
  flight (≤ 1 stop); everything else is never scraped.
- **Round trips at every length 14–21**, not just 14/17/21.
- **Tiered, layered cadence:** the important/expensive stuff (YVR long legs to main cities, core
  lengths) hourly; other lengths and new gateways ~6 h; hops 12–24 h; each graph has a max age and a
  sweep does the most overdue work within a time budget. Be nice to Google; sweeps stay well under
  an hour.
- **Vietnam anchor, not just Da Nang (added 2026-10-31):** the real destination is Hoi An, reached by
  train/bus. A trip may fly into and out of any of DAD, HUI, HAN, SGN, and may be open-jaw inside
  Vietnam (e.g. into Hanoi, out of Da Nang). Hoi An still needs ≥ 5 nights **after ground time**:
  Da Nang and Hue cost 0 days, Hanoi and Ho Chi Minh City 1 day each way.
- **Any mix of tickets:** one-ways, returns, and returns nested inside returns (e.g. YVR⇄Manila +
  Manila⇄Da Nang). Return tickets between the Vietnamese cities and every gateway/hop city (only
  over routes the discovery pass finds), at every length that fits; low-value pairs refreshed
  slowly (layered/tiered, as above).

**Dashboard**
- **Colour means one thing each:** green/purple = price tiers; gold = business class; tickets get
  their own palette (blue, orange, pink, cyan, yellow, grey), also on the map; layovers grey.
- Board: city names only (no codes), "Hong Kong / Tokyo" for open jaws; each fare tile holds price,
  dates, +N. Filters: month, **via city** (single; precomputed `derived/via/`), YVR/YYJ.
  **Multi-city via (2–3 cities, AND)** wanted; approach not yet chosen (on-demand build recommended
  over precomputing ~800 pairs).
- Trip view: ticket-stub summary; map of flights actually flown (connections included), nights per
  city; leg cards = slim header + one box per flight (dep | duration | arr, flight no./airline/
  aircraft muted, cabin per flight).
- Tabs: Board / History / Health (bottom bar as in `~/movie-server`). History = per class, the 8
  cheapest routes in the board's current view (history is per route overall). Health = scraper,
  alerts, thresholds, sweeps, flight checks, routes.
- **Priority class (business/economy) is per device** (localStorage): sorts the board, opens trips,
  leads History. **Alerts go out for both classes** to whoever has alerts on.
- No filler/caveat text anywhere (Brennan: "slop").
- **Multi-city single tickets (2026-10-31):** after the flight checks, up to 80 Google multi-city
  searches a build (half per class, most promising first; cached 24 h in `state/multi.json`): the two
  long one-ways as one open-jaw ticket, and economy trips as one ticket for every flight. Cheaper
  wins and is shown as one ticket (one colour, a rail joining its flights, a link to that exact
  multi-city search). Seen: YVR→MNL + SGN→YVR business $4,953 as one ticket vs ~$7,000 as two.
- **Lowest-ever marks** (`state/lows.json`, verified cells only, all time): gold ★ route's cheapest
  yet; faint gold ☆ cheapest yet for these dates; red ○ other dates were cheaper (mild); bold red ●
  these exact dates were cheaper before (bad). Tile corner on the board; the ticket stub spells out
  the earlier prices.
- **Rows are named by where the trip sleeps:** the first and last cities with at least a night; a city
  only changed planes in doesn't name the row or count for the via filter.
- **Stay ranges:** "4–12 nights" (the range replaces the count): each Asia one-way moved alone, long legs fixed, within 3% of
  the total, Hoi An minimum kept (`trips/flex.js`).
- **The Hoi An stay is checked against real flights** (an overnight arrival can't eat a night);
  stays outside Da Nang/Hue read "Hanoi + Hoi An" or "Hanoi → Hoi An → Saigon".
- **Via filter, up to 3 cities (AND: a night in each).** One city: its flight-checked file. Two or
  three: instantly, the trips from each city's file that also stay in the others; then exactly, the
  builder itself (`frontend/app/build.js`, shared with the scraper) in a Web Worker over
  `derived/fares.json`, a cell's cheapest trip with no same-day connection (graph prices, not
  flight-checked; where both found the same trip the checked one stays). Chips pulse while it builds.
- iOS installed app: solid sticky header padded by the safe-area inset + 30 px (status-bar fade).

**Main page (phone-first):** one row per **in/out city pair** (e.g. "in Seoul / out Manila"), sorted by
cheapest hybrid, with the top row visually set apart as the headline ticket. Brennan wants to revisit
the row definition once real data is in.
- Columns: **Hybrid** (business long legs + economy hops, the headline), **Full economy**. No full
  business, no premium economy.
- Each cell: cheapest over all dates and trip lengths, with its dates underneath, and a small ▲/▼ for
  the change vs 24 h ago.
- Header: Vancouver / Victoria toggle (top right), month filter dropdown (default all months).
- Colours: $ tiers (good / great / exceptional, plus **purple = buy now**); thresholds tuned after
  seeing real data.
- Tapping a row opens the **trip details**: a simple hand-drawn SVG map (simplified coastline, city
  dots, flight arcs; no embedded map tiles) and a list of flights, each row expandable to the
  specifics, everything linking to Google Flights.

**History page (desktop-first):** x = scrape time, y = cheapest hybrid per destination (independent of
travel dates), one line per destination, Van/Vic toggle.

**Also:** a simple Health tab. No Deals page (deals are push notifications). No separate trips or
leaderboard page (the main page is that). The route view waits until there's something to look at.
Charts are hand-rolled SVG.

## Architecture

**All prod infrastructure is made by CI, never by hand** (Brennan's pattern across projects). GitHub
secrets are the source of truth: `deploy-worker.yml` creates the KV namespace if absent
(`worker/scripts/ensure-kv.mjs`), deploys, and re-pushes every Worker secret on each deploy.

```
Cloudflare Worker (codexwilkes account)                       GitHub (one public repo)
 ├─ cron "5 * * * *" ──workflow_dispatch(tier set)──────────►  Actions: sweep.yml
 ├─ POST /subscribe   ◄── PWA (stores the one subscription      ├─ vpn_up.sh (if route=vpn)
 │                        in KV, keyed by device id)            ├─ node scraper/bin/sweep.js
 ├─ POST /notify      ◄── Actions (shared secret) ──────────────┤   sweep → trips → rules → alerts
 │    └─ RFC 8291/8292 Web Push → Apple/Google push service     ├─ commit + push data branch
 └─ GET  /health      ──► dashboard (last push, last error)     └─ [[RUN-HEALTH]] in commit msg

GitHub Pages: frontend/ PWA  ──fetch──►  raw.githubusercontent.com/<repo>/data/…  (data files)
```

- **The Worker is the clock and the push sender.** Its job is small: GitHub `schedule:` runs 2–5 h late
  and skips runs (spirit-tracker measured 31% never fired), so the Worker cron dispatches instead
  (`spirit-tracker-api/src/tracker_schedule.ts` pattern, `GH_DISPATCH_TOKEN` secret). It holds the
  single push subscription in KV and sends via a port of meowmap's `worker/src/push.ts`.
- **One Worker cron trigger.** The free plan allows 5 cron triggers *per account*, and
  spirit-tracker-api and vessel-tracker already use some. The Worker decides which tiers are due
  from the hour, so this project needs only one trigger. Check the account's current count before deploying.
- **Pages deploys only when `frontend/` changes.** The dashboard fetches data straight from the
  `data` branch via raw.githubusercontent.com (CORS-open, ~5 min CDN cache). Redeploying Pages
  hourly to ship data would hit Pages build limits and adds nothing. Fallback if raw proves flaky:
  jsDelivr's GitHub mirror, or spirit-tracker's Release-asset approach.
- **Cloudflare account:** personal `brennan@codexwilkes.com` (account `a53d0d3cb40662b52e001ffd082d2f1f`)
  ONLY, never the Text Groove work account. The meowmap/vessel-tracker repos commit only the
  account id and CLAUDE.md prose; their real protection (a `codexwilkes` wrangler profile bound to
  the directory) lives on another machine and isn't in git. haleiwa has no wrangler login at all
  yet. This repo commits its own guard, in layers, all failing closed:
  1. `account_id` pinned in `worker/wrangler.toml`. A login without access to that account errors
     out; nothing can land on the work account.
  2. `worker/scripts/cf-guard.mjs`: runs `wrangler whoami` and refuses unless the email is
     `brennan@codexwilkes.com` and the account id matches. Wired as npm `pre*` hooks on every
     script that calls wrangler (`predeploy`, `predev`, …).
  3. Project `.claude/settings.json` PreToolUse hook: any Bash command containing `wrangler` runs
     the guard first and is blocked on failure, and `wrangler login|logout|auth` is always blocked.
  4. CI uses an API token scoped to the personal account (`CLOUDFLARE_API_TOKEN` +
     `CLOUDFLARE_ACCOUNT_ID` secrets), so it's immune to whatever is logged in locally.
  Auth on haleiwa: Brennan runs `wrangler auth create codexwilkes` from `worker/` (wrangler
  >= 4.131 pinned there); Claude never changes auth. Done on haleiwa 2026-10-30 (wrangler 4.151.0).
- **Cron slots: 2/5 used** (check with `node worker/scripts/cf-crons.mjs`): spirit-tracker-api
  `25,48 * * * *`, vessel-tracker-api `0-50 * * * *`. On 2026-10-30 vessel-tracker's 4 triggers
  were collapsed into one that branches on the minute (vessel-tracker `c7c7a5a`), freeing 3. This
  project takes 1. Any new project shares the same 5-per-account free-plan limit: one trigger
  per Worker, branching in code.

## Repo layout

```
scraper/
  bin/sweep.js            entry: --tiers hot,warm,cool --route direct|vpn --dry-run --maxRequests N
  src/gflights/           Google Flights client: query encoding, calendar, shopping, booking RPCs
  src/sweep/              plans the run's requests from config + tier + shard
  src/store/              read/append route files, current state, ledger
  src/rules/              cabin-by-length, "reasonable", airline-direct, tiers, new-low
  src/trips/              trip builder (long leg + hops, layover-day rule)
  src/alerts/             dedupe/re-alert logic, POST /notify
  src/build/              derived views for the dashboard
  config/                 cities.json, routes.json (incl. open-jaw pairs), tiers.json, rules.json, bag_fees.json
worker/                   TypeScript Worker: cron dispatch, /subscribe, /notify, /health
frontend/                 PWA: index.html, app/*.js, sw.js, manifest.webmanifest
scripts/                  run_sweep.sh (orchestration), vpn_up.sh (from spirit-tracker)
tests/                    plain node tests (rules + query encoding pinned to fixtures)
.github/workflows/        sweep.yml (dispatch-only), deploy-pages.yml, deploy-worker.yml
```

## Data layout (`data` branch)

Lessons from spirit-tracker: there, history *is* the commit history of `data/db/**`. That
forced the SKU cache, `--full-reindex`, stats bundles and Release-asset workarounds, and made
the branch impossible to squash. Here every reader opens a file and never walks git.

```
routes/<O>-<D>-<cabin>/<YYYY-MM>.csv      change log, one dir per route+cabin, one file per observation month
    observed_at,out,ret,trip_len,price_cad,route_used
    (a row is written only when a cell's price changes, including → empty)
routes/<O>-<D>-<cabin>/current.json       every cell's current price + last_seen (freshness without rows)
routes/<O>-<D>-<cabin>/detail.jsonl       detail-pass records: flights, durations, seat type, seller, direct price, typical-price label, link
derived/                                  small files the dashboard actually loads
    routes/<O>-<D>-<cabin>.json           daily min, rolling median, business÷economy premium
    leaderboard.json  dest_month.json  trips.json  fare_loading.json  deals.json
state/alerts.json                         ledger: what was alerted, at what price, when
state/health.json                         per-run outcome, consecutive-failure count, control-route result
```

- **What a route is.** `<O>-<D>-<cabin>`, e.g. `YVR-ICN-J`, `ICN-DAD-Y`, open-jaw `YVR-HAN~SGN-J`.
  It's a route, not a flight: the broad sweep returns only the cheapest price per date,
  and flight numbers come only from the detail pass. About 48 long-leg directories (2 origins × 12
  airports × 2 cabins) plus open-jaws, and about 132 short-hop directories.
- **Monthly files** keep each append small and diff-friendly. The repo grows with the change
  rate (unknown until M1). If it turns out to be high, compress closed months (`.csv.gz`).
- **Concurrency:** all runs share one Actions concurrency group (`sweep`), so there is only one writer.

## Scraping

> **M1 finding (2026-10-30): the RPCs below are gated.** Since 2026-08, `GetCalendarGraph`,
> `GetShoppingResults` and `GetBookingResults` need an `x-goog-batchexecute-bgr` header signed by
> the page's own JS (documented by punitarani/fli). Plain HTTP still gets the public search page
> (`/travel/flights?tfs=…`, ~2 MB, one date pair per fetch), whose inline `ds:1` blob carries every
> itinerary, prices in CAD, and Google's price insight (typical range + ~60 days of daily history for
> that pair). Verified with `scraper/bin/probe.js`. No calendar grid and no seller list that way, so
> the full grid would be ~13k pages per business pass. Next: spike a headless browser (Playwright),
> which signs its own requests, to get the calendar and booking RPCs back. Pages whose return date is
> beyond ~330 days come back with no `ds:1` (fares not loaded), the same shape as a failed page.
>
> **Browser spike (same day, from haleiwa): works.** Playwright driving Chrome gets the gated RPCs
> back (`scraper/src/gflights/browser.js`). One page load + the price graph = 60 departure days, then
> 21 per "Scroll forward": all 182 days for one route/cabin/trip length in ~6 s, so the 72-combo
> business grid is ~8 min, and hourly is feasible. The graph silently stops at the fare-loading horizon
> (handled as "not loaded", not an error). Accuracy vs the search page: 7/10 exact, 2 off by $1, 1
> stale (graph $579 low), so **graph = candidate only; confirm on the search page before alerting**.
> Playwright 1.64 doesn't support Ubuntu 20.04: locally use `PW_CHANNEL=chrome` (system Chrome).
>
> **Egress from Actions (run 41148430475, 2 rounds × 24 combos of 182 days):** ProtonVPN (CA) 48/48,
> ~150 s per round, two one-retry rejections. Direct Azure IP: 16/24 in round 1, then Google returned
> rejected RPCs (HTTP 200, null payload) that the page doesn't retry: soft blocking under load. So
> **VPN is the primary egress, direct the fallback**, reversing the Egress decision above.
> Plain-HTTP search pages worked on both. Read RPC bodies with the in-page recorder (`browser.js`
> `RECORDER`), never DevTools `response.text()`, which drops bodies on 2-vCPU runners.
>
> **Confirm pass works** (`bookingOptions`, ~7 s per date pair): GetBookingResults gives every seller
> with `airlineDirect`, fare brand, per-leg cabin, and `matchesCabin`. Airlines list economy brands
> in a business search (KE Economy Flex $3,586 among Prestige fares), so airline-direct price =
> cheapest option with `airlineDirect && matchesCabin`.
>
> Still open from M1: sustained hourly load on one VPN IP (the week-long ramp), and the cell change
> rate (sizes the data branch).

**Source (as originally planned):** Google Flights' internal RPCs, `curr=CAD`, `gl=CA`, `hl=en`:
- **Calendar** (`GetCalendarGraph`/grid) for the broad sweep: about 60 departure days per request for a
  fixed origin, destination, cabin and trip length. This is what makes the volume feasible.
- **Shopping results** for the top candidates: flights, durations, stops, amenities (lie-flat).
- **Booking results** for confirm: seller list (airline vs OTA), airline-direct price, link.
- Checked-bag count parameter for short hops (1 bag). Where Google doesn't price the bag, add
  `config/bag_fees.json` per airline.

**Reference implementations** (read, don't depend): `punitarani/fli` (Python, uses the RPCs
including calendar) and `AWeirdDev/fast-flights` (Python, `tfs` protobuf query encoding). M1 spike:
check whether a maintained Node client exists. If not, hand-roll it, pinning query encoding and
response parsing to saved fixtures in `tests/` so a format change fails loudly.

**Being polite and not getting blocked:** pace requests (start at about 1 req/s with jitter). Each run
picks an egress route (direct Azure IP, which changes per job, or VPN) and retries failures on the
other. Keep a consistent, realistic header set per run; don't randomise per request. Send consent
cookies as a browser would. A user-agent swap alone does little: blocking keys on rate per IP,
cookies and TLS fingerprint. A CAPTCHA, consent wall or HTTP 429 is recorded per route in
`state/health.json` and counts as a failure, never as "no fares".

## Cadence

One hourly Actions run, dispatched by the Worker at :05. It always does the hot tier and adds a
**shard** of the slower tiers, so every run does a similar amount of work and stays well under an hour.

| Tier | What | Fresh every | Approx. requests/hr |
| --- | --- | --- | --- |
| Control | YVR–ICN, economy, departing 14 days out | every run, **first**; empty → abort run as failed | 1 |
| Hot | Long-leg business, round trips, all origins × airports × trip lengths | 1 h | ~290 |
| Warm | Long-leg economy + open-jaws (both cabins) | 4–6 h (sharded) | ~60 |
| Cool | Short-hop matrix (economy; business on 6 h+ routes) | 12 h (sharded) | ~45 |
| Confirm | Shopping + booking for any cell that just crossed an alert threshold | immediately, same run | 0–20 |

About 400 requests/hr, or roughly 10k/day, which is about 7 min of paced requests per run. Counts assume about 4 calendar
requests per route and trip length to cover the window, **unverified until M1**. All
intervals live in `config/tiers.json`. If M1 shows no blocking, tightening everything to hourly is a
config change. The fare-loading period stays empty early on: Feb 2028 fares appear around March 2027.

## Rules engine

Implements plan §Business rules as pure functions in `scraper/src/rules/` with unit tests.
- **Cabin by flight length** (per flight, ≥ 6 h → business) and **lie-flat** (Pacific crossing and any
  overnight flight) need detail data, so a broad-sweep price is a *candidate* until confirm
  passes.
- **"Reasonable"**: ≤ 3,000 / 2,500 / 2,000 CAD round trip (good / great / exceptional), **or** ≤ 2.5×
  economy for the same route and dates, **or** ≥ 25% below the route's tracked business median.
- **Median and "new low" need history:** both stay disabled on a route until it has 14 days of
  observations. Before that, Google's typical-price label is the only baseline.

## Notifications

Web Push from the dashboard PWA, using meowmap's push implementation.

- **Setup:** open the Pages URL in Safari → Add to Home Screen → open it from the home screen → Enable
  alerts (iOS 16.4+; must be a user tap). One subscription in Worker KV. There is no auth, so
  anyone could technically subscribe. Accepted: alerts contain nothing sensitive.
- **Triggers** (plan §Alerts), on Google's published price:
  1. A business fare meets "reasonable" for the first time on a route.
  2. A route or full trip sets a new low against its own history (after the 14-day warm-up).
  3. A long-leg business round trip under CAD 3,000.
  4. **Scraper failed 2 runs in a row** (control route empty, all egress blocked, parse failure).
     One push, then silent until a run succeeds; recovery shows only on the dashboard.
- **One push per deal.** A deal is a route + cabin (or a full trip), *not* a date pair. A sale
  that lights up 30 dates on YVR–ICN is one push, with the cheapest date and the
  range: `YVR⇄ICN business $2,380 · exceptional` / `Korean Air · 14–28 Nov (+11 dates) · typical ~$4,100 · seen 12 min ago`.
  Tapping it opens that deal on the dashboard (full trip, comparison to typical, booking link).
- **All tiers buzz the same.** iOS web push has no time-sensitive or Focus breakthrough, so the
  title carries the tier word (good / great / exceptional / new low).
- **No repeats:** an alerted deal re-alerts only if it drops a further ≥ CAD 100 or 5%, or crosses
  into the next tier. Ledger in `state/alerts.json`.
- **Every push must show a notification** (iOS revokes permission otherwise): `sw.js` shows a
  generic line if the payload can't be read (meowmap lesson).
- **Dead subscription:** dashboard only. `/health` reports the last successful push and the last push
  error (a 404/410 from the push service deletes the subscription). The dashboard shows a banner when
  push is broken.

## Dashboard (plan §Outputs)

Vanilla ES-module PWA, one screen per view, all loading `derived/*` only:
**Deals** (current confirmed deals, the target of each push) · **Trips** (trip builder ranking) ·
**Leaderboard** (cheapest qualifying full trip by departure month) · **Destination × month** ·
**Route** (history chart: business, economy, premium; drill-down loads that route's monthly CSVs) ·
**Health** (last runs, egress per run, control route, fare-loading log, push status).

## Reused from existing repos

| From | Take |
| --- | --- |
| spirit-tracker | `run_daily.sh` orchestration shape; `data` branch + worktree; `vpn_up.sh` + opposite-egress retry; run health in commit messages (`[[FAILED-…]]` sentinels → `run: <ts> \| FAILED(n): …`); one-shot failed-job retry; 48 h flip-flop rule (Google fares bounce); vanilla SPA + PWA + `stamp_pwa.js`; zero-dep Node conventions |
| spirit-tracker-api | Worker-cron → `workflow_dispatch` clock (`tracker_schedule.ts`) |
| meowmap | `worker/src/push.ts` (RFC 8291/8292 on WebCrypto, RFC-pinned tests), PWA push UX and iOS rules, CI with check-before-deploy + smoke test, Cloudflare account/profile rules |
| movie-server | `controller/lib/push.js` (Node version of the same push code): option to send from Actions directly if the Worker path is ever a problem; terse alert-copy discipline |
| vessel-tracker | Worker ↔ Actions dispatch split; "a red gate on a cold start trains you to ignore red" smoke-test retry |
| lavena | Fallback only: register a self-hosted runner label (`residential`) that only the scrape job targets, if cloud egress is blocked |

## Milestones (revised)

1. **Prototype and go/no-go (1 week).** YVR⇄ICN business + economy, all three trip lengths. Answers four questions:
   - **Accuracy:** do calendar prices and confirm-pass seller/price match Google Flights in a browser? (Spot-check about 20 cells by hand.) If they don't match, stop.
   - **Egress:** CAPTCHA, 429 and empty rates per route (direct / VPN), ramping YVR⇄ICN from every 4 h to hourly over the week. If both cloud routes fail, try the lavena runner.
   - **Volume:** actual calendar coverage per request (is "about 4 per combo" right?) and the daily cell change rate (sizes the data branch).
   - **Library:** a maintained Node client, or hand-roll?
2. **Long-leg grid + hot tier hourly**, data branch, run health, Worker clock.
3. **Push live early:** PWA shell + subscribe + `/notify`, with the threshold rules (triggers 3 and 4) on long-leg business. Push moves up from plan milestone 5 because catching deals early is the point.
4. **Short-hop matrix** (cool tier), bag fees.
5. **Trip builder + full dashboard**, median and new-low rules (by now routes have 14+ days of history).
6. **Run until booked**, adding coverage as later months load (through about Mar 2027).

## Risks and remaining open items

- **Google ToS / format changes.** Personal, low-volume use. Fixtures make parse breaks loud, and trigger 4 pushes.
- **Blocking at hourly cadence.** Unknown until M1. Mitigations in order: slower pacing, more VPN
  configs (several ProtonVPN servers), lavena runner.
- **Change rate.** Unknown until M1; affects repo size and how big the drill-down files are.
- **raw.githubusercontent.com caching and rate limits** for dashboard data: fine for one user. Fallbacks noted above.
- **Open-jaw pair list:** start with into HAN, out of SGN or BKK (and reverse); finalize after hub data is in.
- **Bag-fee table** for budget carriers on short hops: build during milestone 4.
- **Hub list** needs re-checking against 2027–28 YVR nonstop schedules (plan §City list).
