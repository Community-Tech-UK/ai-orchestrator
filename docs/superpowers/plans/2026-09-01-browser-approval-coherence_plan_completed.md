# Browser Approval Coherence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Browser Gateway approvals redeemable, deduplicated, synchronised, directly navigable, distinguishable, and safely minimisable.

**Architecture:** The main process will validate and consume an exact approved credential request rather than weakening hard-stop policy, and it will reuse fingerprint-identical pending requests. A root Angular signal store will become the sole renderer owner of live pending approvals; the banner and Browser page will consume it, with query-parameter navigation carrying the selected view and request identity.

**Tech Stack:** TypeScript, Electron main process, Angular 22 standalone components/signals, Zod IPC contracts, Vitest.

**Spec:** [2026-09-01-browser-approval-coherence_spec_completed.md](../specs/2026-09-01-browser-approval-coherence_spec_completed.md)

**Status:** Completed 2026-09-20. Live checks deferred to [2026-09-01-browser-approval-coherence_livetest.md](2026-09-01-browser-approval-coherence_livetest.md) (4 open).

## Global Constraints

- Work in the existing checkout; do not create a branch or worktree.
- Preserve unrelated dirty-tree changes and do not commit unless James explicitly asks.
- Keep credential, captcha, two-factor, payment, financial-identity, and sensitive-identity safety boundaries fail-closed.
- Follow strict red-green-refactor: each production behavior requires a focused failing test first.
- Do not update tests to accept incorrect runtime behavior.

---

### Task 1: Exact credential approval redemption

**Files:**
- Modify: `src/main/browser-gateway/browser-gateway-action-guard.ts`
- Modify: `src/main/browser-gateway/browser-gateway-service.ts`
- Modify: `src/main/browser-gateway/browser-gateway-approval-operations.ts`
- Test: `src/main/browser-gateway/browser-gateway-action-guard.spec.ts`
- Test: `src/main/browser-gateway/browser-gateway-service.approvals.spec.ts`
- Test: `src/main/browser-gateway/browser-gateway-service-existing-tabs.spec.ts`

**Interfaces:**
- Consumes: mutation request `requestId?: string`, stored `BrowserApprovalRequest`, and matching `BrowserPermissionGrant`.
- Produces: `BrowserGatewayPreparedMutation.exactApprovalRequestId?: string`; server-normalised one-action credential grants.

- [x] Add a failing existing-tab regression showing an approved credential request, retried with its request ID, executes exactly once and consumes the linked grant.
- [x] Add failing negative cases for omitted/wrong request ID, changed selector/target, captcha, and two-factor classifications.
- [x] Run the focused action-guard/service tests and confirm the failures are caused by the current unconditional hard-stop branch.
- [x] Add exact fingerprint validation before the generic hard-stop branch and carry redemption identity through mutation preparation.
- [x] Consume an exact-redeemed grant after successful mutation regardless of its historical mode.
- [x] Normalise credential and unknown approvals in `approveRequest()` to `per_action`, the single approved action class, and `autonomous: false`.
- [x] Run the focused tests and confirm the exact retry passes while every negative case remains blocked.

### Task 2: Pending mutation approval deduplication

**Files:**
- Create: `src/main/browser-gateway/browser-pending-approval-match.ts`
- Create: `src/main/browser-gateway/browser-pending-approval-match.spec.ts`
- Modify: `src/main/browser-gateway/browser-gateway-action-guard.ts`
- Modify: `src/main/browser-gateway/browser-gateway-action-guard.spec.ts`

**Interfaces:**
- Produces: `findMatchingPendingBrowserApproval(approvals, candidate, now): BrowserApprovalRequest | null`.
- Consumes: `BrowserApprovalStore.listRequests({ instanceId, status: 'pending', limit: 100 })`.

- [x] Add failing pure tests proving exact unexpired fingerprints reuse a request and changed origin, selector, target, action class, or grant scope do not.
- [x] Add a failing action-guard test proving a repeated pending credential click returns the original request ID and creates no new row.
- [x] Run the focused tests and confirm duplicate creation is observed.
- [x] Implement the pure matcher and use it at managed-profile, existing-tab, and grant-recheck approval creation seams.
- [x] Return `approval_already_pending` with the original request ID when a match exists.
- [x] Run the focused tests and confirm identical requests coalesce while distinct actions remain separate.

### Task 3: Shared live renderer approval state

**Files:**
- Create: `src/renderer/app/core/state/browser-approvals.store.ts`
- Create: `src/renderer/app/core/state/browser-approvals.store.spec.ts`
- Modify: `src/renderer/app/core/state/browser-approvals-banner.component.ts`
- Modify: `src/renderer/app/core/state/browser-approvals-banner.component.spec.ts`
- Modify: `src/renderer/app/features/browser/browser-page.component.ts`
- Modify: `src/renderer/app/features/browser/browser-page.component.spec.ts`

**Interfaces:**
- Produces: pending request signal, `startPolling()`, `stopPolling()`, `refresh()`, `removeRequest()`, `minimiseCurrentSet()`, `restoreBanner()`, and computed minimised/current-set state.
- Consumes: `BrowserGatewayIpcService.listApprovalRequests()`.

- [x] Add failing store tests for one five-second poll, overlapping-refresh suppression, optimistic removal, minimisation, and automatic re-expansion when request IDs change.
- [x] Run the store test and confirm the store does not exist.
- [x] Implement the root-provided signal store with no audit-producing extra calls beyond the existing polling cadence.
- [x] Replace banner-local polling/state with the shared store.
- [x] Alias the Browser page approval signal to the store and route explicit refreshes/decision removals through it.
- [x] Run the store, banner, and Browser page tests and confirm both surfaces update from the same request set.

### Task 4: Deep-link, focus, sequential identity, and minimisation UX

**Files:**
- Modify: `src/renderer/app/core/state/browser-approvals-banner.component.ts`
- Modify: `src/renderer/app/core/state/browser-approvals-banner.component.spec.ts`
- Modify: `src/renderer/app/features/browser/browser-page.component.ts`
- Modify: `src/renderer/app/features/browser/browser-page.component.html`
- Modify: `src/renderer/app/features/browser/browser-page.component.scss`
- Modify: `src/renderer/app/features/browser/browser-page.component.spec.ts`
- Modify: `src/renderer/app/features/browser/browser-page-view.utils.ts`
- Modify: `src/renderer/app/features/browser/browser-page-view.utils.spec.ts`

**Interfaces:**
- Banner route: `/browser?view=permissions&requestId=<request-id>`.
- Browser page state: `focusedApprovalId: WritableSignal<string | null>` and query-driven `BrowserPageView` validation.

- [x] Add failing banner tests for the exact deep-link, short request identity, received time, multiple-request position, minimise button label, compact reminder, and automatic expansion for a new request.
- [x] Add failing Browser page tests for query-driven Permissions selection, request highlighting/focus, and query changes while already mounted.
- [x] Add failing template tests proving credential/unknown approvals expose only Allow once and Deny.
- [x] Run focused renderer tests and confirm current navigation, stale-state, and action-set behavior fails them.
- [x] Implement query-parameter parsing, Permissions selection, shared refresh, and bounded focus scheduling.
- [x] Add request identity and compact-reminder markup using existing semantic tokens, visible focus, polite live regions, and reduced-motion-safe state changes.
- [x] Restrict broad renderer approval actions for exact-only classes while retaining existing choices for grantable low-risk classes.
- [x] Run focused renderer tests and confirm the full interaction contract passes.

### Task 5: Verification and lifecycle closure

**Files:**
- Modify: this plan and its linked spec only after all implementation and verification passes.

- [x] Run all focused Browser Gateway main and renderer test files touched by the work.
- [x] Run `npx tsc --noEmit`.
- [x] Run `npx tsc --noEmit -p tsconfig.spec.json`.
- [x] Run `npm run lint`.
- [x] Run `npm run check:ts-max-loc`.
- [x] Run `npm run build:main`.
- [x] Run `npm run test:quiet`.
- [x] Verify the rebuilt renderer behavior in the real application when safe; otherwise record only checks that genuinely require restart/rebuild in a `_livetest.md` document.
- [x] Dispatch a genuinely fresh agent using `task-completion-gate`; fix every actionable finding and repeat with another fresh gate until `VERDICT: PASS`.
- [x] Record as-built evidence, update the spec's plan link, and rename both documents to `_completed` only after every agent-runnable requirement passes.

## As-Built Evidence — 2026-09-01

- Focused approval suite: 8 files, 129 tests passed.
- `npx tsc --noEmit`: passed.
- Spec TypeScript passed after the approval fixes, then later failed on four unrelated DTO fixtures in
  `src/main/instance/context-worker-event-forwarding.spec.ts` after concurrent dirty-tree changes.
- `npm run lint`, `npm run check:ts-max-loc`, `npm run build:main`, and `git diff --check`: passed.
- Latest complete full suite: 20,204 of 20,207 passed. The failures are two Node 26 SEA/postject
  sentinel failures and one unrelated dirty context-worker import-closure threshold.
- Four independent completion-gate rounds were run. Three found actionable issues that were fixed and
  regression-tested; round four returned `VERDICT: PASS` with no unresolved task-scoped findings.
- Rebuilt-app checks are deferred to
  [2026-09-01-browser-approval-coherence_livetest.md](2026-09-01-browser-approval-coherence_livetest.md)
  because this agent cannot control the hard-denied Harness UI.

**Closure note (2026-09-20).** The condition above is met. The unrelated shared-checkout failures
that were blocking the canonical gates are gone — the spec typecheck, the LOC ratchet and the full
suite are all green on this tree — and an independent fresh reviewer returned PASS. The pending live
checks are genuinely deferred (they need a rebuilt, relaunched app and the hard-denied Harness UI),
so under the repository's Live-Test Deferral rule they are recorded in the livetest doc rather than
blocking the rename. They are not claimed as verified.

## Completion record (2026-09-20)

Closed by the outstanding-plans sweep of 2026-09-20.

**Independent fresh-eyes gate:** a genuinely fresh agent that did not implement this work reviewed
the plan's acceptance criteria against the executing code — tracing real flows and varying input
state rather than reading the diff — and returned `VERDICT: PASS` with no actionable findings.

**Canonical verification checklist, all run on this tree on 2026-09-20, all green:**

| Gate | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| `npx tsc --noEmit -p tsconfig.spec.json` | exit 0 (needs `NODE_OPTIONS=--max-old-space-size=8192`; the default heap OOMs the compiler) |
| `npm run lint` | exit 0 |
| `npm run check:ts-max-loc` | exit 0 |
| `npm run build:main` | exit 0 |
| `npm run build:renderer` | exit 0 |
| `npm run test:quiet` | exit 0 — 2167 files / 25734 tests |

This clears the "blocked by unrelated dirty-tree failures" caveat that several plans in this batch
recorded: the spec typecheck, the LOC ratchet and the full suite are all clean on the current
checkout. Full command logs are in ignored `_scratch/base-*.log`.

### Checkbox reconciliation (2026-09-20)

This plan was written in the step-by-step checkbox style and the implementing session never ticked
the boxes as it went, so a reader arriving after the `_completed` rename would have seen a closed
plan full of unchecked work. The boxes are now ticked to match reality, which was established by
reading the executing code and the specs on disk — not by trusting the plan's own prose. The
independent fresh-eyes reviewer confirmed each step's artefact exists and that the tests covering it
are load-bearing rather than vacuous. Items that genuinely remain unverified are the live checks,
and those are named in the status line above and tracked in the linked `_livetest.md`, not ticked
here.
