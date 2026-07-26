# Live-Test Remediation Register

**Type: standing register — deliberately tracked, no `_spec`/`_plan` lifecycle.**
This file has no `_completed` state and never will: new `LT-NNN` items are appended whenever a
live-test campaign reproduces a defect (see Operating Rule 6 below). It was previously named
`2026-07-18-livetest-failure-remediation_spec_planned.md`; renamed 2026-07-26 because a `_planned`
suffix implies a terminal `_completed` that cannot apply to a rolling index, and because the
untracked-until-complete rule would leave weeks of accumulated defect triage unbacked-up. Per-item
status lives in the Remediation Index; implementation progress lives in the plan.

**Original status:** Approved in review `2026-07-18-livetest-failure-remediation`.

**Plan:** [2026-07-19-livetest-failure-remediation_plan.md](2026-07-19-livetest-failure-remediation_plan.md)

**Purpose:** Provide one execution index for every confirmed defect found while running the
live-test backlog. The originating live-test files remain the canonical acceptance procedures and
evidence records.

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
| LT-008 | P0 | A yolo-only (or any fork-resume) runtime change must resume the session that exists, not a freshly minted id, and must not destroy a live session on an unproven health probe | [YOLO reconciler evidence](../superpowers/plans/2026-07-17-yolo-mode-reconciler-migration-plan_livetest.md#evidence-run--2026-07-26--checks-1-and-3-fail-reproducibly-root-cause-found) | [YOLO reconciler checks](../superpowers/plans/2026-07-17-yolo-mode-reconciler-migration-plan_livetest.md#checks) |
| LT-009 | P0 | The skill registry must actually contain the builtin skills, so trigger matching and skill attribution can record anything at all | [Skill observability evidence](../../2026-07-23-skill-observability-and-design-skills_livetest.md#evidence-run-2--2026-07-26-dev-app-with-a-send-path--check-2-fails-the-registry-is-empty) | [Skill observability checks](../../2026-07-23-skill-observability-and-design-skills_livetest.md) |
| LT-010 | P1 | `sync_to_node` / `sync_from_node` must validate against the node's file-transfer roots, the same allowlist `upload_to_node` uses | [Worker file-movement evidence](2026-07-16-worker-controller-file-movement_livetest.md#evidence-run--2026-07-26--check-5-re-run-sync-root-bug-root-caused) | [Worker file-movement check 5](2026-07-16-worker-controller-file-movement_livetest.md#5-agent-folder-sync-spec-item-5) |
| LT-011 | P2 | Live-test checks must assert on signals the app actually emits; add the missing log lines (or rewrite the checks) | [History-restore evidence](../superpowers/plans/2026-07-17-history-restore-reconciler-migration-plan_livetest.md#evidence-run--2026-07-26--corroboration-for-check-1-24-not-run-the-checks-are-not-log-observable-as-written) | [History-restore checks](../superpowers/plans/2026-07-17-history-restore-reconciler-migration-plan_livetest.md#checks) |
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
8. **LT-008 first among the 2026-07-26 additions** — it corrupts every fork-resume runtime change on
   Claude, which also blocks session-provider-model-swap and rolling-handoff from being tested
   meaningfully. Then LT-009, LT-010, LT-011.

## LT-008: Fork-Resume Passes a Never-Minted Session Id as the Resume Source

**Priority P0. Found 2026-07-26, reproduced 2 of 2 on a real Claude session.**

### Observed behavior

`toggleYoloMode({ enabled })` on an **idle** Claude instance with conversation history returns
`TOGGLE_YOLO_MODE_FAILED: "Illegal transition: error → busy"`. The CLI is SIGTERM'd, the instance
drops to `error`, and roughly 45 s later the generic `process_exited_unexpected` recovery recipe
respawns it with a **fresh provider session and a replayed transcript**. No
`[System: YOLO mode enabled …]` notice ever appears. Provider session id changed on every toggle
(`0fd999dd… → a9d33453… → 3d359928… → 12e02cae…`).

### Root cause

`src/main/instance/lifecycle/runtime-reconciler.ts:194-206` resolves a yolo-only change on a
conversation-bearing Claude session to `native-resume-fork` (Claude reports `supportsForkSession`).
Lines 238-241 then mint the fork's *target* id and overwrite the instance with it **before** spawn:

```ts
const newSessionId = shouldResume && shouldForkSession
  ? generateId()                                   // an id the CLI has never minted
  : (shouldResume ? instance.sessionId : generateId());
instance.sessionId = newSessionId;
```

That id is passed as `spawnOptions.sessionId` (line 265). `claude-cli-adapter.ts:1064-1069` treats
`spawnOptions.sessionId` as the **source** to resume from and builds
`--resume <id> --fork-session`; `UnifiedSpawnOptions` carries no separate source-id field (only
`forkSession?: boolean`). `shouldUseNativeResume()` finds no transcript for the never-used id,
logs `Skipping --resume: no transcript for session under current cwd`, and spawns **without**
`--resume`. No resume proof arrives, so `waitForResumeHealth` is false, and line 301 throws
`Native resume did not stabilize after model change` → `adapter.terminate(true)`.

### Required behavior

1. For a fork, pass the **existing** `instance.sessionId` as the resume source and let the CLI mint
   the forked id — the adapter already adopts the authoritative id from the init message
   (`claude-cli-adapter.ts:1080-1084`). The reconciler must not pre-generate the target id, or must
   pass source and target as distinct fields.
2. **Same file, related hazard:** the runtime-change path uses the boolean `waitForResumeHealth`
   (line 301), where an `inconclusive` verdict collapses to `false` and destroys the session. The
   recovery path deliberately does not — `resolveRecoveryResumeHealth` (line 488) retries once and
   then *keeps* the live session, commenting that tearing it down "is exactly what previously lost
   the live thread and in-flight background agents on 'resume failed'". Apply the same policy to the
   runtime-change path.

### Acceptance

A yolo toggle on an idle Claude instance with history keeps the same provider session id, emits the
system notice, and answers a pre-toggle question from native context — YOLO reconciler checks 1 and
3, plus check 2's apply-on-settle half.

## LT-009: Skill Registry Is Empty, So Skill Observability Records Nothing

**Priority P0. Found 2026-07-26.**

### Observed behavior

Six real `sendInput` turns carrying exact builtin trigger phrases — including the bare phrase
`flaky test` (100% of the message) and the slash form `/test-stabilizer` — produced **zero**
`skill_activations` rows on a profile where migration `053_skill_attribution` is applied and both
tables exist. Every send logged `RLM context injected`; **no** send logged
`UnifiedMemory context injected`, i.e. the branch carrying skills never yielded a payload.
`/test-stabilizer` came back from the agent as `Unknown command: /test-stabilizer`.

The min-confidence gate is **not** the cause: `triggerMinConfidence` is `0.05`
(`skills-loader.ts:56`); the bare-phrase send scores 1.0.

### Root cause (partially established)

`skillsList()` returns **0 skills** — confirmed via two independent call paths, and it takes no
payload so it cannot be a validation artifact. Meanwhile **17 builtin skill directories exist on
disk** under `src/main/skills/builtin/`. With an empty registry `SkillRegistry.matchTrigger()` can
never match, so `detectRelevantSkills()` returns nothing and `fetchSkills()`
(`unified-controller.ts:765-801`) records nothing.

**Open:** why discovery/registration finds none of the 17 builtins. That is the first thing to chase.

### Required behavior

The builtin skills are registered at startup; a message containing a builtin trigger injects the
skill and writes a `skill_activations` row with `matched_by='trigger'`; `/test-stabilizer` resolves.

### Acceptance

Skill-observability checks 2, 4, 7 and 9 become scoreable (they are currently *indeterminate*, not
passing — their negative halves are vacuous while nothing can inject at all).

## LT-010: Sync Handler Validates Against the Wrong Allowlist

**Priority P1. Found 2026-07-26 (confirms and root-causes the 2026-07-24 report).**

### Observed behavior

Against the live `windows-pc` worker, in the same minute:

- `sync_to_node → C:\Users\shutu\.orchestrator\_scratch\aio-transfers\aio-lt-sync` fails with
  `RPC error -32603: Path outside allowed roots`.
- `upload_to_node` writes to **that same path** successfully.

The node advertises that root as
`{id: "scratch", path: "C:\\Users\\shutu\\.orchestrator\\_scratch\\aio-transfers", read: true, write: true}`.

### Root cause

`src/worker-agent/worker-agent.ts:929` constructs the handler from the wrong list:

```ts
this.syncHandler = new SyncHandler(this.config.workingDirectories ?? []);
```

`SyncHandler.assertAllowed()` (`src/worker-agent/sync-handler.ts:29-33`) therefore validates against
`workingDirectories`, a different allowlist from the file-transfer roots that
`upload_to_node`/`download_from_node` use. `isPathAllowed()` itself
(`src/worker-agent/path-sandbox.ts`) is correct — it is handed the wrong roots. Proof: the identical
sync into a *working directory* path succeeds (`added: 2, totalBytesTransferred: 48`).

### Required behavior

Construct `SyncHandler` from the node's writable file-transfer roots so the sync and upload tools
share one allowlist, and read-only roots are refused **as read-only** rather than as
"outside allowed roots".

### Acceptance

Worker file-movement check 5 passes against the `aio-transfers` scratch root exactly as its recipe
is written, including the read-only-root refusal assertion.

## LT-011: Live-Test Checks That Assert on Signals the App Never Emits

**Priority P2. Found 2026-07-26.**

### Observed behavior

- History-restore check 4 instructs the runner to "check the app log for
  `Browser gateway MCP disabled for instance`". **That string is never logged.** Neither are
  `restoreMode`, `native-resume`, `replay-fallback`, or `nativeResumeFailedAt` — so **none** of that
  doc's four checks is log-observable, even with full UI access.
- `VectorStore.getStats()` has no log line and no IPC exposure, so
  `2026-07-21-rlm-vector-store-memory_livetest.md` check 2 cannot be read at all.
- Stale preload wrappers: `electronAPI.skillsDiscover` sends `{ directory }` and
  `electronAPI.skillsMatch` sends `{ query, maxResults }`
  (`src/preload/domains/orchestration.preload.ts:534-536, 589-591`) while the contracts require
  `{ searchPaths }` and `{ text }` (`packages/contracts/src/schemas/provider.schemas.ts:326-328`),
  so both fail Zod validation. The Angular `OrchestrationIpcService` sends the correct shapes, so
  this is a latent inconsistency rather than a user-facing break — but it silently breaks any agent
  probing through `electronAPI`.

### Required behavior

Either emit the signals the checks name (a `restoreMode` log line at each rung; a
`Browser gateway MCP disabled for instance` line; a `getStats()` diagnostics field or log line), or
rewrite those checks to assert on something real. Align the stale preload wrappers with the
contracts.

## 2026-07-26 observations — triage needed, not yet classified as defects

Reproduced and evidenced, but each needs a judgement call before it becomes an LT item:

1. **76% of production sends (51 of 67) miss the 500 ms `INPUT_CONTEXT_DEADLINE_MS`** and defer
   their context bundle to the next turn. Unified-memory context yielded a payload on only 2 of 67
   sends. Deferral is by design (`instance-manager.ts:1789-1802`); the *rate* may not be.
2. **Automation-initiated turns are entirely outside skill observability** — an automation delivers
   its prompt as the instance's initial prompt at spawn, which never runs `buildInputContexts` →
   `fetchSkills`, so scheduled work can never produce a `skill_activations` row.
3. **28 `codex app-server` wrapper processes** parented to the Harness main process, several 4–12 h
   old, against `activeInstances: 0` on the remote node. Possible orphan-process leak.
4. **`rlm-storage:get-health` blocks the main event loop** — `syncMs` 189 / 214 / 266 and once
   **2164 ms** against a 100 ms threshold (`IpcHandlerTiming`, `SlowOperations`).
5. **The dev app still writes its `app.log` into the production profile** (wave-2 finding 12,
   re-confirmed 2026-07-26). This actively contaminates log-based evidence gathered from
   `harness/logs/` while a dev app is running.

## Completion Criteria

This remediation program is complete when:

- LT-001 through LT-011 satisfy their acceptance criteria.
- Every linked source live test is renamed `_livetest_completed.md`.
- Every newly discovered defect has been fixed and linked here before its retest is completed.
- All remaining untracked `_livetest.md` files have either passed and been renamed or contain a
  current external prerequisite that is not a software defect.
- The canonical project verification checklist passes after all implementation changes.
