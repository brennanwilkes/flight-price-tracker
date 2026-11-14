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
- **Searches on the sweep IP degrade** over the run (pages without results climb).

## Estimates

- Filters: about +500 fresh a run → all fresh around 3 pm Nov 14 if the 24 h holds keep up.
- Search backlog: about −700 a run → drained in about 16 runs (around 1 pm Nov 14), less as
  rejected pages stop losing the full list.
