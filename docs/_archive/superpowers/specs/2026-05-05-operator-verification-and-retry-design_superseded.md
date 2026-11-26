# Operator Verification and Retry Design

**Date:** 2026-05-05
**Status:** Superseded on 2026-05-07
**Scope:** Add independent verification and bounded fix-worker retry loops to global Operator project work.

Do not implement this design as written. It targets the removed global `OperatorEngine` architecture. The replacement direction is the persistent Chats collection in `docs/superpowers/specs/2026-05-06-chats-collection-design_completed.md`, with deterministic work represented as explicit structured tools and audit runs.

## Summary

The current global Operator can accept a project-level request, spawn a project agent, and persist the run graph. The next architectural step is to stop treating the worker's final message as proof that the work is correct.

Project work should become:

1. Resolve the target project.
2. Spawn a project-agent node to do the requested work.
3. Spawn a separate verification node that runs deterministic checks for that project.
4. If required checks pass, complete the run.
5. If required checks fail and retry budget remains, spawn a fix-worker node with the failure context, then verify again.
6. If verification still fails after the retry budget is exhausted, block the run with a clear persisted reason.

This keeps autonomy real while preserving reviewability. The Operator is allowed to continue working, but every command, result, retry, and block reason remains queryable through the run store.

## Goals

- Independently verify project-agent work instead of relying on prompt instructions.
- Persist verification as first-class `verification` nodes in the operator run graph.
- Record `shell-command` and `verification-result` events for auditability.
- Use the existing `OperatorVerificationPlanner` for project-type detection and safe default commands.
- Enforce command timeouts, output limits, run budgets, node budgets, and retry budgets.
- Provide fix workers with enough failure context to repair the specific issue.
- Keep verification behavior deterministic and testable.

## Non-Goals

- Do not add a general arbitrary shell executor.
- Do not add auto-commit, push, branch creation, or PR creation.
- Do not implement full multi-project synthesis in this wave.
- Do not redesign the renderer progress UI in this wave.
- Do not replace the project-agent executor with a new provider stack.
- Do not make unknown projects fail solely because no automated checks were detected.

## Existing App Context

These pieces already exist and should be reused:

- `src/main/operator/operator-engine.ts` routes global Operator messages into git-batch and project-agent runs.
- `src/main/operator/operator-project-agent-executor.ts` creates project-scoped instances and waits for `InstanceManager.waitForInstanceSettled()`.
- `src/main/operator/operator-verification-planner.ts` detects common project types and returns command plans.
- `src/main/operator/operator-run-store.ts` persists runs, nodes, parent node links, usage, budgets, and events.
- `src/shared/types/operator.types.ts` already defines `verification` as an operator node type and `verification-result` as an event kind.
- `OperatorRunBudget.maxRetries`, `maxNodes`, `maxWallClockMs`, and `maxConcurrentNodes` already exist and should become load-bearing.

Today, `ProjectAgentExecutor` includes suggested verification text in the worker prompt. That remains useful context for the worker, but it must not be the only verification mechanism.

## Architecture

### New Verification Executor

Add `OperatorVerificationExecutor` under `src/main/operator/`.

Responsibilities:

- Accept a run, verification node, project record, and optional precomputed `OperatorVerificationPlan`.
- Run each planned check with `execFile`, never with a shell string.
- Use the check's `timeoutMs`.
- Use bounded stdout/stderr buffers and store excerpts rather than unlimited output.
- Append heartbeat `progress` events while long-running commands are active.
- Append a `shell-command` event for every command.
- Append a `verification-result` event with a structured summary.
- Return a typed `OperatorVerificationSummary`.
- Leave verification node terminal status decisions to `OperatorEngine`, because only the engine knows whether a retry will follow.

The executor should be dependency-injected with:

- `runStore`
- `planProjectVerification`
- `commandRunner`
- `now`
- `heartbeatIntervalMs`

`commandRunner` should default to an `execFile` wrapper, but tests should inject a fake runner.

### Verification Result Model

Move the project kind type into shared operator types so persisted event payloads and main-process planning agree on one vocabulary:

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

Add shared result types:

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

Only `OperatorVerificationProjectKind` should move to shared types. `OperatorVerificationCheck` and `OperatorVerificationPlan` stay main-process local because they contain executable command details and should not become renderer/contract surface area.

### Command Policy

Verification commands must come from `OperatorVerificationPlanner` in this wave.

Allowed execution behavior:

- `execFile(command, args, { cwd, timeout, maxBuffer })`
- no shell interpolation
- no pipelines
- no redirects
- no implicit interactive prompts
- bounded output capture
- timeout mapped to a failed check with `timedOut: true`
- progress heartbeat while a command is running, at least once every 60 seconds

Recommended default output policy:

- Capture stdout and stderr byte counts.
- Store an excerpt that keeps the first and last sections of each stream.
- Limit each excerpt to a small deterministic size, such as 8 KB.
- Limit each process stream buffer, such as 1 MB, to prevent memory blowups.

`execFile` failure mapping must be deterministic:

| Node outcome | Detection | `timedOut` | `exitCode` | `error` |
| --- | --- | --- | --- | --- |
| successful exit | no error | `false` | `0` | `null` |
| non-zero exit | `typeof error.code === 'number'` | `false` | numeric `error.code` | error message |
| timeout | `error.killed === true` and `error.signal === 'SIGTERM'` after timeout | `true` | `null` | `Process timed out after <timeoutMs>ms` |
| max buffer exceeded | `error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'` | `false` | `null` | `Output exceeded maxBuffer` |
| spawn failure | any other error before exit | `false` | `null` | error message |

### Run Graph Flow

For a `project_feature` or `project_audit` intent:

```text
run
  project-agent node
    verification node
      fix-worker project-agent node, if needed
        verification node
```

The engine should create verification nodes after project-agent completion. Verification node input should include:

- `projectId`
- `projectPath`
- `sourceNodeId`
- `attempt`

Verification node output should be the `OperatorVerificationSummary`.

Do not persist `OperatorVerificationPlan` in verification node `inputJson`. The executor can receive a precomputed plan in memory, but persisted node input should avoid storing executable command details.

Verification node status is assigned by the engine:

- `completed` when required checks pass or verification is skipped.
- `failed` when required checks fail and a fix-worker retry will follow.
- `blocked` when required checks fail and no retry will follow.

If the planner returns no checks:

- create the verification node anyway
- append a `verification-result` event with `status: 'skipped'`
- complete the run if the project agent completed successfully
- surface the fallback reason in the transcript/progress events

Unknown projects should not be blocked by default in this wave. The Operator can still make useful changes in repositories that have no recognized automated test command.

### Retry Policy

A failed required check should trigger a fix worker only when all of these are true:

- the latest project-agent node completed
- the run is still within `maxWallClockMs`
- starting the full fix attempt will not exceed `maxNodes`
- `usage.retriesUsed < budget.maxRetries`

Each fix attempt consumes:

- one retry from `usage.retriesUsed`
- one project-agent node
- one verification node

Before starting the fix worker, the engine must reserve the whole attempt atomically with `evaluateOperatorBudget(run, { nodesToStart: 2, retriesToUse: 1 })`. If budget would be exceeded, the current failed verification node and the run become `blocked`.

If a fix-worker project-agent node returns any status other than `completed`, the engine must not run a follow-up verification node. It should terminally fail the run with a clear worker failure reason, because there is no new completed work to verify.

Operator cancellation is not part of v1 retry gating. A later cancellation wave can add a persisted cancellation flag or query and include it in this decision.

### Fix Worker Prompt

Create a small prompt builder rather than formatting a complex prompt inline in the engine.

The fix prompt must include:

- original user request
- resolved project display name and path
- attempt number
- previous project-agent output preview
- failed required checks
- command, args, exit code, timeout state, stdout excerpt, stderr excerpt
- explicit instruction to make the smallest repair that addresses verification failure
- explicit instruction to run the relevant checks when possible
- reminder that the Operator will independently rerun verification afterward

Optional check failures should be included as context, but they should not drive retry by themselves.

The previous worker output preview should be read from the latest project-agent node at `outputJson.outputPreview` only when that field is a string. Missing or non-string values should become `null`.

### ProjectAgentExecutor Extension

Keep one executor for normal project work and fix-worker project work. Add a narrow input option:

```ts
promptOverride?: string;
```

When present, `ProjectAgentExecutor` uses the override as the instance `initialPrompt`; otherwise it uses the existing project-agent prompt.

This avoids duplicating instance creation, metadata linking, settle waiting, and recovery behavior.

### Run Status Semantics

- `completed`: project-agent work completed and all required verification checks passed, or verification was skipped because no checks were available.
- `blocked`: required verification checks failed after retry budget was exhausted, or budget prevented the next retry.
- `cancelled`: user or supervisor cancellation stopped the run.
- `failed`: unexpected infrastructure failure prevented the Operator from producing a meaningful blocked/completed state.

The distinction matters. A bad TypeScript error after all retries is a blocked task with evidence, not an infrastructure crash.

Node status has one extra convention: an intermediate verification node may be `failed` while the run remains `running` because a fix-worker retry is already scheduled. Renderer and CLI consumers should use the run status to decide whether the whole run is terminal.

Fix-worker non-completion is treated as a `failed` run, not `blocked`, because there is no completed repair to verify against.

### Audit Events

Use existing operator events:

- `shell-command`: one event per verification check command.
- `verification-result`: one event per verification node summary.
- `progress`: human-readable milestone events.
- `state-change`: run and node state changes.

For command events, payload should include:

```ts
{
  cmd: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  stdoutBytes: number;
  stderrBytes: number;
  timedOut?: boolean;
  error?: string;
}
```

Do not persist full unbounded command output in `shell-command` events. Store excerpts in the verification result payload.

### Stuck-Node Interaction

`operator-run-store.ts` already treats `verification-result`, `shell-command`, and `instance-spawn` as progress events for stalled-node detection. The verification executor should append at least one progress event before long-running command execution begins, then append heartbeat progress events at a fixed interval while the command is active, then append shell-command events when commands end.

For a command timeout, the verification node should finish with a failed summary rather than relying on the stuck-node detector.

## Testing Strategy

### Unit Tests

Add executor tests with injected fake command runners:

- required check passes -> summary `passed`
- optional check fails -> summary `passed` with `optionalFailed: 1`
- required check fails -> summary `failed`
- command timeout -> required failure with `timedOut: true`
- no checks -> summary `skipped`
- shell-command and verification-result events are persisted
- long-running checks emit heartbeat progress events while the process is active

Add prompt-builder tests:

- includes original goal, project path, attempt number, and failed command summaries
- truncates large stdout/stderr excerpts
- does not include unrelated optional failures as primary retry cause

Add engine tests:

- project-agent success plus verification pass -> run completed
- project-agent success plus required verification failure with retry budget -> fix worker is spawned
- fix worker success plus verification pass -> run completed
- fix worker failure -> run failed without a follow-up verification node
- verification failure after retry budget -> run blocked
- no verification checks -> run completed with skipped verification node
- budget maxNodes prevents retry -> run blocked with budget reason

### Validation Commands

After implementation, run:

```bash
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.electron.json
npx tsc --noEmit -p tsconfig.spec.json
npm run lint
npm run verify:ipc
npm run check:contracts
npm run test
```

Because this touches main-process command execution, also run focused tests while developing:

```bash
npx vitest run src/main/operator/operator-verification-executor.spec.ts
npx vitest run src/main/operator/operator-engine.spec.ts
```

## Rollout

### Wave A: Result Types and Executor

- Move project kind into shared operator types.
- Add verification summary/result types.
- Implement `OperatorVerificationExecutor`.
- Add focused executor tests.

### Wave B: Engine Integration

- Add `verificationExecutor` to `OperatorEngine` config.
- Create verification nodes after project-agent nodes.
- Complete, block, or skip based on verification summary.
- Add engine tests for pass, fail, and skipped verification.

### Wave C: Fix-Worker Retry Loop

- Add fix prompt builder.
- Add `promptOverride` to `ProjectAgentExecutor`.
- Add bounded retry loop in `OperatorEngine`.
- Persist retry usage increments.
- Add retry and budget tests.

### Wave D: Full Validation

- Run full TypeScript, lint, contracts, IPC, and test validation.
- Review the operator run graph for readability in persisted events.
- Leave UI polish for a later wave unless the existing transcript output is insufficient to understand blocked verification.

## Open Questions

1. Should unknown projects eventually block and ask the user for a verification command, or should they always be allowed to complete with skipped verification?
2. Should the Operator expose a per-run override for `maxRetries`, or should the first UI use the default budget only?
3. Should verification support package-manager detection beyond npm, such as pnpm/yarn/bun, in the first executor implementation?

Recommended v1 answers:

- Unknown projects complete with skipped verification but clear evidence.
- Use default budgets only.
- Keep existing npm-based planner behavior first, then extend package-manager detection after the executor is proven.
