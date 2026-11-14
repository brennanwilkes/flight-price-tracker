# Saturation: where each run's checks go

Goal: every board cell and every filter-view ticket proven against a real flight list and a real
booking page, with a recheck soon after its listed price moves. Two runners only (two IPs); no
more runners or VPN configs. Times are Vancouver (UTC−7).

## The two jobs (`.github/workflows/sweep.yml`)

| Job | IP | Does |
|---|---|---|
| `sweep` | .135 | scrape (price graphs), warm checks (search pages ≤ 300 days out, inline), off-board date pairs, build, alerts |
| `booking` | .74 | booking runner (booking pages, 2 s gap, new session every 300 pages) and search runner (browser search pages > 300 days out, from the build's queue) side by side |

The build writes `.booking-queue.json` (board, then filters) and `.search-queue.json` (most
wanted first, at most 8,000). The next run's booking job works through them; the next build merges
the search runner's rows (`--search-extra`).

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

## Known limits and what's being done

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

(`scripts/run-stats.mjs 10`, 12:05-9:05 am Nov 14; the earlier "3 pm / 1 pm Nov 14" estimates were wrong.)

- Filters fresh: 4,509 of 14,134, +132 a run → all fresh ~10 am Nov 17 at this rate.
- Search backlog: 11,798, −64 a run → ~Nov 22. Too slow: the search runner is the bottleneck.
- Hidden board cells: 1,519, −35 a run → ~5 am Nov 16.
- Booking pages ~1,590 a run: the board takes ~610 (steady state ~350 at 12 h, so ~260 a run
  are due early on price moves), unchecked dates ~290, filters ~690 (steady state 575-1,150).
