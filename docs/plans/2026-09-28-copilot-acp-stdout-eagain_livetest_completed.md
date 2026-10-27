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

## Evidence run — 2026-10-27 (Plan Queue worker)

**LT-A: PASS in the rebuilt isolated dev app.** One of one open checks exercised; no
untested requirement or human step remains. Queue verification is still pending, and this
document has deliberately not been renamed.

### Runtime and personal-account preflight

- Built and launched this queue worktree at `80412201a`, using
  `AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-dabff6ef`, renderer debug port `9676`,
  main-process inspector `9677`, and a private server for the freshly built renderer on `4567`.
  The executing main process reported that exact worktree and isolated data path.
  No packaged app or existing user session was restarted or driven.
- The real Harness settings identify profile `legacy` as **personal**, expected login
  `shutupandshave`, host `github.com`; its own Copilot configuration names that same identity.
  The ordinary `~/.copilot` home instead names the enterprise account and was not used.
  Seeded only the verified personal identity metadata and its account policy into the isolated
  profile. No credential or token was copied or displayed; Copilot used its existing named
  operating-system credential entry. This follows the shared named-credential behaviour
  documented in `src/main/providers/copilot/copilot-account-binding-service.ts:3`.
- Real diagnostics IPC returned `aggregate: available`, exactly one profile, `accountKind:
  personal`, `bindingState: authenticated`, matching expected/observed login and host, no
  ambient token-variable names and no warnings. The same diagnostic still passed after recovery.
  The explicit personal route was persisted through both replacements.
- Disposable root instance: `phf3z26ce`; app main PID: `96096`. A real first turn returned
  `RECOVERY_BASELINE_OK` and persisted provider conversation history before the crash check.
- The initial launch failed with Electron's `sandbox initialization failed: Operation not
  permitted` and exited with `SIGTRAP`. The test launch used `--no-sandbox --disable-gpu`
  in this worker environment. Hardened provider execution was not enabled or claimed tested.
  Focus emulation was enabled before renderer assertions; the final DOM observation confirmed
  `document.hidden: false` and `visibilityState: visible`.

### LT-A observations (all times UTC)

1. **03:57:08.760:** killed Copilot PID `5089` with `SIGKILL` while the real instance was
   `busy` on a requested 3,000-word response, with the earlier conversation already present.
   At **03:57:08.762**, the saved main log records
   `Auto-respawning instance after unexpected exit`, `previousStatus: busy`.
2. **03:57:14.250:** killed replacement PID `12933` while the instance was still
   `respawning` and the session mutex owner was `respawn-unexpected`, operation `respawn`,
   recovery reason `unexpected-exit`. This reached the target race on the **first actual
   double-kill attempt**. Both kills independently checked that the PID was absent from the
   pre-campaign process snapshot, its parent was main PID `96096`, its actual command line
   selected `copilot --acp`, and its configuration directory was the isolated personal home.
   The OS executable was Node, so ownership was checked against the actual command line,
   rather than assuming the executable filename would contain “copilot”.
3. At **03:57:14.250**, the saved main log records
   `Adapter exited during a recovery respawn; deferring to the recovery owner`.
   At **03:57:14.251**, it records
   `Resume failed during recovery respawn, falling back to fresh session` with
   `ACP agent exited (null/SIGKILL).` At **03:57:16.841**, it records
   `Recovery respawn complete`, PID `12950`, `resumed: false`, followed by
   `Auto-respawn successful`.
4. The lifecycle receipt records `busy -> respawning -> ready -> idle`, recovery method
   `replay`, followed by a real automatic continuation. There are **zero
   `respawning -> terminated` transitions** among the 22 transitions captured before
   intentional cleanup. The session retained its conversation and finished the continuation.
5. The live renderer displayed a `<p>` containing
   `Session restarted automatically (resume failed)`, with focus emulation active. At
   **04:01:11.698**, a further real user turn had returned exactly
   `RECOVERY_AFTER_DOUBLE_CRASH_OK`; the same instance was `idle`, PID `12950`, with persisted
   provider history. Usability was observed after the recovery, not inferred from status alone.

**Timing clarification:** step 3's suggestion to kill the replacement within one second of
the original kill did not describe this runtime's timing. The owner spent about five seconds
terminating the previous adapter before creating the replacement. A bounded observer then
killed the first replacement while it was still starting, with the required `respawning`
status and held recovery lock. The measured original-to-replacement kill interval was
5.490 seconds. No timing window was artificially widened and no recovery implementation was
patched. One earlier long response completed while the probe was being prepared; its guarded
kill attempts refused to send a signal. Those are not counted as crash attempts.

### Durable receipts and verification

Receipts are in the queue worktree at
[`evidence/2026-10-27-copilot-acp-stdout-eagain/`](evidence/2026-10-27-copilot-acp-stdout-eagain/):

- `runtime-receipt.json`: verified personal-account diagnostics, both guarded kill receipts,
  mutex owner, final reply, final state and rendered restart notice.
- `app-log-receipt.ndjson`: timestamped records copied from the real
  `~/Library/Application Support/harness/logs/app.log`, filtered to this instance. They
  survive log rotation and deletion of the isolated runtime.
- `lifecycle-receipt.ndjson`: this instance's real lifecycle records, saved before deliberate
  termination so cleanup cannot be mistaken for recovery failure.
- `command-receipts.ndjson`: test commands, helper source, verification results and cleanup
  receipts. `seal.json` hashes the report and receipts for the independent queue verifier.

Current checks passed: `npm run build:main`, `npm run build:renderer`, `npx tsc --noEmit`,
and `npm run typecheck:spec` (the repository's 8 GiB wrapper). The renderer build emitted its
existing non-fatal initial-bundle budget warning (1.63 MB against a 1 MB warning threshold).
No product code or test expectations changed; the full unit suite and lint were not rerun
for this evidence-only task. A packaged DMG was not tested; the current built dev runtime
exercised the real Copilot adapter, recovery owner, IPC and renderer.

No recovery defect was reproduced, so no remediation-register entry was added. The backlog
file now explicitly says it is historical and forbids new current-status entries; this
owning document is therefore the updated status source, following that newer instruction.

### Cleanup and worker status

- The disposable session was intentionally terminated through IPC after its successful reply.
  The isolated automation list was empty; no production settings or automations were changed.
- Stopped the app and its private renderer server. The app did not exit within the supervisor's
  15-second `SIGTERM` grace period, so the supervisor stopped its own app child with `SIGKILL`.
  All recorded app descendants, both original/replacement Copilot PIDs, both launch PIDs and
  both supervisors were subsequently absent; ports `4567`, `9676` and `9677` were closed.
- Removed the isolated data directory, scratch test helpers, generated `dist/` and Angular
  build cache after preserving the report, seal and receipts. The pre-existing dependency
  installation was reused and left in place; no dependencies, browser binaries or database
  clusters were installed or copied for this run.
- No commit, stash, branch/worktree creation, branch switch or document rename was performed.
  The coordinator owns independent verification and closure.

## Status — 2026-10-27

LT-A **PASS (worker evidence)**. **1 of 1 checks exercised and passed; 0 untested; 0 human
actions required.** Independent Plan Queue verification remains pending. Filename unchanged.
