# Supergoal-Inspired Loop Planning And Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the useful Supergoal ideas to Harness Loop Mode: baseline-aware final audit, preflight verification, structured phase planning, and phase-scoped recovery, while keeping Harness as the runtime authority.

**Architecture:** Harness remains the loop engine. Supergoal's slash-command protocol, transcript markers, and `.supergoal/` directory are not imported. New behavior is implemented as typed loop config/state, pure orchestration helpers, per-run artifacts under `.aio-loop-state/<loopRunId>/`, and completion gates owned by `LoopCoordinator` plus `EvidenceResolver`.

**Tech Stack:** TypeScript 5.9, Electron main process, Angular 21 renderer, Zod contract schemas in `packages/contracts`, Vitest, existing loop artifacts and IPC contracts.

## Global Constraints

- Do not add a dependency on Supergoal, `/supergoal`, native `/goal`, or transcript markers such as `SUPERGOAL_PHASE_DONE`.
- Do not write loop-owned planning or audit files to the workspace root; use `.aio-loop-state/<loopRunId>/`.
- Keep the user's configured `planFile` at its existing workspace-relative path. The `_completed.md` rename gate stays scoped to that file only.
- Completion authority stays machine-owned. Agent self-report, markdown claims, and transcript text are never sufficient by themselves.
- New audit behavior must be configurable and rollout-safe: add observe mode before gate mode is made default for user-started loops.
- Do not expose secrets in audit diffs, logs, artifacts, screenshots, or test fixtures. Keep existing `.aio-loop-control/` and attachment secret exclusions.
- Do not commit or push unless James explicitly asks.
- After code changes, run `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, `npm run lint`, `npm run check:ts-max-loc`, and targeted Vitest specs. After multi-file loop changes, run `npm run test`.

---

## Context

Supergoal is useful as a discipline layer, not as a runtime dependency. Its strongest ideas are:

- Plan packet before execution: roadmap, phases, acceptance criteria, risks, and required evidence.
- Preflight check before implementation starts.
- Per-phase failure recovery: retry, narrow fix spec, handoff.
- Final audit that re-checks the original plan, reruns evidence, compares working tree state against a baseline, and reports how much was actually verified.

Harness already has the stronger runtime primitives:

- `LoopCoordinator` owns iteration scheduling and completion handling.
- `LoopStageMachine` writes scoped state under `.aio-loop-state/<loopRunId>/`.
- `LoopTaskLedger` gates completion with `LOOP_TASKS.md`.
- `LoopCompletionDetector` detects candidate completion signals.
- `EvidenceResolver` owns the authority ladder.
- Fresh-eyes review, no-progress detection, branch selection, worktree isolation, provider quota handling, and loop memory already exist.

This plan adds the missing planning and audit envelope around those primitives.

## Existing Files To Reconfirm Before Editing

- `src/main/orchestration/loop-coordinator.ts` - loop lifecycle and completion seam.
- `src/main/orchestration/evidence-resolver.ts` - completion authority decision.
- `src/main/orchestration/loop-completion-detector.ts` - candidate completion signals and verify execution.
- `src/main/orchestration/loop-stage-machine.ts` - prompt and loop-owned artifacts.
- `src/main/orchestration/loop-artifact-paths.ts` - per-run state path helper.
- `src/main/orchestration/loop-diff.ts` - current git diff collection for fresh-eyes review.
- `src/main/orchestration/loop-workspace-snapshot.ts` - file-change snapshot helper.
- `src/main/orchestration/loop-task-ledger.ts` - structured `LOOP_TASKS.md` parsing.
- `src/main/orchestration/loop-start-config.ts` - user-started loop defaults.
- `src/shared/types/loop.types.ts` - loop config and shared completion types.
- `src/shared/types/loop-state.types.ts` - loop state and iteration records.
- `packages/contracts/src/schemas/loop.schemas.ts` - Zod IPC/contracts schema.
- `src/renderer/app/features/loop/loop-config-panel.component.ts` and `.html` - user loop config.
- `src/renderer/app/features/loop/loop-control.component.ts` - active loop UI.
- `src/renderer/app/core/state/loop.store.ts` - loop state projection in renderer.

## New File Structure

- Create `src/main/orchestration/loop-repo-state.ts`.
  - Captures git baseline at loop start.
  - Compares current working tree against the captured baseline with tracked, staged, unstaged, and untracked files.
  - Uses single-revision comparison semantics (`git diff <baselineRef>`), not range semantics (`<baseline>..HEAD`).

- Create `src/main/orchestration/loop-repo-state.spec.ts`.
  - Covers git repo, non-git repo, untracked files, ignored loop state directories, and dirty baseline.

- Create `src/main/orchestration/loop-final-audit.ts`.
  - Pure evaluator that combines repo comparison, ledger state, plan packet evidence, verify result, fresh-eyes result, and cleanliness findings.
  - Renders `AUDIT.md`.

- Create `src/main/orchestration/loop-final-audit.spec.ts`.
  - Covers pass, fail, and needs-review outcomes.

- Create `src/main/orchestration/loop-plan-packet.ts`.
  - Defines phase packet types.
  - Renders templates for `ROADMAP.md` and `phases/phase-NN.md`.
  - Parses written packet files back into structured summaries for audit.

- Create `src/main/orchestration/loop-plan-packet.spec.ts`.
  - Covers rendering, parsing, acceptance criteria extraction, and malformed packet handling.

- Modify `src/main/orchestration/loop-artifact-paths.ts`.
  - Add artifact paths for `ROADMAP.md`, `AUDIT.md`, `PRE_FLIGHT.md`, `repo-baseline.json`, and `phases/`.

- Modify `src/main/orchestration/loop-stage-machine.ts`.
  - Bootstrap new optional artifacts.
  - Prompt PLAN stage to write the plan packet when enabled.
  - Prompt IMPLEMENT stage to keep phase evidence current.

- Modify `src/main/orchestration/loop-coordinator.ts`.
  - Capture repo baseline at loop start.
  - Run preflight once before first child iteration when enabled.
  - Run final audit at candidate-completion seam.
  - Inject audit/phase recovery feedback when completion is blocked.

- Modify `src/main/orchestration/evidence-resolver.ts`.
  - Add final-audit status to the authority ladder.
  - In gate mode, audit failure blocks completion; audit needs-review stops as `completed-needs-review`.

- Modify `src/shared/types/loop.types.ts`, `src/shared/types/loop-state.types.ts`, and `packages/contracts/src/schemas/loop.schemas.ts`.
  - Add audit config, preflight result, final audit result, and plan packet summary payloads.

- Modify renderer loop UI files.
  - Show audit/preflight status and expose advanced config after backend behavior is stable.

## Public Interfaces To Add

These names are used consistently by later tasks.

```ts
export type LoopFinalAuditMode = 'off' | 'observe' | 'gate';
export type LoopPreflightMode = 'off' | 'record' | 'block';
export type LoopPlanPacketMode = 'off' | 'prompted';

export interface LoopAuditConfig {
  finalAuditMode: LoopFinalAuditMode;
  preflightMode: LoopPreflightMode;
  planPacketMode: LoopPlanPacketMode;
  cleanlinessScan: boolean;
}

export type LoopAuditStatus = 'passed' | 'failed' | 'needs-review' | 'skipped';

export interface LoopAuditFinding {
  severity: 'blocking' | 'review' | 'info';
  code:
    | 'verify-failed'
    | 'ledger-open'
    | 'no-deliverable-change'
    | 'repo-state-unavailable'
    | 'plan-criteria-unproven'
    | 'cleanliness-blocking'
    | 'preflight-red-baseline'
    | 'audit-internal-error';
  message: string;
  file?: string;
  detail?: Record<string, unknown>;
}

export interface LoopFinalAuditResult {
  status: LoopAuditStatus;
  ranAt: number;
  coverage: {
    criteriaTotal: number;
    criteriaVerified: number;
    criteriaUnverified: number;
    verifyCommandRan: boolean;
    repoComparisonRan: boolean;
    cleanlinessScanRan: boolean;
  };
  findings: LoopAuditFinding[];
  changedFiles: string[];
  reportPath?: string;
}
```

Add these to shared types first, then mirror them in Zod schemas.

## Task 1: Repo Baseline And Complete Working-Tree Comparison

**Files:**
- Create: `src/main/orchestration/loop-repo-state.ts`
- Create: `src/main/orchestration/loop-repo-state.spec.ts`
- Modify: `src/main/orchestration/loop-diff.ts` only if a helper should be shared instead of copied

**Interfaces:**
- Produces:
  - `captureLoopRepoBaseline(workspaceCwd: string, runner?: LoopRepoGitRunner): LoopRepoBaseline`
  - `compareLoopRepoState(workspaceCwd: string, baseline: LoopRepoBaseline, options?: LoopRepoComparisonOptions, runner?: LoopRepoGitRunner): LoopRepoComparison`
- Consumes later:
  - `LoopCoordinator` stores `LoopRepoBaseline`.
  - `LoopFinalAudit` consumes `LoopRepoComparison`.

```ts
export type LoopRepoStateSource = 'git' | 'none';

export interface LoopRepoBaseline {
  source: LoopRepoStateSource;
  capturedAt: number;
  workspaceCwd: string;
  headRef: string | null;
  dirtyAtStart: boolean;
  trackedDirtyAtStart: string[];
  untrackedAtStart: string[];
}

export interface LoopRepoComparison {
  source: LoopRepoStateSource;
  baseline: LoopRepoBaseline;
  changedFiles: string[];
  trackedDiff: string;
  untrackedFiles: string[];
  dirtyAtStartCarriedForward: boolean;
  truncated: boolean;
}

export interface LoopRepoComparisonOptions {
  maxDiffChars?: number;
}

export type LoopRepoGitRunner = (
  args: string[],
  cwd: string,
) => { status: number | null; stdout: string; stderr?: string };
```

- [x] **Step 1: Write failing tests for baseline capture**

Create `loop-repo-state.spec.ts` with tests that initialize a temporary git repo, commit `src/a.ts`, then assert:

```ts
const baseline = captureLoopRepoBaseline(tmpDir);
expect(baseline.source).toBe('git');
expect(baseline.headRef).toMatch(/^[0-9a-f]{40}$/);
expect(baseline.dirtyAtStart).toBe(false);
expect(baseline.trackedDirtyAtStart).toEqual([]);
expect(baseline.untrackedAtStart).toEqual([]);
```

Run: `npx vitest run src/main/orchestration/loop-repo-state.spec.ts`

Expected: fail because `loop-repo-state.ts` does not exist.

- [x] **Step 2: Implement baseline capture**

Create `loop-repo-state.ts` using `spawnSync('git', ...)` with:

- `git rev-parse --is-inside-work-tree`
- `git rev-parse HEAD`
- `git diff --name-only HEAD`
- `git ls-files --others --exclude-standard`

Normalize all paths to POSIX separators. Reuse the ignore policy from `loop-diff.ts`: exclude `.aio-loop-control/`, `.aio-loop-attachments/`, `.aio-loop-state/`, `.git/`, and `node_modules/`.

- [x] **Step 3: Write failing tests for complete comparison**

Add a test that:

1. Captures baseline at clean `HEAD`.
2. Modifies a tracked file.
3. Adds an untracked source file.
4. Calls `compareLoopRepoState`.
5. Asserts both files are present.

Expected assertions:

```ts
expect(comparison.changedFiles).toEqual(['src/a.ts', 'src/new.ts']);
expect(comparison.trackedDiff).toContain('git diff');
expect(comparison.untrackedFiles).toEqual(['src/new.ts']);
```

- [x] **Step 4: Implement complete comparison**

Use single-revision commands:

- `git diff --stat <baseline.headRef>`
- `git diff <baseline.headRef>`
- `git ls-files --others --exclude-standard`

Do not use `git diff <baseline>..HEAD`; that misses staged and unstaged work.

- [x] **Step 5: Add non-git and dirty-baseline tests**

Expected behavior:

- Non-git workspace returns `source: 'none'` and no changed files.
- Dirty baseline sets `dirtyAtStart: true`.
- A file dirty at start and unchanged during the loop is not counted as a new deliverable.
- A file dirty at start and changed again during the loop is included, with `dirtyAtStartCarriedForward: true`.

- [x] **Step 6: Verify Task 1**

Run:

```bash
npx vitest run src/main/orchestration/loop-repo-state.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: both pass.

## Task 2: Audit Config, Result Types, Artifact Paths, And Schemas

**Files:**
- Modify: `src/shared/types/loop.types.ts`
- Modify: `src/shared/types/loop-state.types.ts`
- Modify: `packages/contracts/src/schemas/loop.schemas.ts`
- Modify: `packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts`
- Modify: `src/main/orchestration/loop-artifact-paths.ts`
- Modify: `src/main/orchestration/loop-artifact-paths.spec.ts`

**Interfaces:**
- Produces:
  - `LoopAuditConfig`
  - `LoopFinalAuditResult`
  - `LoopPreflightResult`
  - new artifact paths
- Consumes later:
  - `LoopCoordinator`, renderer store, UI, and IPC payload validation.

- [x] **Step 1: Extend shared types**

Add the `LoopAuditConfig`, `LoopFinalAuditResult`, and `LoopAuditFinding` interfaces from the "Public Interfaces" section to `loop.types.ts`.

Add:

```ts
export interface LoopPreflightResult {
  status: 'passed' | 'failed' | 'skipped';
  ranAt: number;
  commands: Array<{
    label: 'quick-verify' | 'verify' | 'extra';
    command: string;
    status: 'passed' | 'failed' | 'skipped';
    durationMs: number;
    outputExcerpt: string;
  }>;
}
```

In `LoopConfig`, add:

```ts
audit: LoopAuditConfig;
```

In `defaultLoopConfig`, use rollout-safe defaults:

```ts
audit: {
  finalAuditMode: 'observe',
  preflightMode: 'off',
  planPacketMode: 'off',
  cleanlinessScan: true,
},
```

In `LoopIteration`, add:

```ts
finalAudit?: LoopFinalAuditResult;
```

In `LoopState`, add:

```ts
repoBaseline?: LoopRepoBaseline;
preflight?: LoopPreflightResult;
latestFinalAudit?: LoopFinalAuditResult;
```

Import the repo baseline type from `loop-repo-state.ts` only in main-process files. For shared state payloads, mirror the shape as a shared interface so contracts do not import main-process modules.

- [x] **Step 2: Extend contracts schemas**

In `packages/contracts/src/schemas/loop.schemas.ts`, add Zod schemas matching the shared types. Update `LoopConfigSchema`, `LoopConfigInputSchema`, `LoopIterationSchema`, and `LoopStateSchema`.

Use strict enums:

```ts
const LoopFinalAuditModeSchema = z.enum(['off', 'observe', 'gate']);
const LoopPreflightModeSchema = z.enum(['off', 'record', 'block']);
const LoopPlanPacketModeSchema = z.enum(['off', 'prompted']);
```

Update schema tests to assert:

- Old minimal states without audit fields still parse when defaults are applied through config preparation.
- Full state payload with `latestFinalAudit` parses.
- Invalid mode strings are rejected.

- [x] **Step 3: Add artifact paths**

Extend `LoopArtifactPaths` with:

```ts
roadmap: string;
audit: string;
preflight: string;
repoBaseline: string;
phasesDir: string;
```

Return:

```ts
roadmap: path.join(dir, 'ROADMAP.md'),
audit: path.join(dir, 'AUDIT.md'),
preflight: path.join(dir, 'PRE_FLIGHT.md'),
repoBaseline: path.join(dir, 'repo-baseline.json'),
phasesDir: path.join(dir, 'phases'),
```

Extend `loop-artifact-paths.spec.ts` to assert deterministic absolute paths and no workspace-root artifact names.

- [x] **Step 4: Verify Task 2**

Run:

```bash
npx vitest run src/main/orchestration/loop-artifact-paths.spec.ts packages/contracts/src/schemas/__tests__/loop.schemas.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: all pass.

## Task 3: Capture Baseline At Loop Start

**Files:**
- Modify: `src/main/orchestration/loop-coordinator.ts`
- Modify: `src/main/orchestration/loop-coordinator-restore.spec.ts`
- Modify: `src/main/orchestration/loop-store.spec.ts`
- Modify as needed: `src/main/orchestration/loop-checkpoint.ts`

**Interfaces:**
- Consumes: `captureLoopRepoBaseline`, `LoopRepoBaseline`
- Produces: `state.repoBaseline` and `repo-baseline.json`

- [x] **Step 1: Write failing coordinator start test**

Add a test in an existing coordinator start/restore spec or a focused new spec:

```ts
const state = await coordinator.startLoop('chat-1', config);
expect(state.repoBaseline?.source).toBe('git');
const paths = resolveLoopArtifactPaths(config.workspaceCwd, state.id);
expect(fs.existsSync(paths.repoBaseline)).toBe(true);
```

Expected: fail because no baseline is captured.

- [x] **Step 2: Capture and persist the baseline**

In `LoopCoordinator.startLoop`, after state id and artifact paths are known, call:

```ts
const repoBaseline = captureLoopRepoBaseline(config.workspaceCwd);
state.repoBaseline = repoBaseline;
await fsp.mkdir(paths.dir, { recursive: true });
await fsp.writeFile(paths.repoBaseline, JSON.stringify(repoBaseline, null, 2), 'utf8');
```

Handle failures by setting:

```ts
state.repoBaseline = {
  source: 'none',
  capturedAt: Date.now(),
  workspaceCwd: config.workspaceCwd,
  headRef: null,
  dirtyAtStart: false,
  trackedDirtyAtStart: [],
  untrackedAtStart: [],
};
```

Do not fail loop start just because git state is unavailable.

- [x] **Step 3: Restore baseline from checkpoint or artifact**

On restore, prefer checkpointed `state.repoBaseline`. If missing but `repo-baseline.json` exists, parse it. If both are missing, capture a new `source: 'none'` fallback and write an informational finding in the next audit.

- [x] **Step 4: Verify Task 3**

Run:

```bash
npx vitest run src/main/orchestration/loop-coordinator-restore.spec.ts src/main/orchestration/loop-store.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: all pass.

## Task 4: Preflight Verification Before First Child Iteration

**Files:**
- Modify: `src/main/orchestration/loop-coordinator.ts`
- Modify: `src/main/orchestration/loop-completion-detector.ts` only if verify runner needs a shared method label
- Create or modify: `src/main/orchestration/loop-coordinator-preflight.spec.ts`
- Modify: `src/main/orchestration/loop-stage-machine.ts` to mention `PRE_FLIGHT.md` when enabled

**Interfaces:**
- Consumes: `LoopAuditConfig.preflightMode`, `runQuickVerify`, `runVerify`
- Produces: `LoopPreflightResult`, `PRE_FLIGHT.md`

- [x] **Step 1: Write failing preflight tests**

Cover three modes:

- `off`: no command runs, no preflight file required.
- `record`: quick/full verify runs once before first child invocation and loop continues even if red.
- `block`: red preflight pauses before the first child invocation.

Expected test shape:

```ts
expect(invocations).toHaveLength(0);
expect(coordinator.getLoop(loopRunId)?.status).toBe('paused');
expect(coordinator.getLoop(loopRunId)?.preflight?.status).toBe('failed');
```

- [x] **Step 2: Implement a one-shot preflight guard**

In `runLoop`, before the first `loop:invoke-iteration` emit, add a guard:

```ts
if (state.totalIterations === 0 && !state.preflight && state.config.audit.preflightMode !== 'off') {
  const preflight = await this.runPreflight(state);
  state.preflight = preflight;
  await this.writePreflightArtifact(state, preflight);
  if (state.config.audit.preflightMode === 'block' && preflight.status === 'failed') {
    state.status = 'paused';
    state.lastCompletionOutcome = 'unverifiable';
    state.endReason = 'preflight verification failed before implementation';
    this.emitStateChanged(state);
    return;
  }
}
```

The exact method names can be private coordinator helpers. Keep the behavior one-shot so resume does not re-run preflight forever.

- [x] **Step 3: Render `PRE_FLIGHT.md`**

Format:

````markdown
# Loop Preflight

- Status: failed
- Ran at: 2026-06-27T00:00:00.000Z
- Mode: block

## quick-verify

Command: npm run lint
Status: failed

```text
<bounded output>
```
````

Bound output using the same `excerpt` helper pattern as verify output.

- [x] **Step 4: Verify Task 4**

Run:

```bash
npx vitest run src/main/orchestration/loop-coordinator-preflight.spec.ts src/main/orchestration/loop-completion-detector.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: all pass.

## Task 5: Pure Final Audit Evaluator And `AUDIT.md`

**Files:**
- Create: `src/main/orchestration/loop-final-audit.ts`
- Create: `src/main/orchestration/loop-final-audit.spec.ts`
- Modify: `src/main/orchestration/loop-task-ledger.ts` only if a reusable summary helper is needed

**Interfaces:**
- Consumes:
  - `LoopRepoComparison`
  - parsed `LOOP_TASKS.md`
  - optional plan packet summary
  - verify status and fresh-eyes summary already collected at completion seam
- Produces:
  - `evaluateLoopFinalAudit(input: LoopFinalAuditInput): LoopFinalAuditResult`
  - `renderLoopFinalAuditMarkdown(result: LoopFinalAuditResult): string`

```ts
export interface LoopFinalAuditInput {
  goalIntent: 'implementation' | 'investigation';
  mode: LoopFinalAuditMode;
  verifyStatus: 'passed' | 'failed' | 'skipped';
  repoComparison: LoopRepoComparison;
  ledger: { total: number; open: number; resolved: number };
  planPacket?: LoopPlanPacketSummary;
  cleanliness: LoopCleanlinessResult;
}

export interface LoopCleanlinessResult {
  status: 'passed' | 'failed' | 'skipped';
  findings: LoopAuditFinding[];
}
```

- [x] **Step 1: Write failing audit evaluator tests**

Add cases:

- Verify failed yields `status: 'failed'` and finding code `verify-failed`.
- Ledger has open items yields `status: 'failed'` and code `ledger-open`.
- Implementation goal has zero new changed files after the repo baseline comparison yields `status: 'failed'` and code `no-deliverable-change`.
- Non-git repo with passed verify yields `status: 'needs-review'` and code `repo-state-unavailable`.
- Passed verify, resolved ledger, changed files, and no cleanliness findings yields `status: 'passed'`.

- [x] **Step 2: Implement evaluator rules**

Implement deterministic precedence:

1. If mode is `off`, return `skipped`.
2. Blocking inputs produce `failed`: verify failed, open ledger items, conflict markers, focused tests, or obvious debug statements in added lines.
3. Missing independent evidence produces `needs-review`: no repo comparison, plan criteria unverified, verify skipped.
4. Otherwise return `passed`.

The evaluator must be pure. It must not read files or spawn commands.

- [x] **Step 3: Implement cleanliness scan**

Add a helper in `loop-final-audit.ts`:

```ts
export function scanAddedLinesForCleanliness(diff: string): LoopCleanlinessResult
```

Blocking patterns:

- Git conflict markers: `<<<<<<<`, `=======`, `>>>>>>>`
- Focused tests: `.only(` in added lines
- Debug statements in TypeScript/JavaScript added lines: `console.log(`, `debugger;`

Review-level patterns:

- Temporary marker comments containing `fixme` or `hack` in added lines.

Only inspect lines beginning with `+` from a diff hunk. Ignore `+++ b/file` headers.

- [x] **Step 4: Implement markdown renderer**

`AUDIT.md` must contain:

- Status
- Coverage counts
- Verify ran or skipped
- Repo comparison source
- Changed files
- Findings grouped by severity

Example:

```markdown
# Loop Final Audit

- Status: failed
- Criteria verified: 3 / 5
- Verify command ran: yes
- Repo comparison ran: yes
- Cleanliness scan ran: yes

## Blocking Findings

- ledger-open: LOOP_TASKS.md still has 2 open items.

## Changed Files

- src/main/orchestration/example.ts
```

- [x] **Step 5: Verify Task 5**

Run:

```bash
npx vitest run src/main/orchestration/loop-final-audit.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: all pass.

## Task 6: Integrate Final Audit Into Completion Authority

**Files:**
- Modify: `src/main/orchestration/loop-coordinator.ts`
- Modify: `src/main/orchestration/evidence-resolver.ts`
- Modify: `src/main/orchestration/evidence-resolver.spec.ts`
- Modify: `src/main/orchestration/loop-coordinator-accept-completion.spec.ts`
- Modify: `src/main/orchestration/loop-coordinator-completion-seed.spec.ts`
- Modify: `src/main/orchestration/loop-completion-detector.spec.ts` only if candidate payload expectations change

**Interfaces:**
- Consumes: Task 5 evaluator
- Produces:
  - `iteration.finalAudit`
  - `state.latestFinalAudit`
  - `AUDIT.md`
  - resolver outcomes that honor audit status

- [x] **Step 1: Extend `ResolveCompletionInput`**

In `evidence-resolver.ts`, add:

```ts
finalAuditMode: LoopFinalAuditMode;
finalAuditStatus: LoopAuditStatus;
finalAuditFindings: LoopAuditFinding[];
```

Add resolver rules before the final stop decision:

```ts
if (input.finalAuditMode === 'gate' && input.finalAuditStatus === 'failed') {
  return {
    action: 'continue',
    outcome: 'review-blocked',
    acceptedTier: input.candidate.tier,
    reason: 'final audit blocked completion',
    convergenceNote: 'final audit blocked completion',
  };
}

if (input.finalAuditMode === 'gate' && input.finalAuditStatus === 'needs-review') {
  return {
    action: 'stop-needs-review',
    outcome: 'unverifiable',
    acceptedTier: input.candidate.tier,
    reason: 'final audit requires operator review',
    convergenceNote: 'final audit requires operator review',
  };
}
```

If mode is `observe`, never block solely on audit. Still persist and emit the audit.

- [x] **Step 2: Add resolver tests**

Cases:

- Gate + failed audit + passed verify returns `continue`.
- Gate + needs-review audit + passed verify returns `stop-needs-review`.
- Observe + failed audit + passed verify follows existing resolver behavior.
- Off + skipped audit follows existing resolver behavior.

- [x] **Step 3: Run audit at the completion seam**

In `loop-coordinator.ts`, at the candidate completion block after quick/full verify and fresh-eyes review have run, but before `resolveCompletion`, gather:

- Repo comparison from `compareLoopRepoState`.
- Ledger from `stageMachine.readTaskLedger()`.
- Plan packet summary from Task 7 when available.
- Cleanliness scan from tracked diff text.

Then:

```ts
const finalAudit = await this.runFinalAudit(state, iteration, {
  verifyStatus: v2.status,
  repoComparison,
  ledger,
  planPacket,
});

iteration.finalAudit = finalAudit;
state.latestFinalAudit = finalAudit;
await fsp.writeFile(paths.audit, renderLoopFinalAuditMarkdown(finalAudit), 'utf8');
```

Pass `finalAudit.status` and findings to `resolveCompletion`.

- [x] **Step 4: Feed audit failures back into the loop**

When resolver returns `continue` because of final audit failure, push a bounded intervention:

```text
Your completion was not accepted. The final audit found blocking issues:

1. ledger-open: LOOP_TASKS.md still has 2 open items.
2. cleanliness-blocking: added line contains console.log in src/foo.ts.

Read AUDIT.md, fix the issues, update LOOP_TASKS.md, rerun verification, then try completion again.
```

Use the scoped absolute path to `AUDIT.md` in the actual message.

- [x] **Step 5: Preserve existing operator accept semantics**

`acceptCompletion` should run final audit in gate mode before terminal completion when a verify command exists. If audit fails, reject accept with the audit findings. If no verify command exists, existing `completed-needs-review` behavior remains.

- [x] **Step 6: Verify Task 6**

Run:

```bash
npx vitest run src/main/orchestration/evidence-resolver.spec.ts src/main/orchestration/loop-coordinator-accept-completion.spec.ts src/main/orchestration/loop-coordinator-completion-seed.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: all pass.

## Task 7: Plan Packet And Phase Spec Artifacts

**Files:**
- Create: `src/main/orchestration/loop-plan-packet.ts`
- Create: `src/main/orchestration/loop-plan-packet.spec.ts`
- Modify: `src/main/orchestration/loop-stage-machine.ts`
- Modify: `src/main/orchestration/loop-stage-machine.spec.ts`
- Modify: `src/main/orchestration/loop-artifact-paths.ts`
- Modify: `src/main/orchestration/loop-artifact-paths.spec.ts`

**Interfaces:**
- Produces:
  - `LoopPlanPacketSummary`
  - `renderPlanPacketInstructions(paths: LoopArtifactPaths): string`
  - `readLoopPlanPacket(paths: LoopArtifactPaths): Promise<LoopPlanPacketSummary | null>`
- Consumes later:
  - Final audit coverage.
  - Phase recovery.

```ts
export interface LoopPhaseSpec {
  id: string;
  title: string;
  acceptanceCriteria: string[];
  requiredCommands: string[];
  evidence: string[];
}

export interface LoopPlanPacketSummary {
  roadmapPath: string;
  phases: LoopPhaseSpec[];
  criteriaTotal: number;
  criteriaWithEvidence: number;
  malformed: boolean;
}
```

- [x] **Step 1: Write parser/render tests**

Create a markdown sample:

```markdown
# Loop Roadmap

## Phase 1: Baseline Audit

Acceptance Criteria:
- [ ] Captures repo baseline before first child iteration.
- [ ] Writes repo-baseline.json under the scoped state dir.

Required Commands:
- npx vitest run src/main/orchestration/loop-repo-state.spec.ts

Evidence:
- src/main/orchestration/loop-repo-state.spec.ts:12
```

Assert parser returns one phase, two criteria, one required command, one evidence line.

- [x] **Step 2: Implement parser**

Keep parsing intentionally small:

- Phase starts at `## Phase N: Title`.
- Section labels are exact: `Acceptance Criteria:`, `Required Commands:`, `Evidence:`.
- Criteria are lines beginning `- [ ]`, `- [x]`, or `-`.
- Evidence lines count only if they contain a `path:line` shape.

Malformed packets return `malformed: true`; they do not throw.

- [x] **Step 3: Prompt PLAN stage to write packet**

When `config.audit.planPacketMode === 'prompted'`, add to `LoopStageMachine.buildPrompt`:

```text
Before leaving PLAN, write the loop plan packet:

1. Write ROADMAP.md at <absolute roadmap path>.
2. Create one phase file per phase under <absolute phases dir>.
3. Each phase must include Acceptance Criteria, Required Commands, and Evidence.
4. Seed LOOP_TASKS.md from the phase criteria.
5. Do not write DONE.txt during PLAN.
```

Use absolute paths from `LoopArtifactPaths`, matching the existing scoped-state prompt pattern.

- [x] **Step 4: Include packet in final audit**

In `runFinalAudit`, call `readLoopPlanPacket(paths)` when plan packet mode is prompted. Set audit coverage:

```ts
criteriaTotal = packet.criteriaTotal;
criteriaVerified = packet.criteriaWithEvidence;
criteriaUnverified = packet.criteriaTotal - packet.criteriaWithEvidence;
```

If packet is malformed in gate mode, audit status is `needs-review`, not `failed`, unless verify or ledger also failed.

- [x] **Step 5: Verify Task 7**

Run:

```bash
npx vitest run src/main/orchestration/loop-plan-packet.spec.ts src/main/orchestration/loop-stage-machine.spec.ts src/main/orchestration/loop-final-audit.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: all pass.

## Task 8: Phase-Level Recovery After Repeated Failures

**Files:**
- Modify: `src/main/orchestration/loop-coordinator.ts`
- Modify: `src/main/orchestration/loop-coordinator-convergence.spec.ts`
- Modify: `src/main/orchestration/loop-next-objective-planner.ts` only if phase recovery should reuse next-objective injection
- Modify: `src/shared/types/loop-state.types.ts`
- Modify: `packages/contracts/src/schemas/loop.schemas.ts`

**Interfaces:**
- Consumes: final audit findings, verify failures, plan packet phase ids
- Produces:
  - phase failure counters in state
  - `phases/<phase-id>.fix.md`
  - bounded intervention text

```ts
export interface LoopPhaseRecoveryState {
  phaseId: string;
  consecutiveFailures: number;
  lastFailureAt: number;
  lastFindingCodes: string[];
}
```

- [x] **Step 1: Add tests for failure counters**

Simulate the same phase failing completion three times:

- First failure: normal audit/verify feedback.
- Second failure: writes `phase-1.fix.md` and injects narrow fix guidance.
- Third failure: pauses as `completed-needs-review` with handoff reason, unless new file changes appeared since the previous failure.

- [x] **Step 2: Add phase key resolution**

Resolve current phase in this order:

1. The first unresolved phase from parsed `ROADMAP.md`.
2. The first open ledger item prefix that matches `Phase N`.
3. Fallback key `unscoped`.

Store recovery counters by `phaseId`.

- [x] **Step 3: Write fix spec on second repeated failure**

Create `phases/<phase-id>.fix.md`:

```markdown
# Phase Fix Spec: phase-1

## Blocking Findings

- verify-failed: npm run test failed.
- ledger-open: 1 open item remains.

## Required Next Attempt

Work only on this phase. Do not broaden scope. Fix the blocking findings, update evidence, rerun required commands, then attempt completion again.
```

Inject a pending intervention pointing at the absolute fix spec path.

- [x] **Step 4: Pause with useful handoff on third repeated failure**

If the same phase fails three times without new changed files, stop or pause with:

- Status: `completed-needs-review` when verify passed but audit stayed needs-review.
- Status: `no-progress` when verify/audit stayed failed.
- `OUTSTANDING.md` entry describing the phase, findings, and fix spec path.

Do not classify this as a generic crash or provider error.

- [x] **Step 5: Verify Task 8**

Run:

```bash
npx vitest run src/main/orchestration/loop-coordinator-convergence.spec.ts src/main/orchestration/loop-final-audit.spec.ts
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: all pass.

## Task 9: Renderer Visibility And Config Controls

**Files:**
- Modify: `src/renderer/app/features/loop/loop-config-panel.component.ts`
- Modify: `src/renderer/app/features/loop/loop-config-panel.component.html`
- Modify: `src/renderer/app/features/loop/loop-control.component.ts`
- Modify: `src/renderer/app/features/loop/loop-control.component.html`
- Modify: `src/renderer/app/core/state/loop.store.ts`
- Modify: relevant renderer specs

**Interfaces:**
- Consumes: contract payload fields from Task 2
- Produces: visible status for preflight/final audit and advanced config controls

- [x] **Step 1: Show audit status in active loop UI**

Add a compact row near existing gate/completion status:

- Preflight: off, passed, failed, or skipped.
- Final audit: observe passed, observe failed, gate passed, gate failed, needs review, or skipped.
- Link text should display the artifact filename only, such as `AUDIT.md`; do not expose absolute paths in cramped UI labels.

- [x] **Step 2: Add advanced config controls**

In the loop config panel, add controls:

- Final audit: `Observe` and `Gate`; keep `Off` available in advanced settings.
- Preflight: `Off`, `Record`, `Block on red baseline`.
- Plan packet: `Off`, `Prompted`.
- Cleanliness scan: checkbox.

Renderer defaults should match `prepareLoopStartConfig`, not duplicate hidden engine defaults.

- [x] **Step 3: Add renderer tests**

Update component/store specs to assert:

- Audit fields from state are rendered without crashing when absent.
- Config submission includes `audit` fields.
- Existing saved configs without `audit` still start.

- [x] **Step 4: Verify Task 9**

Run:

```bash
npx vitest run src/renderer/app/features/loop/loop-control.component.spec.ts src/renderer/app/core/state/loop.store.spec.ts
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: all pass.

## Task 10: Rollout Defaults, Docs, And Full Verification

**Files:**
- Modify: `src/main/orchestration/loop-start-config.ts`
- Modify: `src/main/orchestration/loop-start-config.spec.ts`
- Modify: `docs/architecture.md`
- Modify: this plan only after implementation is fully verified, by renaming with `_completed`

**Interfaces:**
- Consumes: all prior tasks
- Produces: default behavior and documentation

- [x] **Step 1: Set rollout defaults deliberately**

In `prepareLoopStartConfig`, for user-started loops:

```ts
audit: {
  finalAuditMode: input.audit?.finalAuditMode ?? 'gate',
  preflightMode: input.audit?.preflightMode ?? 'record',
  planPacketMode: input.audit?.planPacketMode ?? 'off',
  cleanlinessScan: input.audit?.cleanlinessScan ?? true,
}
```

Keep engine-level `defaultLoopConfig` at `observe` for programmatic callers until all tests and manual smoke checks have passed.

- [x] **Step 2: Enable plan packet only for substantial loops**

If the prompt or attached plan is short, default plan packet to `off`. If either condition is true, default to `prompted`:

- `planFile` is configured.
- `initialPrompt.length >= 800`.
- `maxIterations >= 5`.

Add tests for all three paths.

- [x] **Step 3: Document the model**

Update `docs/architecture.md` loop section with:

- Audit config modes.
- Artifact paths.
- Completion authority order.
- Preflight behavior.
- Plan packet behavior.
- Explicit note that Supergoal transcript markers are not used.

- [x] **Step 4: Run targeted verification**

Run:

```bash
npx vitest run \
  src/main/orchestration/loop-repo-state.spec.ts \
  src/main/orchestration/loop-final-audit.spec.ts \
  src/main/orchestration/loop-plan-packet.spec.ts \
  src/main/orchestration/evidence-resolver.spec.ts \
  src/main/orchestration/loop-stage-machine.spec.ts \
  src/main/orchestration/loop-start-config.spec.ts
```

Expected: all pass.

- [x] **Step 5: Run required project verification**

Run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run check:ts-max-loc
npm run test
```

Expected: all pass.

- [x] **Step 6: Manual smoke check**

Run one local Harness loop on a tiny fixture repository with:

- `finalAuditMode: 'gate'`
- `preflightMode: 'record'`
- `planPacketMode: 'prompted'`

Verify:

- `.aio-loop-state/<loopRunId>/repo-baseline.json` exists.
- `.aio-loop-state/<loopRunId>/PRE_FLIGHT.md` exists when preflight is enabled.
- `.aio-loop-state/<loopRunId>/ROADMAP.md` exists when plan packet is prompted.
- `.aio-loop-state/<loopRunId>/AUDIT.md` exists after candidate completion.
- A fake open ledger item blocks completion.
- Removing the open item and passing verify allows completion.

Do not use a workspace containing secrets for this smoke check.

## Acceptance Criteria

- Final audit can run in observe mode without changing completion behavior.
- Gate mode blocks completion on red audit findings even when verify passed.
- Gate mode returns `completed-needs-review` when audit cannot independently verify enough evidence.
- Preflight runs before the first child iteration and is one-shot across pause/resume.
- Repo comparison includes untracked files and uncommitted tracked changes relative to the baseline.
- Repo comparison does not include `.aio-loop-control/`, `.aio-loop-attachments/`, `.aio-loop-state/`, `.git/`, or `node_modules/`.
- Plan packet artifacts are under `.aio-loop-state/<loopRunId>/`.
- The loop never depends on Supergoal transcript markers.
- Existing loop tests still pass.
- Renderer tolerates older state payloads with no audit fields.

## Risks And Mitigations

- **Risk: false audit failures block useful loops.**
  - Mitigation: ship observe mode first, keep messages actionable, and make needs-review distinct from failed.

- **Risk: audit diff leaks sensitive loop-control files.**
  - Mitigation: reuse the existing exclusions and add tests for `.aio-loop-control/`.

- **Risk: plan packet parsing becomes a second fragile planner.**
  - Mitigation: parse only simple section labels and treat malformed packets as needs-review, not as a crash.

- **Risk: preflight red baseline stops legitimate repair loops.**
  - Mitigation: `record` mode records red baseline and continues; only `block` pauses.

- **Risk: active loop-engine overhaul work collides with this plan.**
  - Mitigation: re-read `docs/plans/2026-06-26-loop-engine-overhaul-spec_completed.md` before implementation. Coordinate any shared edits to `LoopCoordinator`, `EvidenceResolver`, and `loop-start-config.ts`.

## Out Of Scope

- Passing native `/goal` through to Claude or Codex.
- Replacing Harness Loop Mode with Supergoal.
- Mid-turn steer or interactive CLI control.
- Branch-selection changes.
- New external dependencies.
- Persisting audit artifacts outside the workspace.

## Execution Order

1. Task 1: repo baseline helper.
2. Task 2: types, schemas, artifacts.
3. Task 3: baseline capture.
4. Task 5: pure final audit evaluator.
5. Task 6: observe-mode completion integration.
6. Task 4: preflight.
7. Task 7: plan packet.
8. Task 8: phase recovery.
9. Task 9: renderer.
10. Task 10: rollout defaults and full verification.

Task 5 is listed before Task 4 in execution order because final audit is the highest-value behavior and can land in observe mode without changing loop start semantics.

## Self-Review Checklist

- Spec coverage: Supergoal planning, preflight, final audit, baseline diff, cleanliness, phase recovery, and UI surfacing all map to tasks.
- Type consistency: `LoopAuditConfig`, `LoopFinalAuditResult`, `LoopPreflightResult`, and `LoopPlanPacketSummary` are defined before use.
- Rollout safety: observe mode exists before gate mode is enabled by default.
- Repo safety: all artifacts stay in `.aio-loop-state/<loopRunId>/`.
- Verification: every task has targeted Vitest commands and Task 10 has the full project gate.
