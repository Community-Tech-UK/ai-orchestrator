# Loop Mode — Implementation Plan (v1)

> **Status:** Completed 2026-05-08 — verified end-to-end (`tsc`, `tsc -p tsconfig.spec.json`, lint, 91 loop tests + 532 orchestration/RTK tests green).

A robust per-chat-session "Loop Mode" toggle that drives a Ralph-style iterative loop until completion or a hard cap. Spawns fresh-context children per iteration, watches aggressively for stuck loops, and verifies completion claims before stopping.

## Implementation evidence

| Plan section | Files |
|---|---|
| Progress signals A–H | `src/main/orchestration/loop-progress-detector.ts` (+ 26 unit tests) |
| Completion signals 1–6 + verify-before-stop | `src/main/orchestration/loop-completion-detector.ts` (+ unit tests, integration in `loop-coordinator.ts`) |
| Stage machine (PLAN / REVIEW / IMPLEMENT) | `src/main/orchestration/loop-stage-machine.ts` (+ 11 unit tests) |
| Coordinator state machine + events | `src/main/orchestration/loop-coordinator.ts`, `loop-coordinator-double-start.spec.ts` |
| Persistence (loop_runs, loop_iterations) | `src/main/orchestration/loop-schema.ts`, `loop-store.ts` (self-runs migrations on init) |
| IPC bridge | `src/main/ipc/handlers/loop-handlers.ts`, `packages/contracts/src/channels/loop.channels.ts`, `src/preload/domains/loop.preload.ts` |
| Renderer (store + components) | `src/renderer/app/core/state/loop.store.ts`, `src/renderer/app/features/loop/{loop-toggle,loop-control,loop-config-panel,loop-prompt-history.service}.ts` |
| Default invoker (fresh-child + same-session) | `src/main/orchestration/default-invokers.ts` (with RTK + permission hook wiring) and `default-invokers.loop.spec.ts` |
| Filesystem watcher for `*_Completed.md` rename | `src/main/orchestration/loop-attachments.ts` (+ unit tests) |
| Path aliases for `@contracts/{schemas,channels}/loop` | `tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts` |

## Decisions (locked by James)

| Decision | Choice |
|---|---|
| Default context strategy | **Fresh child per iteration** (hybrid opt-in later) |
| REVIEW stage default | **3-agent in-process debate** (Claude only) |
| Star Chamber upgrade | **Claude + Codex only** — Gemini excluded (unreliable) |
| Hard caps | **50 iterations / 8 hours / $10** |
| No-progress detection | **Aggressive — first CRITICAL signal pauses** |
| Completion detection | **Verify-before-stop** (signal alone never stops the loop) |
| Toggle location | **Chat composer footer** |
| v1 scope | **Loop only.** Snapshot-replay UI deferred to v2. |

## Two priority algorithms (the hard parts)

### A. Aggressive no-progress detection

Eight independent signals computed at the end of each iteration. Any single CRITICAL pauses the loop and surfaces a question to the user. WARNs accumulate; 3 WARNs in 5 iterations escalates to CRITICAL.

| ID | Signal | Computation | WARN threshold | CRITICAL threshold |
|---|---|---|---|---|
| **A** | Identical work hash | `sha256(sorted(fileDiffPathHashes) ‖ stage ‖ uniqueToolCallSig)` | 2 consecutive identical | 3 of last 5 identical, or 2 consecutive after iteration 3 |
| **B** | Edit churn (revert oscillation) | Per file, track edited line ranges per iteration. Churn = lines edited that revert to a prior state. | Churn ratio > 30% over 5 iterations | Churn ratio > 50%, or A→B→A line-content cycle on same file |
| **C** | Stage stagnation | Iterations spent on current `STAGE.md` value | PLAN > 3, REVIEW > 2, IMPLEMENT > 8 | PLAN > 5, REVIEW > 3, IMPLEMENT > 12 |
| **D** | Test oscillation | Pass-count delta sequence over last 5 iterations | Up-down-up-down pattern detected (variance high, mean unchanged) | Strict oscillation `[N, M, N, M, N]` with M ≠ N |
| **D'** | Test stagnation w/ writes | Pass-count unchanged for 3+ iterations AND files were modified | 3 iterations | 5 iterations |
| **E** | Error repeat | Hash of normalized error message, bucketed via existing `ChildErrorClassifier` | Same bucket 3 times in 5 iterations | Same bucket 4 times in 5, or same exact hash 3 in a row |
| **F** | Token-burn-without-progress | `tokensSpentSinceLastTestImprovement` | > 25k tokens since last improvement | > 60k tokens, or rate > 10k/iter for 3 iterations |
| **G** | Tool call repetition | Within an iteration: same `(toolName, argsHash)` seen N times | 5x in one iteration | 8x, or same set across 3 iterations |
| **H** | Output similarity | Cosine similarity of last 3 iteration outputs (sentence-transformer-style; fall back to Jaccard on tokens) | mean ≥ 0.85 | mean ≥ 0.92 across 3 iterations |

**On WARN:** annotate UI status bar (yellow), continue. Log structured signal.

**On CRITICAL:** call `LoopCoordinator.pause()`, emit `loop:paused-no-progress` with the failing signal + evidence. UI shows: "Loop paused — Signal A: identical work hash 3 of last 5 iterations. [Inject hint] [Resume anyway] [Stop]".

**Special case — pre-iteration kill switch:** before spawning iteration N, check the trailing 5 iterations. If any combination of (A, B, D, D', H) triggers, do not spawn — pause first.

### B. Robust break-out (completion) detection

Six signals are observed; **none of them stops the loop on their own.** When any fires, the coordinator runs the configured **verify command** (default `npx tsc --noEmit && npm test --silent && npm run lint`). Only if verify passes does the loop stop.

| ID | Signal | Detection |
|---|---|---|
| **1** | `*_Completed.md` rename | chokidar watcher on workspace; matches `*_[Cc]ompleted.md` |
| **2** | `<promise>DONE</promise>` marker | regex on iteration output (configurable phrase) |
| **3** | `DONE.txt` sentinel | file exists in cwd at iteration end |
| **4** | All-green gate | configured verify command exits 0 AND previous iteration was failing (transition) |
| **5** | Self-declared done | output contains "TASK COMPLETE" or similar — **auxiliary only**, never sufficient on its own |
| **6** | Plan checklist 100% | `PLAN.md` parsed for `- [x]` vs `- [ ]`; ratio = 1.0 |

**Verify-before-stop rule:**

```
on signal s:
  v1 = run verify command (fresh)
  if v1 fails:
    emit loop:claimed-done-but-failed { signal: s, failure: v1.output }
    UI: "Loop reports done via {s}, but verify failed: {summary}. [Inject hint] [Continue] [Stop anyway]"
    do NOT stop
  else:
    v2 = run verify command again (no flakiness)
    if v2 fails:
      treat as flake — log, do NOT stop, surface flake warning
    else:
      stop loop, emit loop:completed { signal: s, evidence: v2 }
```

**Aux belt-and-braces:** before final stop, also confirm the `*_Completed.md` rename actually happened. If user prefers, this can be the *only* required signal.

## Architecture overview

### Main process

```
src/main/orchestration/
├── loop-coordinator.ts          # Singleton; state machine; pause/resume/intervene/cancel/stream
├── loop-progress-detector.ts    # Signals A–H, threshold config, evidence packaging
├── loop-completion-detector.ts  # Signals 1–6 + verify-before-stop runner
├── loop-stage-machine.ts        # STAGE.md read/write, stage transitions, prompt building
└── loop-store.ts                # SQLite DAO: loop_runs, loop_iterations
```

### Shared

```
src/shared/types/loop.types.ts            # LoopConfig, LoopState, LoopIteration, LoopStage, ProgressSignal, CompletionSignal
packages/contracts/src/schemas/loop.schemas.ts  # Zod
packages/contracts/src/channels/loop.channels.ts # IPC channel constants
```

### Renderer

```
src/renderer/app/core/state/loop.store.ts                  # Signals-based store
src/renderer/app/features/chats/loop-toggle.component.ts   # Footer toggle
src/renderer/app/features/chats/loop-status-bar.component.ts  # Inline status during run
src/renderer/app/features/chats/loop-config-modal.component.ts # First-run config
src/renderer/app/features/chats/loop-summary-card.component.ts # Final summary
```

### LoopCoordinator API (mirror of DebateCoordinator)

```ts
class LoopCoordinator extends EventEmitter {
  static getInstance(): LoopCoordinator
  static _resetForTesting(): void

  startLoop(chatId: string, config: LoopConfig): Promise<string /*loopRunId*/>
  pauseLoop(loopRunId: string): boolean
  resumeLoop(loopRunId: string): boolean
  intervene(loopRunId: string, message: string): boolean
  cancelLoop(loopRunId: string): Promise<boolean>
  getLoop(loopRunId: string): LoopState | undefined
  getActiveLoops(): LoopState[]
  streamLoop(loopRunId: string): AsyncGenerator<LoopStreamEvent>

  // Events emitted (mirroring debate:* shape):
  // loop:started, loop:iteration-started, loop:iteration-complete,
  // loop:paused-no-progress, loop:claimed-done-but-failed, loop:intervention-applied,
  // loop:completed, loop:cancelled, loop:error
}
```

### Iteration lifecycle

For each iteration:

1. **Pre-flight**: check hard caps (iterations/wall-time/tokens). Run pre-iteration kill-switch from progress detector. If pause condition, halt.
2. **Stage read**: read `STAGE.md` from cwd (default `PLAN` on first iter).
3. **Spawn child** via existing `InstanceLifecycleManager` with provider per config (Claude default; Codex if Star Chamber on review stage). Fresh context.
4. **Send prompt**: composed by `LoopStageMachine` based on current stage.
5. **Stream child output** through to chat transcript (collapsible per-iteration block).
6. **On child exit**:
    - Capture: tokens used, files changed (via `session-diff-tracker`), tool-call log, test pass/fail counts (from configured test command), error classifications.
    - Compute work hash, churn delta, similarity to prior iterations.
    - Run `LoopProgressDetector.evaluate()` → WARN | CRITICAL | OK.
    - Run `LoopCompletionDetector.observe()` → list of fired signals.
    - If any completion signal fires → run verify-before-stop. On pass, stop. On fail, surface and continue.
    - Persist iteration row.
7. **Sleep guard**: 1.5s minimum between iterations to allow filesystem watcher debounce.
8. **Loop**.

### Stage machine prompt (single source of truth in `STAGE.md`)

A single prompt is sent every iteration. The agent reads `STAGE.md`, does that stage's work, and advances `STAGE.md` itself. This collapses the user's three-stage workflow into one loop with self-advancing state.

```
You are iteration {N} of a Loop Mode run on plan {planFile}.

1. Read STAGE.md to find your current stage.
2. Read PLAN.md (the canonical plan) and NOTES.md (compressed running notes).
3. Do that stage's work:
   - PLAN: continue/improve the plan. Choose the best architectural decision; do not be lazy.
   - REVIEW: re-read PLAN.md with completely fresh eyes; fix any issues.
   - IMPLEMENT: implement the next chunk of the plan. Use best architecture, no shortcuts. After implementing, re-review your code with completely fresh eyes and fix issues.
4. At the end:
   - If all of PLAN.md is implemented, verified, and passes tests: rename {planFile} → {planFile}_Completed.md and write `<promise>DONE</promise>` on its own line.
   - Else: update STAGE.md to the next stage (PLAN → REVIEW → IMPLEMENT → REVIEW → IMPLEMENT → … as appropriate).
5. Append a one-paragraph summary to NOTES.md.
```

`PLAN.md`, `STAGE.md`, `NOTES.md` are the file-system memory. The coordinator never edits them; only the agent does.

### Persistence schema

```sql
CREATE TABLE loop_runs (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL,
  plan_file TEXT NOT NULL,
  config_json TEXT NOT NULL,    -- LoopConfig
  status TEXT NOT NULL,          -- 'running','paused','completed','cancelled','error','no-progress','verify-failed'
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  total_iterations INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  total_cost_cents INTEGER NOT NULL DEFAULT 0,
  end_reason TEXT,               -- 'completion-signal-N','iteration-cap','wall-time-cap','token-cap','user-stop','no-progress-signal-X'
  end_evidence_json TEXT
);

CREATE TABLE loop_iterations (
  id TEXT PRIMARY KEY,
  loop_run_id TEXT NOT NULL REFERENCES loop_runs(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  stage TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  child_instance_id TEXT,
  tokens INTEGER,
  files_changed_json TEXT,        -- [{path, additions, deletions}]
  work_hash TEXT,
  test_pass_count INTEGER,
  test_fail_count INTEGER,
  tool_calls_json TEXT,
  output_excerpt TEXT,            -- first/last 2KB
  output_similarity_to_prev REAL,
  progress_verdict TEXT,          -- 'OK','WARN','CRITICAL'
  progress_signals_json TEXT,
  completion_signals_fired_json TEXT,
  verify_status TEXT,             -- 'not-run','passed','failed'
  verify_output_excerpt TEXT
);

CREATE INDEX idx_loop_iterations_run ON loop_iterations(loop_run_id, seq);
CREATE INDEX idx_loop_runs_chat ON loop_runs(chat_id, started_at);
```

### IPC channels

```ts
export const LOOP_CHANNELS = {
  LOOP_START: 'loop:start',
  LOOP_PAUSE: 'loop:pause',
  LOOP_RESUME: 'loop:resume',
  LOOP_INTERVENE: 'loop:intervene',
  LOOP_CANCEL: 'loop:cancel',
  LOOP_GET_STATE: 'loop:get-state',
  LOOP_LIST_RUNS_FOR_CHAT: 'loop:list-runs-for-chat',
  LOOP_GET_ITERATIONS: 'loop:get-iterations',

  LOOP_STARTED: 'loop:started',
  LOOP_ITERATION_STARTED: 'loop:iteration-started',
  LOOP_ITERATION_COMPLETE: 'loop:iteration-complete',
  LOOP_PAUSED_NO_PROGRESS: 'loop:paused-no-progress',
  LOOP_CLAIMED_DONE_BUT_FAILED: 'loop:claimed-done-but-failed',
  LOOP_COMPLETED: 'loop:completed',
  LOOP_CANCELLED: 'loop:cancelled',
  LOOP_ERROR: 'loop:error',
} as const;
```

### UI surface

**Footer toggle (`LoopToggleComponent`)** — pill button next to model selector in `InputPanelComponent`. Off by default. Click → opens config modal first time, or starts/stops if already configured.

**Inline status bar** — appears above transcript when active:

```
[Loop] iter 7/50 · stage REVIEW · 4m12s/8h · 12.4k tok / $0.31 · [Pause] [Inject hint] [Stop]
```

Yellow border when WARN signals accumulating. Red border on CRITICAL pause.

**Final summary card** — replaces status bar on stop:

```
Loop ended (completed | no-progress | verify-failed | cap | user)
8 iterations · 14m · 22k tokens · $0.42
Files changed: 6  Tests: 18 → 24 passing
End reason: signal #1 (_Completed.md rename) verified
[Open transcript filter] [Restart with same config]
```

## Robustness layers (recap)

| Layer | Mechanism |
|---|---|
| L1 hard caps | iterations 50, wall 8h, tokens-cost $10, per-iter tool-call cap |
| L2 smart caps | progress detector signals A–H |
| L3 completion | signals 1–6 + verify-before-stop |
| L4 safety | existing ResourceGovernor + per-tool permission profile (deny destructive ops without explicit allow in config) |
| L5 observability | iteration log table, structured signals, HUD card |
| L6 recovery | per-iter checkpoint via existing CheckpointManager; on app restart, paused loops are restored, completed/errored loops are sealed |

## Out of scope for v1

- Snapshot-replay UI (branch-and-retry from iteration N)
- Cross-LLM Star Chamber UI configuration (data model is in place; UI is a single Codex-only toggle in v1)
- Hybrid context strategy UI (always fresh-child in v1; hybrid is a config flag we won't expose yet)
- Plan-file picker (v1 uses the active plan file the chat is already editing, or a free-form prompt)
- Multi-loop-per-chat (one active loop per chat in v1)

## Implementation order (matches TodoWrite list)

1. Phase 1 — Types & Schemas
2. Phase 2 — LoopCoordinator + LoopProgressDetector + LoopCompletionDetector
3. Phase 3 — Persistence (SQLite + DAO + restart recovery)
4. Phase 4 — IPC handlers + preload bridge
5. Phase 5 — Renderer (store + 4 components)
6. Phase 6 — Integration in `src/main/index.ts`, LLM invokers, fs watcher
7. Phase 7 — Tests
8. Phase 8 — Verification: tsc, tsc -p tsconfig.spec.json, lint, test, manual smoke test

## Verification gates per phase

- After every file write: `npx tsc --noEmit` (fast, narrow)
- After each phase: full `npx tsc --noEmit -p tsconfig.spec.json && npm run lint`
- After Phase 7: `npm run test` (full)
- After Phase 8: manual smoke — toggle loop on a tiny throwaway plan, watch it run to `_Completed`

## Packaging gotcha checklist

`@contracts/schemas/loop` is a new subpath. Per `CLAUDE.md`, sync these four:
1. `tsconfig.json` paths
2. `tsconfig.electron.json` paths
3. `src/main/register-aliases.ts` `exactAliases`
4. `vitest.config.ts` if used in tests
