# Global Operator Control Plane Design

**Date:** 2026-05-04
**Status:** Superseded by `2026-05-06-chats-collection-design_completed.md`
**Scope:** Add a persistent top-level Orchestrator conversation that sits above project sessions and can autonomously delegate work across projects, repos, workflows, and direct workspace operations.

## Supersession Note

This design is intentionally not marked `_completed`. Its deterministic global conversation engine, regex planner, and canned acknowledgement path were superseded by the Chats Collection design on 2026-05-06. The later design keeps the durable operator run graph, event bus, project store, and `git-batch` executor, but repositions them as tools that real provider-backed chats can invoke.

Implementation now lives in:

- `docs/superpowers/specs/2026-05-06-chats-collection-design_completed.md`
- `src/main/chats/`
- `src/main/mcp/orchestrator-tools.ts`
- retained operator run audit modules under `src/main/operator/`

## Summary

AI Orchestrator should have a first-class global conversation named Orchestrator. This conversation is not tied to a project working directory. It owns the user's high-level intent, discovers target projects, creates an execution plan, delegates work to project-bound agents or mechanical executors, supervises progress, verifies outcomes, and reports back in the same persistent thread.

The best architecture is a new Global Operator Control Plane above the current project/session layer. The control plane reuses existing systems instead of replacing them:

- `ConversationLedgerService` for persistent global transcript storage.
- `InstanceManager` for provider-backed project worker sessions.
- `RepoJobService` for repo audits and implementation jobs.
- `WorkflowManager` for structured project work.
- `BackgroundTaskManager` for long-running task execution.
- `RecentDirectoriesManager` and VCS helpers for project discovery.
- Child result storage, orchestration HUD patterns, and session continuity for supervision and recovery.

The core rule is:

**The global conversation owns intent and supervision. Project sessions and jobs own local execution.**

## Glossary

- **Operator**: the internal global control-plane engine, IPC namespace, persistence layer, and TypeScript code. New code should use `operator` names for this subsystem.
- **Orchestrator**: the user-visible label for the global conversation in the sidebar and transcript. It should appear in UI copy, not as the internal subsystem namespace.
- **Orchestration**: the existing parent-child instance coordination subsystem inside a project/session, including verification, debate, cascade, child agents, and the orchestration HUD. Do not reuse this term for the new global control plane.

## Goals

- Add a persistent global Orchestrator conversation in the main UI, visually above all project groups.
- Let the user submit natural-language requests that are not scoped to the currently selected project.
- Resolve project references such as "AI Orchestrator", "the dingley project", or "all repos in my work folder".
- Default to full autonomy for normal work: investigate, plan, edit, run commands, pull repos, create worktrees, run tests, and delegate without asking for routine approval.
- Keep all work durable and inspectable through a run graph, transcript events, child sessions, artifacts, and final summaries.
- Continue execution until success criteria are met, verification fails with a concrete blocker, or a hard safety policy blocks the operation.
- Preserve user work by respecting dirty worktrees, using isolated worktrees for implementation where appropriate, and never silently discarding local changes.
- Make restart recovery possible: active operator runs should be reconstructable after app restart.
- Keep the design aligned with the existing Electron main process, Angular renderer, TypeScript contracts, Zod IPC schemas, and SQLite persistence patterns.

## Non-Goals

- Do not replace normal project conversations. Project sessions remain the right surface for focused local work.
- Do not turn repo jobs into a chat system. Repo jobs remain execution units underneath the global operator.
- Do not bypass the app's security, path, and permission systems. Full autonomy means no routine user approval for ordinary work, not unrestricted destructive access.
- Do not make the first implementation depend on a single provider. The operator should be provider-aware but not provider-owned.
- Do not require native write-back into external provider apps for the global conversation.
- Do not build a marketing-style landing page or separate assistant UI. This belongs in the main working interface.

## Existing App Context

The current app already has most of the lower-level machinery:

- `src/shared/types/instance.types.ts` models root and child instances, provider identity, working directories, parent-child hierarchy, output buffers, session recovery, yolo mode, and metadata.
- `src/main/instance/instance-manager.ts` and `src/main/instance/instance-lifecycle.ts` create project-bound provider sessions, spawn children, send input, track output, and recover sessions.
- `src/main/repo-jobs/repo-job-service.ts` can launch PR review, issue implementation, and repo health audit jobs as background instances, then wait for the instance to settle and persist structured results.
- `src/main/workflows/workflow-manager.ts` owns templates, phases, gates, agent invocation events, and active workflow persistence per instance.
- `src/main/tasks/background-task-manager.ts` provides queueing, progress, cancellation, concurrency, and typed executors.
- `src/main/core/config/recent-directories-manager.ts` stores known project directories, pins, access counts, and manual order.
- `src/main/workspace/git/vcs-manager.ts` detects Git repositories, status, branches, diffs, remotes, and history.
- `src/main/conversation-ledger/` already has a SQLite-backed conversation ledger with provider `orchestrator` in the shared type union, message storage, source metadata, sync status, and IPC handlers.
- `src/renderer/app/features/instance-list/instance-list.component.*` already renders the project index and groups live/history sessions by working directory.
- `src/renderer/app/features/instance-detail/` already provides the main transcript, composer, inspector panels, child agent panel, orchestration HUD, and new-session welcome surface.

The missing layer is not another project session. It is a durable global coordinator that can use those systems together.

## Product Model

### Global Orchestrator Conversation

The UI gets a pinned "Orchestrator" item above the Projects list. Selecting it opens a normal transcript/composer surface, but its scope is global instead of project-bound.

The global conversation can contain:

- user messages,
- operator planning messages,
- delegated run cards,
- project target chips,
- child worker updates,
- mechanical job progress,
- verification results,
- final summaries,
- recoverable error messages.

The transcript is persistent across app restarts. It should use the conversation ledger with:

- `provider: "orchestrator"`,
- `sourceKind: "orchestrator"`,
- `workspacePath: null`,
- metadata such as `scope: "global"` and `operatorThreadKind: "root"`.

The existing `ConversationLedgerService` currently only starts writable native Codex conversations. This design extends it with an internal orchestrator thread path rather than creating a second unrelated transcript database.

The first implementation should keep this extension small:

- update `ConversationLedgerStartPayloadSchema` so `provider` accepts `"orchestrator"` as well as `"codex"`;
- remove or generalize the `request.provider !== 'codex'` guard in `ConversationLedgerService.startConversation()`;
- register an `InternalOrchestratorConversationAdapter` implementing `NativeConversationAdapter`.

No new transcript tables or ledger migrations are required for the global conversation. The operator run graph is stored separately, but the transcript remains in the existing ledger.

### Operator Runs

Each user request that requires work creates an `OperatorRun`. A run is a durable graph of steps connected to the global conversation message that started it.

Examples:

- "In AI Orchestrator, allow voice conversations, please implement it."
- "Go through all the code in the dingley project and create a list of improvements."
- "Pull all the repos in my work folder."

The run graph records how the operator interpreted the request, which targets it selected, what it delegated, what succeeded, what failed, and how it verified the result.

### Full Autonomy Policy

Default behavior is full-auto for normal software work:

- read files,
- search projects,
- run Git status/fetch/pull with safe defaults,
- create branches or worktrees,
- edit code,
- run builds, tests, typecheck, and lint,
- launch worker sessions,
- run repo jobs,
- retry failed verification with a fix worker,
- summarize and persist results.

Hard safety rails remain:

- no silent deletion of projects,
- no `git reset --hard`, `git clean`, force push, or destructive branch deletion unless the user's request explicitly names that destructive action,
- no overwriting dirty user changes outside an isolated worktree,
- no secret exfiltration or network use outside configured policy,
- no privilege escalation outside the app's permission model,
- no hidden infinite loops after repeated failure.

This gives the requested autonomy without making the app reckless.

## Architecture

### 1. Operator Engine

Create a main-process service:

`src/main/operator/operator-engine.ts`

Responsibilities:

- accept a global user message,
- persist it to the global conversation ledger,
- classify the request,
- resolve target projects,
- build an execution graph,
- enqueue executable nodes,
- subscribe to node progress,
- decide next steps after each node settles,
- append status and summary messages to the global transcript,
- recover active runs after restart.

The engine should be event-driven. It should not block IPC while work runs. Sending a message returns the updated thread and run id; progress streams back through operator events.

### 2. Operator Planner

Create a planner module:

`src/main/operator/operator-planner.ts`

Responsibilities:

- classify broad intents,
- decide whether a request is conversational, project-bound, multi-project, mechanical, or mixed,
- choose a target resolver strategy,
- choose executor types,
- define success criteria,
- estimate concurrency and risk.

Initial intent types:

- `global_question`: answer from existing context without launching work.
- `project_feature`: implement a feature in one project.
- `project_audit`: inspect a project and produce findings.
- `workspace_git_batch`: run Git operations across many repos.
- `cross_project_research`: inspect multiple projects and synthesize.
- `ambiguous`: run discovery first, then continue automatically.

Future intent types should be designed separately:

- `automation_request`: create or update automations through the existing automation channels.
- `operator_maintenance`: maintain the operator subsystem itself. In the initial implementation, "change AI Orchestrator" is just `project_feature` with the AI Orchestrator project as the target.

The planner can start with deterministic heuristics and later use a local or configured model for better classification. Its output must be stored as data, not only prose.

### 3. Project Registry

Create a durable project registry:

`src/main/operator/project-registry.ts`

Responsibilities:

- maintain known projects from recent directories, pinned projects, active instances, conversation ledger workspace paths, configured roots, and discovered Git repos,
- scan workspace roots such as `/Users/suas/work` with ignore rules,
- normalize and de-duplicate Git roots,
- store aliases and confidence scores,
- resolve names used in prompts.

Suggested record:

```ts
export interface ProjectRecord {
  id: string;
  canonicalPath: string;
  displayName: string;
  aliases: string[];
  source: 'recent-directory' | 'active-instance' | 'conversation-ledger' | 'scan' | 'manual';
  gitRoot: string | null;
  remotes: Array<{ name: string; url: string }>;
  currentBranch: string | null;
  isPinned: boolean;
  lastSeenAt: number;
  lastAccessedAt: number | null;
  metadata: Record<string, unknown>;
}
```

Alias source of truth:

- auto-derived aliases from package metadata (`package.json` name), README H1, directory basename, Git root basename, and remote origin owner/repo names;
- manual aliases edited through a project edit dialog later in the rollout;
- high-confidence planner resolutions can propose a new alias event, but the registry should not silently add planner-inferred aliases until they are confirmed by either repeated use or user edit.

Resolution rules:

- exact alias/path match wins,
- pinned and recent projects rank higher,
- Git root display name ranks higher than nested directories,
- ambiguous matches trigger an internal discovery node that can inspect candidates and choose based on context,
- if still ambiguous, the operator records a blocked run with the candidate list instead of guessing dangerously.

### 4. Operator Run Graph

Create a durable store:

`src/main/operator/operator-run-store.ts`

Use SQLite under app `userData`, following the conversation ledger and repo job store patterns. The graph should survive app restart.

Core types:

```ts
export type OperatorRunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export type OperatorNodeType =
  | 'plan'
  | 'discover-projects'
  | 'project-agent'
  | 'repo-job'
  | 'workflow'
  | 'git-batch'
  | 'shell'
  | 'verification'
  | 'synthesis';

export interface OperatorRunRecord {
  id: string;
  threadId: string;
  sourceMessageId: string;
  title: string;
  status: OperatorRunStatus;
  autonomyMode: 'full';
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  goal: string;
  budget: {
    maxNodes: number;
    maxRetries: number;
    maxWallClockMs: number;
    maxTokens?: number;
    maxConcurrentNodes: number;
  };
  usageJson: {
    nodesStarted: number;
    nodesCompleted: number;
    retriesUsed: number;
    tokensUsed?: number;
    wallClockMs: number;
  };
  planJson: Record<string, unknown>;
  resultJson: Record<string, unknown> | null;
  error: string | null;
}

export interface OperatorRunNodeRecord {
  id: string;
  runId: string;
  parentNodeId: string | null;
  type: OperatorNodeType;
  status: OperatorRunStatus;
  targetProjectId: string | null;
  targetPath: string | null;
  title: string;
  inputJson: Record<string, unknown>;
  outputJson: Record<string, unknown> | null;
  externalRefKind: 'instance' | 'repo-job' | 'workflow' | 'task' | 'worktree' | null;
  externalRefId: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  error: string | null;
}
```

The flexible `Record<string, unknown>` fields are for storage compatibility only. IPC callers and executors should use per-node-type discriminated Zod schemas in `packages/contracts/src/schemas/operator.schemas.ts`, and the run store should validate `planJson`, `inputJson`, `outputJson`, event payloads, and budget updates at write time.

Every node appends events for progress and auditability. The transcript renders a friendly summary; the store keeps the complete structured state.

Operator event kinds should include:

```ts
export type OperatorRunEventKind =
  | 'state-change'
  | 'progress'
  | 'shell-command'
  | 'fs-write'
  | 'instance-spawn'
  | 'verification-result'
  | 'recovery'
  | 'budget';
```

Audit payload expectations:

- `shell-command`: `{ cmd, args, cwd, exitCode, durationMs, stdoutBytes, stderrBytes }`
- `fs-write`: `{ path, bytesWritten, sha256, kind: 'create' | 'modify' | 'delete' }`
- `instance-spawn`: `{ instanceId, provider, workingDirectory, operatorRunId, operatorNodeId }`
- `verification-result`: `{ command, cwd, passed, exitCode, durationMs, summary }`

Shell command events store command names and argument arrays, not shell strings. Output should be summarized by byte counts and artifact references rather than dumping full stdout/stderr into the event table.

### 5. Executor Layer

Create a common executor interface:

```ts
export interface OperatorExecutor<TInput, TOutput> {
  readonly type: OperatorNodeType;
  canRun(node: OperatorRunNodeRecord): boolean;
  run(node: OperatorRunNodeRecord, context: OperatorExecutionContext): Promise<TOutput>;
  cancel(node: OperatorRunNodeRecord): Promise<void>;
}
```

### 5.1 Intent To Executor Routing

Routing must be explicit so repo jobs are not mistaken for the generic implementation path.

| Intent | Primary executor | Notes |
| --- | --- | --- |
| `global_question` | Synthesis executor | Uses existing context; no run graph needed unless the answer requires discovery. |
| `project_audit` | Repo Job Executor | Maps to `repo-health-audit`; can fan out to project agents for very large repos. |
| `project_feature` | Project Agent Executor | Uses `InstanceManager.createInstance()`, optionally with `WorkflowManager`; do not route through `issue-implementation` unless there is a real issue-style payload. |
| `workspace_git_batch` | Git Batch Executor | Mechanical Git operations with direct `execFile`-style calls and bounded concurrency. |
| `cross_project_research` | Project Agent Executor -> Synthesis Executor | One bounded worker per resolved project, then a synthesis node. |
| `ambiguous` | Discover Projects Executor -> routed intent | Discovery should resolve the target and continue automatically when confidence is high. |

Initial executors:

#### 5.2 Project Agent Executor

Uses `InstanceManager.createInstance()` to launch a project-bound worker session.

Use for implementation and broad project reasoning. The worker prompt should include:

- global user request,
- resolved project path,
- autonomy policy,
- expected output,
- verification requirements,
- instruction to respect dirty changes and repo conventions.

For larger implementation tasks, prefer an isolated worktree and a workflow template. For narrow tasks, a normal project worker can be sufficient.

#### 5.3 Repo Job Executor

Wraps `RepoJobService.submitJob()` and watches the resulting job.

Use for:

- repo health audits,
- issue-style implementation,
- PR review-style work.

This preserves the existing background job page and remote observer integration.

#### 5.4 Git Batch Executor

Runs mechanical Git operations across many repos. This requires a real Git batch capability; it is more than a cosmetic wrapper around the current `VcsManager`.

Preferred implementation: extend `src/main/workspace/git/vcs-manager.ts` with bounded write operations:

- `findRepositories(root, ignorePatterns)`,
- `fetch(options)`,
- `pullFastForward(options)`.

These should use `execFile`/`execFileSync` with argument arrays, never shell strings. The scan should avoid `.git`, `node_modules`, package manager caches, build output, dependency directories, and configured ignore patterns. If keeping `VcsManager` read-only becomes a stronger local convention, introduce `src/main/workspace/git/git-batch-service.ts` instead; it should still reuse VCS status helpers where possible.

Default pull behavior:

- discover Git repos,
- skip repos with no remote,
- run `git fetch --prune`,
- check dirty state,
- if clean and tracking branch exists, run `git pull --ff-only`,
- if dirty, skip and report,
- if divergent or conflict-prone, skip and report,
- summarize per repo.

This is safer and more useful than launching an LLM worker for every `git pull`.

The Git Batch Executor should use an internal semaphore for per-batch parallelism instead of depending on `BackgroundTaskManager` for each individual repo. The batch node itself can run as one background task with low priority, while the executor enforces its own cap, for example six concurrent Git repos by default.

#### 5.5 Verification Executor

Runs task-specific checks:

- TypeScript project: `npx tsc --noEmit`, `npx tsc --noEmit -p tsconfig.spec.json`, lint, targeted tests.
- Unknown project: inspect project metadata first, then run the smallest relevant checks.
- Audit job: require a structured findings list and optionally run static checks.
- Git batch: verify final ahead/behind/status for each repo.

Project-type detection order:

1. `package.json`
2. `tsconfig.json`
3. `Cargo.toml`
4. `pom.xml` / `build.gradle`
5. `go.mod`
6. `pyproject.toml` / `requirements.txt`
7. fallback to `no-automated-verification`

For each detected type, the executor should define required checks, optional checks, command timeouts, and safe test flags. JavaScript test commands must avoid watchers (`--run`, `--watch=false`, or framework-specific equivalents). Multi-language repos should run the required check for each primary manifest, bounded by the run budget.

For failed verification after implementation, the supervisor should launch a follow-up fix node until either checks pass or a concrete blocker is reached.

Fix worker prompts must be assembled from a template stored with the operator subsystem. The prompt should include:

- original user goal,
- resolved project and branch/worktree context,
- node that failed,
- commands run,
- exact failure summaries,
- changed files/artifacts from the previous worker,
- allowed scope for the repair,
- verification command that must pass before returning.

The template can later be promoted into a workflow template, but Wave 5 should keep it local to the verification/repair executor to avoid coupling the first implementation to workflow authoring.

#### 5.6 Synthesis Executor

Collects node results, child outputs, artifacts, and verification status into a final answer in the global conversation. It should distinguish:

- completed work,
- skipped work,
- failed work,
- unresolved blockers,
- exact verification performed.

### 6. Supervisor Loop

The operator engine runs a supervisor loop per active run:

1. Select runnable nodes whose dependencies are complete.
2. Enforce concurrency and cost limits.
3. Start executor.
4. Persist progress events.
5. On completion, evaluate success criteria.
6. On failure, choose one of:
   - retry same executor with bounded retry count,
   - launch a fix worker,
   - fall back to another executor,
   - mark blocked with a concrete reason.
7. When all required nodes settle, run synthesis.
8. Append final global transcript message.

The loop must be idempotent. If the app restarts, it should reload active runs, reconnect to live instances/jobs when possible, and mark stale external work explicitly when it cannot recover it.

Budgets are persisted on `OperatorRunRecord`, not just kept in memory. The default full-auto budget should cap:

- maximum graph nodes,
- maximum retries per node and per run,
- maximum wall-clock duration,
- maximum concurrent nodes,
- maximum provider tokens when token usage is available.

When a budget is exhausted, the supervisor must hard-stop runnable nodes, cancel cancellable external work, mark the run `blocked`, append a `budget` event, and surface a transcript card such as "Blocked: budget exhausted after 3 repair attempts."

Stuck-node detection should run as part of the supervisor tick. A node with no progress events for longer than its threshold is marked stalled, then either retried or blocked according to the retry budget. Initial thresholds:

- `git-batch`: 5 minutes without progress,
- `project-agent`: 30 minutes without progress,
- `repo-job`: 30 minutes without progress,
- `verification`: 10 minutes without progress,
- `synthesis`: 5 minutes without progress.

This is separate from `src/main/instance/stuck-process-detector.ts`, which remains instance-focused.

### 7. Instance Settled Events

Wave 4 requires an event-based instance completion API before project-agent and repo-job worker supervision scale up.

Current repo jobs poll `getInstance(instanceId)` once per second and infer completion from `outputBuffer` plus status. Replace that with `InstanceManager` events:

- `instance:state-changed` for every lifecycle status change,
- `instance:idle` when an instance reaches an idle/waiting state after a turn,
- `instance:settled` when the defined settled predicate is true.

The settled predicate should live next to `InstanceStateMachine` and be documented there. Initial predicate:

- status is `idle`, `waiting_for_input`, `terminated`, `error`, or `failed`;
- at least one assistant or error output exists after the triggering user turn;
- no active turn id or interrupt/cancel phase is present;
- a short debounce window has elapsed after the last output/status event.

`RepoJobService.waitForInstanceSettled()` and the Operator Project Agent Executor should both use this API. Tests should cover false positives where an instance briefly becomes idle before assistant output arrives.

## User Experience

### Sidebar

Add a pinned Orchestrator row above Project index:

- label: `Orchestrator`,
- status: idle, running, attention, failed,
- badge: active run count,
- keyboard selectable like visible project/session slots.

This should not be counted as a project group. It is the global control plane.

Implementation choice: add a separate pinned global rows slot above the existing `projectGroups()` list, not a synthetic `ProjectGroup` with a sentinel key. A sentinel group would leak into project count, drag/drop, project menus, path actions, and filtering rules. The separate slot keeps the renderer model honest even though it requires a small template/state addition.

### Main Conversation Surface

Reuse as much of `InstanceDetailComponent` and `InputPanelComponent` behavior as practical, but do not pretend the global thread is an `Instance`.

Best practice is a new feature component:

- `src/renderer/app/features/operator/operator-page.component.ts`,
- `src/renderer/app/features/operator/operator-transcript.component.ts`,
- `src/renderer/app/features/operator/operator-composer.component.ts`,
- `src/renderer/app/features/operator/operator-run-panel.component.ts`.

The global composer should feel like the existing composer, but it should not expose project-only controls such as selected provider model, yolo toggle for a single instance, or file explorer against one working directory.

### Run Panel

The right side or inspector area should show:

- active run title,
- plan steps,
- target projects,
- child sessions,
- repo jobs,
- progress by node,
- verification status,
- artifacts and changed paths,
- cancel/retry controls.

This panel is a status surface, not a mandatory form.

### Transcript Events

The transcript should show compact cards for:

- "Resolved target: AI Orchestrator -> `/Users/suas/work/orchestrat0r/ai-orchestrator`",
- "Started implementation worker",
- "Created worktree branch",
- "Verification failed: spec typecheck",
- "Launched fix worker",
- "All checks passed",
- "Pulled 24 repos, skipped 3 dirty repos".

These cards should link to instances, jobs, artifacts, and project paths.

## IPC And Contracts

Add operator channels in `packages/contracts/src/channels/operator.channels.ts`:

- `operator:get-thread`
- `operator:send-message`
- `operator:list-runs`
- `operator:get-run`
- `operator:cancel-run`
- `operator:retry-run`
- `operator:list-projects`
- `operator:rescan-projects`
- `operator:event`

Add Zod schemas in `packages/contracts/src/schemas/operator.schemas.ts`.

Add preload domain:

- `src/preload/domains/operator.preload.ts`

Add renderer IPC service:

- `src/renderer/app/core/services/ipc/operator-ipc.service.ts`

Add renderer state:

- `src/renderer/app/core/state/operator.store.ts`

As with any new contracts subpath, update:

- `tsconfig.json`,
- `tsconfig.electron.json`,
- `src/main/register-aliases.ts`,
- `vitest.config.ts` if tests import the new subpath.

This follows the packaging rule in `AGENTS.md`.

## Persistence

Use two persistence layers:

1. Conversation transcript in the existing conversation ledger.
2. Operator runs, nodes, and project registry in an operator SQLite database.

Suggested layout:

`userData/operator/operator.db`

Tables:

- `operator_runs`
- `operator_run_nodes`
- `operator_run_events`
- `operator_projects`
- `operator_project_aliases`
- `operator_project_scan_roots`
- `operator_instance_links`

The conversation ledger thread id should be stored on every operator run. Operator messages can include `metadata.operatorRunId` and `metadata.operatorNodeId` to connect transcript cards to structured state.

`operator_instance_links` is the source of truth for worker-to-run relationships:

- `instance_id`,
- `run_id`,
- `node_id`,
- `created_at`,
- `last_seen_at`,
- `recovery_state`.

`Instance.metadata.operatorRunId` and `Instance.metadata.operatorNodeId` are useful hints for renderer links and native resume, but they are not load-bearing for recovery.

The operator database should be initialized from `src/main/app/initialization-steps.ts`, beside the existing conversation ledger initialization. The initializer should create `userData/operator/` and run migrations before IPC handlers accept operator requests.

## Integration Flows

### Feature Implementation In AI Orchestrator

User message:

`In AI Orchestrator, I want to allow voice conversations, please implement it.`

Flow:

1. Planner classifies `project_feature`.
2. Project registry resolves AI Orchestrator to `/Users/suas/work/orchestrat0r/ai-orchestrator`.
3. Engine creates a run with discovery, implementation, verification, and synthesis nodes.
4. Project Agent Executor launches a worker in an isolated worktree or project session.
5. Worker implements using project instructions.
6. Verification executor runs required checks.
7. If verification fails, engine launches a fix worker with failure context.
8. Synthesis summarizes files changed, checks run, remaining risks, and branch/worktree details.

### Project Improvement Audit

User message:

`Please go through all the code in the dingley project and create a list of things we can improve.`

Flow:

1. Planner classifies `project_audit`.
2. Project registry resolves `dingley`.
3. Repo job executor launches a repo health audit.
4. For a large repo, the engine can split by subsystem and launch bounded review workers.
5. Synthesis produces prioritized findings with file references and confidence.
6. No code edits are made unless the user's request asks for implementation.

### Pull All Repos

User message:

`Please pull all the repos in my work folder.`

Flow:

1. Planner classifies `workspace_git_batch`.
2. Project registry scans `/Users/suas/work` and known recent directories for Git roots.
3. Git batch executor runs safe Git pull operations with concurrency limits.
4. Dirty, untracked, divergent, detached HEAD, and no-upstream repos are skipped with reasons.
5. Synthesis reports successful pulls, skipped repos, failures, and recommended follow-ups.

## Autonomy, Safety, And Auditability

The operator should be powerful by default, but every action must remain attributable and recoverable.

Rules:

- Use full autonomy for ordinary operations.
- Prefer isolated worktrees for implementation that could touch many files.
- Record every delegated action in the run graph.
- Record shell command and filesystem write audit events for mechanical executors.
- Record assumptions in the transcript.
- Use safe direct APIs for Git and filesystem work where possible.
- Treat dirty user work as protected input.
- Bound retries per run and per node.
- Surface blockers rather than looping indefinitely.
- Leave normal app permission prompts in place for provider/tool permissions.

Default blocked operations:

- force push,
- hard reset,
- deleting repositories,
- cleaning untracked files,
- deleting branches with unmerged commits,
- modifying files outside resolved project/work roots,
- sending secrets to external services outside configured provider calls.

If the user explicitly asks for one of these operations, the operator may create a run node that requires a specific destructive-action acknowledgement. That is a hard safety exception, not routine approval.

## Recovery

On startup, the operator engine should:

1. Load active runs.
2. Rehydrate known projects.
3. Reconnect nodes linked to live instances, repo jobs, workflows, or background tasks.
4. Mark missing external references as `blocked` with a recovery event.
5. Append a transcript notice when a run was recovered, partially recovered, or could not be recovered.

Workers should store `operatorRunId` and `operatorNodeId` in `Instance.metadata`, repo job submission metadata, and task payloads where available. However, metadata is not sufficient for recovery because fork/replay recovery can rebuild instances without copying arbitrary metadata.

Mitigation:

- fix `InstancePersistenceManager.forkInstance()` to copy custom metadata by default when preserving runtime settings;
- maintain `operator_instance_links` as the durable source of truth;
- on recovery, link nodes by `operator_instance_links` first, then use instance metadata as a hint;
- if a linked instance was forked without a link, emit a recovery event and either re-link by history/session provenance or mark the node `blocked` instead of guessing.

## Testing Strategy

Unit tests:

- project registry path normalization, alias resolution, ambiguity handling, and scan deduplication,
- planner intent classification for the three sample prompts,
- operator run store migrations and graph updates,
- safety policy decisions,
- executor selection,
- Git batch executor using temporary Git repos,
- Git repository discovery ignore rules for `.git`, `node_modules`, package manager caches, build directories, nested repos, and configured ignore patterns,
- verification project-type detection and watcher-safe command selection,
- supervisor retry and blocked-state logic.

IPC tests:

- payload schema validation,
- send-message creates transcript and run records,
- list/get/cancel/retry operations,
- event forwarding and listener cleanup.

Renderer tests:

- operator store state transitions,
- pinned sidebar row behavior,
- transcript run cards,
- run panel rendering,
- cancel/retry interactions.

Integration tests:

- fake instance manager project worker flow,
- fake repo job flow,
- real temporary Git workspace for pull-all-repos success, dirty skip, no-upstream skip, divergence skip, detached HEAD skip, no-remote skip, and clean fast-forward pull.
- Wave 1 restart persistence: type a global message, render it, restart the app/runtime, and confirm the global transcript still contains it without any engine/planner/executor running.

Verification after implementation:

- `npx tsc --noEmit`
- `npx tsc --noEmit -p tsconfig.spec.json`
- `npm run lint`
- targeted Vitest suites for operator, project registry, repo jobs, IPC, and renderer store/components
- full `npm run test` after multi-file implementation waves

## Rollout Plan

This design should be implemented in waves, with each wave producing useful, testable software.

### Wave 1: Global Conversation Foundation

- Extend conversation ledger for internal orchestrator threads by lifting the Codex-only start schema/service guard and registering `InternalOrchestratorConversationAdapter`.
- Add operator IPC contracts and preload domain.
- Add renderer operator store.
- Add pinned Orchestrator row and global conversation view.
- Persist and render user/operator messages without executing work.
- Acceptance test: type a message, see it render, restart the app/runtime, and see the message still present.

### Wave 2: Project Registry And Resolution

- Build project registry and scan roots.
- Seed from recent directories, live instances, conversation ledger workspace paths, and configured roots.
- Add project list/rescan IPC.
- Render resolved target chips in the operator UI.

### Wave 3: Run Graph And Mechanical Git Batch

- Prerequisite: add Git batch capabilities through `VcsManager` or `git-batch-service`, including repository discovery, fetch, and fast-forward pull.
- Add operator run store and event stream.
- Add supervisor loop.
- Implement Git batch executor.
- Support "pull all repos in my work folder" end to end.

### Wave 4: Delegated Project Work

- Prerequisite: add `InstanceManager` settled events and replace repo job polling with the event-based API.
- Prerequisite: add `operator_instance_links` and make `forkInstance()` preserve metadata when runtime settings are preserved.
- Add project agent executor.
- Wrap repo job executor.
- Link instances/jobs back to operator runs.
- Support project audit and single-project feature implementation.

### Wave 5: Verification And Autonomous Repair

- Prerequisite: implement verification project-type detection, command policy, timeouts, and watcher-safe test execution.
- Add verification executor.
- Add failed-check repair loop.
- Add run synthesis with exact verification evidence.
- Add restart recovery for active runs.

### Wave 6: Advanced Routing

- Add more nuanced model/provider routing.
- Use remote nodes when beneficial.
- Connect operator runs to automations and scheduled follow-ups.
- Promote high-confidence results into project memory with source links.

## Open Design Decisions Resolved

- Surface: real persistent conversation in the main UI.
- Autonomy: full-auto for normal operations.
- Architecture: dedicated global operator engine above project sessions.
- Persistence: conversation ledger for transcript, operator database for run graph and project registry.
- Execution: reuse instances, repo jobs, workflows, and tasks through executor adapters.

## Success Criteria

The feature is successful when the user can open Orchestrator, type broad requests, and the app can autonomously carry them through with durable progress and verifiable results.

Minimum complete examples:

- "Pull all repos in my work folder" discovers repos, pulls clean tracking branches, skips unsafe repos with reasons, and summarizes results.
- "Audit the dingley project" resolves the project, launches an audit worker/job, and returns concrete prioritized findings.
- "Implement voice conversations in AI Orchestrator" resolves the app repo, delegates implementation, runs verification, retries fix work on failure, and reports exact changed files plus checks.
