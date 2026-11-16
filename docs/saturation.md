# Saturation: where each run's checks go

Goal: every board cell and every filter-view ticket proven against a real flight list and a real
booking page, with a recheck soon after its listed price moves. Two runners only (two IPs); no
more runners or VPN configs. Times are Vancouver (UTC−7).

## The two jobs (`.github/workflows/sweep.yml`)

| Job | IP | Does |
|---|---|---|
| `sweep` | .135 | scrape (price graphs), warm checks (search pages ≤ 300 days out, inline), off-board date pairs, build, alerts |
| `booking` | .74 (4 vCPUs, ~2 physical cores) | booking runner (`--pages 3 --gap 1500 --session-pages 300`) and search runner (`--pages 5 --gap 1500 --session-pages 300`: browser searches the build ran out of time for, mostly > 300 days out, from the build's queue) side by side, 43 min each |

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
