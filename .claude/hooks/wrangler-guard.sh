#!/usr/bin/env bash
# PreToolUse(Bash) hook: keeps Claude's wrangler calls on the personal Cloudflare account.
#  - Commands that change wrangler auth are always blocked (Brennan re-auths himself).
#  - Any other command that mentions wrangler runs worker/scripts/cf-guard.mjs first and is
#    blocked (exit 2) unless the login is brennan@codexwilkes.com.
#  - Read-only commands (grep, cat, git, ...) that merely mention the word are let through.
set -uo pipefail

cmd="$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input?.command??"")}catch{}})')"

grep -qiw 'wrangler' <<<"$cmd" || exit 0

first="$(sed -E 's/^[[:space:]]*//; s/[[:space:]].*//' <<<"$cmd")"
case "$first" in
  grep|rg|cat|less|head|tail|sed|ls|find|git|echo|which|wc|diff) exit 0 ;;
esac

if grep -qiE 'wrangler(@[^[:space:]]+)?[[:space:]]+(login|logout|auth[[:space:]]+(create|delete|activate|deactivate|keyring|token))' <<<"$cmd"; then
  echo "wrangler-guard: BLOCKED. Changing or reading wrangler auth is Brennan's job, never Claude's. Ask him to run it with the ! prefix." >&2
  exit 2
fi

if ! out="$(node "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}/worker/scripts/cf-guard.mjs" 2>&1)"; then
  printf 'wrangler-guard: BLOCKED.\n%s\nStop and ask Brennan to re-auth. Do not change auth or switch accounts.\n' "$out" >&2
  exit 2
fi
exit 0
