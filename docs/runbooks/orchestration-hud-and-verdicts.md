# Orchestration HUD And Verdicts Runbook

Use this runbook to interpret parent-session orchestration status and verification verdicts.

## HUD Layout

The HUD appears on parent sessions and summarizes the child tree. Counts should match the agent tree state: active, waiting, failed, stale, and idle.

## Child State Badges

- `active`: child is currently working.
- `waiting`: child is blocked on input or dependency.
- `failed`: child failed or exhausted retries.
- `stale`: child has not reported recent progress.
- `idle`: child is available but not actively running a turn.

## Churn And Heartbeat

Churn count and turn count help distinguish healthy activity from repeated respawns or loops. Heartbeat timestamps should advance for active children; stale badges indicate the heartbeat is no longer fresh.

## Quick Actions

Quick actions include focusing a child, copying the spawn prompt hash, opening the diagnostic bundle, and summarizing children. Copy hash must route through `ClipboardService`, not direct browser clipboard calls.

## Verification Verdicts

Verdict statuses are pass, pass-with-notes, needs-changes, blocked, and inconclusive. Read confidence, required actions, risk areas, and evidence together; a high-confidence `needs-changes` verdict still requires follow-up.

## Raw Responses

Raw responses remain attached to verdict payloads for audit. If a rendered panel looks truncated, fetch the underlying verification result before assuming the source evidence was dropped.

## Loop Mode — Lifecycle, Completion Gate, And Context Discipline (loopfixex)

### Lifecycle statuses (`LoopStatus`)

Live: `running`, `paused`. Terminal: `completed`, `completed-needs-review`,
`cancelled`, `failed`, `error`, `no-progress`, `cap-reached`. The dead values
`idle` and `verify-failed` were removed (the coordinator never emitted them).

- **`completed-needs-review` (LF-7)** is a *successful* terminal state: "work is
  done and was accepted, but a human should glance at it." It is reached when an
  operator accepts a manual-review loop, or when verify kept passing but the
  `*_Completed.md` rename gate never cleared within `caps.maxCompletionAttempts`.
  It is NOT a failure — distinct from `cap-reached` (stopped without converging).
- Every `LoopStatus` resolves to a non-empty label (`loopStatusLabel`); terminal
  ones also resolve via `terminalStatusLabel`. A contract test asserts this.

### Status pill, verdict chip, and pause kinds (LF-8)

The active strip shows an always-on **status pill** (RUNNING / NEEDS REVIEW /
PAUSED · NO PROGRESS / BLOCKED / DONE / STOPPED) and a **verdict chip**
(OK/WARN/CRITICAL from the latest iteration). Paused loops are disambiguated:

- **awaiting-review** — no verify command; the loop thinks it's done and waits
  for an operator. Action: **Accept as complete** (or Configure verify / Stop).
- **no-progress** — structural CRITICAL. Action: Hint / Resume / Stop.
- **blocked** — `BLOCKED.md` / block intent. Action: address the block.

### Operator accept-completion (LF-7)

`acceptCompletion(loopRunId)` (channel `loop:accept-completion`, store
`acceptCompletion`, UI "Accept as complete") is valid only when the loop is
`paused` and either `manualReviewOnly` or a pending `complete` terminal intent.
If a verify command exists it runs once (pass → `completed`, fail → stays
paused with `lastCompletionOutcome='verify-failed'`); with no verify command it
lands `completed-needs-review`. Emits `loop:completed` (`acceptedByOperator:true`)
or `loop:completed-needs-review`.

### Completion-gate stepper (LF-8)

`declared → verify → rename → review → stop`, with the blocked step highlighted.
Derived from `lastIteration.verifyStatus`, `completedFileRenameObserved`,
`requireCompletedFileRename`, `manualReviewOnly`, `crossModelReview.enabled`, and
`lastCompletionOutcome` (`accepted` / `verify-failed` / `unverifiable` /
`rename-gate` / `review-blocked`). It answers "the loop says it's done — what is
it waiting on?".

### Completion-attempt budget (LF-7)

`caps.maxCompletionAttempts` (default 3) bounds the "declare done → rename gate
rejects → re-declare" oscillation. When verify passes but the rename gate keeps
blocking, the loop terminates `completed-needs-review` (verify is green, so the
code is in a good state) rather than spinning to `maxIterations`. A verified-done
iteration never falls through to a no-progress pause.

### Structured task ledger (LF-4)

`LOOP_TASKS.md` is the per-item source of truth for stopping: while it has open
items (`[ ]`/`[~]`) no completion signal is sufficient (a premature `DONE.txt`
can't stop a half-done run); once every item is `[x]` (done) or `[-]` (deferred,
with a reason) the `ledger-complete` signal stops the loop (subject to verify).
A ledger already resolved at start is ignored (staleness guard).

**RPI behaviours (LF-4):** on a `PLAN`→`IMPLEMENT` stage transition the loop
recycles its same-session context (when context discipline is enabled) so the
first IMPLEMENT iteration starts fresh on the finalized plan. With
`plan.regenerateOnStall` enabled, repeated stalls inject a "throw out the plan
and regenerate it from the goal" directive instead of pausing — bounded by
`LOOP_MAX_PLAN_REGENERATIONS` (after the cap the loop pauses normally). Emits
`loop:plan-regenerated`.

### Context discipline + hygiene (LF-1 / LF-3)

- **Context recycle (LF-1):** for `same-session` loops the coordinator recycles
  its own persistent adapter to a fresh session once context utilization crosses
  `context.compaction.resetAtUtilization` (default 0.6), re-anchoring from disk
  state. Emits `loop:context-compacted` + an ITERATION_LOG note. Borrowed
  instance adapters are never recycled. `fresh-child` stays the lowest-rot option.
- **Tool-result clearing (LF-1, `context.compaction.clearToolResults`):** an
  oversized full iteration response (>50KB) is offloaded to the shared output
  cache and replaced with a compact head+tail preview before the loop retains
  it — bounding peak memory on chatty iterations (test-counts/errors are parsed
  from the full text first; the appended DONE marker survives in the tail).
- **Cost cap (LF-3):** `caps.maxCostCents` defaults to `1000` ($10). A non-null
  cap is required for operator-reviewed completion and branch-and-select.
- **NOTES.md curation (LF-3):** bounded on long runs; the `## Completion
  Inventory` section is preserved verbatim. Emits `loop:notes-curated`.

### Semantic progress, branch-select, memory (LF-2 / LF-5 / LF-6)

- **Semantic progress (LF-2, opt-in):** a cadence-gated, two-check-confirmed
  model verdict that can upgrade a WARN→CRITICAL (confirmed no-progress) or
  soften a churn-only CRITICAL→WARN (confirmed progress). Never a sole authority.
  Emits `loop:semantic-progress`.
- **Branch-and-select (LF-5, opt-in, default off, requires cost cap):** on a
  CRITICAL that would pause, fan out `exploration.fanout` candidates in isolated
  git worktrees (one CLI turn each, optionally cross-model), run verify in each,
  pick the best (verify-pass + list-wise LLM comparison), merge the winner back
  and discard the losers. Wired in `registerDefaultLoopInvoker` via the
  `WorktreeManager` + the CLI invocation pipeline; emits `loop:branch-select`.
  (If the runtime is unavailable the selector degrades to a normal pause.)
- **Cross-loop memory (LF-6):** terminal/CRITICAL learnings are recorded per
  workspace and surfaced into the next run's prompt as non-binding "Prior
  Observations". Persisted durably (survives app restart) to a JSON file under
  `userData` (`DurableLoopMemoryStore`), with a best-effort mirror into the
  EpisodicStore; wired in `registerDefaultLoopInvoker`.

## Wave 7 Evidence

- Screenshot: `screenshots/wave-7/dashboard-orchestration-dark.png`.
- Screenshot: `screenshots/wave-7/verification-results-dark.png`.
- Assertions: `screenshots/wave-7/smoke-evidence.json` records the HUD present, verification verdict present, and zero browser exceptions.
- Specs: child diagnostics, quick-action dispatcher, verdict derivation, verdict IPC round-trip, and verification results component tests cover the underlying behavior.
