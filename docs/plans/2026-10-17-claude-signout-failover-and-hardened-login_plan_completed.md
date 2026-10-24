# Claude sign-outs: switch accounts automatically, and stop hardened sessions breaking logins — plan

**Status:** COMPLETED 2026-10-17 (code, tests and all agent-runnable gates; two fresh-eyes reviews PASS). Checks that need the rebuilt app and James are deferred to [2026-10-17-claude-signout-failover-and-hardened-login_livetest.md](2026-10-17-claude-signout-failover-and-hardened-login_livetest.md). Written 2026-10-17 from James's two asks:

1. "We should swap providers when this breaks, like we do if a provider is full."
2. "Both the comtech and the claudeSUAS account needed reauthing … they should automatically keep the
   sessions fresh and alive."

## What we found (evidence, 2026-10-17)

- `app.log`: `Failed to authenticate: OAuth token revoked` at 02:32, 16:17 and 18:28 BST, each followed by
  `OAuth session expired and could not be refreshed` on other sessions of the same account.
- Each Claude login's plain-text fallback file (`~/.claude/.credentials.json` and the Comtech profile's
  `.credentials.json`) was rewritten at the exact minute of a revoke (16:18 and 18:28). Claude Code only
  writes that file when it cannot write the macOS Keychain.
- Sessions in hardened mode (Seatbelt) ran on **both** accounts that day (`Spawning CLI under Seatbelt
  hardened mode`, roots `~/.claude` and `claude-cli-profiles/claudecomtech-7e12`). LT-029 already
  verified that a jailed Keychain write is denied.
- Claude Code 2.1.302 storage code (read from the installed binary): Keychain write fails → plain-text
  write → Keychain delete also fails → the Keychain keeps the **old** refresh token while the new one
  lives only in the file/memory. Refresh tokens are single-use, so the next session that refreshes from
  the Keychain re-uses a spent token and the server revokes the whole login for every session.

**Root cause:** a hardened (jailed) Claude session refreshing the shared login it cannot store.

Also found:

- The auth-failure path never tries the account pool: a signed-out session shows a banner even when the
  other Claude account is signed in and has usage left. The usage-limit path already switches accounts.
- The auth-repair sign-in watcher probes the *default* Claude login for every session, so a Comtech
  session's watcher looks at the SUAS login.

## Changes

### 1. Signed-out session switches to another signed-in account (James's ask 1)

- `InstanceAuthRepairHandler` gets an account-aware probe and a `switchAccount` dependency. When the
  session's own account is confirmed signed out, it asks the existing `AccountFailoverCoordinator` to
  move the session to another signed-in account with usage left and re-send the interrupted turn —
  the same machinery, guardrails (pool mode, cooldown, per-turn cap) and notices as a usage-limit switch.
- `AccountFailoverParams` gains a `trigger` (`usage-limit` | `signed-out`) so the handoff reason and
  notices say "signed out" instead of "usage limit".
- No candidate, pool off, cooldown, or a confirmed-healthy login → the existing sign-in banner, unchanged.
- The watcher's probe checks the session's own account (binding service, forced), not the default login.

### 2. Hardened Claude sessions can no longer break a login (James's ask 2)

- A hardened Claude spawn gets the account's current login handed in as `CLAUDE_CODE_OAUTH_TOKEN` (plus
  `CLAUDE_CODE_OAUTH_SCOPES`, `CLAUDE_CODE_SUBSCRIPTION_TYPE`, `CLAUDE_CODE_RATE_LIMIT_TIER`). With no
  refresh token in hand, the jailed CLI cannot refresh, so it cannot leave the Keychain stale.
  Verified 2026-10-17 outside the jail: the CLI runs on the handed-in token, Claude Code scrubs the
  variable from tool subprocesses (`printenv` saw nothing), and the stored login is byte-for-byte unchanged.
- Keep-alive: before handing in, if the stored token is expired or inside Claude Code's 5-minute refresh
  window, Harness runs one tiny non-jailed Claude request for that account (single-flight per account).
  That is a normal Claude Code refresh with Keychain access. Measured: ~3 s, ~$0.002.
- A hardened session whose handed-in token later expires fails with an auth error; its account probe
  reports signed in, so no account switch happens and the existing auth-repair restart re-spawns it with
  a current token and re-sends the turn.

### As built (2026-10-17)

- Switch trigger: the probe confirms this account is signed out, **or** the provider itself reported
  `OAuth token revoked` (the whole login is gone even if the stored copy has not been blanked yet).
- A late duplicate failure report for an account the session has already left is ignored
  (`stillCurrent`), so it cannot re-send the old turn a second time.
- Concurrent reports of one failure join the running switch; only one banner can result.

- The switch applies to every pooled provider (Claude, Codex, OpenCode/MiMo), like the usage-limit
  switch; the hardened login hand-in is Claude-only.

### Known limits (accepted)

- A provider-reported revoke switches the session even if the account was re-signed-in meanwhile;
  restarting in place would also have worked. Harmless (the other account is signed in), but a hop.
- The exact error text of an expired handed-in token is not yet captured (livetest Check 2); if it
  ever read "OAuth token revoked" the session would switch instead of restarting.

- Like the usage-limit switch, the re-sent turn is the message text only; attachments and the
  resolved context block are not re-sent. The banner path still re-sends the whole turn.
- When the keep-alive refresh runs, a hardened spawn waits for it (normally ~3 s, at most 2 min, the
  timeout chosen so a slow refresh is never killed mid-flight). The refresh request runs with the
  user's normal Claude settings and hooks.
- `base-cli-adapter.ts` and `instance-manager.ts` now sit at their max-LOC ratchet limit (both were
  already over their base ceilings before this change).

## Verification

- Focused unit tests: auth-repair handler (switch, fallback, account-aware probe), failover coordinator
  (signed-out trigger wording), hardened login hand-in (env built, refresh gating, single-flight, no
  secrets in logs), base adapter env application.
- Canonical gates from `AGENTS.md`.
- Live checks that need a rebuilt app: see the livetest doc linked in the status line.
- As run 2026-10-17: `tsc --noEmit`, `typecheck:spec`, `lint`, `check:ts-max-loc`, `build:main`,
  `build:renderer` all pass; full `test:quiet` 33,196 tests pass.
