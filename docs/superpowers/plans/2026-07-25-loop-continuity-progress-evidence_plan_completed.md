# Loop Continuity and Progress Evidence Reliability Implementation Plan

> **Execution note:** Follow the linked specification and this plan task by task. Do not commit or push unless James explicitly requests it.

**Date:** 2026-07-25

**Status:** Completed. Implementation and all agent-runnable verification passed; paid/rebuilt-app checks are deferred to the linked live-test plan.

**Specification:** [2026-07-25-loop-continuity-progress-evidence_spec_completed.md](../specs/2026-07-25-loop-continuity-progress-evidence_spec_completed.md)

**Deferred live validation:** [2026-07-25-loop-continuity-progress-evidence_plan_livetest.md](2026-07-25-loop-continuity-progress-evidence_plan_livetest.md)

**Incident run:** `loop-1784996690913-2bbaa1b4`

## Outcome

Loop Mode will preserve real Codex context in AIO-owned state, report workspace observation coverage honestly, recognize stable task-ledger progress, and keep an activated cap as the controlling terminal reason.

## Constraints

- Read every target file and its callers/tests in full before editing.
- Reproduce each defect in a focused failing test before changing implementation.
- Preserve unrelated dirty-tree work.
- Keep active specification and plan files untracked.
- Do not solve continuity by persisting Loop sessions in the user's normal Codex home.
- Do not classify partial observation as proof of no writes.
- Do not fold semantic ledger progress into the structural work hash.
- Do not weaken cost, verification, or degraded-retry safety.
- Keep new modules below the repository TypeScript LOC limit.

## Workstream dependency map

```text
WS1 incident fixtures and contracts
 ├── WS2 persistent adapter lifecycle
 ├── WS3 coverage-aware workspace observation
 └── WS4 progress and terminal policy
          \        |        /
           WS5 incident integration
                    |
           WS6 full verification
                    |
           WS7 live-test deferral/as-built closeout
```

WS2, WS3, and WS4 are logically independent after WS1 defines the test contracts, but implementation must remain sequential in one working tree unless explicitly delegated.

## WS1. Lock the incident into executable contracts

### Task 1.1: Add Codex continuity regression coverage

**Read fully before editing:**

- `src/main/orchestration/default-invokers.ts`
- `src/main/orchestration/default-loop-invoker-helpers.ts`
- `src/main/orchestration/default-invokers.loop.spec.ts`
- `src/main/providers/provider-runtime-service.ts`
- `src/main/cli/adapters/adapter-factory.ts`
- `src/main/cli/adapters/adapter-factory.types.ts`
- `src/main/cli/adapters/codex-exec-adapter.ts`
- `src/main/cli/adapters/codex-app-server-adapter.ts`
- `src/main/cli/adapters/codex-app-server-turn-adapter.ts`
- relevant Codex adapter specs

**Add failing tests that prove:**

1. `createPersistentLoopAdapter()` requests non-ephemeral Codex state.
2. A reused Loop adapter is initialized once before its first turn.
3. Two turns use the same initialized runtime and native thread.
4. The second turn does not enter stale-resume fresh replay.
5. A one-shot/fresh-child adapter retains the current ephemeral default.
6. Adapter termination occurs once at Loop teardown or context recycle.

Use fakes for unit tests. Do not invoke a real paid provider in the automated suite.

**Verification:**

```bash
rtk npm run test:quiet -- src/main/orchestration/default-invokers.loop.spec.ts
rtk npm run test:quiet -- src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts
```

Expected before implementation: at least the lifecycle/non-ephemeral assertions fail.

### Task 1.2: Add workspace-coverage regression fixtures

**Read fully before editing:**

- `src/main/orchestration/loop-attempt-observation.ts`
- `src/main/orchestration/loop-workspace-snapshot.ts`
- `src/main/orchestration/loop-repo-state.ts`
- `src/main/orchestration/loop-invocation-attempt.ts`
- their complete spec files

Add `src/main/orchestration/loop-attempt-observation.spec.ts` for the observer-level cases; this focused spec does not exist at planning time.

Create reusable temporary-workspace fixtures that can:

- create a parent directory that is not a Git repository;
- create two nested Git repositories;
- create more than 5,000 eligible files under an early-sorted subtree;
- create a root-level untracked deliverable after the baseline;
- modify an untracked file that existed at baseline;
- modify tracked and staged files in different nested repositories;
- force one observer to fail or truncate.

Add failing assertions for every acceptance criterion in specification sections 6.2–6.4.

**Verification:**

```bash
rtk npm run test:quiet -- src/main/orchestration/loop-workspace-snapshot.spec.ts
rtk npm run test:quiet -- src/main/orchestration/loop-attempt-observation.spec.ts
rtk npm run test:quiet -- src/main/orchestration/loop-invocation-attempt.spec.ts
```

### Task 1.3: Add progress and cap-precedence regressions

**Read fully before editing:**

- `src/main/orchestration/loop-coordinator.ts`
- `src/main/orchestration/loop-ledger-progress.ts`
- `src/main/orchestration/loop-pre-iteration-guard.ts`
- `src/main/orchestration/loop-completion-context-store.ts`
- `src/main/orchestration/loop-coordinator-ledger-stall.spec.ts`
- `src/main/orchestration/loop-coordinator-completion-budget.spec.ts`
- related terminal and convergence specs

Add failing tests for:

- successive meaningful ledger transitions with persistent CRITICAL findings reset review stall;
- three CRITICAL iterations with no semantic or production progress still stall;
- cap wrap-up plus CRITICAL/no-progress evidence ends `cap-reached`;
- original cap reason survives the wrap-up;
- verified completion on the wrap-up turn is allowed to win;
- a failed wrap-up still terminalizes under the cap, with failure as secondary evidence.

Use the real stable-leaf ledger transition helper rather than mocking a boolean in the incident-level test.

**Verification:**

```bash
rtk npm run test:quiet -- src/main/orchestration/loop-coordinator-ledger-stall.spec.ts
rtk npm run test:quiet -- src/main/orchestration/loop-coordinator-completion-budget.spec.ts
```

## WS2. Make persistent Loop turns lifecycle- and transport-aware

### Task 2.1: Define one request/response turn seam

**Likely files:**

- `src/main/cli/adapters/base-cli-adapter.ts`
- `src/main/cli/adapters/base-cli-adapter.types.ts`
- `src/main/cli/adapters/codex-exec-adapter.ts`
- `src/main/cli/adapters/codex-app-server-adapter.ts`
- `src/main/cli/adapters/codex-app-server-turn-adapter.ts`
- `src/main/orchestration/default-invokers.ts`

Choose the smallest interface that lets orchestration:

1. initialize a persistent adapter exactly once;
2. route a turn through the adapter's selected runtime;
3. await the single `CliResponse` completed by that turn.

Preferred implementation direction:

- add a lifecycle-aware request/response method or focused orchestration wrapper;
- factor Codex app-server turn execution so it can return the same `CliResponse` it currently passes to `completeResponse`;
- have event-driven `sendInputImpl()` and request/response orchestration share that internal turn result;
- keep direct exec behavior for modes that intentionally use exec;
- prevent two assistant outputs or two `completeResponse` calls for one turn.

Do not make orchestration wait on general transcript events without a bounded, turn-correlated completion mechanism. Do not infer readiness from `isRunning()` alone for exec-backed adapters; readiness and “child process currently alive” are different states.

### Task 2.2: Initialize persistent adapters and preserve owned cleanup

Update `invokeCliTextResponse()` or a focused helper used by it so:

- owned one-shot adapters keep current one-call cleanup;
- reused adapters are initialized once and remain owned by the Loop persistent-adapter registry;
- activity hooks and `onAdapterReady` still attach per invocation;
- per-call timeout metadata still reaches the turn;
- tools-disable overrides apply only for the cap wrap-up and are restored in `finally`;
- initialization failure is returned as explicit attempt failure evidence;
- Loop teardown and model/context recycle terminate the adapter and release its prepared runtime.

Add focused lifecycle tests for normal completion, throw, wrap-up tools-disable, and recycle.

### Task 2.3: Select safe Codex persistence

In `createPersistentLoopAdapter()`:

- pass `ephemeral: false` for persistent Codex Loop adapters;
- leave fresh-child/one-shot construction unchanged;
- ensure initialization invokes Codex home preparation before a turn can persist state;
- assert through test-visible configuration/runtime state that persistent storage is AIO-managed;
- fail closed if isolation cannot be established instead of running non-ephemeral against the default user home.

Avoid logging the full prepared environment or any credential-bearing configuration.

### Task 2.4: Verify continuation and recovery boundaries

Test:

- first turn creates a native thread;
- second turn continues it;
- real missing-thread errors still enter the existing bounded recovery path;
- normal continuation does not log or count as recovery;
- context recycle intentionally creates a new thread after terminating the old runtime;
- the old runtime's temporary home is cleaned up while shared AIO session state remains available according to `CodexHomeManager`.

**Targeted verification:**

```bash
rtk npm run test:quiet -- src/main/orchestration/default-invokers.loop.spec.ts
rtk npm run test:quiet -- src/main/cli/adapters/codex-cli-adapter.app-server.spec.ts
rtk npm run test:quiet -- src/main/cli/adapters/codex-cli-adapter.thread-recovery.spec.ts
```

## WS3. Make workspace observation complete or explicitly incomplete

### Task 3.1: Introduce an observation result type

**Likely files:**

- `src/main/orchestration/loop-attempt-observation.ts`
- `src/main/orchestration/loop-workspace-snapshot.ts`
- `src/main/orchestration/loop-invocation-attempt.ts`
- `src/main/orchestration/default-invokers.ts`

Replace the array-or-null observation contract with a result containing:

- bounded known changes;
- coverage: complete, partial, or failed;
- observer sources used;
- bounded reason/details.

Keep persisted attempt evidence backward-compatible if possible by mapping:

| Observation | Attempt workspace effect |
|---|---|
| complete, zero known changes | `none-observed` |
| complete, one or more changes | `writes-observed` |
| partial, one or more changes | `writes-observed` with limitation reason |
| partial, zero known changes | `unknown` |
| failed | `unknown` |

Update `deriveAttemptEvidenceFromResult()` so a legacy result without explicit coverage is not used at new call sites to manufacture false certainty. If the public result type must grow, make coverage required internally and optional only at compatibility boundaries.

### Task 3.2: Extract reusable Git state comparison

Use `loop-repo-state.ts` as the source of truth for tracked, staged, deleted, and untracked hashing. Extract pure/shared helpers if necessary rather than implementing a second subtly different Git parser.

The baseline must distinguish:

- an untracked file that did not exist before the attempt;
- an untracked file present before the attempt whose content changed;
- an unchanged dirty file;
- staged versus unstaged content changes where path reporting is the same.

Git command failures must be localized to the affected repository and returned as partial coverage.

### Task 3.3: Add bounded nested-repository discovery

Add a focused module if needed, such as:

- `src/main/orchestration/loop-workspace-repositories.ts`
- matching `.spec.ts`

Required behavior:

1. If the selected workspace belongs to one Git repository, use it as the authoritative Git scope.
2. Otherwise discover nested repository roots using shallow-first bounded traversal.
3. Stop descending below a discovered `.git` root.
4. Apply the canonical ignore list to vendor, build, scratch, archive, and Loop-state directories.
5. Return discovery coverage and truncation/failure details.
6. Normalize changed paths against the selected workspace.

Do not run recursive Git commands against an arbitrary parent workspace.

### Task 3.4: Repair the filesystem fallback

Update `loop-workspace-snapshot.ts` so its result includes at least:

- entries;
- whether the entry/traversal limit was reached;
- optionally skipped/failed path counts needed for a useful reason.

Use breadth-first or explicit shallow-first scheduling so a deep `src` subtree cannot starve root siblings. Preserve deterministic ordering for reproducible hashes and tests.

Hash eligible file content consistently with current safety/performance bounds. A scan that skips unreadable eligible paths or reaches its cap cannot be complete unless authoritative Git coverage covers that path space.

### Task 3.5: Merge observer results conservatively

In `AttemptDeltaObserver`:

- combine authoritative results from all discovered nested Git roots;
- use filesystem snapshots for uncovered non-Git path space;
- deduplicate normalized paths;
- choose the strongest known change kind where observers overlap;
- preserve partial coverage even when changes were found;
- cap evidence paths only after merge, not per observer;
- produce structured coverage logs.

On degraded/failed attempts, automatic replay remains blocked unless the merged observation is complete and empty.

**Targeted verification:**

```bash
rtk npm run test:quiet -- src/main/orchestration/loop-repo-state.spec.ts
rtk npm run test:quiet -- src/main/orchestration/loop-workspace-snapshot.spec.ts
rtk npm run test:quiet -- src/main/orchestration/loop-attempt-observation.spec.ts
rtk npm run test:quiet -- src/main/orchestration/loop-invocation-attempt.spec.ts
```

## WS4. Unify progress facts and terminal precedence

### Task 4.1: Extract a pure review-stall policy

Create a small pure module, likely:

- `src/main/orchestration/loop-review-stall-policy.ts`
- `src/main/orchestration/loop-review-stall-policy.spec.ts`

Inputs should include:

- structural review verdict/severity;
- production changes observed;
- clean-review convergence state;
- `ledgerMeaningfulTransition`;
- current consecutive review-stall count;
- configured limit;
- whether cap wrap-up terminal intent is active.

Outputs should say whether to reset, increment, preserve/suppress, or terminalize, plus a machine-readable reason for logs/tests.

Policy:

- production progress resets;
- meaningful stable-leaf ledger transition resets;
- clean review convergence resets;
- unchanged CRITICAL evidence increments only when no higher-priority cap intent is active;
- a cap-active result may collect secondary stall evidence but cannot terminalize as review stall.

Wire the existing `LedgerConvergenceUpdate.meaningfulTransition` into this helper. Do not change the structural work hash to include `.aio-loop-state`.

### Task 4.2: Store full cap wrap-up intent

Replace `Map<string, LoopCapKind>` in `LoopCompletionContextStore` with a typed cap-wrap-up state carrying:

- cap kind;
- original reason;
- trigger iteration;
- trigger measurement and configured limit when available;
- phase (`pending-turn` or `turn-complete`) if needed.

Inspect Loop persistence and restart reconciliation before deciding whether this stays transient. If an active run can resume after process restart, persist a backward-compatible pending cap intent in the appropriate Loop state/end-evidence schema. Otherwise make restart reconciliation terminalize conservatively under the cap.

Unit-test set/get/clear/reset semantics.

### Task 4.3: Centralize post-iteration terminal precedence

Extract a pure terminal-selection helper or a visibly ordered policy block with direct unit coverage. Required order:

1. explicit external stop/cancel semantics that already outrank normal completion;
2. verified completion, including on the cap wrap-up;
3. active cap intent after its one permitted wrap-up;
4. other convergence/stall/no-progress terminals.

If existing product semantics require external cancellation ahead of completion, preserve them and document the choice in as-built notes.

When cap wins:

- status/reason/event/end evidence all identify `cap-reached`;
- the stored original reason is primary;
- review/ledger/no-progress findings may appear as secondary evidence;
- no additional iteration is scheduled.

### Task 4.4: Add exact incident-sequence policy test

Drive coordinator policy through:

- ledger initialization at 20 open tasks;
- meaningful transitions to 18, 14, and 10;
- empty structural `filesChanged` and `toolCalls`;
- persistent CRITICAL review findings;
- cost cap reached after the fourth work turn;
- one wrap-up turn with no completion.

Assert:

- review stall does not stop iterations 1–3;
- cap starts exactly one wrap-up;
- the next terminal state is `cap-reached`;
- the reason identifies the cost limit;
- no sixth invocation occurs.

**Targeted verification:**

```bash
rtk npm run test:quiet -- src/main/orchestration/loop-review-stall-policy.spec.ts
rtk npm run test:quiet -- src/main/orchestration/loop-coordinator-ledger-stall.spec.ts
rtk npm run test:quiet -- src/main/orchestration/loop-coordinator-completion-budget.spec.ts
rtk npm run test:quiet -- src/main/orchestration/loop-pre-iteration-guard.spec.ts
```

## WS5. Incident-shaped integration and regression audit

### Task 5.1: Add a cross-contract integration spec

Prefer extending an existing Loop integration spec if it can express the whole scenario without excessive mocking; otherwise add:

- `src/main/orchestration/loop-continuity-progress-evidence.integration.spec.ts`

Use:

- a temporary parent workspace;
- at least one nested Git repository;
- a root-level untracked deliverable;
- a fake persistent Codex adapter with a stable native thread;
- real workspace observation;
- real stable-leaf ledger transitions;
- a low deterministic cost cap;
- a CRITICAL reviewer sequence.

The integration should prove behavior across the invoker/coordinator boundary, not re-test internal implementation details.

### Task 5.2: Audit all observation consumers

Search for every use of:

- `snapshotFileChangesViaGit`
- `snapshotWorkspace`
- `AttemptDeltaObserver`
- `filesChanged`
- `workspaceEffect`
- `computeWorkHash`
- `meaningfulTransition`
- `getCapWrapUp` / `setCapWrapUp`

For each consumer, document in code or tests whether:

- it needs known paths only;
- it requires complete coverage;
- partial coverage should block a decision;
- cap-active behavior changes its terminal authority.

Do not leave an array-only compatibility path that turns empty partial results back into “none observed.”

### Task 5.3: Regression-check provider and Loop lifecycle behavior

Verify:

- Claude/Gemini/other provider one-shot paths are unchanged;
- fresh-child retries still follow their existing isolation policy;
- persistent adapter registry cleanup works on normal end, error, manual stop, context reset, and model change;
- tools-disable remains scoped to the cap wrap-up call;
- no new listener leaks or duplicate output events occur;
- no session path, token, environment value, or credential appears in logs.

## WS6. Verification gates

### Task 6.1: Run targeted tests after each workstream

Use the commands listed in WS1–WS5. Do not update expectations merely to make a failure green; confirm the runtime contract first.

### Task 6.2: Run static and repository gates

```bash
rtk npx tsc --noEmit
rtk npx tsc --noEmit -p tsconfig.spec.json
rtk npm run lint
rtk npm run check:ts-max-loc
```

Resolve all new failures. Record unrelated pre-existing failures separately with exact evidence.

### Task 6.3: Run the full suite and build

```bash
rtk npm run test:quiet
rtk npm run build
```

The full suite is required because this change crosses shared adapter, orchestration, retry, and terminal paths.

### Task 6.4: Inspect the final diff and runtime wiring

```bash
rtk git diff --check
rtk git status --short
rtk git diff --stat
```

Then manually confirm:

- new modules are imported by the real runtime;
- no test-only seam is the sole caller;
- adapter termination is reachable on every Loop exit;
- cap intent is cleared on terminal cleanup;
- active spec/plan files remain untracked until closeout;
- unrelated existing changes remain untouched.

## WS7. Live validation and documentation closeout

### Task 7.1: Decide whether rebuilt-app checks remain

All behavior that can be tested with fakes, temporary repositories, or the dev app must be verified in-loop. If checks genuinely require a rebuilt/restarted packaged app or paid live Codex service, create beside this plan:

`docs/superpowers/plans/2026-07-25-loop-continuity-progress-evidence_plan_livetest.md`

Record:

- exact rebuild/restart prerequisite;
- exact workspace fixture or safe disposable test workspace;
- provider/model and settings;
- steps for two consecutive Loop turns;
- expected stable thread evidence without exposing IDs;
- expected AIO-owned history location without printing secrets;
- expected detection of a root untracked deliverable;
- a safe low-cap scenario and expected `cap-reached` status;
- how to inspect logs for absence of `no rollout found`;
- why each item could not be automated.

Do not perform a paid live-provider run unless it is within James's requested scope.

### Task 7.2: Update as-built documentation

After every agent-runnable gate passes:

1. update this plan with actual files, deviations, commands, and results;
2. update the specification with final compatibility/schema decisions;
3. if live checks remain, move them into the `_livetest.md` file and leave only a pointer here;
4. update the specification's plan link to the completed filename;
5. rename this file to `2026-07-25-loop-continuity-progress-evidence_plan_completed.md`;
6. rename the specification to `2026-07-25-loop-continuity-progress-evidence_spec_completed.md`;
7. verify the lifecycle filenames and Git status.

Do not commit or push without explicit instruction.

## Risk register

| Risk | Consequence | Mitigation |
|---|---|---|
| Non-ephemeral Codex runs before home preparation | User history pollution | Fail closed; lifecycle test asserts preparation precedes first turn |
| Request/response seam duplicates event completion | Duplicate transcript, cost, or output | One internal turn result; event and direct callers share it; listener-count tests |
| Nested repo discovery is too broad | Slow Loop startup | Shallow-first bounded traversal, canonical ignores, stop at repo root |
| Partial observation is treated as clean | Unsafe automatic replay | Type-level coverage and conservative mapping to `unknown` |
| Git and fallback report the same path differently | False repeated changes | Normalize workspace-relative paths and merge after observation |
| Ledger prose churn resets stall | Endless run | Use existing stable leaf IDs and meaningful-transition predicate only |
| Cap terminal blocks legitimate completion | Completed work shown as capped | Verified completion explicitly outranks post-wrap-up cap |
| Competing terminal branches overwrite cap | Misleading status and extra turns | Centralized precedence helper with incident-sequence test |
| Cap intent is lost on restart | Budget reopens | Persist intent or conservatively terminalize during reconciliation |
| Shared adapter change regresses other providers | Broad orchestration breakage | Keep lifecycle seam capability-based; run full suite and provider regressions |

## As-built record

Implemented the selected targeted control-plane repair:

- Persistent Loop adapters now expose an idempotent lifecycle-aware request/response seam. Persistent Codex uses `ephemeral: false`, initializes its prepared AIO-owned runtime before the first turn, serializes app-server requests, correlates one response per turn, and forwards attachments and timeout metadata. One-shot/fresh-child construction retains its prior ephemeral default.
- Workspace observation now returns structured coverage and sources, discovers bounded nested Git repositories, compares tracked/staged/untracked state including baseline-dirty restoration/deletion, and uses a shallow-first bounded filesystem fallback. Repository discovery, filesystem scanning, and Git filtering derive their directory/file exclusions from `DEFAULT_CODE_INDEX_IGNORES`. Post-merge changed paths are deterministically bounded to the existing attempt-evidence limit with an omission reason.
- Review-stall policy is a pure helper that treats meaningful stable-leaf ledger transitions as progress. Structural work hashes remain separate.
- Full cap-wrap-up intent is stored in backward-compatible optional `LoopState` data and hydrated on resume. Verified completion retains priority; otherwise active cap intent suppresses ping-pong, review, ledger, and no-progress terminals. Failed wrap-up attempts still end `cap-reached` with the failure recorded as secondary evidence.
- The incident integration now drives a persistent fake invoker through the real `LoopCoordinator` with real nested/root observation, ledger transitions, and a deterministic five-turn cap sequence.

Primary implementation additions:

- `src/main/cli/adapters/codex-app-server-request.ts`
- `src/main/orchestration/loop-attempt-observation.ts`
- `src/main/orchestration/loop-review-stall-policy.ts`
- `src/main/orchestration/loop-workspace-repositories.ts`
- structured cap intent additions in shared Loop state/types

Compatibility decisions:

- No database migration or renderer contract change was required; the optional persisted cap intent is backward-compatible.
- Existing external stop/cancel semantics remain ahead of normal completion.
- Paid provider and rebuilt-app validation was not run. It is recorded in the linked live-test plan.

Verification evidence:

- Focused regression gate: 13 files, 214 tests passed.
- `npx tsc --noEmit`: passed.
- `npx tsc --noEmit -p tsconfig.spec.json`: passed.
- `npm run lint`: passed.
- `npm run check:ts-max-loc`: passed.
- `git diff --check`: passed.
- `npm run build`: passed; existing Angular initial-bundle budget warning only.
- `npm run test:quiet`: 1,583 files, 15,721 tests passed in 569.5 seconds.
- Fresh independent `task-completion-gate`: `VERDICT: PASS`, no actionable findings.

## Completion checklist

- [x] Persistent Codex Loop turns use one real native thread in automated transport tests; paid live confirmation is deferred.
- [x] Persistent Codex state is prepared under AIO ownership; live user-history confirmation is deferred.
- [x] One-shot Codex behavior is unchanged.
- [x] Workspace observation exposes complete/partial/failed coverage.
- [x] Nested Git and root-level untracked changes are detected.
- [x] Truncated scans cannot produce `none-observed`.
- [x] Meaningful ledger transitions reset review stall.
- [x] Unchanged CRITICAL iterations still stop at the configured threshold.
- [x] Cap wrap-up terminal precedence preserves `cap-reached`.
- [x] Incident-shaped integration test passes.
- [x] Typechecks pass.
- [x] Lint passes.
- [x] TypeScript LOC check passes.
- [x] Full quiet test suite passes.
- [x] Build passes.
- [x] Required live checks are recorded in `_livetest.md`.
- [x] Specification and plan contain as-built notes before `_completed` rename.
