# Loop execution-cwd discipline + reviewer budget — implementation plan

Status: COMPLETED 2026-09-20. No live check is deferred — every phase is verified in-loop by
`loop-cwd.spec.ts` and the coordinator integration specs.
Created: 2026-09-03
Owner: agent session (James)

## Why

Investigation on 2026-09-03 found that **no loop has reached a clean `completed`
status since 2026-06-30** (0 of 35 runs across July/August/September; 14/32 in
May, 8/65 in June). Root cause, verified against `loop-mode.db` and the running
loop `loop-1788424058473-d5dc4480`:

1. The completion gate runs the verify command in `config.workspaceCwd` (the
   repo root) instead of `config.executionCwd` (the per-run worktree the agent
   actually edits). Under `isolateLoopWorkspaces: true` those are always
   different, by design (`loop-coordinator.ts:848-851`).
   Consequence: the gate grades **other sessions' uncommitted work**. The live
   loop recorded `verify_status = failed` at iterations 3, 5 and 7 — the exact
   three iterations where the ping-pong reviewer returned `APPROVED` — with a
   `TS2345 includeSessionReplay` error that exists only in the repo root's dirty
   tree and does not exist at all in the loop's worktree. Reproduced live.
2. The agentic ping-pong reviewer is given `crossModelReview.timeoutSeconds`
   (shipped default **90 s**, `loop.types.ts:339`) as its whole wall-clock
   budget, so `DEFAULT_REVIEWER_TIMEOUT_MS = 15 min` is unreachable dead code.
   ~48% of reviewer rounds die as `fault: "timeout"`.
3. Reviewer-backed loops pointed at a non-git directory get an empty diff and
   silently rubber-stamped reviews (warned 8×, never blocked).

The fix must be architectural: the two directories have genuinely different
meanings and the choice is currently made ad hoc at ~90 call sites.

## The invariant

A loop has two directories and they are not interchangeable:

- **state cwd** (`workspaceCwd`) — durable loop-owned state that must survive the
  worktree being reaped: `.aio-loop-state/`, `.aio-loop-control/`, attachments,
  `BLOCKED.md`, learnings, worktree lifecycle bookkeeping (`repoRoot`).
- **execution cwd** (`executionCwd ?? workspaceCwd`) — where the agent works.
  Anything that **inspects or executes the agent's work product** belongs here:
  verify/quick-verify, reviewers, diffs, plan-file rename detection, workspace
  liveness probes.

Getting it wrong in the state direction leaks state into a reaped worktree.
Getting it wrong in the execution direction grades the wrong code.

## Phases

### Phase 1 — one named home for the decision
- New `src/main/orchestration/loop-cwd.ts` exporting `loopExecutionCwd(config)`
  and `loopStateCwd(config)` with the invariant documented at the top.
- `effectiveLoopRepoCwd` in `loop-audit-runtime.ts` becomes a re-export so the
  preflight (already correct) and the new call sites share one implementation.

### Phase 2 — fix at the sink, not the call site
- `LoopCompletionDetector.runVerify` / `runQuickVerify` resolve the cwd
  internally via `loopExecutionCwd(config)`. No caller can get it wrong again.
  (`loop-completion-detector.ts:667`, `:694`)
- Plan-rename detection (`detectConfiguredPlanCompletedRename`, `:804`) and the
  configured-plan-file read (`:553`) resolve against the execution cwd — a plan
  renamed in the worktree is currently invisible to `requireCompletedFileRename`.
- `completedPlanFileCandidates` / `isCompletedRenameForPlan` take the resolved
  root from their caller rather than reading `workspaceCwd` themselves.

### Phase 3 — fix the review surfaces
- `loop-coordinator-completion-gates.ts:456` — fresh-eyes reviewer gets `diffCwd`
  (matching ping-pong at `loop-pingpong-completion.ts:357`).
- `loop-coordinator-completion-gates.ts:207` and
  `loop-pingpong-completion.ts:267` — clean-review classifier gets the execution
  cwd, not the repo root.
- `loop-coordinator-block-utils.ts` workspace liveness probe runs in the
  execution cwd.

### Phase 4 — give the agentic reviewer its own budget
- Add `LoopPingPongConfig.reviewerTimeoutSeconds` (optional) + zod schema.
- `loop-pingpong-completion.ts:343` reads it, defaulting to
  `DEFAULT_REVIEWER_TIMEOUT_MS` (15 min) and no longer falling back to
  `crossModelReview.timeoutSeconds`. Clamp to a sane range.
- Back-compat: existing persisted configs have no field → they get 15 min.

### Phase 5 — refuse to start a blind reviewer-backed loop
- Promote `nonGitReviewWorkspaceWarning` to a hard start-time failure for
  reviewer-backed loops, with an actionable message that names a git repository
  found in an immediate subdirectory when there is exactly one.

### Phase 6 — raise the context reset threshold
- `resetAtUtilization` default 0.6 → 0.85. At 0.6 the live loop recycled its
  session at iterations 6 and 9 and re-derived its inventory from scratch, which
  is what the "Repeating the same work" STUCK signal was reporting.

### Phase 7 — ratchet
- `scripts/check-loop-cwd-discipline.js`: fails when a file under
  `src/main/orchestration/` reads `config.workspaceCwd` / `state.config.workspaceCwd`
  outside the allowlist in `loop-cwd.ts`. Wired into `npm run verify:architecture`.
- Regression tests that would have caught the original defect: assert the spawn
  cwd of verify/quick-verify under isolation, and the reviewer cwd.

## Verification

Targeted specs per phase, then the canonical gate:
`npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`,
`npm run check:ts-max-loc`, `npm run build:main`, `npm run test:quiet`.

Note: the repo root working tree is currently red (another session's in-flight
`includeSessionReplay` edit in `loop-iteration-prompt.ts`). Gates that typecheck
the whole root tree will report that pre-existing failure; it is not caused by
this work and must be reported, not "fixed" by this session.

## As-built notes

### Phase 1 — one named home
- New `src/main/orchestration/loop-cwd.ts`: `loopExecutionCwd`, `loopStateCwd`,
  `isLoopWorkspaceIsolated`, `configForLoopExecutionCwd`, with the invariant and
  the incident documented at the top.
- `effectiveLoopRepoCwd` (`loop-audit-runtime.ts`) is now a deprecated re-export
  of `loopExecutionCwd`; `configForEffectiveRepoCwd` delegates to
  `configForLoopExecutionCwd`. One implementation, several names retired.

### Phase 2 — fixed at the sink
- `runVerify` / `runQuickVerify` resolve via `loopExecutionCwd(config)` inside
  the detector, so no caller can pass the wrong directory. `spawnVerify`'s
  parameter renamed `workspaceCwd` → `executionCwd`.
- Plan-checklist read and `detectConfiguredPlanCompletedRename` resolve against
  the execution cwd; `completedPlanFileCandidates` / `isCompletedRenameForPlan`
  take `executionCwd` in their `Pick<>` and resolve it themselves. This also
  fixes `requireCompletedFileRename`, which could never see a rename performed
  inside a worktree.

### Phase 3 — review surfaces
- Fresh-eyes reviewer now receives `diffCwd` (was the repo root) — it previously
  inspected a different tree than the diff it was reviewing.
- Clean-review classifier receives the execution cwd in both the fresh-eyes gate
  and the ping-pong gate.
- Post-compaction workspace liveness probe runs in the execution cwd.
- Inline `executionCwd ?? workspaceCwd` fallbacks in `default-invokers.ts` (×4),
  `loop-commit-ratchet.ts`, `loop-verification-run-ledger.ts` and
  `loop-coordinator-state-helpers.ts` all replaced with `loopExecutionCwd`. The
  ledger previously recorded the execution cwd for a command that had actually
  run in the repo root.

### Phase 4 — reviewer budget
- `LoopPingPongConfig.reviewerTimeoutSeconds` (+ zod schema, min 60 / max 3600),
  `PINGPONG_DEFAULT_REVIEWER_TIMEOUT_SECONDS = 900`, and
  `clampPingPongReviewerTimeoutSeconds`. Absent ⇒ 900, so configs persisted
  before this field get the safe value rather than the old 90 s.
- `loop-pingpong-completion.ts` no longer reads `crossModelReview.timeoutSeconds`;
  the unreachable `DEFAULT_REVIEWER_TIMEOUT_MS` constant is gone.
- The renderer's loop config panel deliberately does not set the field, so the
  default stays in one place.

### Phase 5 — blind reviewer refusal
- `blindReviewerWorkspaceStartError` in `loop-coordinator-state-helpers.ts`,
  thrown from `startLoop` before any side effect (worktree, store row, state
  files). Names a git repository found directly below the workspace when there
  is exactly one.
- **Self-caught defect during review:** the first implementation gated on
  `existsSync('.git')`. That is not the question `collectWorkspaceDiff` asks —
  it runs `git rev-parse --is-inside-work-tree`. A *subdirectory* of a
  repository has no `.git` of its own but diffs perfectly well, so the guard
  would have refused legitimate workspaces. Extracted
  `isDiffCapableWorkspace()` in `loop-diff.ts` as the single predicate,
  `collectWorkspaceDiff` now calls it too, and the guard takes it as an
  injectable dependency. Regression test added for the subdirectory case.
- Four coordinator specs now `git init --quiet` their tmp workspace, which makes
  those fixtures represent the repo-backed loops they were always simulating.
  (An empty `.git` directory is not enough once the predicate asks git.)

### Phase 6 — context reset
- `resetAtUtilization` default 0.6 → 0.85; the duplicated `?? 0.6` fallback in
  `loop-context-survival.ts` now reads the shared default.
- `loop-context-survival.spec.ts` pins its own threshold rather than inheriting
  the default, since that test is about tier composition, not the default value.

### Phase 7 — ratchet
- `scripts/check-loop-cwd-discipline.js`, wired into `npm run verify:architecture`.
  Two narrow rules: no re-implementing the fallback outside `loop-cwd.ts`, and no
  `cwd:`/`workingDirectory:` read straight off `config.workspaceCwd`. Verified it
  fails on a probe reproducing the original defect and passes once removed.
- `src/main/orchestration/loop-cwd.spec.ts` — 16 tests. The four load-bearing
  ones were confirmed to FAIL when the corresponding fix is reverted:
  `runVerify`/`runQuickVerify` spawn cwd (revert `loop-completion-detector.ts`),
  and both plan-rename cases (revert `loop-completed-plan-helpers.ts`).
- `recordCwdVerifyCommand` added to `loop-test-commands.ts` so a test can assert
  the spawn cwd directly instead of inferring it.

### Fresh-eyes review cycle 1 — findings fixed

An independent completion-gate reviewer returned `VERDICT: FAIL` with two
actionable findings. Both reproduced and fixed:

1. **Phase 6 had no effect on the path that matters.**
   `loop-config-panel.component.ts:201` hardcoded `signal(0.6)` and sends
   `context.compaction` *unconditionally* on every loop start, so every
   UI-created loop kept overriding the shipped default — the recycle-at-60%
   problem would have continued for all real usage. Fixed by importing
   `defaultLoopContextConfig()` and seeding the signal from it, deleting the
   copy. The existing spec asserted the literal `0.6`, so it was locking the bug
   in; it now asserts against the shared default (anti-drift).
2. **A missed cwd site in post-reset rehydration.**
   `buildRehydrationPaths` (`loop-context-survival.ts:224`) joined the plan file
   and the agent's read/changed paths against `workspaceCwd`. Under isolation
   that silently dropped the plan pointer from the "Restored working set" note,
   or picked up an unrelated same-named file left at the repo root by another
   loop — right at the recovery moment the feature exists to make reliable.
   This function genuinely needs BOTH cwds: work product against
   `loopExecutionCwd`, LOOP_TASKS.md against `loopStateCwd`. Fixed and spelled
   out with a comment.

The reviewer also demonstrated a real false negative in the guard: rules 1–2
only match a single line, so `const cwd = state.config.workspaceCwd` followed by
later use passed clean. Added rule `state-cwd-alias`, which flags binding the
state cwd to a local. It has exactly one hit in the codebase — the defect above —
and was confirmed to fire on a probe reproducing it.

Both new tests confirmed to FAIL when their fix is reverted.

### Fresh-eyes review cycle 2 — findings fixed

A second independent reviewer confirmed all cycle-1 fixes and returned
`VERDICT: FAIL` on two further findings, both latent rather than live. Fixed:

1. **`CompletedFileWatcher`'s watch root was still the state cwd** —
   `loop-coordinator.ts:946` and `:1310`. This is the *live* path for the
   completed-plan-rename signal (the poll fixed in Phase 2 is only the
   fallback), and the watch root doubles as the `isInsideOrEqual` containment
   filter for the plan directories in `watchTargets()`. It worked only because
   `WorktreeManager` always nests worktrees under `<repoRoot>/.worktrees/`, so
   the correctly-resolved plan dirs survived the filter by luck of nesting.
   Point `executionCwd` anywhere else — an external clone, a remote-worker
   checkout — and the live watcher silently drops the real plan directory.
   Both call sites now pass `loopExecutionCwd(...)`; the constructor parameter
   is renamed `executionCwd` and documents why. Regression test added that
   watches a plan directory NOT nested under the repo root.
   Not a live bug today: `isCompletedRenameForPlan` (fixed in Phase 2) gates the
   listener, so a repo-root rename by another session was already ignored.
2. **Guard false negatives.** The reviewer demonstrated that `state-cwd-alias`
   missed `const { workspaceCwd } = config` destructuring and bare positional
   arguments — the latter being exactly how finding 1 escaped every rule. Added
   `state-cwd-destructure` and `state-cwd-positional`. Neither has a hit in the
   codebase today; both were confirmed to fire on probes reproducing the two
   patterns.

### Fresh-eyes review cycle 3 — findings fixed

A third independent reviewer swept files the first two cycles had not, and
returned `VERDICT: FAIL` on two LIVE instances of the same defect class plus a
guard hole and a test-scope overclaim. All fixed:

1. **Two liveness probes ran in the repo root** —
   `loop-terminal-intent-actions.ts:89` (block-intent probe, wired from
   `loop-coordinator.ts:3832`) and `loop-blocked-file-handler.ts:44` (the
   `BLOCKED.md` handshake, wired from `loop-coordinator.ts:1848`). Both call the
   same helper the post-compaction canary uses — which Phase 3 fixed, while
   these two were missed. This is a *safety* failure, not just a wrong
   directory: the probe result OVERRIDES the block, so under isolation a
   trivially-alive repo root discards a legitimate block raised because the
   agent's worktree toolchain is dead. Both now use `loopExecutionCwd`.
   Regression tests added for the injectable one
   (`loop-blocked-file-handler.spec.ts`), covering isolated and non-isolated.
2. **A third clean-review classifier call site** (`loop-review-backedge.ts:191`)
   still passed the repo root. Rather than patch it, the classifier's input
   field was renamed `workspaceCwd` → `executionCwd`
   (`loop-clean-review-classifier.ts`). A same-named field made the mismatch
   invisible at all three call sites; the rename turns it into a compile error.
   It immediately surfaced the two remaining sites via `tsc`.
3. **The guard was line-by-line, so it could not see either defect.** Both split
   the function name and the `config.workspaceCwd` argument across lines. The
   script now strips comments (preserving line numbers) and matches whole-file.
   Widening `inline-resolution` first produced two false positives on legitimate
   isolation *guards* (`loop-commit-ratchet.ts:109`,
   `loop-coordinator.ts:1222`), so it was tightened to the true fallback shape:
   the two operands adjacent, separated by nothing but an optional `?.trim()`.
   All six defect shapes are now caught — verified with a probe file; the real
   codebase passes clean.
4. **Test-scope overclaim corrected.** The cycle-2 `CompletedFileWatcher` test
   exercises the class, not the two `loop-coordinator.ts` construction sites
   where the defect actually lived — reverting them would leave it green. Its
   docstring now says so, and points at the `state-cwd-positional` guard rule,
   which does catch a revert (verified).

Deferred, out of scope, flagged for follow-up: `campaign-coordinator.ts:171,420`
overwrites `workspaceCwd` with a worktree path under `policy.isolation ===
'worktree'` instead of using `executionCwd`, so durable loop state lands inside
a directory that gets reaped — the *state-direction* failure of this same
invariant, on a code path this plan does not touch. Untouched by this session.

### Fresh-eyes review cycle 4 — findings fixed

A fourth independent reviewer returned `VERDICT: FAIL`, including a **regression
introduced by this work**. Fixed:

1. **CRITICAL, self-inflicted: baseline and runtime read different trees.**
   Phase 2 moved the completion detector's plan read to the execution cwd, but
   `LoopStageMachine.readPlan` (`loop-stage-machine.ts:168`) still read the repo
   root — and it captures `planChecklistFullyCheckedAtStart`, the baseline the
   detector compares against. Before this work both read the root and *agreed*;
   after Phase 2 they disagreed. Under isolation that means either a **false
   completion** (root copy has open boxes, worktree copy is ticked → the
   `plan-checklist` signal fires as sufficient on iteration 0, with no work
   done) or **permanent suppression** (another session ticks the root copy →
   the signal is disabled for the entire run). The class comment even stated
   the old contract, which the change silently broke.
2. **HIGH: `scanUncompletedPlanFiles` scanned the repo root** while rename
   detection had moved to the worktree. That list auto-enables
   `requireCompletedFileRename`. Since this repo keeps plans untracked and
   `WorktreeManager.copyConfigFiles` copies only `copyInclude` entries, a root
   plan is absent from the worktree — arming a gate the agent can never satisfy.
   An unconditional completion deadlock: exactly the failure this plan exists to
   remove.

   Fix for both: `LoopStageMachine` now takes an optional third `executionCwd`
   (defaulting to `cwd`, so its ~55 existing spec constructions are unchanged).
   Artifact paths keep the state cwd; `readPlan` and `scanUncompletedPlanFiles`
   use the execution cwd. All four coordinator sites now read
   `new LoopStageMachine(loopStateCwd(config), id, loopExecutionCwd(config))`,
   which states both intents at the call site. Four regression tests added; the
   two behavioural ones confirmed to fail when the fix is reverted.
3. **MEDIUM: guard runaway silenced all rules.** `stripComments` treated a glob
   inside a template literal (`src/api/routes/*.ts`) as a block-comment opener
   running to the next `*/` anywhere later — **149 source lines blanked in
   `orchestration-protocol.prompts.ts` alone**, invisible to every rule. A
   block-comment opener must now be preceded by start-of-file, whitespace or an
   opening delimiter, and `//` must not be preceded by `:` (so URLs survive).
   Verified against a probe containing both a glob and a URL.
4. **LOW: two remaining guard shapes.** Added `state-cwd-ternary`
   (`x.executionCwd ? x.executionCwd : x.workspaceCwd`) and widened
   `state-cwd-positional` to any `new X(config.workspaceCwd`, which is finding
   1's shape. The widened rule immediately flagged the four `LoopStageMachine`
   sites, which is why they now say `loopStateCwd(config)` explicitly.

Deferred with reasoning — `loop-coordinator.ts:3375` branch-and-select passes
the state cwd, so candidates fork from the repo root's branch/HEAD. The deeper
defect is that `default-invokers.ts:846` `adopt()` ignores the cwd argument
`loop-branch-select.ts:213` passes it and merges into the root branch, so the
loop's worktree never receives the winner. Fixing only the fork root would
produce a WORSE mixed state (fork from worktree, adopt into root). It is gated
behind `exploration.enabled`, default `false` (`loop.types.ts:469`), so it is
latent. Left for a dedicated change that can exercise the path.

## Verification results (2026-09-03)

| Gate | Result |
| --- | --- |
| `npm run lint` | pass |
| `npm run verify:architecture` | pass (incl. the new cwd guard) |
| `npm run check:contracts` | pass |
| `npx tsc --noEmit` (renderer) | clean |
| `npx tsc --noEmit -p tsconfig.electron.json` | clean apart from a pre-existing error (below) |
| `npx tsc --noEmit -p tsconfig.spec.json` | same single pre-existing error |
| `npm run check:ts-max-loc` | one violation, pre-existing (below) |
| `npm run build:main` | blocked by the pre-existing error; **passes in an isolated copy** with only that other session's files reverted to HEAD |
| `npm run test:quiet src/main/orchestration/` | 2478/2479 — the one failure is pre-existing (below) |
| Full suite (frozen snapshot) | 20,948 / 20,960. Every one of the 12 failures attributed: 11 are snapshot artefacts (the copy has no `.git`, so the git-index and real-repo tests cannot run) — **verified by re-running all three of those spec files in the real repo: 33/33 pass** — and 1 is the pre-existing failure below. **Zero attributable to this work.** |

### Why the full suite was run against a frozen snapshot

Three other agents are writing to this repo root continuously. Two earlier
full-suite runs were corrupted by mid-run edits — one by me (I edited source
while a suite was in flight; a new spec was executed against not-yet-saved
source) and one by another session landing a new untracked
`acp-prompt-timeout-policy.spec.ts` plus edits to its source, which produced 15
failures that vanish when that spec is run in isolation. A moving tree cannot
give an attributable result, so the final run used an rsync'd copy with
everyone's work intact and a snapshot-local patch to make it compile.

### Pre-existing failures owned by another session, NOT this work

A concurrent session has uncommitted, incomplete `includeSessionReplay` work in
the repo root. Verified: `git show HEAD:src/main/orchestration/loop-stage-machine.ts`
contains zero occurrences of the symbol, and `src/main/orchestration/loop-iteration-prompt.ts`
is untracked (`??`). It causes all three of:

- `loop-iteration-prompt.ts(70,83): error TS2345 … 'includeSessionReplay' is missing`
  — blocks `tsc`, `build:main`.
- `check:ts-max-loc`: `loop-stage-machine.ts` 781 lines vs 714 ceiling (HEAD is
  exactly 714; the diff adds 86 lines).
- `loop-stage-machine.spec.ts › injects existing-session context …` — the new
  gating defaults `includeSessionReplay` to `iterationSeq === 0`, and that test
  runs at iteration 3.

Left untouched deliberately: it is another session's in-flight work.

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
