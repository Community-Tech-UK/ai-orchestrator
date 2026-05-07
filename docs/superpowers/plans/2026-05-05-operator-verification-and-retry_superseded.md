# Operator Verification and Retry Implementation Plan

**Status:** Superseded on 2026-05-07 by the Chats architecture.

Do not implement this plan as written. It depends on `OperatorEngine`, `OperatorProjectAgentExecutor`, and deterministic project-agent run graphs that were removed when the app moved to provider-backed persistent Chats. Future verification should be designed either as chat-invoked provider work or as auditable structured tools, not as an engine-owned retry loop.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not commit or push unless the user explicitly asks.

**Goal:** Add first-class deterministic verification and bounded fix-worker retry loops to global Operator project runs.

**Architecture:** Keep project work inside the existing `OperatorEngine`, but make verification a separate persisted `verification` node after every project-agent node. Run verification commands through a new `OperatorVerificationExecutor` using `execFile`, planner-produced commands, timeouts, bounded output, and audit events. If required verification fails, the engine may spawn a fix-worker project-agent node using a failure-context prompt, then verify again until the run budget blocks further retries.

**Tech Stack:** Electron main process, TypeScript 5.9, better-sqlite3 operator run store, Vitest.

---

## File Map

- Modify `src/shared/types/operator.types.ts`: add verification project kind and result payload types.
- Modify `src/main/operator/operator-verification-planner.ts`: import project kind from shared types.
- Create `src/main/operator/operator-verification-executor.ts`: deterministic verification executor.
- Create `src/main/operator/operator-verification-executor.spec.ts`: executor tests with fake command runner and fake run store.
- Create `src/main/operator/operator-fix-worker-prompt.ts`: prompt builder for repair attempts.
- Create `src/main/operator/operator-fix-worker-prompt.spec.ts`: prompt-builder tests.
- Modify `src/main/operator/operator-project-agent-executor.ts`: accept optional `promptOverride`.
- Modify `src/main/operator/operator-engine.ts`: add verification node execution and retry loop.
- Modify or create `src/main/operator/operator-engine.spec.ts`: engine pass, skipped, retry, and blocked tests.
- Modify `src/main/operator/index.ts`: re-export new executor and prompt-builder APIs.
- Modify `src/shared/types/index.ts` only if new exported names are not already included through existing barrel behavior.

## Task 1: Add Shared Verification Result Types

**Files:**
- Modify: `src/shared/types/operator.types.ts`
- Modify: `src/main/operator/operator-verification-planner.ts`

- [ ] **Step 1: Read the current type and planner files**

Read both files before editing:

```bash
sed -n '1,260p' src/shared/types/operator.types.ts
sed -n '1,260p' src/main/operator/operator-verification-planner.ts
```

- [ ] **Step 2: Move project kind to shared types**

In `src/shared/types/operator.types.ts`, add:

```ts
export type OperatorVerificationProjectKind =
  | 'node'
  | 'typescript'
  | 'rust'
  | 'maven'
  | 'go'
  | 'python'
  | 'unknown';
```

Then update `src/main/operator/operator-verification-planner.ts` to import that type instead of declaring it locally:

```ts
import type { OperatorVerificationProjectKind } from '../../shared/types/operator.types';
```

Delete the local `OperatorVerificationProjectKind` export from the planner.

Before removing the planner export, verify there are no external imports:

```bash
rg "OperatorVerificationProjectKind" src packages
```

Expected today: only the planner itself references this type. `OperatorVerificationCheck` and `OperatorVerificationPlan` stay planner-local because they contain main-process command details, not renderer or contract surface area.

- [ ] **Step 3: Add result payload types**

In `src/shared/types/operator.types.ts`, add:

```ts
export type OperatorVerificationCheckStatus = 'passed' | 'failed' | 'skipped';

export interface OperatorVerificationCheckResult {
  label: string;
  command: string;
  args: string[];
  cwd: string;
  required: boolean;
  status: OperatorVerificationCheckStatus;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutExcerpt: string;
  stderrExcerpt: string;
  error: string | null;
}

export interface OperatorVerificationSummary {
  status: 'passed' | 'failed' | 'skipped';
  projectPath: string;
  kinds: OperatorVerificationProjectKind[];
  requiredFailed: number;
  optionalFailed: number;
  checks: OperatorVerificationCheckResult[];
  fallbackReason?: string;
}

export type OperatorVerificationResultEventPayload =
  Record<string, unknown> & OperatorVerificationSummary;
```

- [ ] **Step 4: Verify Task 1**

Run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.electron.json
```

Expected: pass. If imports break, fix the relative import path rather than duplicating types.

## Task 2: Implement the Verification Executor Test-First

**Files:**
- Create: `src/main/operator/operator-verification-executor.ts`
- Create: `src/main/operator/operator-verification-executor.spec.ts`

- [ ] **Step 1: Read existing operator test patterns**

Read current operator tests before creating new ones:

```bash
rg --files src/main/operator | sort
sed -n '1,260p' src/main/operator/operator-run-store.spec.ts
sed -n '1,260p' src/main/operator/operator-engine.spec.ts
```

If `operator-engine.spec.ts` does not exist, use `operator-run-store.spec.ts` and nearby service specs as style references.

- [ ] **Step 2: Write failing executor tests**

Create `src/main/operator/operator-verification-executor.spec.ts`.

Test with an injected fake command runner and a minimal fake run store that records `appendEvent()` calls. Cover:

- required check passes -> summary `passed`
- optional check fails -> summary `passed`, `optionalFailed: 1`
- required check fails -> summary `failed`, `requiredFailed: 1`
- timeout -> failed check with `timedOut: true`
- empty plan -> summary `skipped`
- each executed command appends one `shell-command` event
- each execution appends one `verification-result` event
- long-running command execution emits heartbeat `progress` events before the check timeout can race the stall detector

Use `vi.useFakeTimers()` with a deferred fake command runner for the heartbeat test: start execution, advance timers past `heartbeatIntervalMs`, assert the progress event was appended, then resolve the fake runner.

Run:

```bash
npx vitest run src/main/operator/operator-verification-executor.spec.ts
```

Expected: fail because the executor does not exist.

- [ ] **Step 3: Implement the executor skeleton**

Create `src/main/operator/operator-verification-executor.ts` with these interfaces:

```ts
import { execFile } from 'node:child_process';
import type {
  OperatorProjectRecord,
  OperatorRunNodeRecord,
  OperatorRunRecord,
  OperatorShellCommandEventPayload,
  OperatorVerificationCheckResult,
  OperatorVerificationResultEventPayload,
  OperatorVerificationSummary,
} from '../../shared/types/operator.types';
import type {
  OperatorVerificationCheck,
  OperatorVerificationPlan,
} from './operator-verification-planner';
import { getOperatorDatabase } from './operator-database';
import { planProjectVerification } from './operator-verification-planner';
import { OperatorRunStore } from './operator-run-store';

export interface OperatorVerificationCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  error: string | null;
}

export interface OperatorVerificationCommandRunner {
  run(
    command: string,
    args: string[],
    options: { cwd: string; timeoutMs: number; maxBufferBytes: number },
  ): Promise<OperatorVerificationCommandResult>;
}

export interface OperatorVerificationExecutorConfig {
  runStore?: OperatorRunStore;
  commandRunner?: OperatorVerificationCommandRunner;
  planProjectVerification?: typeof planProjectVerification;
  now?: () => number;
  maxBufferBytes?: number;
  maxExcerptChars?: number;
  heartbeatIntervalMs?: number;
}

export interface OperatorVerificationExecutionInput {
  run: OperatorRunRecord;
  node: OperatorRunNodeRecord;
  project: OperatorProjectRecord;
  plan?: OperatorVerificationPlan;
}
```

Construct the default run store the same way the existing operator services do:

```ts
this.runStore = config.runStore ?? new OperatorRunStore(getOperatorDatabase().db);
```

Do not import or call `getOperatorRunStore()`; that factory does not exist today.

Use a default command runner backed by callback-style `execFile` so failures still preserve `stdout` and `stderr`.

Default `heartbeatIntervalMs` to `60_000`. Tests should inject a much smaller interval or use fake timers instead of waiting for real 60-second ticks.

Map `execFile` outcomes exactly:

| Outcome | Detection | Result mapping |
| --- | --- | --- |
| success | no callback error | `exitCode: 0`, `timedOut: false`, `error: null` |
| non-zero exit | `typeof error.code === 'number'` | `exitCode: error.code`, `timedOut: false`, `error: error.message` |
| timeout | `error.killed === true && error.signal === 'SIGTERM'` | `exitCode: null`, `timedOut: true`, `error: Process timed out after <timeoutMs>ms` |
| max buffer exceeded | `error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` | `exitCode: null`, `timedOut: false`, `error: Output exceeded maxBuffer` |
| spawn failure | any other error | `exitCode: null`, `timedOut: false`, `error: error.message` |

- [ ] **Step 4: Implement output excerpting**

Add a small pure helper in the executor file:

```ts
function excerptOutput(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }

  const half = Math.floor(maxChars / 2);
  return `${value.slice(0, half)}\n...[truncated]...\n${value.slice(-half)}`;
}
```

Tests should verify truncation if practical, but do not overfit exact byte counts beyond deterministic behavior.

- [ ] **Step 5: Implement check execution**

For every check:

1. Append a `progress` event before command execution starts.
2. Record `startedAt = now()`.
3. Start a heartbeat timer that appends `progress` events for the verification node every 60 seconds while the command is active.
4. Run the command with `{ cwd: project.canonicalPath, timeoutMs: check.timeoutMs, maxBufferBytes }`.
5. Clear the heartbeat timer in a `finally` block.
6. Compute duration with `now()`.
7. Append a `shell-command` event with `cmd`, `args`, `cwd`, `exitCode`, `durationMs`, `stdoutBytes`, `stderrBytes`, `timedOut`, and `error`.
8. Build an `OperatorVerificationCheckResult`.

Check status rules:

- `passed` when `exitCode === 0` and `timedOut === false` and `error === null`
- `failed` otherwise
- `skipped` is only for plans with no checks, not for individual planned checks in v1

- [ ] **Step 6: Implement summary and event**

Summary rules:

- no checks -> `status: 'skipped'`, `requiredFailed: 0`, `optionalFailed: 0`
- required failures > 0 -> `status: 'failed'`
- required failures = 0 -> `status: 'passed'`

Propagate `plan.fallbackReason` into `OperatorVerificationSummary.fallbackReason` whenever it is present.

Append a final `verification-result` event using the summary payload. The top-level payload must be an object, not an array, because `OperatorRunStore.parseObject()` rejects top-level arrays when reading persisted JSON.

Do not set failed verification node status inside the executor. The engine owns verification node terminal status because it knows whether a retry will follow:

- `completed` for `passed` or `skipped`
- `failed` for a failed verification that will be followed by a fix-worker retry
- `blocked` for a terminal failed verification when no retry will follow

The executor may append events and return the summary; the engine writes the verification node's `outputJson`, `status`, `completedAt`, and `error`.

- [ ] **Step 7: Verify Task 2**

Run:

```bash
npx vitest run src/main/operator/operator-verification-executor.spec.ts
npx tsc --noEmit -p tsconfig.electron.json
```

Expected: pass.

## Task 3: Add Fix-Worker Prompt Builder

**Files:**
- Create: `src/main/operator/operator-fix-worker-prompt.ts`
- Create: `src/main/operator/operator-fix-worker-prompt.spec.ts`

- [ ] **Step 1: Write failing prompt tests**

Create tests for:

- prompt includes original goal, project display name, project path, and attempt number
- prompt includes failed required checks with command, args, exit code, timeout state, stdout excerpt, and stderr excerpt
- optional failures are labelled as optional context
- large worker output is truncated

Run:

```bash
npx vitest run src/main/operator/operator-fix-worker-prompt.spec.ts
```

Expected: fail because the builder does not exist.

- [ ] **Step 2: Implement builder types**

Create:

```ts
import type {
  OperatorProjectRecord,
  OperatorVerificationSummary,
} from '../../shared/types/operator.types';

export interface OperatorFixWorkerPromptInput {
  originalGoal: string;
  project: OperatorProjectRecord;
  attempt: number;
  previousWorkerOutputPreview: string | null;
  verification: OperatorVerificationSummary;
  maxSectionChars?: number;
}

export function buildOperatorFixWorkerPrompt(input: OperatorFixWorkerPromptInput): string {
  // implementation
}
```

- [ ] **Step 3: Implement prompt content**

The prompt should be direct and repair-focused:

```text
You are continuing a global Operator run for a project.

Original user request:
<goal>

Project:
<display name>
<path>

Repair attempt:
<attempt>

Previous worker output:
<preview or "No output preview was captured.">

Required verification failures:
...

Optional verification failures:
...

Make the smallest change that addresses the required verification failures.
Run the relevant checks when practical.
The Operator will independently rerun verification after you finish.
```

Use helper functions for command formatting and truncation.

- [ ] **Step 4: Verify Task 3**

Run:

```bash
npx vitest run src/main/operator/operator-fix-worker-prompt.spec.ts
```

Expected: pass.

## Task 4: Extend ProjectAgentExecutor for Prompt Overrides

**Files:**
- Modify: `src/main/operator/operator-project-agent-executor.ts`
- Modify existing tests or create: `src/main/operator/operator-project-agent-executor.spec.ts`

- [ ] **Step 1: Read the executor and tests**

```bash
sed -n '1,320p' src/main/operator/operator-project-agent-executor.ts
rg "ProjectAgentExecutor" -n src/main src/shared packages
```

- [ ] **Step 2: Add `promptOverride` to input**

Extend `ProjectAgentExecutionInput`:

```ts
promptOverride?: string;
```

In the current file, prompt construction is handled by the top-level `buildProjectAgentPrompt(goal, project, verificationPlan)` helper, not a private method. Preserve that helper and compute:

```ts
const initialPrompt = input.promptOverride
  ?? buildProjectAgentPrompt(input.goal, input.project, verificationPlan);
```

- [ ] **Step 3: Preserve metadata and behavior**

Do not change:

- `operatorRunId`
- `operatorNodeId`
- `operatorProjectId`
- `runStore.upsertInstanceLink()`
- `waitForInstanceSettled()`
- status mapping

The override only changes the instance initial prompt.

- [ ] **Step 4: Add or update tests**

If existing tests can inspect `createInstance()` input, assert:

- normal execution uses the existing generated prompt
- the normal generated prompt still contains `Suggested verification`
- override execution uses the exact override prompt
- metadata linking still occurs

Run the focused test file.

## Task 5: Integrate Verification into OperatorEngine

**Files:**
- Modify: `src/main/operator/operator-engine.ts`
- Modify or create: `src/main/operator/operator-engine.spec.ts`

- [ ] **Step 1: Read engine flow again**

Read `operator-engine.ts` in full before editing. Pay attention to:

- `handleProjectTaskRequest()`
- run usage updates
- budget checks
- node creation and update patterns
- progress/state events
- terminal run status handling

- [ ] **Step 2: Add executor dependency**

Add a config dependency:

```ts
verificationExecutor?: OperatorVerificationExecutorLike;
```

Define the interface near other engine-local interfaces:

```ts
interface OperatorVerificationExecutorLike {
  execute(input: OperatorVerificationExecutionInput): Promise<OperatorVerificationSummary>;
}
```

Import the executor and construct the default in the engine constructor:

```ts
this.verificationExecutor =
  config.verificationExecutor ?? new OperatorVerificationExecutor({ runStore: this.runStore });
```

- [ ] **Step 3: Create a helper for verification nodes**

Add a private method shaped like:

```ts
private async runVerificationNode(input: {
  run: OperatorRunRecord;
  project: OperatorProjectRecord;
  sourceNode: OperatorRunNodeRecord;
  attempt: number;
  runStartedAt: number;
}): Promise<{
  run: OperatorRunRecord;
  node: OperatorRunNodeRecord;
  summary: OperatorVerificationSummary;
}> {
  // create node, update usage nodesStarted, append progress, execute, update usage nodesCompleted
  // update run wallClockMs as this.now() - input.runStartedAt
}
```

Node input should include:

```ts
{
  projectId: project.id,
  projectPath: project.canonicalPath,
  sourceNodeId: sourceNode.id,
  attempt,
}
```

Use `parentNodeId: sourceNode.id` when creating the verification node.

The helper should return the summary without deciding whether a failed verification node is `failed` or `blocked`. The caller must decide that after checking retry budget.

Always compute run usage `wallClockMs` from the original run start timestamp, not from the verification node start time. The existing engine convention writes `wallClockMs: completedAt - startedAt`, where `startedAt` is the run start.

- [ ] **Step 4: Complete runs based on verification**

After the initial project-agent node finishes:

- if project-agent result is not `completed`, keep existing failure behavior for now
- run the verification node
- if summary is `passed` or `skipped`, complete the run
- if summary is `failed`, mark the verification node `blocked` and block the run until Task 6 adds retry

Blocked reason should be human-readable, for example:

```text
Verification failed for <project>; retry support has not run or retry budget was exhausted.
```

- [ ] **Step 5: Write engine tests for no-retry verification**

Use fake project-agent and verification executors. Cover:

- project-agent completed plus verification passed -> run completed
- project-agent completed plus verification skipped -> run completed
- project-agent completed plus verification failed and no retries -> run blocked
- verification node has `parentNodeId` equal to project-agent node id
- existing exact event-kind sequence assertions for project-agent runs are updated to include the verification progress, `verification-result`, and state-change events
- any audit-event assertion for project-agent runs is updated so verification events are asserted intentionally rather than papered over

Run:

```bash
npx vitest run src/main/operator/operator-engine.spec.ts
```

Expected: pass before moving to retry loop.

## Task 6: Add Bounded Fix-Worker Retry Loop

**Files:**
- Modify: `src/main/operator/operator-engine.ts`
- Modify: `src/main/operator/operator-engine.spec.ts`

- [ ] **Step 1: Add retry decision helper**

Add a private helper:

```ts
private canStartFixAttempt(run: OperatorRunRecord): { allowed: true } | { allowed: false; reason: string } {
  // checks maxRetries, maxNodes, wall clock
}
```

Use `usageJson.retriesUsed` and `budget.maxRetries`.

The pre-flight budget check must reserve the full fix attempt, not only the fix worker:

```ts
const breach = evaluateOperatorBudget(run, {
  nodesToStart: 2,
  retriesToUse: 1,
});
```

This reserves both the fix-worker project-agent node and the follow-up verification node. If this check fails, mark the current failed verification node `blocked` and block the run.

If the existing engine already has a budget helper, extend it rather than introducing duplicate budget logic.

- [ ] **Step 2: Add project work loop**

Refactor `handleProjectTaskRequest()` so the project portion is loopable:

```text
run initial project-agent
run verification
while verification failed:
  if retry blocked -> block run
  mark failed verification node as failed because a retry will follow
  increment retry usage
  build fix prompt
  run fix-worker project-agent with promptOverride
  if fix worker did not complete -> fail run and do not run verification
  run verification
complete when verification passed or skipped
```

All node executions in this loop must write run `wallClockMs` as `this.now() - runStartedAt`, with `runStartedAt` captured at the entry of `handleProjectTaskRequest()`.

The fix-worker project-agent node should use:

- `parentNodeId` equal to the failed verification node id
- input JSON that records `attempt`, `projectId`, `projectPath`, and `repairForVerificationNodeId`
- a display/progress label that distinguishes it from the initial worker

- [ ] **Step 3: Increment usage accurately**

Usage counters should reflect actual work:

- `nodesStarted`: increment when a node is created to run work
- `nodesCompleted`: increment when a node reaches terminal state, including `completed`, `failed`, or `blocked`
- `retriesUsed`: increment before starting a fix worker
- `wallClockMs`: preserve existing run-start-based behavior, so each update writes `now - runStartedAt`

Do not increment retry usage for the initial project-agent.

- [ ] **Step 4: Build and pass fix prompt**

Use `buildOperatorFixWorkerPrompt()` with:

- original goal from the parsed request
- project record
- attempt number starting at 1
- previous worker output preview from latest project-agent result
- failed verification summary

Pass it to `ProjectAgentExecutor.execute({ promptOverride })`.

Read the previous worker output preview from the latest project-agent node with a guard:

```ts
function readProjectAgentOutputPreview(node: OperatorRunNodeRecord): string | null {
  const preview = node.outputJson?.['outputPreview'];
  return typeof preview === 'string' ? preview : null;
}
```

- [ ] **Step 5: Add retry tests**

Cover:

- first verification fails, fix worker runs, second verification passes -> run completed
- retry budget `maxRetries: 0` -> run blocked after first failed verification
- retry budget `maxRetries: 1`, second verification fails -> run blocked
- maxNodes budget prevents fix worker -> run blocked with budget reason
- wall-clock budget exceeded mid-retry-chain -> run blocked with budget reason
- fix-worker result status `failed` -> run failed and no follow-up verification node is created
- fix-worker prompt override is passed to the project-agent executor
- retry usage increments exactly once per fix worker

Run:

```bash
npx vitest run src/main/operator/operator-engine.spec.ts
```

Expected: pass.

## Task 7: Barrel Exports, Persistence, and Event Review

**Files:**
- Modify: `src/main/operator/index.ts`
- Modify only if needed: `src/main/operator/operator-run-store.ts`
- Modify only if needed: `src/shared/types/operator.types.ts`

- [ ] **Step 1: Update operator barrel exports**

Update `src/main/operator/index.ts` to export:

- `OperatorVerificationExecutor`
- `OperatorVerificationExecutionInput`
- `OperatorVerificationExecutorConfig`
- `OperatorVerificationCommandRunner`
- `OperatorVerificationCommandResult`
- `buildOperatorFixWorkerPrompt`
- `OperatorFixWorkerPromptInput`

Do not export `OperatorVerificationCheck` or `OperatorVerificationPlan` from the shared type barrel; they remain planner-local main-process types.

- [ ] **Step 2: Confirm stalled-node progress compatibility**

Read `listStalledNodes()` in `operator-run-store.ts`. Verify these events are still treated as progress:

- `progress`
- `shell-command`
- `instance-spawn`
- `verification-result`

If `verification-result` is already included, do not change the store.

- [ ] **Step 3: Confirm output JSON is serializable**

Ensure verification summaries contain only JSON-serializable values:

- strings
- numbers
- booleans
- arrays
- plain objects
- null

Do not persist `Error` instances or buffers.

- [ ] **Step 4: Confirm top-level payloads are objects**

`OperatorRunStore.parseObject()` returns the fallback for top-level arrays. Ensure every `inputJson`, `outputJson`, `resultJson`, and event payload written by this feature is wrapped in an object.

- [ ] **Step 5: Confirm audit events avoid full output**

Review executor payloads:

- `shell-command` events should include byte counts, duration, exit code, timeout state, and error string
- `verification-result` should include excerpts, not unbounded output

Add tests if this is not covered by executor specs.

## Task 8: Focused Validation

- [ ] **Step 1: Run focused operator tests**

```bash
npx vitest run src/main/operator/operator-verification-executor.spec.ts src/main/operator/operator-fix-worker-prompt.spec.ts src/main/operator/operator-engine.spec.ts
```

- [ ] **Step 2: Run main-process typecheck**

```bash
npx tsc --noEmit -p tsconfig.electron.json
```

- [ ] **Step 3: Run spec typecheck**

```bash
npx tsc --noEmit -p tsconfig.spec.json
```

Expected: all pass before full validation.

## Task 9: Full Validation

Run the full project gates required by `AGENTS.md`:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.electron.json
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run verify:ipc
npm run check:contracts
npm run test
git diff --check
```

Expected: all pass.

If `npm run test` fails because an existing unrelated test is flaky, rerun the failed test once and document the exact failure. Do not claim completion without clear verification evidence.

## Implementation Notes

- Keep verification execution in the main process only.
- Use `execFile`, not shell strings.
- Keep the planner as the only source of verification commands in this wave.
- Do not introduce renderer UI changes unless a type or contract requires it.
- Do not create a separate fix-worker executor unless reuse through `ProjectAgentExecutor` becomes materially awkward.
- Keep optional verification failures visible but non-blocking.
- Treat retry exhaustion as `blocked`, not `failed`.
- Keep unknown-project verification as `skipped` for v1.
- Use `const` by default and constructor generics for new collections, matching `AGENTS.md` project style.
