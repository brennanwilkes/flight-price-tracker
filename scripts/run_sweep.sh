#!/usr/bin/env bash
# Run one sweep into the `data` branch, rebuild trips (derived/), and push it.
#
#   EGRESS=vpn|direct scripts/run_sweep.sh [extra sweep.js args, e.g. --routes YVR-ICN]
#
# The data branch is checked out as a worktree at .worktrees/data (created as an orphan branch on
# the first run). The sweep's exit code is passed through AFTER committing, so a failed run still
# records its health. Single writer: CI runs share one concurrency group; push retries once.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DATA_BRANCH=data
DATA_DIR="${DATA_DIR:-$REPO_ROOT/.worktrees/data}"
cd "$REPO_ROOT"

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

set +e
node scraper/bin/sweep.js --data "$DATA_DIR" --egress "${EGRESS:-direct}" "$@"
rc=$?
set -e
# The scrape is committed before the build, so a build that overruns the job can't lose it.
summary_file="$DATA_DIR/.sweep-summary"
msg="$(cat "$summary_file" 2>/dev/null || echo "sweep $(date -u +%FT%TZ) | CRASHED (exit $rc)")"
rm -f "$summary_file"
commit_push "$msg"

# Trips from whatever fares are current, even after a failed sweep (stale cells age out).
# BUILD_DEADLINE (epoch seconds, CI): when the build must be done.
set +e
node scraper/bin/build-trips.js --data "$DATA_DIR" ${BUILD_DEADLINE:+--deadline "$BUILD_DEADLINE"} || rc=1
set -e
commit_push "build $(date -u +%FT%TZ)"

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
fi
exit "$rc"
