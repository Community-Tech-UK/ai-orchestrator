# ACP Long-Running Tool Timeout — Live Test

> **Found a defect while running this check?** Record it in the remediation
> register — `docs/plans/livetest-remediation-register.md` — as a new `LT-NNN`
> item (index row, then observed behaviour, root cause, required behaviour and
> acceptance), and add the matching implementation-status section to
> `docs/plans/2026-07-19-livetest-failure-remediation_plan_completed.md`. Per-check
> evidence stays in this file.
>
> Before starting a run, read `docs/plans/livetest-campaign-runbook.md`.

**Plan:** [2026-08-25-acp-long-tool-timeout_plan_completed.md](2026-08-25-acp-long-tool-timeout_plan_completed.md)

## Status — completed by consolidation 2026-09-27

Open: 0 · Transferred: 1 · Failed: 0

The only check requires a human-authenticated Copilot profile before the agent-runnable 10–60 minute
runtime begins. It is now [RES-020](../../plans/2026-09-27-livetest-human-external-residuals_livetest.md#res-020--authenticated-copilot-acp-long-running-tool-timeout), preserving both inconclusive attempts below without leaving a one-item source checklist open.

## Prerequisites

- A rebuilt and restarted Harness app running this checkout's main process.
- An authenticated Copilot ACP session in a disposable workspace.
- A safe command that is expected to run for more than ten minutes but less
  than sixty minutes, such as this repository's complete quiet test suite.

Why deferred: this check requires a restarted Electron app, a real authenticated
Copilot child process, and more than ten minutes of uninterrupted wall-clock
execution. Local application UI control was not authorised for this task.

## 1. Active Copilot tool survives the ordinary prompt timeout — TRANSFERRED

1. Start a new Copilot session in the disposable workspace.
2. Ask Copilot to run `rtk npm run test:quiet` and wait for the ACP `tool_call`
   activity to appear.
3. Leave the command running past ten minutes without cancelling or sending
   another message.
4. **Expected:** Harness does not emit `ACP session/prompt request timed out
   after 600000ms`, does not send `session/cancel` at ten minutes, and does not
   show `Operation cancelled by user`. The command remains active and Copilot
   reports its eventual result before sixty minutes.
5. Confirm the ordinary repeating stall warning remains available during the
   run so the operator can still cancel deliberately.

Record the Copilot session id, start/end timestamps, command result, and the
absence of the ten-minute timeout/cancel event here without including secrets
or authentication material.

## Attempts (neither reached the ACP tool call — no timeout verdict recorded)

- **2026-08-30:** Scheduled Copilot automation refused at preflight — Copilot is on the app's
  `never auto-pick these providers` list (`CopilotRoutingError`, `origin: automation`,
  `failureCode: automation-disallowed`); no Copilot child ever spawned. The interactive CDP-driven
  fallback was also abandoned because host load (`53.96/31.16/19.84`) exceeded the campaign
  runbook's stop threshold before the dev app came up. Lesson: automation cannot supply the
  required provider route — must be a user-originated create.
- **2026-08-31:** Quiet-host route reached the real, user-originated Copilot preflight
  (`npm run build:main` passed, isolated dev app started), but `CopilotRoutingError` refused the
  create because the only resolved profile (`legacy`) was not signed in on this device. No Copilot
  or ACP child, tool call, timer, cancellation, or timeout request started.

Neither attempt crossed the ten-minute boundary; do not interpret either as a pass or failure of the
timeout fix. A future run needs a quiet host and a disposable, already-authenticated Copilot profile
(sign-in is a human-owned step; the automation route is structurally excluded).

Complete the current run from RES-020; this historical source is closed.
