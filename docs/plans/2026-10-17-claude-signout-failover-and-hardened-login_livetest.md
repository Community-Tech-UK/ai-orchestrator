# Claude sign-out failover and hardened login hand-in — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-10-17-claude-signout-failover-and-hardened-login_plan_completed.md](2026-10-17-claude-signout-failover-and-hardened-login_plan_completed.md)

**Prerequisites:**

- Rebuild Harness from this checkout (`npm run build:main && npm run build:renderer`), then James
  restarts it when no live sessions would be lost. These checks need the rebuilt app; a hardened
  session cannot be started from inside a Harness session (the signal fence refuses nested
  Seatbelt), which is why none of them could run in-loop.
- Both Claude accounts signed in (ClaudeSUAS `legacy`, Comtech `claudecomtech-7e12`).
- Never print token values. Inspect the Keychain with metadata only (`security find-generic-password
  -s "<service>"` without `-w`), or with a script that prints booleans and expiry times only.

## Check 1 — a hardened Claude session runs on the handed-in login and leaves the stored login alone

Steps:

1. Note the Keychain `mdat` of `Claude Code-credentials` and the mtime of `~/.claude/.credentials.json`.
2. Create a hardened Claude session (Comtech or SUAS) and send one short turn.
3. Grep `app.log` for `Handing the stored Claude login to a hardened session`.

Expected: the session answers; the log line appears with the account and `expiresInMinutes`; the
Keychain `mdat` and the `.credentials.json` mtime are unchanged; no token value appears in `app.log`.

## Check 2 — keep-alive across expiry without a sign-out

Steps: leave a hardened Claude session open across its account's token expiry (check the stored
`expiresAt` first), with no other Claude session on that account active, then send a turn.

Expected: the turn fails once with an auth error, the session restarts itself within about 10 s and
re-sends the turn; `app.log` shows no `Refreshing the Claude login outside the jail failed`; the
account stays signed in (`claude auth status` for that account reports `loggedIn: true`); no other
session reports `OAuth token revoked`.

## Check 3 — a signed-out session moves to the other account

Needs James: it signs one account out, and he must sign it back in afterwards.

Steps:

1. Start a Claude session on Comtech and send a turn.
2. Sign Comtech out outside Harness: `CLAUDE_CONFIG_DIR="$HOME/Library/Application Support/harness/claude-cli-profiles/claudecomtech-7e12" claude auth logout`.
3. Send another turn in the session.

Expected: no "Signed out of claude" banner; an "Account switched" notice reading
`Comtech → ClaudeSUAS (signed out).`; the turn is re-sent and answered on ClaudeSUAS; `app.log`
shows `Account switch after sign-out` with `outcome: 'switched'`. Then sign Comtech back in.
