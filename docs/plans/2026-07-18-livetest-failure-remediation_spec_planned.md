# Live-Test Failure Remediation Spec

**Status:** Approved in review `2026-07-18-livetest-failure-remediation`.

**Plan:** [2026-07-19-livetest-failure-remediation_plan.md](2026-07-19-livetest-failure-remediation_plan.md)

**Purpose:** Provide one execution index for every confirmed defect found while running the
currently untracked live-test backlog. The originating live-test files remain the canonical
acceptance procedures and evidence records.

## Operating Rules

1. Fix work starts from this document, not by rediscovering failures across every pending
   live-test file.
2. Every remediation item links to its originating live test. Do not copy or weaken the
   originating test's completion criteria.
3. Reproduce each defect with the smallest focused test before changing production code.
4. A fix is complete only after its targeted regression tests, the canonical project gates, and
   every linked live test pass.
5. Rename a linked file from `_livetest.md` to `_livetest_completed.md` only when all checks in
   that file pass with current evidence.
6. A pending or unrun check is not automatically a product defect. Add newly reproduced defects
   to this spec with their source evidence before implementing them.
7. Historical Gemini live-test steps must use Antigravity as the current live provider.
   `gemini` remains only where backward compatibility with persisted data or older remote nodes
   is explicitly under test.

## Remediation Index

| ID | Priority | Required fix | Evidence source | Retest source |
| --- | --- | --- | --- | --- |
| LT-001 | P0 | Browser Gateway grants for an existing shared tab must match the action retried after approval | [Browser Permission UX evidence](../superpowers/plans/2026-07-17-browser-permission-ux_plan_livetest.md#2026-07-18-live-test-evidence) | [Browser Permission UX checks](../superpowers/plans/2026-07-17-browser-permission-ux_plan_livetest.md#check-1-low-risk-permission-bar) |
| LT-002 | P0 | The embedded document-review runtime must execute without weakening renderer or iframe isolation | [Doc-review embedded evidence](2026-07-13-doc-review-choice-controls-plan_livetest.md#scenario-2--embedded-doc-reviews-pane-blocked-both-root-causes-verified) | [Doc-review choice-controls checklist](2026-07-13-doc-review-choice-controls-plan_livetest.md#2-embedded-doc-reviews-pane) |
| LT-003 | P1 | Unsaved document-review choices and comments must survive the reload/reselection behavior required by the live test | [Doc-review state finding](2026-07-13-doc-review-choice-controls-plan_livetest.md#scenario-2--embedded-doc-reviews-pane-blocked-both-root-causes-verified) | [Doc-review choice-controls checklist](2026-07-13-doc-review-choice-controls-plan_livetest.md#2-embedded-doc-reviews-pane) |
| LT-004 | P0 | Interrupt and unexpected-exit recovery must classify the active runtime correctly and preserve the session | [Interrupt evidence](../superpowers/plans/2026-07-17-interrupt-respawn-reconciler-migration-plan_livetest.md#2026-07-18-live-test-evidence), [unexpected-exit evidence](../superpowers/plans/2026-07-17-unexpected-exit-reconciler-migration-plan_livetest.md#2026-07-18-live-test-evidence) | [Interrupt checks](../superpowers/plans/2026-07-17-interrupt-respawn-reconciler-migration-plan_livetest.md#checks), [unexpected-exit checks](../superpowers/plans/2026-07-17-unexpected-exit-reconciler-migration-plan_livetest.md#checks) |
| LT-005 | P1 | `bench:retrieval -- --local` must run the documented read-only local-personal suite against real stores | [WS16 evidence](2026-07-13-fable-ws16_livetest.md#2026-07-18-live-test-evidence) | [WS16 local-personal check](2026-07-13-fable-ws16_livetest.md#3-local-personal-suite-read-only-never-committed) |
| LT-006 | P1 | Replace obsolete live Gemini requirements with Antigravity while preserving explicit backward-compatibility coverage | [WS1 historical blocker](2026-07-13-fable-ws1_livetest.md#evidence-run--2026-07-16-blocked-no-rows-recorded) | [WS1 completion matrix](2026-07-13-fable-ws1_livetest.md#completion-matrix), [WS7 failover check](2026-07-13-fable-ws7-phaseb_livetest.md), [provider-context evidence check](../superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan_livetest.md) |
| LT-007 | P2 | Remove obsolete “no GUI automation” and “non-interactive session” blockers from live-test guidance now that Computer Use is available | [Doc-review delivery attempt](2026-07-13-doc-review-delivery-reconciliation-plan_livetest.md#evidence-run--2026-07-16-attempt-1-autonomous-agent), [WS1 attempt](2026-07-13-fable-ws1_livetest.md#evidence-run--2026-07-16-blocked-no-rows-recorded), [context-pressure attempt](../superpowers/plans/2026-07-13-codex-context-pressure-observability-discovery-plan_livetest.md#live-test-attempt-log-2026-07-16) | Re-run each linked checklist with current Computer Use capabilities |

## LT-001: Existing-Tab Browser Grant Scope Mismatch

### Observed behavior

A real request for `read`, `navigate`, and `input` on a shared localhost tab was approved with
`Allow for session`. The resulting `browser.type` retry returned `requires_user` with
`no_matching_grant` and created another request.

### Required behavior

The approved session grant must authorize the same instance, provider, shared target, origin, and
requested action classes. The retry must type into the harmless field without another prompt.
The fix must not broaden the grant to another node, tab, origin, instance, provider, or action
class.

### Investigation boundary

- `src/main/browser-gateway/browser-grant-scope.ts`
- `src/main/browser-gateway/browser-grant-policy.ts`
- `src/main/browser-gateway/browser-gateway-approval-operations.ts`
- `src/main/browser-gateway/browser-gateway-action-guard.ts`
- Existing-tab attachment and request construction in
  `src/main/browser-gateway/browser-existing-tab-operations.ts`

The evidence suggests a scope-normalization mismatch: an approved existing-tab grant may be
stored with node scope while the retried action is matched with profile/target scope or without
the same node identifier. Treat this as a hypothesis until a focused regression test reproduces
the exact approved-grant and retry inputs.

### Required regression coverage

- A session grant created from a local existing-tab approval matches the immediately retried
  `input` action.
- The same grant does not match another instance, provider, node, target, origin, or unrequested
  action class.
- Remote existing-tab node scope remains distinct from local scope.
- Per-action consumption and autonomous submit/destructive requirements remain unchanged.

### Acceptance

Run the focused Browser Gateway specs, the canonical project verification checklist, and all
three checks in the linked Browser Permission UX live test. Record the created grant's bounded
scope fields and the successful harmless retry without recording browser content.

## LT-002: Embedded Document-Review Runtime Is Blocked by CSP

### Observed behavior

The same artifact runtime passes in the standalone capture-server browser path. In the Electron
Doc Reviews pane, the sandboxed `srcdoc` iframe renders static option labels but no generated
radio buttons, checkboxes, default marker, mirrored controls, or runtime messages. The renderer
CSP uses `script-src 'self'`, and the inline artifact runtime does not execute in the inherited
CSP context.

The earlier forwarder defect is already fixed: a real Codex instance successfully invoked
`request_doc_review` on 2026-07-18. Do not reopen that resolved item unless a new reproduction
fails.

### Required behavior

The artifact runtime must execute in the sandboxed review iframe while retaining script
isolation. Do not add renderer-wide `'unsafe-inline'`, `allow-same-origin`, direct app-DOM
injection, or an unrestricted message channel.

Acceptable designs include a narrowly scoped nonce/hash path or a self-hosted runtime asset whose
messages continue to pass the existing schemas and `event.source` check. The implementation plan
must choose one design after reproducing the current CSP failure.

### Investigation boundary

- `src/renderer/index.html`
- `src/renderer/app/features/doc-review/doc-review-viewer.component.ts`
- The artifact runtime/template that generates the inline review script
- Existing viewer, page, and template specs

### Required regression coverage

- The sandboxed embedded artifact emits its ready message and renders radio/checkbox controls.
- The standalone capture-server artifact continues to work.
- Arbitrary artifact scripts cannot access the parent DOM or acquire same-origin privileges.
- Unknown, malformed, or wrong-source messages remain ignored.
- The renderer CSP remains restrictive outside the review runtime.

### Acceptance

Complete both standalone and embedded scenarios in the linked choice-controls live test, then
run the delivery-reconciliation live test because all of its decision paths depend on a working
embedded review runtime.

## LT-003: Document-Review Draft State Does Not Meet Reload/Reselection Contract

### Observed behavior

Source inspection shows that pre-submit item state exists only in
`DocReviewPageComponent.itemStates`. Changing the selected review calls
`resetDecisionState()`, and persistence occurs only during final submission. The CSP failure
currently prevents a clean runtime reproduction, but this implementation does not satisfy the
live test's requirement that selections survive reload or reselection.

### Required behavior

Pending review decisions, comments, single choices, multiple choices, overall decision, and
general feedback must rehydrate after the exact reload/reselection boundary defined by the
canonical live test. Draft state must remain isolated by review id and must be cleared after a
successful final submission or explicit dismissal.

### Investigation boundary

- `src/renderer/app/features/doc-review/doc-review-page.component.ts`
- `src/renderer/app/features/doc-review/doc-review.store.ts`
- Doc-review IPC schemas and persistence only if renderer-local draft persistence cannot satisfy
  the reload requirement

### Required regression coverage

- Draft state survives route-away/route-back and full reload for the same pending review.
- Switching between two pending reviews never leaks choices or comments.
- Submitted or dismissed reviews do not restore stale draft state.
- Host state and iframe controls converge after the artifact ready/init handshake.

### Acceptance

LT-002 must pass first. Then exercise choice, reload, reselection, mirror synchronization, and
submission in the linked embedded choice-controls scenario.

## LT-004: Runtime Exit Classification Bypasses Recovery

### Observed behavior

A disposable Codex session started in app-server mode. Killing its verified child PID logged:

```text
Adapter exit event
Ignoring per-turn process exit for stateless exec adapter
```

The UI then showed interrupt/recovery states, removed the session, and returned to the
new-session draft. A normal Escape interrupt also failed to show the documented
`interrupting -> respawning -> idle` path and transcript marker.

### Required behavior

Lifecycle decisions must use the adapter's active runtime mode and capabilities, not only its
provider name. A resident Codex app-server exit must enter the recovery reconciler. A genuine
per-turn exec exit must remain ignored. Interrupt, resume fallback, unexpected exit, queued
messages, idle recovery, and crashloop backoff must preserve their documented semantics.

### Investigation boundary

- `src/main/instance/instance-communication-adapter-helpers.ts`
- `src/main/instance/instance-communication.ts`
- `src/main/cli/adapters/base-cli-adapter.ts`
- Codex adapter app-server/exec mode transitions
- `src/main/instance/lifecycle/interrupt-respawn-handler.ts`
- `src/main/instance/lifecycle/runtime-reconciler.ts`

The first focused reproduction must record the adapter class, `getSpawnMode()`, runtime
capabilities, resident-session capability, instance status, and exit route without logging
conversation content. Determine whether interrupt and unexpected-exit failures share this
classification defect before splitting the implementation work.

### Required regression coverage

- Codex app-server is never classified as stateless exec after it has entered app-server mode.
- Codex exec fallback remains stateless and ignores its normal per-turn exit.
- App-server exit during busy and idle routes once through unexpected-exit recovery.
- Escape interrupt routes once through interrupt recovery and cannot race with the generic exit
  path.
- Queued messages remain ordered across recovery.
- Double-Escape, termination-during-respawn, resume fallback, and crashloop backoff retain their
  existing safety behavior.

### Acceptance

All checks in both linked lifecycle live tests must pass in a disposable session. Evidence must
include the runtime mode, bounded lifecycle transitions, successful contextual follow-up, and
absence of duplicate/zombie provider processes.

## LT-005: Local-Personal Retrieval Benchmark Is a Stub

### Observed behavior

`npm run bench:retrieval` passes the committed synthetic regression gate.
`npm run bench:retrieval -- --local` exits successfully but only prints that live-store support
is not wired.

### Required behavior

The `--local` mode must discover James's real RLM and codemem stores, open them read-only, run the
documented local-personal queries, print local-only metrics, and never update fixtures, the
baseline, either store, or tracked files. Missing stores must produce an explicit skipped result;
an opened-but-unqueryable store must fail the local run.

### Investigation boundary

- `scripts/bench-retrieval.ts`
- Existing RLM and codemem read-only database discovery/opening helpers
- `src/main/memory/retrieval-eval/`
- `docs/testing.md` WS16 procedure

### Required regression coverage

- Store discovery uses the current Harness user-data layout without embedding James's absolute
  home path.
- SQLite connections use read-only mode.
- A test fixture proves the command does not write or create database files.
- Missing-store, schema-mismatch, and successful local-suite outcomes are distinct.
- `--update-baseline` behavior remains limited to the committed synthetic suite.

### Acceptance

Run the synthetic benchmark, then the local benchmark. Record store modification times before
and after and confirm they are unchanged. Complete the remaining WS16 checks before renaming its
live-test file.

## LT-006: Migrate Live Provider Coverage from Gemini to Antigravity

### Observed behavior

Several pending live tests still require a live Gemini CLI even though the contracts state that
Antigravity is the live successor and `gemini` is retained only as a deprecated compatibility
alias. The old wording caused Antigravity-capable checks to be treated as blocked.

### Required behavior

- New live-provider fixtures and provider-interaction tests use `antigravity`.
- Existing `gemini` fixtures remain only where replay compatibility with persisted historical
  data is intentionally tested.
- Failover and provider-context tests use Antigravity as the live Google-backed provider.
- Hardened-mode checks verify the real Antigravity configuration roots discovered at runtime;
  they must not assume `~/.gemini` is required solely because an old checklist says so.

### Investigation boundary

- `docs/plans/2026-07-13-fable-ws1_livetest.md`
- `docs/plans/2026-07-13-fable-ws7-phaseb_livetest.md`
- `docs/plans/2026-07-13-fable-ws13_livetest.md`
- `docs/superpowers/plans/2026-07-15-provider-agnostic-context-evidence-plan_livetest.md`
- `src/main/providers/__tests__/parity/fixture-replay.spec.ts`
- `packages/contracts/src/__fixtures__/provider-events/`
- `scripts/capture-provider-fixture.ts`

### Required regression coverage

- A sanitized Antigravity `basic-conversation` fixture replays to the canonical event stream.
- The historical Gemini fixture still replays as backward-compatibility coverage, or its removal
  is justified by a separate persisted-data migration.
- Failover selects Antigravity in the live successor slot.
- Provider-agnostic context evidence includes a real Antigravity session.

### Acceptance

Update the affected live-test instructions before running them. Complete their provider matrices
with Antigravity in the live successor role; do not report a missing Gemini executable as a
blocker.

## LT-007: Retire Obsolete Automation Blockers

### Observed behavior

Historical evidence in three pending live tests says an autonomous agent cannot operate Electron
GUI controls, approve actions, interrupt a session, or inspect resulting UI state. Computer Use
can now perform those actions. Those historical observations remain valid records of their
original attempts, but they are no longer current blockers.

### Required behavior

- Preserve historical evidence with its date.
- Add a current note to each affected checklist stating that Computer Use is the supported
  interaction path.
- Do not require a new product IPC or Electron E2E harness merely to make a live test agent-runnable.
- Continue to require explicit care for destructive actions such as TCC resets, production-app
  restarts, credential use, or terminating unrelated sessions.

### Acceptance

Re-run the linked checklists with Computer Use. Replace current prerequisite/status summaries
with the new evidence while retaining the dated historical attempts. Any product defect found
during those runs must be added to this remediation spec before implementation.

## Retest-Only Items: No Confirmed Fix Yet

The following observations do not currently justify code changes:

- [Provider/model swap](2026-07-16-session-provider-model-swap-plan_livetest.md): the tested
  Claude-to-Codex swap succeeded. Remaining checks require available provider quota, busy/loop
  scenarios, restart, and a current remote worker.
- [Local macOS signing](../superpowers/plans/2026-07-13-local-macos-computer-use-signing-plan_livetest.md):
  signing verification and steady-state TCC attribution passed. Clean first-prompt attribution
  remains unrun.
- [Computer Use onboarding](../superpowers/plans/2026-07-11-computer-use-permission-onboarding-plan_livetest.md):
  steady-state permissions report Ready. Missing, denied, revoked, repair, and relaunch flows
  remain unrun.
- Every other pending untracked live test remains a discovery/retest item until it produces a
  current, reproducible mismatch between observed and expected behavior.

## Implementation and Retest Order

1. LT-006 and LT-007: correct the live-test contract and remove obsolete blockers.
2. LT-001: fix grant matching and complete Browser Permission UX.
3. LT-002, then LT-003: restore the embedded review runtime and draft-state contract.
4. Re-run document-review delivery reconciliation; add any newly reproduced delivery defects.
5. LT-004: fix the lifecycle classification/recovery cluster and complete both lifecycle tests.
6. LT-005: wire the read-only local benchmark and finish WS16.
7. Work through every remaining pending live test with Codex, Antigravity, Copilot, Computer Use,
   and a current remote worker where required. Add only reproduced defects to this spec.

## Completion Criteria

This remediation program is complete when:

- LT-001 through LT-007 satisfy their acceptance criteria.
- Every linked source live test is renamed `_livetest_completed.md`.
- Every newly discovered defect has been fixed and linked here before its retest is completed.
- All remaining untracked `_livetest.md` files have either passed and been renamed or contain a
  current external prerequisite that is not a software defect.
- The canonical project verification checklist passes after all implementation changes.
