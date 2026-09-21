# ACP Loop Liveness and Failed-Usage Accounting Specification

**Status:** Completed 2026-09-20 — implemented, independently gate-reviewed (`VERDICT: PASS`), and green on the full canonical checklist. Live checks remain deferred to the plan's linked `_livetest.md`.

**Plan:** [2026-09-03-acp-loop-liveness-accounting_plan_completed.md](./2026-09-03-acp-loop-liveness-accounting_plan_completed.md)

## Problem

A Cursor ACP loop using a Grok model performed tool calls and wrote files, then stopped sending
`session/update` notifications. The adapter continued emitting a synthetic heartbeat every 15
seconds solely because `session/prompt` remained pending. Loop Mode rendered those pulses as "CLI
heartbeat received" and treated them as meaningful activity, even though the provider was wedged.

The same run displayed `0 tok · $0.00` throughout its first iteration and retained those totals after
the turn timed out. Loop totals currently advance only after a successful child result. The ACP
adapter had enough prompt, partial assistant, and tool-activity material to estimate usage, but that
material was discarded across the thrown-error boundary.

## Required Behaviour

1. ACP heartbeats emitted to Loop Mode must correspond to real inbound provider activity. Merely
   having a pending `session/prompt` promise must not create a liveness event or reset idle timers.
2. The initial busy/status event remains available, and every valid inbound `session/update` continues
   to refresh the prompt timeout, the stall watchdog, and the real heartbeat.
3. While an iteration is running, the HUD must distinguish settled totals from unsettled current-turn
   usage. It must not present `0 tok · $0.00` as the whole-run truth when iteration 1 is still pending.
4. If an ACP prompt rejects after producing partial material, the adapter must attach an explicitly
   estimated usage snapshot derived from the prompt, partial assistant text, and observed tool
   activity. No context-occupancy value may be fabricated.
5. The estimated usage snapshot must survive the loop invocation error boundary and be charged
   exactly once to run token/cost totals before retry, failover, or safe pause-for-review decisions.
6. Failed-attempt spend must contribute to token-without-progress safeguards. Existing workspace
   observation and no-double-apply retry behaviour must not change.
7. A failed attempt with no estimable material must remain uncharged rather than inventing a number.
8. Logs and the loop activity feed must identify failed-attempt usage as estimated.

## Design

Remove the pending-promise heartbeat interval and the synthetic start heartbeat from
`AcpCliAdapter.sendMessage()`. Valid inbound `session/update` notifications remain the sole ACP
heartbeat source.

On the adapter error path, reuse the existing `estimateAcpCliUsage()` calculation before the current
turn buffer is cleared. Attach a bounded numeric partial-usage shape to the thrown `Error`, including
the resolved ACP model when known. Extend the existing sanitized loop invocation error payload to
carry only finite, non-negative usage fields.

A small orchestration helper will convert partial error usage to a single failed-attempt charge using
the existing iteration-cost resolver. `LoopCoordinator` will apply that charge once per caught child
attempt, update progress safeguards, emit an estimated-usage activity entry, and broadcast the new
state. Retry and workspace-safety decisions remain otherwise unchanged.

The loop status header will display settled totals as `usage pending` for the first in-flight turn, or
as `<settled total> + current pending` when earlier iterations already settled. Cost follows the same
rule. This avoids pretending an unknown current value is zero without fabricating live usage.

## Verification

- Rebuild the Electron main process and renderer.
- In the rebuilt app, start a Cursor/Grok loop and confirm the first running iteration says usage/cost
  are pending rather than `0 tok · $0.00`.
- Confirm only actual provider updates create heartbeat activity; a silent provider surfaces the
  existing stream-idle warning and then times out.
- Force or reproduce a partial ACP timeout and confirm the run total becomes non-zero, the activity
  feed labels it estimated, and a writes-observed attempt still ends `completed-needs-review` without
  replay.
- After live confirmation, add focused adapter, error-payload, coordinator, and renderer regression
  tests, then run the canonical project verification checklist and a fresh completion gate.

