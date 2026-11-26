# Loop Continuity and Progress Evidence Reliability Specification

**Date:** 2026-07-25

**Status:** Completed. Implemented and verified, with paid/rebuilt-app checks deferred.

**Implementation plan:** [2026-07-25-loop-continuity-progress-evidence_plan_completed.md](../plans/2026-07-25-loop-continuity-progress-evidence_plan_completed.md)

**Deferred live validation:** [2026-07-25-loop-continuity-progress-evidence_plan_livetest.md](../plans/2026-07-25-loop-continuity-progress-evidence_plan_livetest.md)

**Incident run:** `loop-1784996690913-2bbaa1b4`

## 1. Executive summary

The incident was not one runaway model failure. Four independent control-plane defects reinforced each other:

1. Loop Mode advertised same-session Codex continuity while creating ephemeral exec sessions that could not be resumed.
2. Workspace observation reported “no changes” after inspecting only a truncated subset of a multi-repository workspace.
3. Review-stall accounting ignored meaningful task-ledger transitions, even though the ledger showed steady progress.
4. A review-stall terminal decision overwrote the cost-cap wrap-up decision that had already been activated.

The result was a five-iteration run that spent 14,090,090 tokens and approximately $35.85, lost native Codex context four times, made real checklist progress from 20 to 10 open tasks, but was recorded as stalled and left the actual deliverable (`codex_todo.md`) unobserved.

The fix must make continuity, observation, progress, and terminal decisions truthful as one coherent contract. A narrow `ephemeral: false` change is explicitly insufficient because the existing Loop invocation path bypasses Codex's prepared AIO-owned runtime and could persist session state in the user's normal Codex home.

## 2. Goals

1. Preserve a real Codex thread across Loop iterations when same-session mode is selected.
2. Keep Loop-owned Codex thread state in the AIO-managed Codex home, not the user's ordinary `~/.codex` history.
3. Report workspace effects with explicit coverage: complete, partial, or failed.
4. Detect root-level and nested-repository untracked changes in large multi-repository workspaces.
5. Treat a meaningful task-ledger transition as progress for review-stall accounting.
6. Preserve the original cap terminal reason after a cap wrap-up iteration.
7. Reproduce the incident shape in automated tests so these failures cannot silently return.
8. Keep provider behavior and existing retry safety conservative when evidence is incomplete.

## 3. Non-goals

1. Rewriting `LoopCoordinator` as a new workflow engine.
2. Replacing the stable leaf-task ledger or verification-authority model.
3. Making every CLI provider use Codex app-server semantics.
4. Treating internal `.aio-loop-state` writes as production progress.
5. Raising configured cost limits or weakening cap enforcement.
6. Retrofitting one parent workspace into a synthetic Git repository.
7. Solving unrelated provider pricing accuracy or historical usage display issues.

## 4. Evidence from the incident

### 4.1 Run progression

| Iteration | Tokens | Open ledger tasks | Observed file changes |
|---|---:|---:|---|
| 0 | 3,801,897 | 20 | 0 |
| 1 | 1,367,615 | 18 | 0 |
| 2 | 2,221,618 | 14 | 0 |
| 3 | 6,498,792 | 10 | 0 |
| 4, cap wrap-up | 200,168 | 10 | 0 |

The ledger changed meaningfully on three successive iterations. The review-stall counter nevertheless reached its limit because its policy looked only at review severity, production-file observations, and clean-review convergence.

### 4.2 Codex continuity failure

`createPersistentLoopAdapter()` omits `ephemeral`. The adapter factory defaults Codex to `ephemeral: true`. The first direct `sendMessage()` therefore executes `codex exec --ephemeral`, captures the returned thread ID, and marks it resumable. The next turn executes `codex exec resume <thread-id>`, but no rollout exists for an ephemeral thread.

Four app-log entries show the resulting `no rollout found` failures, each followed by the adapter's fresh-session recovery path. Recovery kept the run alive but discarded the native conversational context every time.

### 4.3 Workspace observation failure

The workspace was `/Users/suas/work/orchestrat0r`, which contains nested repositories but is not itself a Git repository. The Git delta observer therefore returned no authoritative result.

The fallback filesystem snapshot stops at 5,000 entries and traverses depth-first. A direct reproduction filled the snapshot before it reached the root-level `codex_todo.md`; the snapshot API did not expose truncation. The caller consequently converted incomplete coverage into `filesChanged: []` and `workspaceEffect: none-observed`.

The work hash then repeated because it was computed from the same stage, empty file list, and empty tool-call list.

### 4.4 Terminal reason overwrite

The cost cap was detected between iterations and a tools-disabled wrap-up was allowed. After that turn, review-stall evaluation ran before the next pre-iteration guard and terminated the run as stalled. The cap context recorded only the cap kind and did not protect the original cap terminal decision from competing terminal branches.

## 5. Design decision

### 5.1 Considered approaches

#### A. Minimal incident patch

- Set `ephemeral: false`.
- Reset review stall on ledger progress.
- Check the cap before review stall.

This is rejected. It repairs two symptoms but leaves workspace evidence dishonest. More seriously, direct Codex exec persistence can write into the user's ordinary Codex history because the Loop invocation did not initialize the AIO-managed Codex runtime.

#### B. Targeted control-plane repair

- Give persistent Loop adapters a lifecycle-aware, request/response turn seam.
- Require Codex to initialize its prepared AIO-owned runtime before the first persistent turn.
- Make workspace observers return changes and coverage.
- Use nested Git repositories where available and a fair, truncation-aware fallback elsewhere.
- Centralize review-stall and cap precedence decisions in small pure policy functions.

This is the selected approach. It keeps the existing coordinator and ledger architecture while repairing the contracts that were false.

#### C. Loop state-machine rewrite

Replace the coordinator's distributed counters and terminal branches with a new persisted state machine.

This is rejected for this incident. It would enlarge the regression surface, delay a safety fix, and duplicate working ledger and cap machinery.

## 6. Required behavior

### 6.1 Persistent adapter lifecycle

The orchestration invoker must distinguish:

- an owned one-shot adapter, which may use provider-appropriate ephemeral behavior and is cleaned up after one request;
- a persistent Loop adapter, which is initialized once, owns a provider runtime across turns, and is terminated only when the Loop session is recycled or ends.

A persistent adapter turn must not call a transport-specific method that bypasses adapter initialization. The common invocation seam must:

1. initialize the adapter exactly once;
2. await one complete response for each turn;
3. route through the adapter's active transport;
4. preserve existing activity, timeout, tool-disable, and cleanup behavior;
5. avoid duplicate response and transcript events.

For Codex persistent Loop sessions:

- `ephemeral` must be false;
- initialization must prepare the AIO-managed Codex home;
- the selected runtime may be app-server or its supported fallback, but its native state must remain in AIO-owned storage;
- a second Loop turn must continue the first native thread;
- `no rollout found` must not be treated as expected steady-state behavior;
- an actual stale/lost thread may still use the existing bounded recovery policy;
- context recycle must terminate the old runtime before constructing its replacement.

Fresh-child and deliberately one-shot orchestration calls retain their existing ephemeral defaults unless their own contract says otherwise.

### 6.2 Workspace observation coverage

Workspace delta APIs must return a result equivalent to:

```ts
interface WorkspaceDeltaObservation {
  changes: LoopFileChange[];
  coverage: 'complete' | 'partial' | 'failed';
  sources: Array<'workspace-git' | 'nested-git' | 'filesystem'>;
  reason?: string;
}
```

The exact names may follow local conventions, but callers must be able to distinguish “observed no writes everywhere” from “found no writes in the portion inspected.”

Rules:

1. `none-observed` is legal only when observation coverage is complete.
2. Partial or failed coverage with no known write maps to `workspaceEffect: unknown`.
3. Known writes remain `writes-observed` even if coverage is partial; the reason records the limitation.
4. Known changed paths are retained in attempt evidence and child results within existing bounds.
5. Automatic degraded replay remains allowed only for complete, zero-change observations.

### 6.3 Multi-repository workspaces

For a workspace that is not itself a Git repository, observation must discover bounded nested Git roots and compare each repository's pre/post state.

The Git observation must cover:

- tracked working-tree changes;
- staged changes;
- added and deleted files;
- untracked files, including files already untracked before the iteration whose content changes during it.

Repository discovery must be bounded, ignore known generated/vendor directories, and avoid descending into a discovered repository after registering that root.

Paths returned to Loop Mode must be normalized relative to the selected workspace and must identify their repository prefix.

### 6.4 Filesystem fallback

The fallback scanner must:

- return whether it hit its entry or traversal bound;
- avoid depth-first starvation of root-level siblings;
- prioritize shallow paths before deep trees;
- use existing ignore policy for generated, dependency, scratch, and loop-state paths;
- never describe a truncated scan as complete.

The fallback is for non-Git path space and observer degradation. It is not a substitute for authoritative Git observation inside discovered repositories.

### 6.5 Progress policy

Structural work hashes and semantic ledger progress have different meanings and remain separate:

- the work hash describes observed production/tool activity;
- `ledgerMeaningfulTransition` describes durable movement in stable leaf tasks.

The review-driven stall policy must consume both. A meaningful ledger transition resets the consecutive review-stall count even when no production file delta was observed. A repeated CRITICAL review with no production change, no meaningful ledger transition, and no clean-review convergence must still increment and eventually stop.

Changing only prose, timestamps, task ordering, or unstable task identifiers must not count as a meaningful ledger transition.

### 6.6 Cap wrap-up precedence

Activating cap wrap-up creates a pending terminal intent containing at least:

- cap kind;
- original human-readable trigger reason;
- triggering iteration and measured value;
- the fact that the one allowed wrap-up turn is in progress or has completed.

After the wrap-up turn:

- verified completion may end as completed if all normal completion authority requirements are satisfied;
- otherwise the run ends as `cap-reached` using the original cap reason;
- review stall, ledger stall, repeated work hash, planner regeneration, and other no-progress terminals may be recorded as secondary evidence but cannot replace the cap terminal status;
- no new work iteration may start.

The terminal decision and emitted end evidence must agree.

### 6.7 Restart behavior

The implementation must explicitly decide whether an active cap wrap-up can survive process restart. If Loop continuation already persists enough state to resume the same run, the pending cap terminal intent must be persisted with it. If the current architecture cannot safely resume an in-flight iteration, restart reconciliation must terminalize conservatively as `cap-reached`, not reopen the work budget.

## 7. Failure behavior

1. Failure to prepare the persistent Codex runtime fails or degrades the iteration explicitly; it must not silently fall back to an unisolated user home.
2. Failure of one nested Git observer produces partial coverage and names the affected repository without discarding changes found elsewhere.
3. A truncated fallback scan produces partial coverage.
4. Partial observation prevents automatic replay when a failed/degraded attempt may have written.
5. A genuinely lost Codex thread uses the existing bounded recovery path and records the continuity loss.
6. A cap wrap-up transport failure still terminates under the cap intent, with the transport failure attached as evidence.

## 8. Observability

Add structured logs or existing activity events for:

- persistent adapter initialization mode and whether storage is AIO-managed, without printing secret paths or environment values;
- native thread continuation versus genuine thread recovery;
- workspace observer source counts, changed-path count, and coverage;
- snapshot truncation and nested-repository discovery failures;
- review-stall counter reset reason;
- terminal precedence selection and suppressed secondary terminal candidates.

No credentials, injected socket values, or secret environment values may be logged.

## 9. Acceptance criteria

1. Two persistent Codex Loop turns use the same native thread without a resume fallback.
2. The persistent thread is stored under the AIO-managed Codex state, not normal user history.
3. One-shot Codex calls retain their intentional ephemeral behavior.
4. A root-level untracked file is detected in a workspace containing more than 5,000 earlier traversal entries.
5. A changed file inside a nested Git repository is reported relative to the parent workspace.
6. An untracked file that existed before the iteration and changed during it is detected.
7. A truncated scan with no detected change produces `workspaceEffect: unknown`, never `none-observed`.
8. A known write plus partial coverage remains `writes-observed`.
9. Ledger transitions equivalent to 20→18→14→10 open tasks do not trigger the three-iteration review stall.
10. Three unchanged CRITICAL iterations still trigger review stall when no cap is active.
11. A cost-cap wrap-up followed by a CRITICAL review ends as `cap-reached`, preserving the cost-cap reason.
12. A cap wrap-up that satisfies verified completion may end as completed.
13. The incident-shaped integration test exercises continuity, nested/untracked observation, ledger progress, and cap precedence together.
14. TypeScript checks, lint, LOC policy, full quiet tests, and build pass.

## 10. Rollout and compatibility

No database migration or renderer contract change is expected unless implementation investigation proves cap intent must be added to persisted Loop state. Any schema change must be backward-compatible with existing runs and validated through the shared Zod/schema layer.

The change should ship behind existing Loop Mode and provider capability decisions, not a new user-facing flag. Logs provide the first-line rollout signal. The implementation must not weaken retries, verification authority, or cost caps for other providers.

## 11. Documentation lifecycle

This specification and its linked plan remain untracked and uncommitted while implementation is active. After all agent-runnable checks pass, any checks requiring a rebuilt application are moved to a linked `_livetest.md` document. Only after implementation and permitted verification are complete may the plan and specification be updated with as-built notes and renamed `_completed`.

## 12. As-built decisions

- The lifecycle seam is implemented on the base CLI adapter and specialized by Codex app-server. Persistent requests are initialized once and serialized; app-server response capture is correlated within that serialization boundary.
- Codex persistent Loop construction explicitly uses non-ephemeral state only after its AIO-managed home/runtime preparation. One-shot and fresh-child behavior remains unchanged.
- Observation coverage is an internal required contract. Complete empty observation maps to `none-observed`; partial/failed empty observation maps to `unknown`; any known write maps to `writes-observed`.
- Nested-repository discovery and filesystem traversal are shallow-first and bounded. Their ignore rules derive from the canonical code-index policy with Loop-specific platform build additions.
- Git comparison uses the union of baseline and current dirty/untracked paths, so restoring a baseline-dirty tracked file or deleting a baseline-untracked file is still observed.
- Merged observation paths are sorted and capped only after all sources are combined. Omitted paths are disclosed in the observation reason.
- Meaningful stable-leaf ledger transitions reset review stall without changing the structural work hash.
- Cap intent is persisted as optional backward-compatible Loop state. Verified completion wins; otherwise cap status/reason wins over review, ledger, ping-pong, and no-progress terminals. A failed wrap-up records secondary failure evidence and still terminates under the cap.
- No database migration or renderer schema change was necessary.
- Automated verification passed, including the incident-shaped coordinator integration and the full 15,721-test suite. The fresh independent completion gate returned `VERDICT: PASS`.
- Live provider/history/UI checks remain in the linked `_livetest.md` plan because they require paid Codex calls and a rebuilt/restarted application.
