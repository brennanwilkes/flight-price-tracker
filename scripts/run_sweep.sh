#!/usr/bin/env bash
# Run one sweep into the `data` branch, rebuild trips (derived/), and push it.
#
#   EGRESS=vpn|direct scripts/run_sweep.sh [scrape|build|alerts] [extra sweep.js args, e.g. --routes YVR-ICN]
#   scripts/run_sweep.sh snapshot; WARM_UNTIL=<epoch s> scripts/run_sweep.sh warm
#
# With no step, scrape, build and alerts in order. CI runs each as its own workflow step (sweep.yml),
# and the flight checks beside the scrape: `snapshot` copies the data branch as it is to
# .worktrees/warm (before the scrape starts: one git at a time), `warm` checks flights on that copy
# into the search cache until WARM_UNTIL (build-trips.js --warm), touching no git.
#
# The data branch is checked out as a worktree at .worktrees/data (created as an orphan branch on
# the first run). The sweep's exit code is passed through AFTER committing, so a failed run still
# records its health. Single writer: CI runs share one concurrency group; push retries once.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_BRANCH=data
DATA_DIR="${DATA_DIR:-$REPO_ROOT/.worktrees/data}"
cd "$REPO_ROOT"
WARM_DIR="$REPO_ROOT/.worktrees/warm"

if [[ "${1:-}" == snapshot ]]; then
	rm -rf "$WARM_DIR" && mkdir -p "$WARM_DIR"
	if git fetch -q origin "$DATA_BRANCH" 2>/dev/null; then git archive "origin/$DATA_BRANCH" | tar -x -C "$WARM_DIR"; fi
	exit 0
fi
if [[ "${1:-}" == warm ]]; then
	[[ -d "$WARM_DIR/routes" ]] || { echo "no data snapshot: no checks beside the scrape"; exit 0; }
	exec node scraper/bin/build-trips.js --data "$WARM_DIR" --warm "$WARM_UNTIL" --search-cache "$REPO_ROOT/.search-cache.json.gz"
fi

git worktree prune
if [[ ! -d "$DATA_DIR/.git" && ! -f "$DATA_DIR/.git" ]]; then
	rm -rf "$DATA_DIR"
	if git fetch -q origin "$DATA_BRANCH" 2>/dev/null; then
		git worktree add -f -q -B "$DATA_BRANCH" "$DATA_DIR" "origin/$DATA_BRANCH"
	else
		echo "no remote $DATA_BRANCH branch; creating it as an orphan" >&2
		git worktree add -f -q --detach "$DATA_DIR"
		git -C "$DATA_DIR" switch -q --orphan "$DATA_BRANCH"
	fi
else
	git -C "$DATA_DIR" pull -q --rebase origin "$DATA_BRANCH" 2>/dev/null || true
fi

commit_push() { # message
	git -C "$DATA_DIR" add -A
	if git -C "$DATA_DIR" diff --cached --quiet; then
		echo "no data changes"
		return
	fi
	git -C "$DATA_DIR" -c user.name="flight-tracker-bot" -c user.email="flight-tracker-bot@users.noreply.github.com" commit -q -m "$1"
	if ! git -C "$DATA_DIR" push -q origin "$DATA_BRANCH"; then
		echo "push rejected; rebasing on origin/$DATA_BRANCH and retrying once" >&2
		git -C "$DATA_DIR" pull -q --rebase origin "$DATA_BRANCH"
		git -C "$DATA_DIR" push -q origin "$DATA_BRANCH"
	fi
}

step=all
[[ "${1:-}" =~ ^(scrape|build|alerts)$ ]] && { step=$1; shift; }
rc=0

if [[ $step == all || $step == scrape ]]; then
set +e
node scraper/bin/sweep.js --data "$DATA_DIR" --egress "${EGRESS:-direct}" "$@"
rc=$?
set -e
# The scrape is committed before the build, so a build that overruns the job can't lose it.
summary_file="$DATA_DIR/.sweep-summary"
msg="$(cat "$summary_file" 2>/dev/null || echo "sweep $(date -u +%FT%TZ) | CRASHED (exit $rc)")"
rm -f "$summary_file"
commit_push "$msg"
fi

if [[ $step == all || $step == build ]]; then
# Trips from whatever fares are current, even after a failed sweep (stale cells age out).
# BUILD_DEADLINE (epoch seconds, CI): when the build must be done. The search cache: flight checks
# reused across builds (CI restores and saves it with actions/cache).
set +e
node scraper/bin/build-trips.js --data "$DATA_DIR" ${BUILD_DEADLINE:+--deadline "$BUILD_DEADLINE"} --search-cache "$REPO_ROOT/.search-cache.json.gz" || rc=1
set -e
commit_push "build $(date -u +%FT%TZ)"
fi

if [[ $step == all || $step == alerts ]]; then
cd "$DATA_DIR"
# Deal alerts, linking to the commit just pushed; then the ledger they wrote.
if node "$REPO_ROOT/scraper/bin/alerts.js" --data "$DATA_DIR" --sha "$(git rev-parse HEAD)"; then
	git add -A state/alerts.json
	if ! git diff --cached --quiet; then
		git -c user.name="flight-tracker-bot" -c user.email="flight-tracker-bot@users.noreply.github.com" commit -q -m "alerts $(date -u +%FT%TZ)"
		git push -q origin "$DATA_BRANCH" || { git pull -q --rebase origin "$DATA_BRANCH" && git push -q origin "$DATA_BRANCH"; }
	fi
else
	echo "alerts failed" >&2
	rc=1
fi
fi
exit "$rc"
