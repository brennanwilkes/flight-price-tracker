# Saturation: where each run's checks go

Goal: every board cell and every filter-view ticket proven against a real flight list and a real
booking page, with a recheck soon after its listed price moves. Two runners only (two IPs); no
more runners or VPN configs. Times are Vancouver (UTC−7).

## The three jobs (`.github/workflows/sweep.yml`)

| Job | IP | Does |
|---|---|---|
| `sweep` | .135 | scrape (price graphs), warm checks (search pages ≤ 300 days out, inline), off-board date pairs, build, alerts |
| `booking` | .74 (4 vCPUs, ~2 physical cores) | booking runner (`--pages 3 --gap 1500 --session-pages 300`), 43 min; the search runner shared this machine until Nov 17 |
| `search` | ProtonVPN CA#123, secret `PROTONVPN_WG_CONF_SEARCH` (from Nov 17, 11:05 am) | search runner (`--pages 7 --gap 1500 --session-pages 300`: browser searches the build ran out of time for, mostly > 300 days out, from the build's queue), 43 min; `search machine:` CPU and load lines at the end |

The build writes `.booking-queue.json` (board, then filters) and `.search-queue.json` (most
wanted first, at most 8,000, plus the build's lookups as `used`). The next run's booking job works
through them; the next build merges the search runner's rows (`--search-extra`) and leaves the
first 1,000 of the queue the runner is working to it (`--runner-queue`, RUNNER_REACH).

## Handoff: state and open bugs (9 pm Nov 14)

Standing rules (from Brennan): no guessed prices, everything proven; a saturation shortfall is a
bug, never accepted as a trade-off; catch every sale (filters may run on a looser schedule, never
less coverage); two runners only, no more runners or VPN configs; quote runs and ETAs in Vancouver
time, from `node scripts/run-stats.mjs N` over several runs on one config, never one run's delta;
add telemetry before tuning or estimating (wrong ETAs and wrong root causes came from guessing
without it, more than once, including on Nov 14).

### Where it stands (`run-stats.mjs 8`, 1:05-8:05 pm Nov 14)

| Measure | Now | Trend a run | Done at this rate |
|---|---|---|---|
| Board cells booking-checked | 100% every run (427-666) | | |
| Board tickets fresh (booking page < 12 h) | 3,186 of 4,039 | flat | never |
| Filter tickets fresh | 4,783 of 14,304 | +30 | ~Nov 28 |
| Search backlog (browser searches left out of time) | 9,868 (~12,000 the morning of Nov 14) | −94 to −131 | ~Nov 18-19 |
| Hidden board cells (return not searched) | 1,526 | −16 to +11 by window | not reliably falling |
| Searches looked up a build / fresh at lookup | ~19,300 / ~7,700 | flat | |
| Booking pages a run | ~1,600 (board ~580, unchecked dates ~230, filters ~790) | | needs board ~340 + filters 590-1,180 + unchecked dates |
| Search runner pages a run | 630-890 (median page 14.6-18.7 s) | | |
| Lost "more flights" lists a run | 0-31 | | |

### Review, Nov 15 (read before the list below)

- **Fixed: searches never made and asked for past the search deadline were dropped, not queued.**
  `details.js` `once()` returned "out of time" without reaching `inPage`, the only place that
  filled `cache.wanted` (the runner's queue). Six runs to 8:05 pm Nov 14: the queue was 97.6-99.96%
  refreshes of stale searches (9,855 of 9,868), while 477-764 returns and 287-418 checks never
  searched were dropped a build. Hidden cells could only be searched by the sweep's own 105-141
  pages before the deadline. Now queued at their own priority (ahead of refreshes), tallied
  `wantedLate`. This is bug 1 below; its "returns run at RETURN_PRIO" is wrong: a kept cell's
  returns already run at the cell's rank (`build-trips.js` returnsFor call).
- **The cell walk outruns the deadline:** the build's checks take 650-750 s, 210-500 s of it past
  the search deadline (warm pass 650-975 s more), single-threaded over ~247,000 cells. Open.
- **Hypothesis for bug 2, being measured:** a listed price replaces the graph's for 24 h
  (`CHECKED_HOURS`), renewed only while its search is fresh and looked up. A date that lists above
  its graph price is left by the plan, its listed price runs out 24 h on, the graph's is back and
  the date is walked again (stale by then). `search churn` now starts with how many fares' listed
  prices ran out since the last build and how many of them were new lookups. If confirmed, the
  decision (Brennan's) is whether a listed price stands while its search is still served.

- **After the fix, 12:05-2:05 pm Nov 15:** the queue holds ~1,000 never-searched searches (was
  4-259) and the runner's rows are 100% newer than the cache's (was 66-70%). Hidden cells did not
  fall in two runs (1,643 → 1,910 → 1,954): too early to read, since a search queued by build N is
  made in run N+1 and merged in run N+2, and a cell needs its check and then its return, so ~4
  runs from first wanted to shown. Never-searched lookups stay ~1,100-1,300 a build although the
  runner makes ~600 of them a run: about as many new ones arrive an hour as the runner can make.
- **The 24 h listed-price loop is ruled out:** 133-241 fares' listed prices ran out a build, 5-10
  of them new lookups, of 1,400-1,800 new lookups.
- **"Hidden board cells" covers every view** (`dropUnlisted` walks the board and all via views,
  month and length cells, long-haul caps). From 4:05 pm Nov 15 `priced as listed` ends with where
  they are, and `search queue` splits its never-searched by board cells, via cells, long-haul caps.

- **3:05-5:05 pm Nov 15, the fix four runs in:** cells hidden with no flights checked 1,403 →
  849 → 213 → 267; never-searched in the queue 1,018 → 536-695 (the runner makes 733-811 a run,
  so all of them, then refreshes); backlog 11,187 → 10,073. Hidden as "return not searched" still
  1,461-1,607, and now split: **board overall 49-50** (month 49-50, length 143-159), via 1,200-1,370.
  The board's queue share is 43-50 never-searched a build. Open questions, logged from 6:05 pm:
  why those board searches weren't made in the build itself (`board searches never made, left for
  the runner`: asked past the deadline, no page free, or left to the runner), and how each kept
  trip's return search ended (`return searches for kept trips ended`: a list that came back with
  no return that fits leaves the cell hidden as "return not searched" with nothing queued).

- **6:05-9:05 pm Nov 15:** hidden with no flights checked 6-58; never-searched in the queue
  31-62 (1 for the board); the walk 12-111 s past the deadline (was 400-700). The ~1,050 cells
  still hidden as "return not searched" all had their return searched: the list held none that
  fits (`return searches for kept trips ended`: ~1,000 "no return fits" a build). Why
  (`returns with none that fits`): 934 a long-haul ticket whose returns, with that outbound
  chosen, all leave before the flight before lands (e.g. YVR-JKT J out PR117+PR535: its 3 returns
  leave CGK 01:20, the hop in lands 12:30); 63 an Asia return landing too late for the next flight.
  The check had passed the trip on a return guessed from the one-way list home.
- **Fixed from 10:05 pm Nov 15** (first build: hidden 1,056 → 380, board overall 6)**:** such an outbound is passed over for the next that connects
  (`details.js` pickFlights, OUT_TRIES; its returns searched in turn, each step a search the
  runner makes: ~2 runs); none left, the trip doesn't connect and the cell walks on. Logged as
  `outbounds passed over`. Not done for the long-haul filter's trips (`capped`).

### In progress, night of Nov 15-16 (Brennan: read the runs through the night, then make the fixes)

Pushed 11:36-11:45 pm Nov 15, live from the 12:05 am Nov 16 run; nothing below measured yet.

| # | Open issue | Known at 10:05 pm Nov 15 | Log line to read | Fix if it shows |
|---|---|---|---|---|
| 1 | Hidden cells | 380 (board overall 6), 181 never-searched queued | `priced as listed … where:`, `outbounds passed over`, `return searches for kept trips ended` | should fall ~2 runs a step; if it floors, read `returns with none that fits` |
| 2 | Stale searches | ~10,300 of ~19,700 used are > 24 h old, flat | `search demand by view` (board / via only / caps only, stale ages), `search queue in order`, `search runner, started by view` (from 1:05 am) | if the board's stale is small and the runner reaches all board refreshes: the board is saturated on searches and the rest is via demand (looser schedule allowed for filters); if the board's refreshes exceed a run's pages: order refreshes oldest first within a view, then cut demand |
| 3 | New lookups, 1,000-1,800 a build | 24 h listed-price loop ruled out | `search churn … new by kind` now ends with `for the board / a via view / a long-haul cap` | board share decides whether the board's candidate walk needs stabilising |
| 4 | Booking pages without the listed offer | 126 of 554 board pages, 260 of 875 filter pages a run; held 3 h, never a booking price | `N without the listed offer (… time running, sellers, % above listed)` in `booking runner, board:` / `filters:`; streaks need ~3 cycles (9 h) | same tickets 3+ times running on full seller lists: the listed price is not bookable. Decision for Brennan (shown price would become the dearer booked one, or the hold lengthens): do not change what is shown without asking |
| 5 | Filter tickets never reached | 8,184 of 14,554 not checked in 48 h | `booking runner, filters due:` and `filters in order, the first 900:` | reordered already (listed moved, never checked, oldest first); "not checked in 48 h" in `booking demand` should fall ~900 a run |
| 6 | Board bookings "3,125 of 4,010 fresh, flat" | runner checks every due board ticket each run (554/554) | `booking runner, board due:` | likely measured before the run's own results merge: if due = hold ran out + new itineraries + 3 h re-asks, count freshness after the merge; new itineraries ~350 a build would be the churn of #3 |

Also pushed then: the long-haul filter's trips pass over an outbound with no return that fits
(`capped`, logged `in long-haul filter trips N`); expired booking checks of every kind are kept
48 h (`bookings.js` loadBookings `keep`), so "not checked in 48 h" drops for that reason alone.
Seen, not acted on: the sweep's own build makes ~87 booking pages a run from the queue the
runner is working (likely duplicates).
Watchers print these lines after each run; `node scripts/run-stats.mjs 8` for the table.

Read at the 11:05 pm and 12:05 am runs, and what was done (3896bf46b, live from 2:05 am Nov 16):

- **2, the cause of the flat backlog: each search runner made the last runner's searches again.**
  Runner N works the queue build N-1 wrote; build N-1 ran beside runner N-1, so that queue's head
  is what runner N-1 was searching. ~800 pages a run, about half of them repeats: ~8,700 searches
  fresh of ~19,700 used, where 800 × 24 h would keep ~19,000. Fix: the booking job restores the
  last run's `.search-extra.json.gz`; the runner skips queue items it holds (under 3 h old) and
  keeps their rows. `RUNNER_REACH` 1,000 → 2,000. Log: `search runner: N of the queue searched
  by the last run, skipped`.
- **1: hidden floored at 419** (via overall 195, via month 194, board ~30); `hidden with no
  flights checked` back up 7 → 210. Never-searched searches for via views (303) and long-haul caps
  (189) sat behind the board's 4,872 refreshes in rank order. Fix: the queue is never-searched
  first (any view), then refreshes by view, oldest day first, then rank.
  `outbounds passed over` 8,400-8,900 a build, 0-4 the trip's last: nearly every one has a next
  outbound.
- 2: board demand 10,687 lookups: 5,643 fresh, 4,970 stale (1,511 at 1-2 d, 602 at 2-4 d, 619 at
  4-7 d); via only 8,966: 3,018 fresh, 5,635 stale.
- 3: new lookups 1,315-1,968 a build: 359-458 for the board, 956-1,202 for a via view.
- 5: the reorder works: the first 900 filters were 779 never checked + 121 listed at a new price.
  7,768 never checked in 48 h, ~900 a run.
- 6: a measurement lag. Board due at the build 915 (276 hold ran out, 221 never checked, 65 lacked
  the listed offer); the runner checks all due each run (621 of 621).
- Results, 2:05-4:05 am Nov 16: the runner skipped 684, then 1,057 searches its last runs had
  made (the repeats were real). Hidden cells 433 → 319 → 158 (via overall 70, via month 66, board
  length 20, board overall 1); via never-searched queued 303 → 29. Backlog 10,979 → 10,831 → 10,511.
- Booking runner made 0 pages at 2:05 am (575 of 700 at 1:05): the canary's ~$3,450 fare went at
  1:30 am ($4,613-4,618, 15 sellers) and it read "short" by price. Fixed fb04fa750: 10+ sellers is
  full too. 3:05 am 1,053 of 1,053 board, 4:05 am 625 of 625.
- Next limit, search pages: the booking job's 4 cores are full (load ~11; search 209%, booking
  120%), 630-730 search pages a run at 15-17 s (renderer CPU 4.8 s a page; "View more flights"
  36% of page time, 300 of ~800 rejected and reloaded). Inflow is never-searched ~200-600 a build
  plus ~375 an hour going stale, so refreshes get ~300-500 pages a run. The page's CPU, and why
  1,300-2,000 lookups a build are new, are what's left.
- Long-haul caps: 184-298 never searched every build though ~95 are made a run: not yet explained.
- 5:05-7:05 am Nov 16: hidden back up 158 → 290 → 624 → 603 (via overall 270, via month 268,
  board length 39, board overall 13); backlog 10,719 → 10,096 → 9,998 (board stale 4-7 d 362 → 81).
  Never-searched for via views 29 → ~250 a build, long-haul caps ~220, all started by the runner
  the next run (485 of its 691 pages at 7:05). So hidden ≈ new return searches a build × the ~2
  runs each takes to land. One cause fixed (fbc7a8971, from 8:05 am): the runner skipped any
  search in its last rows, also one the build had read and queued again; it now skips only rows
  newer than the build's newest (`extraTo` in the queue file). Not shown to be the whole rise.
  Open: where ~250 new outbound-chosen return searches a build come from (a refreshed outbound
  list with a new cheapest outbound needs a new return search, and its cell hides meanwhile).
- 8:05 am Nov 16: hidden 416, backlog 9,839. New return searches for kept trips ~140-170 a
  build: about a third each "the ticket has no return search", "returns searched with another
  outbound", "its outbound before was passed over".

#### Left running Nov 16, to read on return (Brennan back in ~2 days; goal then: close every bug)

Start: `node scripts/run-stats.mjs 48` (trend, needs the logs fetched), then the newest log in
`~/.cache/flight-run-logs` for the lines below. All live from the 10:05 am Nov 16 run.

| Question | Log line | Reading → fix |
|---|---|---|
| Is the backlog draining (9,839 at 8:05 am; -200 a run projected ~10 am Nov 18)? | run-stats `backlog`; `search demand by view` | flat above ~2,000: throughput is short, see the two rows below |
| Does the runner still repeat searches? | `search runner: N of the queue searched by the last run since its build read the runner's rows (to <time>)` | "to none read" after 9:05 am means `extraTo` isn't reaching the queue file |
| Is "View more flights" worth 36% of page time? | `search runner, replies after the first list: … with a row cheaper than the first list's cheapest` | rarely cheaper: skip it for refreshes (≈ +50% pages); the booking job's 4 cores are the limit |
| Are hidden cells transient or stuck? | `hidden cells by time hidden:` (new / 1-2 h / 3-6 h / 7-24 h / over a day, by where) and `hidden N h: <view#in-out#set#holder#class>` | 1-2 h only: it's the ~2-run latency, cut inflow or latency; 7 h+: a stuck cell, trace the id |
| Where do new return searches come from? | `return searches never made, asked for kept trips:` | "another outbound" large: keep the searched outbound while the new one's returns are fetched (needs Brennan: shows a proven but maybe not cheapest trip); "passed over" large: search the next outbound's returns ahead |
| Do filters recover? | run-stats `filt.fresh`; `booking runner, filters due:` | never checked (48 h) should fall from 7,308; if "hold ran out" keeps the first 900, the 24 h hold is too short for ~750 pages a run |
| Tickets whose page never has the listed offer | `N without the listed offer (… 3rd-5th time running …)` | board had 68 at 3rd-5th time by 7:05 am: bring Brennan the numbers (changes the shown price) |
| Do the sweep's booking pages duplicate the runner's? | `booking pages made twice within 2 h` | large share of the sweep's ~200: give the sweep the queue's tail |
| Canary | `canary full|short: N sellers, $X`, `held N min for the short list` | full now means under $4,000 or 10+ sellers; held for whole runs again: the test ticket needs replacing |
| Search runner errors | `search runner: errors by kind` | 48-117 a run "GetShoppingResults rejected … not asked again": if they are the same searches each run they hold the queue's head |
| Why don't the filters' never-checked fall? | `booking queue turnover:` (from the 5:05 pm Nov 16 run) | filters' "not in the last build's … not checked in 48 h" near the ~830 never-checked pages a run: the queue's tickets turn over as fast as they are checked; find what changes them (searches refreshed, ~700 a run) before adding pages |
- 4: one cycle only so far. Board: 79 first time, 59 second time running, 59 over 30% above listed.

Read at 4:20 pm Nov 16 (runs 8:05 am-3:05 pm), every line above printing:

- Backlog 9,839 → 8,204, about -430 a run over the last three (the never-searched are done within
  each run: 23-42 started in the last two, 687-762 refreshes). Hidden 870 (11:05 am, after a burst
  of ~250 new via cells a build 10:05 am-12:05 pm) → 286; new hidden a build now 30-55.
- Hidden cells clear after 1-2 h mostly (155-560 a build), some after 3-6 h (19-42); ~60 via and
  ~5 board cells are 3-6 h hidden. None can read over 6 h before the 5:05 pm run (the line began 10:05 am).
- Runner skip: 462-803 a run, `extraTo` a time each run.
- "View more flights" stays: 23-32% of pages with later replies had a row cheaper than the first
  list's cheapest (112-157 of 438-495).
- Business lows up ~10-15% at the cheap end since 11 pm Nov 15 (board p10 $4,900 → $5,750; economy
  and Google's graph fares flat): Globehunters' and Trip.com's deep discounts ended (cheapest on
  ~5% and 1-3% of business pages → ~0%). Real, not the runner's list: Brennan's own Chrome showed
  the canary at $4,618 AranGrant, Trip.com $4,899, Globehunters $4,871 (5 pm Nov 16), as the runner
  sees. So the canary's price test (under $4,000) is dead; only its seller count (10+ full, 6 short) tells.
- Two calls Brennan left to judgement (5:30 pm Nov 16: "the data needs to be real… always see a
  cheap price if it exists"), both live from the 6:05 pm run:
  1. A cell whose best trip's return isn't searched yet shows its best trip that is proven
     already (`verify` p.alt: walked on from searches already made, none added), until the
     cheaper one's return lands. Log: `details round N, cells whose best trip's return isn't
     searched yet: N show their best proven trip meanwhile (over the best's unproven price …)`.
     Hidden should fall to the cells with no proven candidate in 20.
  2. A ticket whose page lacks the listed price twice running (2+ h apart, full list) costs what
     its cheapest seller in the cabin asks (`bookings.js` gone: applied, held 12 h; back to the
     listed price the first page that has it). Log: `N without the listed offer (N of them the
     2nd page running or later on the full list: the page's price applied …)`. Watch business
     lows on the history tab for a step up from this, and the board's rechecks every 3 h ending.
- Booking pages made twice: 51-146 a run of ~1,600.
- Filters: fresh flat (4,161 of 15,317); never checked 7,308 → 6,961 with 836 of the first 900
  never checked each run. Search runner errors 1-16 a run since 10:05 am (82 at 8:05 am). Canary full, held 0 min.
- First run with both calls (6:05 pm Nov 16, run 43992789096, both jobs passed): hidden 286 → 141;
  191 then 139 cells showed their best proven trip (17.5-20.6% median over the best's unproven
  price, 203% most), 22 and 17 had a stand-in picked that didn't prove. Pages without the listed
  offer priced at the page's price: 69 of 140, 0 of 173 and 9 of 10 in the three passes.
- Why the filters don't get fresher: `booking queue turnover` says 3,543 of the filters' 15,275
  tickets are new each build and as many leave (23% an hour; 1,971 of the new ones not checked in
  48 h), against ~830 checked a run. The board's turns over 825 of 4,273 (184 not checked in 48 h).
  Next: log why a filter ticket leaves the queue (its cell's cheapest moved, or the cell went).
- That log, from the 8:05 pm Nov 16 build (`trips/turnover.js`, three lines a tier; stays are
  counted from that build, so read the stay and time-queued parts from Nov 17 on):
  - `booking queue turnover, filters' new (…)`: what the newcomers are against the last build:
    `other dates on its route` (the cell moved to another trip), `same dates, other outbound /
    return flights` (Google's cheapest flight on the date changed), `another outbound of a ticket
    in both` (the 2 other outbounds queued with each long-haul ticket changed with its search's
    rows), `in the board tier there`; and how many `were queued before in 48 h` (tickets that
    flip in and out).
  - `… gone (…)`: the same for the leavers, `stayed one build / 1-3 h / …`, and how many `had a
    booking page in 48 h` (pages spent on tickets that then left).
  - `… by time queued`: the queue by how long each ticket has been in it, with the not-checked of
    each age. Mostly `under 1 h` and `1-3 h` among the not-checked: the pages go to a fringe that
    leaves before it is reached, and the fix is to stop the flipping at its source (which kind
    leads above) or queue a ticket once it has stayed. Mostly `25+ h`: the standing tickets are
    starved, and the order the runner takes them in is the fix.
- Read at 9:40 am Nov 17 (run-stats 40; run 44110251859): not converging. Filters fresh 4,358 of
  14,788 (+27 a run); search backlog drained 11,030 → 7,106 by 6 pm Nov 16, then flat at
  7,300-7,900; hidden 135 (falling ~4 a run).
  - Both queues are fed by the cells moving: the filters' tier takes in 3,565 a build (1,796 of
    them back after 1-12 h away; 1,358 of the leavers stayed one build), the search side 1,840
    lookups a build the last didn't make (28,750 of 45,342 fresh searches unused).
  - Both are starved at the head too: the runner's first 900 filter pages were 694 "hold ran out",
    with 5,347 never checked waiting. Such a recheck (at listed, listed the same) found a cheaper
    seller 137 of 1,993 times (7%, 8 runs); a first page 67 of 193 (35%).
  - Fix (from the 10:05 am Nov 17 build): those rechecks go after the rest of their tier until 36
    h after the check (`bookings.js` QUIET_HOURS). Due reasons now split "hold ran out, at listed
    and unmoved". Expect the filters' never-checked to fall and fresh to rise; watch the
    rechecks' "booked lower" share in `rechecked N` (it should stay near 7%).
  - Telemetry: `booking queue turnover, <tier> gone, why:` per leaver, against this build: `its
    flights no longer planned`, `dearer now (listed up / was below listed …)`, `cheaper now, still
    not picked`, `same price, its cell found a cheaper trip`, `… its cell dearer now`, `… its cell
    gone`, `… the same total with another trip (a flip)`, other outbounds by their ticket. Flips
    are the bug to fix at the source (a tie-break that holds the last pick); the first build
    after this reads `cell not known` (the last queue had no cells).
  - Nov 17, 11:05 am–5:05 pm (7 runs): no reason but `its flights no longer planned` (1,200–2,200
    of the filters' ~2,300–3,700 leavers a build, half to two-thirds) and the tier and outbound
    moves ever showed. Planned trips are mostly cells' picks, so a ticket its cell dropped leaves
    the planned set too and that bucket hid the rest. It now splits by what the cell did: `not
    planned now, its cell found a cheaper trip / dearer now (its flights gone or up) / gone / the
    same total with another trip (a flip)`. Same runs: searches 1,163–1,421 a run (was 551–747),
    rejected replies 25–57% (`lost` 76–279); booking pages ~1,660 a run, capped by the 1.5 s
    pacing, not CPU; filters fresh +79 a run (5,009 of 14,574).
  - First split (6:05 pm Nov 17), the filters' 3,028 leavers: 1,063 other outbounds (682 with
    their ticket, 381 with it still queued), 557 cell gone, 479 to the board, 407 its cell found
    a cheaper trip, 304 its cell dearer, 218 flips (150 with a booking page in 48 h). Board: 451
    to the filters, 72 cell gone, 53 dearer, 45 flips, 40 cheaper. "Cell gone" was mostly the
    long-haul cap cells: `fast` keeps only the caps where the trip changes, so a cap's cell
    vanished whenever its cell's pick changed. Every cap now carries its effective trip (the
    looser cap's when its own is absent), so those read as the cheaper, dearer or flip they are.
  - That didn't shrink it (425, 616). Split by kind (Nov 18): mostly band and band long-haul cap
    cells whose row is gone (180-240 a build), the rest band cells with the row there.
  - Pages by ticket (8:05, 9:05 am Nov 18), the filters: own flights 545-584 pages, 323-376
    cheaper than listed; other outbounds 534-641 pages, 25-46 under their ticket's price (~6%),
    249-324 without the listed offer, 223-248 no seller in the cabin. Board: 75-79 other
    outbounds, 8-9 under. Fix: past the board, other outbounds go after the tier's own tickets
    and its quiet rechecks (`bookingCandidates`). Filters fresh had stalled (−30 a run, Nov 17
    evening), +72 a run overnight (6,190 of 14,580).
  - Search backlog flat at 4,000-4,700 overnight with the runner at ~1,320 a run against ~880
    needed. Telemetry (from the 11:05 am Nov 18 build): `search backlog flow: <last> → <now>;
    left …; stayed …; joined …` against the last build's queue. Left: searched since (in the
    runner's head or past it), no longer looked up. Stayed: in the runner's head (being searched
    this run, its rows reach the next build) or past it. Joined: aged out (24 h YVR / 48 h YYJ and
    hops), a new lookup (never searched, or stale), looked up last build too but not in its
    queue. `search demand` ages now go by quarters of each search's own hours (by 6 h alone
    every 48 h search past 18 h read "18-24 h"), and its "takes N a run" counts each search at
    its own hours.
  - Agency-only sales (only a booking page shows them) on the board: Brennan, Nov 18, the
    likeliest place for a sale, after YVR business. Board tickets were held 12 h (24-36 h at the
    listed price for YYJ's): a 6 h sale caught ~35%. Now held by group whatever they booked at
    (`bookings.js` BOARD_HOURS, half an hour under the cycle): YVR business every 3 h, YVR
    economy 6 h, YYJ business 8 h, YYJ economy 12 h; the hops as before. Telemetry: `booking
    freshness, board / filters:` per home and cabin, the share checked under 3 / 6 / 12 h at
    the run's start (≈ the catch chance for a sale that long). Watch the board's pages a run
    (was ~410) and what it leaves the filters.
    Measured (Nov 18): board pages 412 → 505 → 474 a run, filters ~1,000; YVR business under
    6 h 45% (11:05 am, before) → 47% → 53% (1:05 pm), under 12 h 85% → 90%, still climbing.
  - Fourth runner (Nov 18, 7 pm; Brennan: "another proton vpn but no more", CA#623): job
    `booking2`, a second booking runner on its own IP. `--shard i/n` splits the queue by
    itinerary key (board and filters both), the unchecked dates stay on shard 1, each reads the
    other's last prices (`--also`), the build reads both (`--booking-extra a,b`). Expect ~3,100
    booking pages a run; run-stats sums both runners.
  - Flips aren't ties: of ~350 "same total" flips a build (1:05 pm Nov 18), 30 were to the
    dollar; the rest moved under 1%, cheaper or dearer, and the cheaper trip must win. A sticky
    pick would save ~30 a build: not built.
  - Search backlog (`search backlog flow`, Nov 18): grows ~200-380 a run with the runner at
    ~900-1,080 good searches. ~450-520 a build join as "new lookup, searched before (stale)":
    itineraries the plan dropped and picked again after their searches aged out.
  - YVR's long hauls first (Brennan, Nov 17: "we need to get much closer to 90%+" on catching a
    sale live 6 or 12 h; YYJ and the hops matter less). Estimated catch rates before: airline fare
    on a YVR core city at 14/17/21 days ~60% at 6 h, ~90% at 12 h; other YVR lengths and cities,
    YYJ ~35% / ~75%; agency-only discount on a shown itinerary ~45% / ~80%, on one not shown ~10%
    / ~25%. Changes (from the 11:05 am build):
    - Graphs (`config/sweep.json`, tiers take `cabins`): every YVR business graph every 2 h (was
      2/6/8 h); YYJ business 16 h, economy 24 h (was 8); hops 24/48 h (12/24); Pacific 24/48 h
      (12/24); Asia round trips 96 h (48). Needed 225 graphs an hour (was 277) of ~266 scraped.
    - Booking: YVR's long hauls before YYJ's in each tier (were cheapest first, both together);
      YYJ's and the hops' tickets booked at the listed price held 36 h (`SLOW_HOURS`); a
      listed-price move still brings them back at once; discounts keep 12 h.
    - Searches: YYJ's and the hops' fresh 48 h (`SLOW_SEARCH_HOURS`), YVR's 24 h; in the search
      runner's queue YVR refreshes before YYJ's and the hops' (`refresh (YYJ, hops)` in `search
      queue in order`), but one 5 days old or more goes in place (dropped at 7).
    - Brennan is getting a third runner's VPN credential; efficiency fixes first.
  - Search runner: 667 searches in 43 min, slots 97% in pages, page 14.7 s (Google's reply 61%,
    "more flights" 30%). More slots pinned the machine on Nov 14, so its ~670 a run is the cap;
    the search side converges only if churn falls.

### Open bugs, most important first

1. **Hidden board cells don't converge (~1,500).** A round trip's return is searched with the
   chosen outbound (`details.js` returnQuery, key includes `selected` flight numbers) as a
   browser page. Returns run at RETURN_PRIO (5e5), after every check's search in the build
   (`returnsFor` at the cell's rank × TRIES + TRIES − 0.5; long-haul filter caps FAST_PRIO after),
   so most go out of time into the search runner's queue; ~920-1,000 attempted a build, 560-760
   skipped out of time. Each time a cell's cheapest outbound flight changes, its return key changes
   (~1,300-1,400 fresh returns a day unused because the trip's outbound changed). Untried: priority
   for board cells' returns over via/filter cells' checks; a return search keyed less tightly (but
   the return's price depends on the outbound chosen: proven per outbound).
2. **The build's lookups turn over ~6% an hour** (`search churn`: 17,959 of 19,297 again, ~1,000
   new a build, ~70% of the new 300+ days out, most served stale). So a search made now is often
   no longer looked up when it expires at 24 h, and only ~7,700 of ~19,300 are fresh at once.
   Not wasted work: the runner's queue head is 92-99% looked up next build. Cause: cells walk
   candidate dates in graph-price order (`build-trips.js` verify, TRIES = 10, rankOf/scoreOf), and
   far-out graphs are flat (~13 dates within 1% of a route's cheapest), so small real moves change
   which dates are walked. Ranking by a 2%-banded price would cut top-5 date churn only 17-23%
   (simulated on the data branch's CSVs, 48 h) and could skip a date up to 2% cheaper: not done.
   Effective search demand is therefore higher than used / 24 h ≈ 800 a run. Untried: stable
   tie-breaks among dates within noise (deterministic, preferring a fresh search when prices tie
   exactly or within the scraper's rounding); measuring how often a new lookup becomes the cell's
   shown trip (whether the churn finds cheaper trips or just walks past them).
3. **Filter tickets are capped by booking pages.** ~790 filter pages a run against 590-1,180
   needed; +30 fresh a run. Booking slots: 60% in pages, 40% in the 1.5 s gap. The 1.2 s gap with
   7 search slots (1:05 pm Nov 14) pinned the machine (load ~16) and made no more pages of either
   kind: reverted. A 1.2 s gap with the search runner at 5 slots is untried.
4. **The board takes ~580 booking pages a run against ~340 at steady state** (4,039-4,200 tickets
   at a 12 h hold). The rest are new tickets (a cell's trip or its flights changed: same churn as
   #2) and listed-price moves (1% tolerance, `bookings.js` near). Holds can't be longer: of ~350
   board rechecks with the listed price unmoved after 12 h, 50 booked lower.
5. **The booking machine is CPU-bound for search pages.** A search page: 14.6 s, 91% waiting on
   Google (reply 55%, "more flights" 36%), 3.4-4.0 renderer CPU-s; booking page 2.3 s, 1.0 CPU-s.
   Load 8-12 on 4 vCPUs at 5 search + 3 booking slots; more slots slowed every page. The 1024×640
   lean window saved no CPU. Untried: blocking images (28 a page) and fonts in lean search pages
   (check the results still parse), fewer requests per page.
6. **Lost "more flights" lists: 0-31 a run** (up to 5 loads, MORE_TRIES; tallied `lost`).
7. **Searches on the sweep IP degrade over a run** (pages listing nothing climb).

### Fixed or ruled out on Nov 14 (don't redo)

- Builds and the search runner made the same searches (518 of 1,177 runner rows older than the
  sweep's): builds leave the runner's queue head to it (`runnerKeys`, from 12:05 pm). Runner rows
  newer than the cache's: 56% → 66-70%.
- "More flights" lost about 1 in 3 lists: reload up to 5 loads; now 0-31 a run.
- Graph-price noise outdating searches: real (118,217 graph changes in 48 h, median 0.3%, a
  quarter flipping back) but it outdated only 7-42 fresh searches a build. Moves under 2% (summed
  from the last bigger one) no longer mark a fare changed (`store/routes.js` MOVE, `base` in
  current.json, from 8:05 pm). Not the cause of low freshness.
- 7 search slots / 1.2 s booking gap / 200-page sessions: no gain, machine pinned. Reverted.
- Lean 1024×640 window: no CPU saved (kept, harmless).

### Telemetry to read each run

`node scripts/run-stats.mjs 8 --detail` (logs cached in `~/.cache/flight-run-logs`). Lines in the
build log: `search demand`, `search waste` (fresh searches not looked up, by kind and why),
`search churn` (lookups again vs new, new by kind/state/days out, runner queue head looked up),
`search mix` (incl. `outdated by a graph price change`), `booking demand`, page phase/CPU lines
and slot-time lines for both runners, `CPU averages`, `load (1 min) average`.

## Recheck schedule

| What | Held for | Due early when |
|---|---|---|
| Board ticket, booking page | 12 h | its listed price moves |
| Filter ticket, booked at the listed price | 24 h | its listed price moves |
| Filter ticket, discounted | 12 h | its listed price moves |
| Off-board date pair, nothing proven | 72 h | its graph price drops |
| Off-board date pair, proven | 12 h | its graph price drops |

## Numbers (latest first)

| Run | Board | Filters fresh (< 12 h) | Search runner | Search backlog | Notes |
|---|---|---|---|---|---|
| 8:05 pm Nov 14 | 464/464 | 4,783 of 14,304 (953) | 665, 3 lost | 9,868 | search churn: 17,959 of the last build's 19,297 lookups again, 1,186 new (824 of them 300+ days out, most served stale); graph moves outdated 7-13 fresh searches a build (not the cause); 1,526 hidden |
| 7:05 pm Nov 14 | 427/427 | 4,709 of 14,279 (955) | 744, 13 lost | 10,508 | lookups turn over ~6% an hour: a search made now is often not looked up by the time it expires, so ~7,700 stay fresh of ~19,300; the search runner's queue head is 92% looked up; 1,703 hidden |
| 2:05 pm Nov 14 | 626/626 | 4,556 of 14,205 (786) | 813, 7 lost | 10,701 | back to 5 slots / 1.5 s gap, lean 1024×640 pages: load 8.2 avg (max 11.7), search page 14.6 s, renderer 4.0 CPU-s (3.4 at 11:05 am: the smaller window saved nothing), booking 2.3 s / 1.0 CPU-s, 1,695 booking pages; runner rows newer 963 of 1,385 (70%); ~1,200 searches made against 813 needed, yet only 7,576 of 19,502 fresh: searches go to keys the builds don't keep; 1,497 hidden |
| 1:05 pm Nov 14 | 666/666 | 4,541 of 14,346 (553) | 811, 0 lost | 11,305 | search 7 at once, booking gap 1.2 s / 200-page sessions: load ~16 on 4 vCPUs, search page 20.7 s (main thread 9.4 CPU-s, was 2.8), booking page 4.4 s (was 2.5), no more pages done (1,591 booking): reverted for 3:05 pm, lean pages 1024×640 instead; 1,605 hidden |
| 12:05 pm Nov 14 | 677/677 | 4,517 of 14,689 (681) | 896, 1 lost | 11,900 | builds left the runner's queue head to it: runner rows newer than the cache's 1,034 of 1,569 (66%, was 56%); 1,586 hidden |
| 11:05 am Nov 14 | 826/826 | 4,588 of 14,526 (526) | 820, 8 lost | 11,958 | first telemetry: search page 14.5 s median, 91% waiting on Google (reply 57%, more 34%), renderer 3.4 CPU-s; slots 97% in pages; machine ~2 of 4 cores; search runner rows 1,177, 518 older than the sweep's own (duplicate searches): builds leave the runner's queue head to it from 1:05 pm; 1,378 hidden |
| 10:05 am Nov 14 | 795/795 | 4,537 of 14,298 (611) | 654, 34 lost | 10,942 | 1,571 hidden |
| 9:05 am Nov 14 | 713/713 | 4,509 of 14,134 (668) | 631, "more flights" 4 lost | 11,798 | load 7-18; 1,519 hidden |
| 8:05 am Nov 14 | 563/563 | 4,377 of 13,921 (796) | 680, 50 lost | 11,112 | load ~11; 1,538 hidden |
| 7:05 am Nov 14 | 572/572 | 4,355 of 13,892 (791) | 634, 36 lost | 11,706 | load 12-15; 1,577 hidden |
| 6:05 am Nov 14 | 415/415 | 4,227 of 14,114 (885) | 700, 36 lost | 11,841 | 1,466 hidden |
| 5:05 am Nov 14 | 540/540 | 3,819 of 13,828 (903) | 791, 0 lost | 11,590 | 1,449 hidden |
| 4:05 am Nov 14 | 564/564 | 3,583 of 13,809 (696) | 813, 10 lost | 11,688 | load ~7; 1,589 hidden |
| 3:05 am Nov 14 | 706/706 | 3,633 of 13,596 (489) | 849, 7 lost | 12,100 | load 6-9; 1,695 hidden |
| 2:05 am Nov 14 | 566/566 | 3,672 of 13,521 (606) | 677, 6 lost | 12,105 | load 10-14; 1,664 hidden |
| 1:05 am Nov 14 | 705/705 | 3,543 of 13,509 (581) | 704, 2 lost (up to 5 loads) | 11,910 | load 12-18; 1,796 hidden. Both runners together use 3-4 cores in every run; searches go 630-850 with page time (median 15-20 s, 5 at once) |
| 12:05 am Nov 14 | 747/747 (0.65 pages/s) | 3,343 of 13,331 (filters 495 pages) | 905 searches, 12.9 s median; "more flights" 569 ok, 170 after reload, 89 lost | 12,024 | reduced motion: load 5-8 (was 10-17), CPU search 130-250%, booking 30-85%; more rejected replies at the faster rate: up to 5 loads from 1:05 am; 1,821 board cells hidden (return not searched) |
| 11:05 pm Nov 13 | 786/786 | 3,100 of 13,207 (filters 383 pages) | 710 searches, 17.3 s median; "more flights" 1 lost | 11,975 | CPU: search runner 160-210% at 0.28 pages/s (~7 CPU-s a page), booking ~120% at 0.57 (~2 CPU-s); unchecked dates 0.95 again, same far out; reduced motion from 12:05 am |
| 10:05 pm Nov 13 | 818/819 | 3,193 of 13,269 (filters 247 pages) | 672 searches, 18.2 s median; "more flights" 524 ok, 80 after reload, 32 lost | 11,582 | gap 1.5 s: 0.58 pages/s (3 at once, 4.4 s each), load 12-18 on 4 cores (5-9 at 2 s); unchecked dates booked/graph 3.15 (0.95 before) |
| 9:05 pm Nov 13 | 872/872, 0 left | 3,244 of 13,264 (filters got 1 page: board + unchecked dates used the run) | 881 searches, 13.8 s median, 0 errors; "more flights" 822 ok, 28 ok after reload, 1 lost | 11,728 | booking pages at exactly 0.50/s (the 2 s gap): 1.5 s from 10:05 pm |
| 8:05 pm Nov 13 | 671/671 checked, 0 left | 3,236 of 13,000 | 778 searches, 16.0 s median; "more flights" 469 ok, 267 rejected | 11,510 | rejected "more flights" lost the full list (button gone): reload added for 9:05 pm |
| 6:05 pm Nov 13 | 531 in 18 min | 2,968 | 732 searches | ~12,190 | |

## Known limits as found, oldest first (history; current state in the Handoff above)

- **Search pages are Google-latency-bound:** first load of an uncached date pair takes 8–16 s.
  More pages at once is capped by rejections (Google's throttle signal; the local IP was cut off
  after ~40 quick searches).
- **"View more flights" rejected about 1 time in 3:** the full list (often the cheapest flights)
  was lost. From 9:05 pm Nov 13 the page is loaded again and clicked, up to 3 loads (tallied as
  `reloads`, `okReload`, `lost`).
- **Booking pages are gap-bound:** at a 2 s gap the run made ~1,270 pages, and the board (~870
  due a run) plus unchecked dates (~400) left none for filters. Board holds can't be longer: of
  ~350 board rechecks with the listed price unmoved after 12 h, 50 booked lower (biggest
  $3,240 → $2,073). Gap 1.5 s from 10:05 pm Nov 13.
- **The booking job's machine is out of CPU:** at a 1.5 s gap, load 12–18 on 4 cores. Booking
  pages gained ~210 a run and the search runner lost ~210, with more rejected "more flights"
  replies. The next lever is CPU per page, not rates; CPU by runner logged from 11:05 pm Nov 13.
- **Telemetry, 11:05 am Nov 14, corrects the CPU story:** a search page uses 3.4 renderer
  CPU-s (not ~7) and spends 91% of its 14.5 s waiting on Google's replies; the search runner's 5
  slots are 97% busy in pages; the machine averaged ~2 of 4 cores (search runner 124%, booking 61%).
  The search runner is bound by slots × Google's reply time, not CPU. Booking pages: 2.5 s, 78%
  waiting for sellers; slots 59% in pages, 36% the 1.5 s gap: the gap binds booking.
- **The sweep and the search runner made the same searches:** the sweep's builds paged the
  most-wanted browser searches while the runner worked the same queue head that hour (518 of the
  runner's 1,177 rows older than the sweep's). From 1:05 pm Nov 14 the builds leave the runner's
  first 1,000 to it (`--runner-queue`, logged as "left to the search runner").
- **Searches on the sweep IP degrade** over the run (pages without results climb).
- **Why only ~7,700 of ~19,300 searches looked up are fresh, Nov 14:** not wasted searches. The
  search runner's queue head is 92-99% looked up by the next build. The build's lookups turn over
  ~6% an hour (`search churn`): cells walk different candidate dates as prices move, ~70% of the
  new ones 300+ days out, where ~13 dates sit within 1% of a route's cheapest. A search made now
  is often no longer looked up when it expires. Graph wiggles (median 0.3%, a quarter flipping
  back) explain little: ranking by a 2%-banded price would cut top-5 date churn only 17-23%
  (and could skip a date up to 2% cheaper), and graph moves outdated only 7-42 fresh searches a
  build. Moves under 2% no longer mark a fare changed (`store/routes.js`, from 8:05 pm Nov 14).
  The search backlog is falling (~94 a run over 3-8 pm) since the builds stopped duplicating the
  runner's searches.

## Telemetry (from 11:05 am Nov 14)

Tuning and ETAs used to come from page counts and one run's change. They were wrong more than once.
Each run now logs:

| Line | Says |
|---|---|
| `search runner, search pages: …` / `booking runner, booking pages: …` | each phase's median, p90 and share of all page time (open, nav, reply, more, reload, sellers); renderer CPU a page from Chrome's counters (process, main thread: script, compile, layout, style); requests a page by type |
| `… slot time (N slots × S s): …` | share of slot time in pages, held by the gap, waiting on a new session, idle: which limit binds |
| `CPU averages over N samples` | booking machine CPU by runner and by Chrome process kind (node, browser, renderer, gpu, utility), sampled every minute |
| `load (1 min) average` | the booking machine's load over the run |
| `search demand: …` | searches the build used: fresh by age, stale, never searched; what keeping all fresh at 24 h takes a run |
| `booking demand: …` | board and filter tickets ÷ their holds = pages a run needed; tickets not checked in 48 h |

`node scripts/run-stats.mjs [N] [--detail]` turns the last N runs' logs into the numbers table,
least-squares trends and capacity against demand. The estimates below come from it.

## Estimates

(`scripts/run-stats.mjs 6`, 3:05-8:05 pm Nov 14, one config; the earlier "3 pm / 1 pm Nov 14" estimates were wrong.)

- Filters fresh: 4,783 of 14,304, +33 a run → ~Nov 27. Too slow: booking pages are the limit.
- Search backlog: 9,868, −94 a run → ~5 am Nov 19.
- Hidden board cells: 1,526, −16 a run → ~8 pm Nov 18.
- Booking pages ~1,590 a run: the board takes ~610 (steady state ~350 at 12 h, so ~260 a run
  are due early on price moves), unchecked dates ~290, filters ~690 (steady state 575-1,150).
