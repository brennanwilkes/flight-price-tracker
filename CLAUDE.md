# Asia Flight Fare Tracker

Scope, architecture and every settled decision: `SCOPE.md` (read it first). Product plan:
`~/Downloads/Asia Flight Fare Tracker — Plan.md`.

## Cloudflare account — ONLY the personal one

| | |
|---|---|
| Email | `brennan@codexwilkes.com` |
| Account ID | `a53d0d3cb40662b52e001ffd082d2f1f` |

Never the Text Groove work account (`brennan@textgroove.com`). Wrong-account writes land in
someone else's production. Guards, all failing closed:

- `worker/wrangler.toml` pins `account_id`. Never remove it.
- `worker/scripts/cf-guard.mjs` checks `wrangler whoami --json`. Runs before every npm script
  that calls wrangler; use `npm run cf -- <args>` from `worker/` for ad hoc wrangler commands.
- `.claude/hooks/wrangler-guard.sh` (PreToolUse on Bash) runs the guard before any command
  mentioning wrangler, and always blocks `wrangler login|logout|auth create|delete|activate|deactivate|keyring|token`.
- Wrangler auth is the `codexwilkes` profile, bound to this directory. Wrangler is pinned in
  `worker/` (>= 4.131 needed for profiles; an older wrangler ignores the binding silently).
  Always use `worker/`'s wrangler, never a global or `npx wrangler@latest`.

**Claude never changes Cloudflare auth.** If the guard refuses, stop and ask Brennan to re-auth
(`! cd worker && npx wrangler auth create codexwilkes`). Do not work around the guard, unset it,
or edit `~/.wrangler/` / `~/.config/.wrangler/`.
