# Copilot ACP Exit Recovery — Live Test

> **Found a defect while running these checks?** Record it in
> `docs/plans/livetest-remediation-register.md` as a new `LT-NNN` item (index row plus observed
> behaviour, root cause, required behaviour, and acceptance), and add a matching implementation
> status section to `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check evidence
> stays in this file.
>
> Before continuing, read `docs/plans/livetest-campaign-runbook.md`.

Plan: [2026-09-28-copilot-acp-stdout-eagain_plan_completed.md](2026-09-28-copilot-acp-stdout-eagain_plan_completed.md)

**Prerequisites:**

- Install or restart Harness from a DMG built from this checkout. James restarts it himself; do not
  restart Harness while live sessions run.
- A root Copilot session (any model) with conversation history, in a scratch working directory.
- Evidence sources: `~/Library/Application Support/Harness/logs/app.log` and
  `~/Library/Application Support/Harness/logs/lifecycle.ndjson`. Record the instance id and time
  window for every check.

## Status — 2026-09-28

Open: 1 · Closed: 0 · Failed: 0

All code, unit tests (with revert checks), canonical gates, the full suite and two fresh-eyes
reviews passed. This check stays open only because it needs the rebuilt app: the recovery race is
covered by unit tests against the real `SessionMutex` and exit handler, but has not been observed
end to end.

## LT-A — Replacement dying mid-respawn falls back instead of going silently dead

Why deferred: needs the rebuilt app and a real Copilot process to kill.

Steps:

1. Ask the Copilot session for a long task (for example a 1,500-word essay) so it is `busy`.
2. `pgrep -f "copilot.*--acp"` to find its pid; `kill -9 <pid>`. Harness should log
   `Auto-respawning instance after unexpected exit` and show the session as restarting.
3. Within a second of step 2, find the replacement's pid the same way (the newest one) and
   `kill -9` it while the status is still `respawning`.

Expected:

- app.log shows `Adapter exited during a recovery respawn; deferring to the recovery owner`,
  then either `Resume failed during recovery respawn, falling back to fresh session` or a
  successful respawn.
- The session ends up usable (`idle` or running a continuation), with a "Session restarted
  automatically" / "Session reconnected automatically" notice — not `terminated` with no message.
- lifecycle.ndjson has no `respawning -> terminated` transition for the instance.

If the replacement cannot be killed while `respawning` (the window is short), repeat; record how
many attempts it took.

## Status — 2026-10-04

Open: 1 · Closed: 0 · Failed: 0. LT-A **BLOCKED** (no provable personal Copilot account available to a
dev app); no Copilot session was started. Not renamed `_completed`.

## Evidence run — 2026-10-04 (batch A)

LT-A needs a real Copilot ACP session in a Harness runtime that can be killed. Constraint for this
campaign: only James's personal Copilot account (the legacy `copilot-cli-home` profile) may be used,
never the EBRD seat, and the account must be proven from the runtime's own state before any session.

What was checked, in the isolated dev app (`AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-1004-a`, working tree
at HEAD `3d05e250e`), through the real diagnostics IPC (`getCopilotAccountDiagnostics`,
`listCopilotAccounts`), identifying fields redacted:

- Exactly one profile exists, `legacy` ("Existing Copilot account", `accountKind: personal`,
  `isLegacy: true`, `isDefault: true`), and its binding is `unauthenticated` with error code
  `no-logged-in-user`; aggregate state `auth-required`. Its home
  (`/tmp/aio-lt-1004-a/copilot-cli-home`) holds only a managed `config.json` (first-launch
  timestamp) and CLI logs; no signed-in user. No ambient GitHub token variables are present.
- The only Copilot processes the dev app spawned were its periodic model-catalogue refresh
  (`CursorCopilotCliDiscovery: CLI models refreshed ... provider: 'copilot', count: 39`, every five
  minutes) and the provider doctor (`overall: degraded`); the automatic cross-model review chose
  `cursor`, `antigravity` and `codex`, never Copilot.

Conclusion: a Copilot session started from a dev app cannot authenticate at all, and the one
account that could serve it (James's real legacy profile) lives in the packaged app's profile, which
this campaign must not drive or restart. Signing a personal account into an isolated profile is a
login step that belongs to James. Nothing in the runtime proves which login any other Copilot home
holds, so by the campaign rule the check is recorded BLOCKED rather than guessed.

Residual / what unblocks it (needs James): either (a) a dev profile signed in to his personal Copilot
account (`copilot login` against the dev profile's `copilot-cli-home`, personal account only), after
which LT-A can be run in the dev app exactly as written, or (b) he runs LT-A himself in the packaged
app on a personal-account session. Note for whoever runs it: the original document's `pgrep -f
"copilot.*--acp"` finds the process, but this agent's shell can only see descendants of the dev app, so
use `pgrep -fl -P <dev app main pid>` and gate the kill on the instance's own `processId`.
