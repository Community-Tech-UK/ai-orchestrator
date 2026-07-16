# Loop Convergence and Cost Safety Implementation Plan

> **For agentic workers:** Execute this as a sequential Campaign, one `WS` workstream per loop run. Use test-first red/green cycles, preserve the dirty checkout, and do not commit or push without James's explicit authorization.

**Goal:** Prevent large implementation loops from falsely stalling, repeatedly recycling healthy Codex context, replaying partially side-effecting iterations, or running without meaningful verification and spend limits.

**Architecture:** Keep `LoopCoordinator` as the stop-logic authority and reuse the existing Campaign coordinator for multi-workstream plans. Replace aggregate ledger counts with stable leaf-task transitions, expose provider-native context occupancy through an explicit adapter contract, make retries conditional on observed workspace effects, and enforce safe implementation-loop defaults at the shared config boundary. Pure policy modules own classification and decisions; Electron IPC and Angular surfaces only transport and present those decisions.

**Tech Stack:** TypeScript, Electron IPC, Angular signals, Zod 4, Node filesystem/git observation, better-sqlite3 persistence, Vitest.

---

## Incident baseline and acceptance criteria

This plan responds to the observed run `loop-1784059129229-cec54c2b`:

- The run completed 10 iterations in 1 hour 47 minutes, consumed 55,865,222 tokens, cost $142.27, and ended `completed-needs-review`.
- Its hierarchical ledger open count moved `5 → 4 → 5 → 4 → 8 → 8 → 7 → 8 → 8 → 8`. The current historical-minimum rule interpreted this as eight iterations without progress even though individual workstream tasks were resolving.
- Codex reported 55,659,921 input tokens across the run, but the loop had no Codex `getLastContextUsage()` implementation. The context policy therefore divided aggregate usage by a synthetic 200,000-token window and produced impossible occupancy values, recycling the session every iteration.
- The run allowed 100 turns per iteration and had no token or cost cap.
- No verify command was configured, so verification remained `not-run` and completion depended on review-driven/manual authority.
- One Codex turn emitted 101 bytes and then stayed silent for 900 seconds. The coordinator retried the whole iteration without proof that the failed attempt had made no workspace changes.
- The repository's LOC gate is already red because `scripts/analyze-codex-context-pressure.ts` is 1,153 lines against a 700-line limit. This must be repaired before verification can be an enforceable authority.

The implementation is accepted only when all of the following are true:

1. Resolving a previously open leaf task resets ledger-stall progress even when newly discovered tasks make the raw open count rise.
2. Parent checklist rows do not double-count their child rows for progress or completion.
3. Task identities survive reordering and ordinary wording edits when explicit ledger IDs are present; legacy ledgers remain readable.
4. Codex app-server occupancy uses the latest native turn sample and reported context window. Aggregate lifetime tokens never masquerade as current occupancy.
5. Unknown occupancy remains explicitly unknown and cannot trigger utilization-based recycling.
6. A failed or degraded invocation with observed workspace writes is never automatically replayed in the same workspace.
7. New implementation loops default to a finite per-iteration turn budget and estimated cost cap, and an unverified implementation loop cannot silently present itself as autonomously completable.
8. A plan that explicitly permits only one workstream per run and contains multiple workstreams is routed to a sequential Campaign rather than started as one loop.
9. Every changed policy is covered by targeted tests, the canonical repository gates pass, and rebuilt-app checks are recorded separately where automation cannot prove the result.

## Global constraints

- Read the current implementation and local diff before each workstream. Several Codex watchdog/recovery edits are already uncommitted; preserve and reconcile them rather than overwriting them.
- Do not solve the incident by only increasing `maxLedgerStallIterations`, the context window constant, or the overall iteration cap.
- Raw file churn is not progress. A file-change list may prove side effects for retry safety, but it must not indefinitely reset convergence counters.
- Provider-reported lifetime/aggregate token totals remain useful for cost and telemetry, but never for context occupancy.
- Never log prompt bodies, thread IDs, secrets, credential values, or full workspace diffs in new diagnostics.
- Existing persisted loops must restore safely. New state fields are optional on read and receive deterministic defaults.
- Campaign nodes that mutate the same checkout run sequentially with `maxParallel: 1`; do not add worktree isolation for this flow.
- The existing [Context Cost Governor plan](./2026-07-14-context-cost-governor-plan.md) remains responsible for in-turn Codex interrupt/compact/continue thresholds. This plan owns truthful occupancy at loop boundaries and replay safety.
- Do not rename this file to `_completed.md` until every agent-runnable check passes. Put rebuilt-app or human-only checks in the companion livetest file described in WS10.

## Delivery order

Execute the workstreams in this dependency order:

```text
WS1 gate repair
  ├─> WS2 ledger model ─> WS3 convergence policy ─┐
  ├─> WS4 context occupancy                       ├─> WS9 integration
  ├─> WS5 retry safety                            │
  ├─> WS6 budgets + verification                  │
  └─> WS7 scope assessment ─> WS8 campaign import ┘
                                                   └─> WS10 final gates/live checks
```

Each campaign node must set `completion.requireCompletedFileRename: false`. Only WS10 may rename this plan after the full canonical gate is green.

---

## WS1 — Restore the canonical LOC verification gate

**Outcome:** The existing context-pressure analyzer keeps its command-line and exported behavior while every source file satisfies the LOC ratchet.

**Files:**

- Modify: `scripts/analyze-codex-context-pressure.ts`
- Create: `scripts/codex-context-pressure/types.ts`
- Create: `scripts/codex-context-pressure/diagnostic-source.ts`
- Create: `scripts/codex-context-pressure/provider-capture-source.ts`
- Create: `scripts/codex-context-pressure/rollout-source.ts`
- Create: `scripts/codex-context-pressure/report.ts`
- Create if needed: `scripts/codex-context-pressure/shared.ts`
- Modify: `scripts/__tests__/analyze-codex-context-pressure.spec.ts`

### Steps

- [x] Read the entire analyzer and its spec. Record the current exported symbols, CLI arguments, output paths, exit codes, and report sections before moving code.
- [x] Add or tighten characterization tests around each source parser, merged summary, limitations, JSON output, Markdown output, and CLI validation. Run the spec and confirm it is green before the mechanical split.
- [x] Extract only cohesive pure units. Keep `scripts/analyze-codex-context-pressure.ts` as the stable entrypoint and re-export any API already consumed by tests or other scripts.
- [x] Avoid circular imports: shared types and utilities sit below source parsers; the report module may depend on parsed types, but parsers must not depend on report rendering.
- [x] Run the analyzer spec after each extraction so a structural refactor cannot silently alter the diagnostic evidence format.
- [x] Run the LOC ratchet and confirm the analyzer is no longer the blocker.

### Verification

```bash
npm run test:quiet -- scripts/__tests__/analyze-codex-context-pressure.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
npm run check:ts-max-loc
```

---

## WS2 — Give ledger leaf tasks stable identities

**Outcome:** `LOOP_TASKS.md` exposes stable leaf-level state, treats parent rows as structural summaries, and remains backward compatible with existing Markdown ledgers.

**Files:**

- Modify: `src/main/orchestration/loop-task-ledger.ts`
- Modify: `src/main/orchestration/loop-task-ledger.spec.ts`
- Modify: `src/main/orchestration/loop-stage-files.ts`
- Modify: `src/main/orchestration/loop-stage-machine.ts`
- Modify: `src/main/orchestration/loop-stage-machine.spec.ts`
- Modify: `src/main/orchestration/loop-completion-detector.ts`
- Modify: `src/main/orchestration/loop-completion-detector-ledger.spec.ts`
- Modify: `src/shared/types/loop-state.types.ts`
- Modify: `packages/contracts/src/schemas/loop.schemas.ts`
- Modify: `packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts`

### Data contract

Extend the parsed item without changing the visible checkbox grammar:

```ts
interface LoopTaskItem {
  id: string;
  idSource: 'explicit' | 'legacy-fingerprint';
  text: string;
  state: LoopTaskState;
  reason: string;
  depth: number;
  parentId: string | null;
  leaf: boolean;
}
```

Use an optional trailing identity comment:

```md
- [x] Implement persistence guard <!-- loop-task-id:ws4.persistence-guard -->
  - [x] Add schema migration <!-- loop-task-id:ws4.schema -->
  - [~] Wire runtime call site <!-- loop-task-id:ws4.runtime -->
```

The parser must read the identity comment before stripping comments. It must reject duplicate or malformed explicit IDs through the existing ledger-lint path. For old ledgers, generate a deterministic `legacy-fingerprint` from normalized ancestry plus normalized task text. That fallback supports restore and observation; it is not promised to survive substantial rewrites. The serializer always emits explicit IDs so newly seeded or subsequently normalized ledgers become stable.

Compute `leaf` after parsing indentation: an item is a leaf when no following checkbox before the next same-or-shallower row is deeper than it. Derive ledger totals, `resolved`, `nextTodo`, and completion from leaves only. A standalone top-level task is a leaf. A parent with children is structural and does not independently block completion.

### Steps

- [x] First add failing parser tests for nested parents, leaf detection, explicit IDs, duplicate IDs, malformed IDs, reordering, legacy fingerprints, deferred leaf reasons, and serialization round-trips.
- [x] Implement indentation-aware parsing and explicit ID extraction in the pure ledger module.
- [x] Update the bootstrap template and stage prompt to tell the worker to keep existing IDs, add IDs to discoveries, and use parent rows only as structural summaries.
- [x] Update completion detection to expose unresolved leaf IDs as structured evidence instead of only `openCount`. Keep `openCount` for renderer/backward compatibility, but define it as open leaf count.
- [x] Add optional persisted state fields for the known task inventory. The schema must accept old checkpoints that contain only `ledgerOpenCountBest` and `ledgerNoImprovementIterations`; migration occurs when the first new snapshot is observed.
- [x] Update ledger lint to surface duplicate IDs as a start-time warning and an iteration-time convergence warning, rather than silently collapsing them.

### Verification

```bash
npm run test:quiet -- src/main/orchestration/loop-task-ledger.spec.ts src/main/orchestration/loop-stage-machine.spec.ts src/main/orchestration/loop-completion-detector-ledger.spec.ts packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

---

## WS3 — Replace historical-minimum stall detection with transition-based convergence

**Outcome:** The stall guard measures whether known leaf tasks actually transition, so resolving work is recognized even when the inventory expands.

**Files:**

- Rewrite: `src/main/orchestration/loop-ledger-progress.ts`
- Rewrite: `src/main/orchestration/loop-ledger-progress.spec.ts`
- Modify: `src/main/orchestration/loop-coordinator.ts`
- Modify: `src/main/orchestration/loop-coordinator-ledger-stall.spec.ts`
- Modify: `src/main/orchestration/loop-progress-detector.ts`
- Modify: `src/main/orchestration/loop-progress-detector.spec.ts`
- Modify: `src/main/orchestration/loop-checkpoint.ts`
- Modify: `src/main/orchestration/loop-checkpoint.spec.ts`
- Modify: `src/shared/types/loop-state.types.ts`
- Modify: `packages/contracts/src/schemas/loop.schemas.ts`
- Modify: `packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts`

### State machine

Replace the persisted historical minimum with an optional, versioned tracker:

```ts
interface LedgerConvergenceState {
  version: 1;
  knownTaskStates: Record<string, LoopTaskState>;
  plannedLeafIds: string[];
  discoveredLeafIds: string[];
  noMeaningfulTransitionIterations: number;
  lastObjectiveEvidenceKey?: string;
}
```

The first non-empty ledger snapshot freezes `plannedLeafIds`. Later IDs are recorded in `discoveredLeafIds`; they are still required for completion, but their arrival cannot erase the history of previously resolved work.

A meaningful transition is:

- a known leaf moves from `todo` or `doing` to `done` or validly `deferred`;
- a known leaf moves from `todo` to `doing`, once for that task;
- a previously malformed/duplicate inventory becomes valid; or
- a new, unique objective-evidence key appears for a passing verification result or a strictly higher test-pass count.

The following are not meaningful transitions:

- adding or removing text without a state transition;
- adding newly discovered tasks;
- raw production-file changes;
- repeating the same semantic-progress explanation; or
- moving a task backward from resolved to open.

A backward transition must remain visible in evidence and keeps the counter advancing. When a task is removed from the ledger before it is resolved, treat it as unresolved inventory and emit a lint/convergence warning; removal is not completion.

### Steps

- [x] Write failing pure tests reproducing the incident sequence: a raw open count that rises while distinct WS4/WS5 leaves resolve must never reach the stall limit.
- [x] Add cases for unchanged state, todo-to-doing once, done-to-todo regression, task deletion, discovery without progress, repeated evidence, new passing-test evidence, and old-checkpoint migration.
- [x] Implement a pure `updateLedgerConvergence(previous, snapshot, objectiveEvidence)` function and a separate `isLedgerConvergenceStalled()` predicate.
- [x] Wire the coordinator to read the ledger snapshot directly at the completion-signal seam. Stop deriving convergence from `CompletionSignalEvidence.openCount` alone.
- [x] Persist the tracker in checkpoints and restore it safely. Keep the two legacy count fields readable for old rows, but stop writing them after the new tracker is initialized.
- [x] Update the terminal reason to list the unchanged open leaf IDs, newly discovered IDs, last meaningful transition, and exact threshold. Do not include full task bodies when a compact ID is available.
- [x] Change progress Signal C so stage duration alone cannot be `CRITICAL` during an iteration with a meaningful ledger transition or fresh objective evidence. Preserve the signal as a warning when there is genuinely no transition.

### Verification

```bash
npm run test:quiet -- src/main/orchestration/loop-ledger-progress.spec.ts src/main/orchestration/loop-coordinator-ledger-stall.spec.ts src/main/orchestration/loop-progress-detector.spec.ts src/main/orchestration/loop-checkpoint.spec.ts packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

---

## WS4 — Make Codex context occupancy truthful

**Outcome:** Loop-boundary recycling uses current provider-native occupancy when known and performs no utilization recycle when it is unknown.

**Files:**

- Modify: `src/main/cli/adapters/base-cli-adapter.types.ts`
- Modify: `src/main/cli/adapters/base-cli-adapter.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.spec.ts`
- Modify: `src/main/cli/adapters/claude-cli-adapter.ts`
- Modify: `src/main/orchestration/default-invokers.ts`
- Modify: `src/main/orchestration/default-invokers.loop.spec.ts`
- Modify: `src/main/orchestration/loop-context-discipline.ts`
- Modify: `src/main/orchestration/loop-context-discipline.spec.ts`

### Contract

Define one adapter-level context observation type:

```ts
type ContextUsageObservation =
  | { status: 'known'; used: number; total: number; source: 'provider-turn' | 'provider-session' }
  | { status: 'unknown'; reason: 'not-reported' | 'aggregate-only' | 'invalid-sample' };
```

`BaseCliAdapter.getLastContextUsage()` returns this type. Claude maps its existing current-context sample to `known`. Codex app-server returns `known` only when `lastTurnTokens > 0` and a positive provider-reported/model-resolved context window exists. Codex exec mode returns `unknown: aggregate-only` because its aggregate token total cannot prove occupancy.

`loop-context-discipline.ts` must consume this discriminated result. Delete the fallback that divides aggregate loop tokens by `LOOP_CONTEXT_WINDOW_TOKENS`. Aggregate tokens continue to populate cost/totals and diagnostics only.

### Steps

- [x] Add failing adapter tests for app-server known occupancy, updated later-turn occupancy, missing window, malformed values, and exec aggregate-only usage.
- [x] Add the public Codex getter using the already tracked `lastTurnTokens` and `codexReportedContextWindow`; do not add a second token accumulator.
- [x] Move the optional duck-typed getter in `default-invokers.ts` to the base adapter contract and pass the full observation to context discipline.
- [x] Add the regression case from the incident: 7 million aggregate tokens plus a current 60,000/200,000 observation must report 30% and must not recycle at a 60% threshold.
- [x] Add the missing-observation case: 7 million aggregate tokens plus `unknown: aggregate-only` must not recycle and must emit a bounded diagnostic explaining that occupancy was unavailable.
- [x] Preserve configured/learned context-window calibration where it is truly the denominator for a current turn sample. Never combine a current numerator with a cumulative denominator or vice versa.
- [x] Reconcile with the context-cost-governor work if it has landed: both features must consume the same provider usage event, but the governor's in-turn cumulative cost epochs and this loop's current occupancy remain distinct fields.

### Verification

```bash
npm run test:quiet -- src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts src/main/cli/adapters/codex-cli-adapter.spec.ts src/main/orchestration/default-invokers.loop.spec.ts src/main/orchestration/loop-context-discipline.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

---

## WS5 — Make degraded retries side-effect aware

**Outcome:** A failed/degraded iteration is automatically replayed only when the orchestrator can prove the attempt made no workspace writes.

**Files:**

- Create: `src/main/orchestration/loop-invocation-attempt.ts`
- Create: `src/main/orchestration/loop-invocation-attempt.spec.ts`
- Modify: `src/main/orchestration/default-invokers.ts`
- Modify: `src/main/orchestration/default-invokers.loop.spec.ts`
- Modify: `src/main/orchestration/loop-coordinator.ts`
- Modify: `src/main/orchestration/loop-invocation-error-routing.spec.ts`
- Modify: `src/main/orchestration/loop-coordinator-degraded-retry.spec.ts` if present; otherwise add a focused coordinator retry spec beside the existing loop coordinator specs
- Modify: `src/main/cli/adapters/codex-cli-adapter.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts`
- Modify: `src/main/cli/adapters/codex-cli-adapter.thread-recovery.spec.ts`
- Modify: `src/shared/types/loop-state.types.ts`
- Modify: `packages/contracts/src/schemas/loop.schemas.ts`

### Attempt result

Return or throw a structured attempt record even on timeout/error:

```ts
interface LoopInvocationAttemptEvidence {
  outcome: 'completed' | 'degraded' | 'failed';
  outputExcerpt: string;
  workspaceEffect: 'none-observed' | 'writes-observed' | 'unknown';
  filesChanged: LoopFileChange[];
  providerThreadReusable: boolean;
  reason?: string;
}
```

Capture the before snapshot once per attempt and the after snapshot in `finally`, using both git and filesystem observation as the normal invoker already does on success. `none-observed` means the available observers completed and found no delta; observer failure produces `unknown`, never `none-observed`.

Retry matrix:

| Attempt evidence | Automatic action |
|---|---|
| Degraded/failed + `none-observed` + retryable provider state | Bounded retry, preserving the native thread when safe |
| Degraded/failed + `writes-observed` | Seal evidence and pause as `completed-needs-review`; do not replay |
| Degraded/failed + `unknown` | Pause for review; do not replay |
| Context overflow before tool/write activity and no observed delta | One bounded fresh-context recovery |
| Circuit breaker open before invocation starts | Existing bounded backoff/retry, because no attempt ran |

### Steps

- [x] Write failing pure retry-decision tests for every row in the matrix.
- [x] Move workspace-delta capture into a `try/finally` path so errors and timeouts cannot bypass it.
- [x] Preserve partial output and adapter degradation reason in the structured evidence without treating 101 emitted bytes as proof of no side effects.
- [x] Update the coordinator's retry loop to call the pure decision function. A write-observed/unknown pause must include the changed paths or observer failure reason in `endEvidence`.
- [x] Reconcile the existing uncommitted Codex watchdog edits. Keep the longer post-`turn/started` idle budget and refusal to perform a context-empty thread retry, provided their focused tests prove those behaviors.
- [x] Prefer native same-thread continuation after a transport recovery when `providerThreadReusable` is true. A fresh session is allowed only after `none-observed` is proven or isolation guarantees the failed workspace can be discarded.
- [x] Persist enough attempt evidence that a restart does not lose why an iteration was parked, but do not persist full output or full diffs beyond existing bounded fields.

### Verification

```bash
npm run test:quiet -- src/main/orchestration/loop-invocation-attempt.spec.ts src/main/orchestration/loop-invocation-error-routing.spec.ts src/main/orchestration/default-invokers.loop.spec.ts src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts src/main/cli/adapters/codex-cli-adapter.thread-recovery.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

---

## WS6 — Enforce finite budgets and verification authority

**Outcome:** New implementation loops are finite by default, expose the per-iteration turn cap in the UI, and cannot imply autonomous completion without a real verification authority.

**Files:**

- Modify: `src/shared/types/loop.types.ts`
- Modify: `src/shared/types/loop-config-defaults.ts`
- Modify: `packages/contracts/src/schemas/loop.schemas.ts`
- Modify: `packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts`
- Modify: `src/main/orchestration/loop-start-config.ts`
- Modify: `src/main/orchestration/loop-start-config.spec.ts`
- Modify: `src/main/orchestration/loop-coordinator.ts`
- Modify: `src/main/orchestration/loop-coordinator-goal-intent.spec.ts`
- Modify: `src/renderer/app/features/loop/loop-config-panel.component.ts`
- Modify: `src/renderer/app/features/loop/loop-config-panel.component.html`
- Modify: `src/renderer/app/features/loop/loop-config-panel.component.scss`
- Modify: `src/renderer/app/features/loop/loop-config-panel.component.spec.ts`

### Defaults and rules

- Set the new-loop default `maxTurnsPerIteration` to 30.
- Set the new-loop estimated cost cap to 3,000 cents ($30) per loop node.
- Keep explicit `null` supported for persisted/backward-compatible configs, but require a deliberate `Allow unbounded estimated spend` UI choice to emit it for a new interactive run.
- A campaign generated from a plan inherits these caps per node, not once across an arbitrarily large campaign. The campaign preview must show the aggregate worst-case estimate (`node count × per-node cap`) without presenting it as an invoice or guaranteed charge.
- Verification policy depends on goal intent:
  - `implementation`: requires a non-empty `verifyCommand`, or an explicitly enabled operator-reviewed completion mode with a finite cost cap;
  - `investigation`: may use review/report authority without a machine verify command;
  - ambiguous intent remains `implementation`.
- Cross-model review is corroboration for implementation work, not a substitute for running the repository's specified tests/build/typecheck when the user expects autonomous completion.

Because `prepareLoopStartConfig()` currently runs before `LoopCoordinator.startLoop()` derives goal intent, move goal-intent classification into a shared pure helper used by both seams. Validate after classification and before spawning an adapter. Preserve an explicit caller-supplied intent.

### Steps

- [x] Add failing default-materialization tests for 30 turns and $30, plus persisted explicit-null compatibility.
- [x] Replace start-config tests that currently bless an empty-verify implementation loop with the policy matrix above. Preserve tests for review-driven investigations and explicitly operator-reviewed finite runs.
- [x] Add renderer controls for maximum turns, estimated cost cap, and the deliberate unbounded toggle. Display concise copy explaining that the cost check occurs between iterations, so a single iteration is bounded primarily by the turn cap.
- [x] Keep the submit button disabled, with an inline reason, when an implementation goal has neither a verify command nor valid operator-reviewed authority.
- [x] Validate the same rule in main-process start configuration so IPC/programmatic callers cannot bypass the renderer.
- [x] Update stale comments in `LoopCompletionConfig` and `loop-start-config.ts` to describe actual behavior.
- [x] Add a start-boundary regression proving no adapter/coordinator invocation occurs after validation fails.

### Verification

```bash
npm run test:quiet -- src/main/orchestration/loop-start-config.spec.ts src/main/orchestration/loop-coordinator-goal-intent.spec.ts src/renderer/app/features/loop/loop-config-panel.component.spec.ts packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

---

## WS7 — Classify oversized and multi-workstream plans before loop start

**Outcome:** A pure scope assessment identifies plans that contradict single-loop execution, with deterministic reasons and extracted workstream boundaries.

**Files:**

- Create: `src/main/orchestration/loop-scope-assessment.ts`
- Create: `src/main/orchestration/loop-scope-assessment.spec.ts`
- Modify: `packages/contracts/src/channels/loop.channels.ts`
- Modify: `packages/contracts/src/schemas/loop.schemas.ts`
- Modify: `packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts`
- Modify: `src/main/ipc/handlers/loop-handlers.ts`
- Modify: `src/main/ipc/handlers/__tests__/loop-handlers.spec.ts` if present; otherwise add `src/main/ipc/handlers/loop-scope-handlers.spec.ts`
- Modify: `src/preload/preload.ts`
- Modify: the matching preload/global API type declaration used by loop IPC

### Assessment result

```ts
interface LoopScopeAssessment {
  disposition: 'single-loop' | 'campaign-recommended' | 'campaign-required';
  reasons: Array<'explicit-one-workstream-rule' | 'multiple-workstreams' | 'oversized-checklist'>;
  workstreams: Array<{
    id: string;
    title: string;
    startLine: number;
    endLine: number;
  }>;
  checklistLeafCount: number;
}
```

Classification must be deterministic and conservative:

- Recognize structured headings such as `## WS4 — Title`, `### WS4: Title`, and `## Workstream 4 — Title`.
- Recognize explicit constraints such as “one workstream per run” or “do not start a second workstream.”
- `campaign-required` only when an explicit one-workstream constraint coexists with two or more extracted workstreams.
- `campaign-recommended` when there are multiple workstreams or an oversized leaf checklist but no explicit prohibition.
- Do not send plan text to an LLM for this gate. A false negative may show a recommendation later; a false positive must not silently rewrite execution.

The assessment endpoint accepts a workspace-relative configured `planFile`. Resolve it through the existing workspace path-safety rules, enforce a bounded text-file size, and return metadata rather than the full plan body. Initial implementation does not auto-convert ephemeral chat attachments because their per-loop attachment location is not a durable Campaign source; the UI must explain that the plan should first be saved/configured as `planFile`.

### Steps

- [x] Add failing pure tests using the Fable plan shape, including its explicit one-workstream sentence and multiple WS headings.
- [x] Add negative cases for prose mentioning “workstream,” code fences containing fake headings, duplicate headings, malformed ordering, a single workstream, and a large but non-checklist document.
- [x] Implement code-fence-aware heading/checklist parsing and return line ranges without retaining the full source in state.
- [x] Add validated IPC request/response schemas and a read-only handler.
- [x] Call the same assessor inside `LOOP_START` after `prepareLoopStartConfig()` and before `coordinator.startLoop()`. For `campaign-required`, return a structured start error with the assessment; do not start the loop. A renderer advisory can be bypassed, but this main-process guard cannot.
- [x] For `campaign-recommended`, permit an explicit single-loop override only after the renderer presents the reason. Persist the override flag in config so restarts/audits show that it was deliberate.

### Verification

```bash
npm run test:quiet -- src/main/orchestration/loop-scope-assessment.spec.ts src/main/ipc/handlers/loop-scope-handlers.spec.ts packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

---

## WS8 — Import a scoped plan as a safe sequential Campaign

**Outcome:** The Campaign UI can preview and start one loop node per extracted workstream, using the existing coordinator rather than one oversized prompt.

**Files:**

- Create: `src/main/orchestration/campaign-plan-import.ts`
- Create: `src/main/orchestration/campaign-plan-import.spec.ts`
- Modify: `packages/contracts/src/channels/campaign.channels.ts`
- Modify: `packages/contracts/src/schemas/campaign.schemas.ts`
- Modify: `src/main/ipc/handlers/campaign-handlers.ts`
- Modify: `src/main/ipc/handlers/campaign-handlers.spec.ts`
- Modify: `src/preload/preload.ts`
- Modify: the matching preload/global API type declaration used by Campaign IPC
- Modify: `src/renderer/app/features/campaign/campaign-page.component.ts`
- Modify: `src/renderer/app/features/campaign/campaign-page.component.html`
- Modify: `src/renderer/app/features/campaign/campaign-page.component.scss`
- Modify: `src/renderer/app/features/campaign/campaign-page.component.spec.ts`
- Modify: the renderer Campaign service/store if IPC calls are not currently encapsulated there

### Generated Campaign contract

For a configured repository plan:

- Create one node per extracted workstream, in document order.
- Add an edge from each node to the next, gated on upstream `completed`.
- Set `policy.maxParallel = 1` and `policy.onNodeNeedsReview = 'pause-campaign'`.
- Do not set `policy.isolation`; all nodes intentionally share the same checkout sequentially.
- Copy the selected provider, model/config, verify command, 30-turn default, and $30 estimated cap into every node.
- Set `completion.requireCompletedFileRename = false` on workstream nodes.
- Give each node an explicit prompt: read the full plan for context, implement only the named workstream and its acceptance checks, update only that workstream's checklist, and stop before beginning the next workstream.
- Add a final `integration-gate` node after the last workstream. It runs the canonical verification checklist, checks every plan workstream is resolved, creates a livetest file for checks that genuinely require rebuild/human/external service, and is the only node allowed to rename the plan `_completed.md`.
- Set `sourceRef` to the workspace-relative plan path and include a stable source digest in import metadata so the preview can warn if the plan changed before start.

Do not auto-start from the import action. The user must see the generated nodes, per-node cap, aggregate maximum estimate, sequential policy, and final gate before pressing the existing Campaign start control.

### Steps

- [x] Write failing pure builder tests for node prompts, dependency order, completed-only edges, pause-on-review, per-node caps, final-gate behavior, stable IDs, and source digest.
- [x] Add validated preview/import IPC that reuses WS7 assessment and path safety. Re-read and re-hash the plan at Campaign start; reject a stale preview rather than running against changed scopes.
- [x] Add a Campaign-page “Import implementation plan” flow with plan path, base loop settings, preview, validation errors, and the existing editable DAG representation.
- [x] From the Loop config panel's `campaign-required` error, provide a navigation action that opens Campaigns with the plan path prefilled. Do not duplicate Campaign construction in the loop renderer.
- [x] Ensure Campaign coordinator validation remains the final graph authority and that generated configs still pass `prepareLoopStartConfig()` for each node.
- [x] Add renderer tests proving import does not auto-start, required policy fields are visible, and a changed plan invalidates the preview.

### Verification

```bash
npm run test:quiet -- src/main/orchestration/campaign-plan-import.spec.ts src/main/ipc/handlers/campaign-handlers.spec.ts src/renderer/app/features/campaign/campaign-page.component.spec.ts src/main/orchestration/__tests__/campaign-coordinator.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

---

## WS9 — Add incident-level integration and restore coverage

**Outcome:** Cross-module tests prove the fixes work together on the actual failure shape and survive persistence/restart.

**Files:**

- Create: `src/main/orchestration/loop-convergence-cost-safety.integration.spec.ts`
- Modify: `src/main/orchestration/loop-coordinator-restore.spec.ts`
- Modify: `src/main/orchestration/loop-context-survival.spec.ts`
- Modify: `src/main/orchestration/__tests__/campaign-coordinator.spec.ts`
- Modify: `src/main/orchestration/loop-start-config.spec.ts`
- Modify: `docs/testing.md` only if a new test tier or fixture convention is introduced

### Scenarios

- [x] Reproduce the incident ledger trajectory with stable IDs: WS4 and WS5 child tasks resolve while discoveries increase the raw count. Assert no false ledger stall and assert the tracker identifies the exact resolved IDs.
- [x] Feed 55 million aggregate Codex tokens plus a healthy current occupancy observation. Assert no utilization recycle and no impossible percentage in diagnostics.
- [x] Simulate the 101-byte/900-second degraded turn with a workspace write. Assert no replay, one sealed attempt, and a needs-review state containing bounded changed-path evidence.
- [x] Repeat with no observed delta. Assert the bounded retry occurs once according to config and does not duplicate the iteration sequence.
- [x] Start an implementation config with no verification authority. Assert rejection happens before adapter invocation.
- [x] Assess/import a Fable-shaped plan. Assert it becomes a sequential Campaign with one workstream per node and a final integration node.
- [x] Serialize and restore a running loop containing the new convergence tracker and a parked write-observed attempt. Assert the restored state makes the same next decision and does not replay on startup.
- [x] Restore a legacy checkpoint containing only historical ledger fields. Assert it initializes the new tracker on the next ledger observation without crashing or treating old counts as task IDs.

### Verification

```bash
npm run test:quiet -- src/main/orchestration/loop-convergence-cost-safety.integration.spec.ts src/main/orchestration/loop-coordinator-restore.spec.ts src/main/orchestration/loop-context-survival.spec.ts src/main/orchestration/__tests__/campaign-coordinator.spec.ts src/main/orchestration/loop-start-config.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

---

## WS10 — Final verification, live-test handoff, and plan completion

**Outcome:** All agent-runnable evidence is green, remaining rebuilt-app checks are explicit, and the plan is renamed only at the real completion boundary.

**Files:**

- Create if live checks remain: `docs/superpowers/plans/2026-07-14-loop-convergence-and-cost-safety-plan_livetest.md`
- Rename last: `docs/superpowers/plans/2026-07-14-loop-convergence-and-cost-safety-plan_completed.md`

### Automated gate

- [x] Run every targeted command from WS1–WS9 after merging/reconciling all workstreams.
- [x] Run the canonical project checklist from the repository root:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test:quiet
```

- [x] Run `npm run build` because IPC contracts, preload exposure, and Angular templates changed.
- [x] Review the final diff for unrelated edits, overwritten pre-existing changes, generated artifacts, absolute local paths, and secret-like values.
- [x] Confirm all new channels are exported, registered, exposed through preload, typed in the renderer, and exercised by at least one test.
- [x] Confirm old checkpoint/schema fixtures still parse and new fields round-trip through the store.

### Rebuilt-app checks

Deferred to `2026-07-14-loop-convergence-and-cost-safety-plan_livetest.md` (6 rebuilt-app checks with steps, expected results, and evidence to capture).

### Completion boundary

- [x] Move every genuinely deferred live check out of this plan into the livetest file, leaving only a one-line pointer here.
- [x] Rename this plan to `_completed.md` only after all automated gates pass.
- [x] Do not edit the completed plan after renaming it. Complete the companion live plan later by renaming it `_livetest_completed.md` only after every recorded live check passes with evidence.

## As-Built Evidence (2026-07-16, loop-1784205984733-079fe232)

All ten workstreams implemented and verified in-loop across iterations 1–15:

- **WS1** LOC verification gate (pre-loop, iteration 0 audit confirmed).
- **WS2** stable leaf identities: `loop-task-id` comments + sha256 legacy fingerprints,
  leaf-only ledger totals, duplicate/malformed-id lint, `openLeafIds` completion evidence,
  `LedgerConvergenceState` schema groundwork (17 parser + lint/detector/schema tests).
- **WS3** transition-based convergence: `updateLedgerConvergence`/`isLedgerConvergenceStalled`
  (max-progress recording, removal ≠ completion, parent refinement, inventory-repair and
  objective-evidence transitions), coordinator reads the ledger at the seam, legacy counters
  retired from writes, Signal C held to WARN on meaningful transitions, id-listing terminal
  reason. Deviations: optional `inventoryInvalid` field beyond the plan's literal interface
  (needed for the repair transition); migration starts the counter fresh (the legacy count
  measured the false-stall-prone quantity).
- **WS4** truthful occupancy: `ContextUsageObservation` union on the base adapter contract,
  codex app-server/exec + claude overrides, aggregate recycle fallback DELETED, calibrated
  window only as denominator for a known sample without a usable total, bounded
  unknown-occupancy diagnostic (`loop-context-discipline-runtime.ts`).
- **WS5** side-effect-aware retries: `loop-invocation-attempt.ts` pure matrix +
  `loop-attempt-observation.ts` error-path workspace observation; writes-observed/unknown
  attempts pause as completed-needs-review with sealed `endEvidence`; overflow recovery gated
  on none-observed; native thread preserved when reusable. Deviations: evidence rides
  `LoopChildResult`/`LoopChildInvocationError` rather than a thrown record type;
  loop-state/schemas untouched (endEvidence already persisted); codex watchdog items were
  pre-satisfied with coverage (idle-budget split, context-empty refusal).
- **WS6** finite budgets + authority: 30-turn/$30 defaults (explicit null preserved),
  `maxTurnsPerIteration` ADDED to the IPC schema (was silently stripped), shared
  `resolveLoopGoalIntent` in `src/shared`, policy enforced in `prepareLoopStartConfig` AND
  the renderer submit gate, allow-unbounded toggle, campaign nodes carry authority,
  resume-with-answers falls back to operator-reviewed authority.
- **WS7** plan-scope assessment: code-fence-aware deterministic assessor (12 tests incl.
  Fable shape), `LOOP_ASSESS_SCOPE` endpoint (path-safe, 1MiB bound), LOOP_START guard
  (campaign-required unbypassable; recommended needs persisted `singleLoopOverride`).
- **WS8** plan→campaign import: pure builder (sequential completed-only chain, integration
  gate as sole rename authority, WS6 caps + authority per node, aggregate estimate, sha256
  digest), preview IPC + start-time staleness gate (`CAMPAIGN_PLAN_STALE`), campaign-page
  import panel (preview-only, edit-invalidation), scope-refusal navigation with prefill.
- **WS9** incident-level integration spec (9 tests): trajectory/occupancy/replay/authority/
  import/restore scenarios all green; terminal parked runs are refused re-activation.
- **WS10** gates: combined WS1–WS9 targeted run 650/650; full suites green at WS7 stack
  (14,072/14,072 exit 0), WS8 stack (exit 0), and post-WS9 (recorded at closure); tsc ×2,
  lint, LOC ratchet (two ceilings raised intentionally with notes after extractions),
  `npm run build` exit 0, `git diff --check` clean, secret/absolute-path scan clean,
  1082 IPC channels generated+verified, old checkpoint fixtures parse (schema back-compat
  tests). Live checks: see the companion `_livetest.md`.

## Explicit non-goals

- Replacing Campaign Mode with a new orchestration system.
- Inferring context occupancy from cost, aggregate token totals, output length, or a fixed 200,000-token denominator.
- Treating LLM self-review as equivalent to repository test/build verification for implementation work.
- Automatically replaying a side-effecting attempt and trying to deduplicate its edits afterward.
- Parallelizing nodes that mutate the same checkout.
- Auto-converting ephemeral attachments into durable Campaign sources in the first implementation.
- Raising existing caps as the primary convergence fix.

