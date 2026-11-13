#!/usr/bin/env bash
# Network probe beside a CI job, outside Node: is a search timing out because Google limits the
# IP, the VPN tunnel is full, or the job's process is too busy to send it? (2026-11-13: the sweep's
# plain searches had 200+ "fetch failed (ETIMEDOUT)" a build and ~450 skipped out of time a round,
# with the event loop delayed 1-7 s.)
#
#   scripts/netprobe.sh run <log> &     # every 20 s, until killed
#   scripts/netprobe.sh summary <log>   # per 5-min window
#
# Each round times, through whatever route the job has (the tunnel when it's up):
#   cf      Cloudflare's trace page: slow here too means the tunnel or the runner's network;
#   g204    google.com/generate_204: Google slow at the network level;
#   search  one Google Flights search page (a fixed query, as the plain searches fetch them):
#           slow, refused (non-200) or empty only here means Google limiting the search endpoint.
# with the 1-min load average and the tunnel's received/sent bytes.
set -uo pipefail

SEARCH='https://www.google.com/travel/flights?tfs=CBwQAhoeEgoyMDI3LTA5LTEwagcIARIDWVZScgcIARIDSEtHGh4SCjIwMjctMDktMjVqBwgBEgNIS0dyBwgBEgNZVlJAAUgDcAGYAQE&hl=en&gl=CA&curr=CAD'
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

BODY=
probe() { # name url → "name code connect ttfb total bytes rows" (rows: the search page's result rows inlined, 1/0; - elsewhere)
	local out rows=-
	: > "$BODY"
	out=$(curl -s -o "$BODY" --max-time 15 -A "$UA" -H 'accept-language: en-CA,en;q=0.9' \
		-w '%{http_code} %{time_connect} %{time_starttransfer} %{time_total} %{size_download}' "$2" 2>/dev/null) || true
	# A result row in the inline ds:1 blob starts [[[["<airline>",[ (flights.js parseResults); the
	# page comes back the same size without them, so size alone doesn't tell.
	[[ $1 == search ]] && { grep -qE '\[\[\[\["[A-Z0-9]{2}",\["' "$BODY" && rows=1 || rows=0; }
	echo "$1 ${out:-000 0 0 15 0} $rows"
}

case "${1:-}" in
run)
	log=$2
	BODY=$(mktemp)
	trap 'rm -f "$BODY"; exit' EXIT TERM INT
	while :; do
		t=$(date +%s)
		load=$(cut -d' ' -f1 /proc/loadavg)
		# The tunnel's counters need root: on a CI runner only (never sudo on a machine of ours).
		wg='- -'
		[[ "${GITHUB_ACTIONS:-}" == true ]] && wg=$(sudo -n wg show wg0 transfer 2>/dev/null | awk '{rx+=$2; tx+=$3} END {print (NR ? rx" "tx : "- -")}')
		for p in "cf https://www.cloudflare.com/cdn-cgi/trace" "g204 https://www.google.com/generate_204" "search $SEARCH"; do
			echo "$t $(probe $p) $load $wg" >> "$log"
		done
		sleep 20
	done
	;;
summary)
	log=$2
	[[ -s "$log" ]] || { echo "netprobe: no samples"; exit 0; }
	# Per 5-min window and probe: samples, failed (no answer in 15 s), non-200, avg/max total s, and
	# for search how many came back without result rows; the window's load and tunnel MB/s.
	awk '
		NR == 1 { t0 = $1 }
		{
			w = int(($1 - t0) / 300); k = w SUBSEP $2; win[w] = 1
			n[k]++; tot[k] += $6; if ($6 > mx[k]) mx[k] = $6
			if ($3 == "000") fail[k]++; else if ($3 != "200" && $3 != "204") bad[k]++
			if ($2 == "search" && $3 == "200" && $8 == "0") thin[k]++
			load[w] += $9; ln[w]++
			if ($10 != "-") { if (!(w in rx0)) { rx0[w] = $10; tx0[w] = $11; ts0[w] = $1 } rx1[w] = $10; tx1[w] = $11; ts1[w] = $1 }
		}
		END {
			for (w = 0; w in win; w++) {
				line = sprintf("netprobe %2d-%2d min:", w * 5, w * 5 + 5)
				split("cf g204 search", ps, " ")
				for (i = 1; i <= 3; i++) {
					k = w SUBSEP ps[i]
					if (!n[k]) continue
					line = line sprintf(" %s %d/%d ok, avg %.1f s, max %.1f s", ps[i], n[k] - fail[k] - bad[k], n[k], tot[k] / n[k], mx[k])
					if (bad[k]) line = line sprintf(" (%d refused)", bad[k])
					if (ps[i] == "search" && thin[k]) line = line sprintf(" (%d without results)", thin[k])
					line = line ";"
				}
				dt = ts1[w] - ts0[w]
				line = line sprintf(" load %.1f", load[w] / ln[w])
				if (dt > 0) line = line sprintf("; tunnel in %.2f MB/s, out %.2f MB/s", (rx1[w] - rx0[w]) / dt / 1e6, (tx1[w] - tx0[w]) / dt / 1e6)
				print line
			}
		}' "$log"
	;;
*) echo "usage: $0 run|summary <log>" >&2; exit 2 ;;
esac
