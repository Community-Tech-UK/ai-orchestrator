# Computer Use Consent And Targeting Remediation Spec

**Status:** Completed and agent-verified; rebuilt-app checks deferred

**Implementation plan:** [2026-08-09-computer-use-consent-and-targeting_plan_completed.md](../plans/2026-08-09-computer-use-consent-and-targeting_plan_completed.md)

**Source report:** `/Users/suas/work/harness-computer-use-grant-report-2026-08-09.md`

## Goal

Keep Computer Use consent explicit and make macOS window-scoped observation and input contracts internally consistent.

## Confirmed Root Causes

1. The application-level YOLO listener is described as ACP-only but resolves every `PermissionRegistry` request for a YOLO instance. Desktop `observeAndInput` grant requests therefore receive `auto_approve` decisions before the approval UI can render them.
2. Electron screenshots identify a window as `window:<CGWindowID>:<displayIndex>`, while the Swift helper identifies the same window as the decimal CGWindow ID. Selection already recognises the formats as equivalent, but the later service comparison uses literal string equality.
3. The Swift accessibility helper snapshots the application root even for a specific requested window. That includes menu-bar and other application-level nodes whose coordinates are outside the approved window, so they appear targetable before the input helper correctly rejects them.
4. Stored grant `scope` means instance applicability (`session` or `durable`), while requested `duration` means lifetime (`session`, `boundedMinutes`, or `untilRevoked`). The summary exposes only scope, making a bounded grant look like an unqualified session grant.
5. Separate activation, observation, and input calls can lose foreground state between calls. The helper's final active-window check is a required safety boundary and must remain fail-closed. The audit shows an orchestrated sequence completes without the multi-second gaps that trigger the race.

## Design

### Consent

Extract a pure ACP-request classifier and require both YOLO mode and `details.transport === 'acp'` before automatic approval. Desktop grants remain pending until a user or timeout resolves them. No Computer Use capability, including `observe`, may inherit ACP YOLO approval.

### Screenshot identity

At the Darwin driver boundary, normalise a captured Electron source ID back to the requested/helper window ID only when the existing equivalence matcher proves both identify the same CGWindow. Unrelated IDs remain unchanged so the service still detects target switches.

### Accessibility actionability

When a specific window and its bounds are known, annotate accessibility nodes whose centre lies outside those bounds as `inputEligible: false`. Preserve them for semantic observation, but reject element-handle input against them in the gateway before the helper runs. Nodes without usable bounds keep the existing bounds-unavailable behaviour. The bundled helper remains the final independent in-window guard.

### Grant reporting

Persist the original grant `duration` and optional bounded `minutes`, and return them in `computer.list_grants`. Keep `scope` unchanged because it correctly describes whether a grant applies only to the creating instance or durably across instances. Old stored grants remain readable because the new fields are optional.

### Focus race guidance

Keep the helper's active-app and active-window checks unchanged. Update tool guidance so callers know that a focused AX element is not proof that the app remains frontmost, and that activation, fresh observation, and input should be orchestrated without an avoidable top-level pause. Do not auto-reactivate or click after a focus change.

## Verification

- Regression tests prove desktop permission requests are never ACP-YOLO auto-approved.
- Darwin driver tests prove equivalent IDs normalise and unrelated IDs do not.
- Observation-store and gateway tests prove out-of-window candidates are labelled and rejected before driver input.
- Grant summary tests prove bounded duration metadata is preserved.
- MCP description tests prove the focus/menu guidance is exposed.
- Run the repository's focused tests and canonical TypeScript, lint, LOC, main build, and full test gates.
- Record any rebuilt-app-only checks in a dedicated `_livetest.md` document.

## As Built

- ACP YOLO auto-approval now requires explicit `details.transport === 'acp'`; Desktop Computer
  Use requests stay pending for an operator decision.
- Equivalent raw CGWindow and Electron capture-source IDs are normalised only when they identify
  the same numeric window; unrelated IDs still fail closed.
- Accessibility nodes outside the approved window are returned with `inputEligible: false` and
  are rejected before click, scroll, drag, explicit/implicit typing, or hotkey input can reach the
  native driver.
- Stored and listed grants now preserve requested `duration` and bounded `minutes`, while the
  existing session/durable applicability scope remains unchanged and old persisted records remain
  readable.
- Model-facing tool descriptions explain the safe activation/re-observation/input sequence and
  the non-actionable status of window-external menu nodes.
- Focused verification passed 13 files/115 tests. Both TypeScript checks, lint, the LOC ratchet,
  and `build:main` passed. The full suite passed as four supported sequential shards: 1,732 file
  executions and 18,042 tests. The unsharded runner exhausted Node's 4 GB heap without producing
  an assertion failure, so sharding was used to cover the entire suite without heap accumulation.
- The first independent completion gate found a keyboard-targeting gap; it was reproduced with a
  failing regression test and fixed. A different fresh verifier reran the gates and returned
  `VERDICT: PASS` with no unresolved finding.
- Rebuilt signed-app behaviour remains tracked in
  [2026-08-09-computer-use-consent-and-targeting_livetest.md](../plans/2026-08-09-computer-use-consent-and-targeting_livetest.md).

## Non-goals

- Automatically stealing focus immediately before an input action.
- Weakening observation-token, active-app, active-window, grant, or sensitive-action checks.
- Adding a new compound input API or changing the approval UI architecture.
