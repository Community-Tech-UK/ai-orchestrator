# Claude Code Feature Harvest - Design Spec

**Date:** 2026-05-06
**Status:** Completed, validated 2026-05-07
**Owner:** James (shutupandshave)

## 1. Overview

This spec turns the Claude Code changelog review into a concrete product direction for AI Orchestrator. The source review covered Claude Code releases from **2026-03-06 through 2026-05-05/06**, roughly versions `2.1.70` through `2.1.129`, using:

- [Claude Code CHANGELOG.md](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
- [Raw changelog](https://raw.githubusercontent.com/anthropics/claude-code/refs/heads/main/CHANGELOG.md)
- [Claude Code releases](https://github.com/anthropics/claude-code/releases)

The useful upstream themes are not copied feature-for-feature. They are adapted to Orchestrator's job: running and coordinating multiple provider CLIs, keeping long-running work observable, and reducing manual setup friction.

### Relationship to the MCP management spec

This spec depends on [2026-04-21-mcp-multi-provider-management-design.md](/Users/suas/work/orchestrat0r/ai-orchestrator/docs/superpowers/specs/2026-04-21-mcp-multi-provider-management-design.md). That older design is still **Draft, pending user review** and already owns these MCP items:

- `orchestrator_mcp_servers` persistence.
- `CliMcpConfigService`.
- Provider config round-trip handling.
- `McpManager` DB-backed registry behavior.
- v1 `HTTP_TRANSPORT_NOT_SUPPORTED` handling.

This harvest spec does **not** supersede that design. Implementation plans must sequence the April MCP management spec first, then add the harvest-specific MCP follow-ups: HTTP transport support and actual `MCPToolSearchService` wiring.

### Problem this solves

AI Orchestrator already has many of the primitives Claude Code has recently been improving: automations, MCP discovery, provider plugins, permissions, session recovery, cross-model review, and usage/context signals. The gaps are mostly product integration gaps:

- Scheduled work exists, but it runs as detached fresh instances rather than wakeups on an existing thread.
- MCP configuration is visible in places, but user-added Orchestrator MCPs are not persisted and HTTP transport is not supported.
- Plugin support exists in two separate forms, but there is no package-manager flow for URL/zip/directory installs, validation, dependency handling, or pruning.
- Cross-model review exists in-app, but there is no headless JSON command for CI or scripted use.
- Prompt history is collected, but recall is scoped narrowly to the current instance/project.
- Observability exists, but API-level diagnostics and context/usage summaries are still fragmented.

### Single-line definition

> A Claude Code feature harvest is a set of Orchestrator-native upgrades that convert recent Claude Code quality-of-life features into multi-provider scheduling, MCP, plugin, review, prompt-history, and diagnostics improvements.

## 2. Goals & Non-Goals

### Goals

- Add **session-bound wakeups and loops** that resume an existing Orchestrator thread instead of always spawning a fresh automation instance.
- Add **automation preflight and templates** so unattended runs fail less often due to predictable permission or input prompts.
- Strengthen the **MCP control plane** with persistence, HTTP transport support, server-level capability counts, zero-tool warnings, and wired tool-search deferral.
- Add **package-manager style installation** for Orchestrator runtime plugins from local files, directories, zip archives, URLs, and dependency-aware validation.
- Expose existing review machinery through a **headless `review <target> --json` command** suitable for CI and scripted workflows.
- Add an **all-project prompt-history recall mode** while keeping current instance/project recall as the default.
- Improve **usage, context, and API diagnostics** with normalized request IDs, rate-limit/quota details, stop reasons, and context-window summaries.
- Keep security posture conservative: improve preflight and scoped grants without adding broad permission bypasses.

### Non-Goals

- Reimplement Claude Code wholesale.
- Replace provider-native CLI behavior where Orchestrator already delegates correctly.
- Add a background daemon that runs while the app is closed. Existing automations are app-bound; daemonization is a separate product decision.
- Add broad "skip all permissions" controls. Orchestrator should continue to prefer scoped approvals, auditable rules, and preflight warnings.
- Build a public plugin marketplace backend. This spec covers client-side install/update/prune/validate flows and marketplace metadata consumption.
- Rewrite session storage or the provider runtime event model from scratch.

## 3. Existing Code Inventory

The investigation found strong partial coverage. These files are important starting points for implementation planning:

| Area | Existing files | Current state |
|---|---|---|
| Automations | `src/main/automations/index.ts`, `src/main/automations/automation-scheduler.ts`, `src/main/automations/catch-up-coordinator.ts`, `src/main/automations/automation-runner.ts`, `src/shared/types/automation.types.ts`, `packages/contracts/src/schemas/automation.schemas.ts`, `src/renderer/app/features/automations/automations-page.component.ts` | Cron/one-time automations exist, with app startup/resume catch-up and missed-run policies. The trigger union already includes `scheduled`, `catchUp`, `manual`, `webhook`, `channel`, `providerRuntime`, and `orchestrationEvent`. Each current scheduled run creates a fresh instance. |
| Automation tool surface | `src/main/orchestration/orchestration-protocol.ts`, `src/main/orchestration/orchestration-handler.ts` | `create_automation` exists as an orchestrator tool. It is suited to detached recurring tasks, not thread wakeups. |
| MCP manager | `src/main/mcp/mcp-manager.ts`, `src/main/ipc/handlers/mcp-handlers.ts`, `src/main/mcp/mcp-lifecycle-manager.ts`, `src/main/mcp/provider-mcp-config-discovery.ts`, `src/renderer/app/features/mcp/mcp-page.component.html`, `docs/superpowers/specs/2026-04-21-mcp-multi-provider-management-design.md` | Orchestrator MCP server additions are in-memory. The April MCP management spec already designs persistence, provider config services, capability summaries, and typed HTTP rejection, but it is still draft/unimplemented. The UI accepts `http` as a transport choice, but `McpManager.connect()` supports only `stdio` and `sse`; `http` fails at connect/test time. Provider config discovery exists. UI shows selected-server capabilities but not list-level tool counts or zero-tool warnings. |
| MCP tool search | `src/main/mcp/mcp-tool-search.ts` | A search/truncation service exists but is effectively unused by the runtime prompt/tool-discovery path. |
| Plugins | `src/main/plugins/plugin-manager.ts`, `src/main/providers/provider-plugins.ts`, `packages/contracts/src/schemas/plugin.schemas.ts`, `src/renderer/app/features/plugins/plugins-page.component.ts` | There are two real plugin systems: `PluginManager` for Orchestrator runtime plugins and `ProviderPluginsManager` for custom provider plugins. Both support local-file oriented install/load flows; neither has package-manager lifecycle for URL, zip, dependency resolution, update checks, or prune. |
| Permissions | `src/main/security/permission-manager.ts`, `src/main/security/tool-execution-gate.ts`, `src/main/security/bash-validation/pipeline.ts`, `src/main/security/self-permission-granter.ts`, `src/renderer/app/features/settings/permissions-settings-tab.component.ts`, `src/renderer/app/features/instance-detail/user-action-request.component.ts` | Strong scoped permission system, session/always approvals, bash validation, and Claude settings grants already exist. This is a strength to build on, not bypass. |
| Review | `src/main/orchestration/cross-model-review-service.ts`, `src/main/repo-jobs/repo-job-service.ts`, `packages/contracts/src/schemas/orchestration.schemas.ts` | Cross-model review and PR prompt generation exist. There is no package `bin` or headless review command in `package.json`. |
| Session/worktree/PR | `src/main/ipc/handlers/session-handlers.ts`, `src/main/workspace/git/worktree-manager.ts`, `src/main/reactions/reaction-engine.ts`, `src/main/repo-jobs/repo-job-service.ts` | Session restore is robust. Worktree lifecycle and PR tracking/import primitives exist, but PR URL resume is not a single obvious first-class flow. |
| Prompt history | `src/main/prompt-history/prompt-history-store.ts`, `src/renderer/app/core/state/prompt-history.store.ts`, `src/renderer/app/features/prompt-history/prompt-history-search.controller.ts` | History persists by instance/project. Recall UI searches current instance and current project; global recall is not exposed. |
| Observability/usage | `src/main/observability/otel-setup.ts`, `src/main/core/system/provider-quota-service.ts`, `packages/contracts/src/schemas/provider-runtime-events.schemas.ts`, `src/main/usage/usage-tracker.ts`, `src/renderer/app/core/state/usage.store.ts` | OTel, provider quota, and `ProviderContextEventSchema` (`used` / `total` / `percentage`) exist. Usage store is mostly local frecency/recall, not a Claude-style context/API diagnostics surface. |
| Model discovery | `src/main/providers/model-discovery.ts` | OpenAI model discovery supports configurable base URL. Anthropic discovery is a known-list/API-key verification path rather than gateway-aware model listing. |

## 4. Recommended Delivery Shape

This is an umbrella design. It should produce several implementation plans rather than one large plan. The work splits cleanly into seven deployable slices:

1. Session-bound wakeups and loops.
2. Automation preflight and templates.
3. MCP management completion and harvest follow-ups. The April MCP management spec ships first; this harvest adds HTTP transport and tool-search wiring after that baseline exists.
4. Plugin package manager.
5. Headless review command.
6. Prompt-history recall expansion.
7. Usage/context/API diagnostics.

The first three slices have the highest day-to-day leverage because they reduce repeated manual orchestration work and setup friction.

## 5. Design A - Session-Bound Wakeups and Loops

### User experience

Users can tell an active or historical thread to wake up later, or repeatedly, without creating a detached automation that loses thread context.

Examples:

- "Resume this thread tomorrow morning and check whether the CI failure is still happening."
- "Loop every 20 minutes until the branch builds or I stop it."
- "Wake this session at 09:00 on weekdays and continue from the current context."

The UI should expose this in the instance detail surface, not only in `/automations`:

- A compact wakeup button/menu near the instance controls.
- One-shot, interval, and cron-like choices.
- Clear pending-wakeup status in the thread header.
- Cancel next wakeup and cancel loop controls.

### Architecture

Add a new `thread` automation destination on top of the existing automation domain rather than replacing it.

Current `AutomationRunner` creates a fresh instance per fire. For thread wakeups, it should route through a new service that resumes or reuses the target instance/session:

```ts
type AutomationDestination =
  | { kind: 'newInstance'; workingDirectory: string }
  | { kind: 'thread'; instanceId: string; sessionId?: string };
```

The new service owns only wakeup behavior:

```text
src/main/automations/
|-- thread-wakeup-runner.ts      # resume/send prompt into existing thread destination
|-- thread-wakeup-store.ts       # pending wakeup metadata if not folded into automations table
`-- thread-wakeup-events.ts      # UI fan-out for pending, fired, cancelled, failed
```

The existing scheduler and catch-up coordinator should stay shared where possible. The runner decision becomes destination-based:

- `newInstance` keeps today's behavior.
- `thread` locates the instance/session, resumes if needed, appends the scheduled prompt, and records the wakeup result.

### Trigger model

Thread wakeups are a new destination, not a new trigger family. The existing automation trigger union already includes scheduled and reactive triggers:

```ts
type AutomationTrigger =
  | 'scheduled'
  | 'catchUp'
  | 'manual'
  | 'webhook'
  | 'channel'
  | 'providerRuntime'
  | 'orchestrationEvent';
```

v1 UI wakeups can focus on one-shot and cron/interval scheduling, but the runner/store design must preserve `FireAutomationOptions.trigger` and `triggerSource` so future provider-runtime and orchestration-event wakeups can target either `newInstance` or `thread` destinations without another schema rewrite.

### Revival API

Live-instance wakeups use the existing instance input path:

```ts
await instanceManager.sendInput(instanceId, prompt, attachments);
```

The missing piece is dormant revival. The current history restore flow lives inside `src/main/ipc/handlers/session-handlers.ts` and already knows how to try provider-native resume first, then fall back to replay continuity. It is not exposed as a reusable domain API, and `src/main/instance/lifecycle/interrupt-respawn-handler.ts` is scoped to interrupted or crashed live instances rather than scheduled wakeups.

Implementation should extract the reusable parts of `HISTORY_RESTORE` into a domain service before building archived-thread wakeups:

```text
src/main/session/
`-- session-revival-service.ts   # revive history entry/session into a live instance
```

The API should make the behavior explicit:

```ts
interface SessionRevivalRequest {
  instanceId?: string;
  historyEntryId?: string;
  providerSessionId?: string;
  workingDirectory?: string;
  reviveIfArchived: boolean;
  reason: 'thread-wakeup';
}

interface SessionRevivalResult {
  status: 'live' | 'revived' | 'failed';
  instanceId?: string;
  restoreMode?: 'native-resume' | 'resume-unconfirmed' | 'replay-fallback';
  failureCode?: 'target_missing' | 'target_not_live' | 'resume_failed';
}
```

If `reviveIfArchived` is `false`, an exited or archived target fails with `target_not_live`. If `reviveIfArchived` is `true`, the wakeup runner revives the session, waits for readiness, then sends the scheduled prompt through the same `sendInput` path as a live wakeup.

### Data model

Use the companion-table approach by default. The shared TypeScript/Zod automation schema still gets an additive destination field, but persistence requires a new SQLite migration because the current `automations` table stores only `action_json` and has no destination column.

```ts
type AutomationKind = 'cron' | 'oneTime';
type AutomationDestinationKind = 'newInstance' | 'thread';

interface ThreadAutomationDestination {
  kind: 'thread';
  instanceId: string;
  sessionId?: string;
  reviveIfArchived: boolean;
}
```

```sql
CREATE TABLE IF NOT EXISTS automation_thread_destinations (
  automation_id TEXT PRIMARY KEY REFERENCES automations(id) ON DELETE CASCADE,
  instance_id TEXT NOT NULL,
  session_id TEXT,
  history_entry_id TEXT,
  revive_if_archived INTEGER NOT NULL DEFAULT 1
);
```

This migration is additive and must preserve existing automations as `newInstance` destinations.

### Edge cases

- If the target instance was deleted, mark the wakeup `failed` with `target_missing`.
- If the target session cannot resume, surface `resume_failed` and keep the run history linked to the original automation.
- If a loop fires while the previous wakeup is still running, use the existing `concurrencyPolicy`: `skip` skips when a run is already `running` or `pending`; `queue` inserts another `pending` run. A "running + one queued, then skipped" cap is **not** current behavior and must be introduced explicitly as a new policy, such as `queueOne`, if product wants it.
- If the app was asleep or closed, reuse the existing missed-run policy values: `runOnce`, `skip`, `notify`.

### Acceptance criteria

- A user can create a one-shot wakeup for the current thread and see it fire into the same thread.
- A user can create an interval loop for the current thread and cancel it before the next fire.
- Missed wakeups use the same catch-up semantics as existing automations.
- A deleted or unresumable target produces a visible failed wakeup history item, not silent loss.

## 6. Design B - Automation Preflight and Templates

### User experience

Before saving an unattended automation, Orchestrator runs a lightweight preflight and warns about predictable blockers:

- The selected provider/model is unavailable.
- The working directory is missing.
- The prompt is likely to request shell/network/file writes that will need approval.
- The current permission rules will cause unattended runs to stop at `waiting_for_permission`.
- The automation has no useful output instruction.

Templates turn common recurring tasks into reliable starting points:

- Daily repo health check.
- Dependency audit.
- Open PR review sweep.
- Weekly memory/project summary.
- Log triage.

### Architecture

Extend the existing `TaskPreflightService` in `src/main/security/task-preflight-service.ts`; do not build a parallel sibling preflight system. It already checks instruction stack warnings, branch freshness, filesystem policy, network policy, browser automation health, MCP readiness, and permission preset predictions. Add an automation-flavored entry point that converts an automation draft into the existing preflight inputs, adds automation-specific checks, and returns automation-specific remediation data.

```text
src/main/security/
`-- task-preflight-service.ts      # add getAutomationPreflight(...)

src/main/automations/
`-- automation-templates.ts        # built-in templates and schema
```

Preflight consumes existing services:

- `TaskPreflightService` for shared launch/workspace safety checks.
- `PermissionManager` for rule evaluation.
- `ToolExecutionGate` and bash validation signals for risk categories.
- `ModelDiscovery` / provider availability for provider/model checks.
- Current working-directory validation.

The output is structured so the renderer can show specific warnings and fixes:

```ts
interface AutomationPreflightResult {
  okToSave: boolean;
  blockers: AutomationPreflightFinding[];
  warnings: AutomationPreflightFinding[];
  suggestedPermissionRules: SuggestedPermissionRule[];
  suggestedPromptEdits: SuggestedPromptEdit[];
}
```

Suggested rules need a precise preview contract so the UI does not turn "scoped suggestion" into an ambiguous action:

```ts
interface SuggestedPermissionRule {
  id: string;
  scope: 'session' | 'project' | 'user';
  permission: string;
  pattern: string;
  action: 'allow' | 'ask';
  reason: string;
  risk: 'low' | 'medium' | 'high';
  writeTarget?: {
    filePath: string;
    mode: 'append-rule' | 'update-rule';
  };
  previewRule: {
    permission: string;
    pattern: string;
    action: 'allow' | 'ask';
  };
}
```

### Permission stance

Do not add a broad "dangerously skip permissions" switch to automations. Instead:

- Suggest narrowly scoped rules.
- Prefer session/project rules before global `always` rules.
- Show exactly which rule would be written.
- Keep user confirmation explicit.

### Acceptance criteria

- Creating or editing an automation runs preflight before save.
- A prompt that would likely block on permissions produces a visible warning and a scoped suggested rule.
- Users can still save with warnings, but blockers require correction.
- Built-in templates populate prompt, schedule suggestion, and output expectations.
- Existing automations continue to run without requiring template migration.

## 7. Design C - MCP Control Plane Upgrade

### User experience

The MCP page should become the reliable place to understand and manage MCP health across Orchestrator and provider configs. The April MCP management spec owns the baseline page, persistence, provider config service, capability summaries, and v1 typed HTTP rejection. This harvest adds the follow-up work after that baseline ships:

- HTTP transport servers can be connected and health-checked, not only configured.
- Tool-search is used to keep large MCP tool descriptions out of hot prompts until needed.

### Architecture

Do not duplicate the 2026-04-21 MCP management design in implementation planning. Sequence it first, then add only these harvest-owned pieces:

```text
src/main/mcp/
|-- mcp-http-transport.ts         # Streamable HTTP client support
`-- mcp-tool-search.ts            # existing service, wired into provider/tool discovery path
```

The existing `McpManager` remains the process-owning component. `CliMcpConfigService` is not present today; it belongs to the April MCP management spec and must not be assumed until that spec has shipped.

### Baseline dependency

Implementation planning must choose one of these paths before touching MCP code:

1. **Preferred:** implement the April MCP management spec Phase 1 first (`McpManager` persistence plus provider config adapters), then return to this harvest spec for HTTP transport and tool-search wiring.
2. **Alternative:** explicitly mark the April MCP spec superseded and migrate its MCP requirements into a new consolidated spec before implementation.

Until one of those happens, Design C is blocked from implementation planning.

### Tool-search behavior

The existing `MCPToolSearchService` should be integrated where provider prompts or runtime contexts are assembled:

- Load only compact MCP server summaries by default.
- Defer large tool descriptions until a query requires them.
- Cap returned descriptions using the existing truncation behavior.
- Record telemetry for deferred vs loaded tool counts.

### Acceptance criteria

- April MCP management baseline is implemented or explicitly superseded.
- HTTP MCP configs no longer fail at connect time with `Transport http not yet implemented` or the April spec's typed `HTTP_TRANSPORT_NOT_SUPPORTED` result.
- Provider prompt/context assembly uses tool-search deferral instead of eagerly injecting all MCP tool descriptions.

## 8. Design D - Plugin Package Manager

### User experience

Plugins should feel installable and maintainable, not like copied files:

- Install from local file, local directory, zip archive, and URL.
- Validate before enabling.
- Show installed version, source, last validation result, and update availability where metadata supports it.
- Prune disabled/broken plugins and stale plugin cache entries.
- Explain dependency failures clearly.

### Architecture

Both plugin systems are real and should be treated as product surfaces:

- `PluginManager` loads Orchestrator runtime plugins.
- `ProviderPluginsManager` discovers, installs, loads, unloads, and validates custom provider plugins.

v1 still targets Orchestrator runtime plugins only, because that path is the one tied to Orchestrator slots, hooks, skills, and runtime extension behavior. `ProviderPluginsManager` already has a separate single-file install/uninstall path; extending it to zip/url/dependencies should be a v2 package-manager pass after the runtime plugin lifecycle is proven.

`PluginManager` remains responsible for loading and running runtime plugins. A new package-manager service coordinates installation sources, archive extraction, validation, metadata, and rollback for the Orchestrator runtime plugin directory.

```text
src/main/plugins/
|-- plugin-package-manager.ts     # install/update/prune orchestration
|-- plugin-source-resolver.ts     # file/dir/zip/url fetch and cache normalization
|-- plugin-validator.ts           # manifest, hooks, dependencies, signatures when present
|-- plugin-dependency-resolver.ts # local dependency graph and missing dependency messages
`-- plugin-install-store.ts       # source/version/cache metadata

src/main/ipc/handlers/
`-- runtime-plugin-handlers.ts    # package-manager IPC; separate from provider plugin IPC

packages/contracts/src/channels/
`-- runtime-plugin.channels.ts    # RUNTIME_PLUGINS_* channels

src/preload/domains/
`-- runtime-plugin.preload.ts     # renderer bridge for runtime plugin package manager
```

Do not overload the existing `PLUGINS_*` channels in `packages/contracts/src/channels/provider.channels.ts`; those currently serve `ProviderPluginsManager`. Runtime plugin package management needs separate channels such as `RUNTIME_PLUGINS_LIST`, `RUNTIME_PLUGINS_VALIDATE`, `RUNTIME_PLUGINS_INSTALL`, `RUNTIME_PLUGINS_UPDATE`, `RUNTIME_PLUGINS_PRUNE`, and `RUNTIME_PLUGINS_UNINSTALL`.

Renderer changes stay on the existing plugins page:

- Replace "Install from Path" with an install dialog that accepts path or URL.
- Add validation status and source metadata to installed plugin cards.
- Add Update and Prune actions.

### Manifest extension

Extend `packages/contracts/src/schemas/plugin.schemas.ts` additively:

```ts
interface PluginPackageMetadata {
  source?: {
    type: 'file' | 'directory' | 'zip' | 'url';
    value: string;
  };
  dependencies?: Array<{
    name: string;
    versionRange?: string;
    optional?: boolean;
  }>;
  compatibility?: {
    orchestratorMinVersion?: string;
    providers?: string[];
  };
}
```

Existing plugin manifests remain valid.

### Safety

- URL installs require explicit user action.
- Archives extract into a temporary directory first.
- Validation runs before copying into the active plugin directory.
- Failed update restores the previous installed package.
- Plugin source metadata is persisted for update checks, but secret-bearing URLs are redacted in renderer DTOs.
- v1 may verify an optional checksum when the install source provides one, but it does not create a new code-signing or trust-infrastructure system.

### Acceptance criteria

- Installing from a zip archive validates and enables a plugin without manual extraction.
- Installing from a directory copies the directory into managed plugin storage instead of referencing an unstable source path.
- A plugin with a missing required dependency is rejected with the dependency name.
- Prune removes stale disabled/broken plugin cache entries without touching active plugins.
- Existing single-file Orchestrator runtime plugin installs still work.

## 9. Design E - Headless Review Command

### User experience

Users and CI can run Orchestrator review without opening the desktop UI:

```bash
npm run review -- https://github.com/org/repo/pull/123 --json
npm run review -- main...feature --json
npm run review -- --cwd /path/to/repo --target HEAD --json
```

The command returns structured JSON and exits non-zero only for infrastructure failure, not simply because review findings exist.

### Architecture

Expose a Node CLI entrypoint that wraps existing review services:

```text
src/main/cli-entrypoints/
|-- review-command.ts             # argument parsing and process exit contract
`-- review-command-output.ts      # JSON schema and text formatting
```

Reuse:

- `CrossModelReviewService` for reviewer selection and synthesis.
- `RepoJobService` for PR URL metadata and review prompt construction.
- Existing provider availability and quota services.

Start with an npm script for v1 to avoid packaging changes. A package `bin` entry can follow once the command is stable:

```json
{
  "scripts": {
    "review": "node dist/cli/review-command.js"
  }
}
```

`CrossModelReviewService` is not renderer-coupled, but it is not currently headless-ready either: it depends on `setInstanceManager(im: InstanceManager)` and reads instance state for working directory, task description, and output buffers. The headless command must either:

- Construct a minimal `InstanceManager` and normal bootstrap without starting Electron renderer code, or
- Refactor the review path behind a narrower interface such as:

```ts
interface ReviewExecutionHost {
  getWorkingDirectory(instanceId: string): string | undefined;
  getTaskDescription(instanceId: string): string | undefined;
  dispatchReviewerPrompt(provider: string, prompt: string, cwd: string, signal: AbortSignal): Promise<string>;
}
```

Prefer the narrow interface. It keeps headless review from depending on full app process state and makes CI behavior testable in a plain Node process.

### Output contract

```ts
interface HeadlessReviewResult {
  target: string;
  cwd: string;
  startedAt: string;
  completedAt: string;
  reviewers: Array<{ provider: string; model?: string; status: 'used' | 'skipped' | 'failed'; reason?: string }>;
  findings: Array<{
    title: string;
    body: string;
    file?: string;
    line?: number;
    severity: 'critical' | 'high' | 'medium' | 'low';
    confidence: number;
  }>;
  summary: string;
  infrastructureErrors: string[];
}
```

### Acceptance criteria

- A local diff target produces valid JSON.
- A GitHub PR URL target uses existing PR metadata import/prompt logic.
- Provider failures are represented in `reviewers` or `infrastructureErrors`; they do not crash JSON formatting.
- The command is usable from CI without Electron renderer startup.
- The v1 entrypoint is an npm script; packaged `bin` support is a follow-up.

## 10. Design F - Prompt-History Recall Expansion

### User experience

Prompt recall keeps the current behavior by default, with an added scope toggle:

- Current thread.
- Current project.
- All projects.

The all-project mode is useful for commands and prompts that users repeat across repos.

### Architecture

Use the existing persisted prompt history and renderer store. Add scope selection to the prompt-history search controller and UI.

```ts
type PromptRecallScope = 'thread' | 'project' | 'all';
```

The current `allEntries` computed value already exists in `prompt-history.store.ts`; the recall controller should consume it only when the user selects `all`. v1 all-project recall is text-only. Attachment recall is out of scope unless a later design adds durable cross-project attachment persistence and migration.

### Acceptance criteria

- Default recall behavior remains current instance/current project.
- Users can switch to all-project recall without leaving the input overlay.
- Search results clearly show the source project or working directory in all-project mode.
- The scope selection persists per user setting.
- All-project recall inserts prompt text only; it never silently reattaches files from another project.

## 11. Design G - Usage, Context, and API Diagnostics

### User experience

Users should have one place to answer:

- Why did this provider stop?
- Was this a quota/rate-limit/context-window issue?
- Which request ID should be used for support?
- How much context did this session use?
- Which MCP/tools/plugins contributed prompt weight?

### Architecture

Extend normalized provider runtime events and the diagnostics UI rather than adding a separate logging path. The existing `ProviderContextEventSchema` already provides `used`, `total`, and `percentage`; do not add a parallel context object with overlapping names. Also do not add a new provider-runtime event kind unless the provider-runtime event freeze is explicitly superseded. In v1, API diagnostics are additive optional fields on existing `error` and `complete` events.

```ts
interface ProviderContextDiagnosticsExtension {
  // Additive fields on the existing context event.
  inputTokens?: number;
  outputTokens?: number;
  source?: 'provider-event' | 'adapter-estimate';
  promptWeight?: {
    mcpToolDescriptions?: number;
    skills?: number;
    systemPrompt?: number;
  };
}

interface ProviderApiDiagnosticsFields {
  requestId?: string;
  stopReason?: string;
  rateLimit?: {
    limit?: number;
    remaining?: number;
    resetAt?: number;
  };
  quota?: {
    exhausted?: boolean;
    resetAt?: number;
    message?: string;
  };
}

interface ProviderErrorDiagnosticsExtension extends ProviderApiDiagnosticsFields {
  // Add these fields to the existing kind: 'error' event.
}

interface ProviderCompleteDiagnosticsExtension extends ProviderApiDiagnosticsFields {
  // Add these fields to the existing kind: 'complete' event.
}
```

Wire this into:

- `packages/contracts/src/schemas/provider-runtime-events.schemas.ts` by extending `ProviderContextEventSchema`, `ProviderErrorEventSchema`, and `ProviderCompleteEventSchema` additively.
- Provider adapters where request IDs, stop reasons, and rate-limit headers are available.
- `ProviderQuotaService` for quota status.
- OTel attributes/events for trace correlation.
- Instance detail diagnostics panel for human-readable display.

### Acceptance criteria

- Provider errors include request ID when exposed by the provider CLI/API.
- Context usage warnings are visible in the same diagnostics surface as quota/rate-limit state.
- OTel traces include provider, model, request ID, stop reason, and quota/rate-limit attributes where available.
- Diagnostics redact secrets and do not persist full prompts unless the existing session storage already does so by design.

## 12. Secondary Improvements

These are useful but should follow the primary slices unless they fall out naturally:

### PR URL Resume Flow

Existing PR tracking and repo-job import logic can become a first-class resume/import action:

- Paste a PR URL into session resume/import.
- Orchestrator resolves repo metadata, branch/base, and existing tracked sessions.
- User chooses whether to resume an existing matching session or create a new review/work session.

### Gateway-Aware Anthropic Model Discovery

`ModelDiscovery` can treat Anthropic-compatible gateways more like OpenAI-compatible gateways:

- Respect a configured Anthropic base URL for model listing when supported.
- Keep known-list fallback for native Anthropic.
- Clearly label gateway-discovered models as gateway-scoped.

### Skill Effort Bridging

Claude Code added `${CLAUDE_EFFORT}` and skill effort improvements. Orchestrator can mirror the useful part by:

- Mapping provider reasoning effort into skill/runtime metadata.
- Keeping the existing skill schema additive.
- Avoiding provider-specific environment leakage into non-Claude providers.

## 13. Cross-Cutting Requirements

### Security

- No new broad permission bypass.
- Every persisted secret or secret-bearing config path uses the existing redaction/safe-storage patterns.
- URL/plugin/archive installs require explicit user action and validation before activation.
- Diagnostic payloads redact environment variables, headers, auth, and URL userinfo.

### Persistence

- All new persistent records use SQLite migrations or existing ElectronStore conventions.
- No user-added config should be in-memory only after this work.
- Data migrations must be additive and preserve existing automations, MCP records, plugins, and prompt history.

### Renderer

- Follow Angular standalone component and signal-store patterns already used in the app.
- Keep operational UI dense and direct. This is not a marketing surface.
- New controls should live where users do the work: thread wakeups in instance detail, MCP health in `/mcp`, plugins in `/plugins`, recall scope in the input overlay.

### Provider Compatibility

- Features must degrade gracefully when a provider lacks a capability.
- Provider-native config should not be rewritten unless the user explicitly saves a change.
- Remote workers remain local-filesystem scoped unless a later remote-sync design extends this.

## 14. Suggested Implementation Order

### Phase 1 - Daily Workflow Leverage

1. Session-bound wakeups and loops.
2. Automation preflight and templates.
3. Implement the April MCP management spec's Phase 1 baseline, including `McpManager` persistence and capability counts.

This phase reduces manual repetition and fixes the most visible reliability gaps.

### Phase 2 - Setup and Scale

4. MCP HTTP transport support.
5. MCP tool-search wiring.
6. Orchestrator runtime plugin package manager.

This phase improves setup, large MCP environments, and plugin lifecycle management.

### Phase 3 - Scriptability and Diagnostics

7. Headless review command.
8. Prompt-history all-project recall.
9. Usage/context/API diagnostics.

This phase improves CI/scripted use and makes failures easier to understand.

## 15. Testing Strategy

Every implementation plan generated from this spec should include:

- `npx tsc --noEmit`
- `npx tsc --noEmit -p tsconfig.spec.json`
- `npm run lint` or focused ESLint for modified files
- Focused Vitest coverage for the touched services/components

Feature-specific verification:

| Feature | Focused tests |
|---|---|
| Thread wakeups | Scheduler/run history tests, target-missing tests, missed-run policy tests, renderer state tests |
| Automation preflight | Permission-rule prediction tests, working-directory checks, provider/model availability checks |
| MCP baseline/HTTP | April-spec store migration tests, add/update/delete persistence tests, HTTP transport lifecycle tests, capability summary tests |
| MCP tool search | Search ranking/truncation tests, prompt assembly tests proving deferred descriptions are not eagerly injected |
| Plugin package manager | Orchestrator runtime plugin zip extraction rollback tests, dependency validation tests, source metadata redaction tests |
| Headless review | JSON schema tests, PR URL target tests, provider-failure formatting tests |
| Prompt history | Scope toggle tests, all-project source-label tests, text-only recall tests, persistence tests |
| Diagnostics | Existing context-event extension tests, error/complete diagnostics field tests, redaction tests, quota/rate-limit rendering tests |

Manual verification should include at least one real provider-backed run for thread wakeups, MCP health check, plugin install, and headless review.

## 16. Risks and Mitigations

| Risk | Mitigation |
|---|---|
| A single implementation plan becomes too broad. | Split by the seven slices in Section 4. Each slice must ship independently. |
| Thread wakeups corrupt or confuse session history. | Treat wakeups as scheduled prompts with explicit run history and failure states; do not silently mutate archived sessions. |
| MCP HTTP transport implementation diverges from SDK behavior. | Prefer the official MCP SDK transport if compatible with Electron main process; otherwise wrap it behind `mcp-http-transport.ts`. |
| Plugin URL/zip install creates a supply-chain footgun. | Validate before activation, require explicit user action, preserve rollback, show source metadata, and never auto-run newly downloaded code. |
| Headless review accidentally starts Electron renderer dependencies or full `InstanceManager` bootstrap. | Refactor review dispatch behind a narrow host interface before exposing the npm script, then test it in a plain Node process. |
| Diagnostics leak secrets. | Use existing redaction patterns and add explicit tests for headers/env/auth/url userinfo. |

## 17. Resolved Decisions

Resolved during implementation:

- Keep this as one umbrella spec with separate implementation slices.
- Build one-shot wakeups and interval loops together.
- MCP work is sequenced after the April MCP management spec, not duplicated here.
- Plugin package-manager v1 covers Orchestrator runtime plugins only.
- Headless review v1 starts as an npm script, not a packaged `bin`.

## 18. Definition of Done

This feature harvest is complete when:

- Thread wakeups and loops work from existing instance detail pages.
- Automation preflight reduces predictable unattended-run permission/input failures.
- The April MCP management baseline has shipped, and Orchestrator-owned MCP servers persist across restart.
- Orchestrator MCP transport support includes `stdio`, `sse`, and `http`.
- MCP list cards expose capability counts and zero-tool warnings.
- MCP tool-search is actually used by prompt/tool discovery.
- Orchestrator runtime plugin installs support local file, local directory, zip archive, and URL sources with validation and prune/update actions.
- Headless review returns stable JSON for PR URL and local diff targets through the v1 npm script.
- Prompt recall supports thread, project, and all-project scopes.
- Provider diagnostics show request IDs, stop/context/quota/rate-limit details where available.
- All implementation slices pass TypeScript, spec TypeScript, lint, and focused tests.

## 19. Completion Validation

Completed and revalidated on 2026-05-07.

Implementation evidence:

- Session-bound wakeups and loops: `src/main/automations/thread-wakeup-runner.ts`, destination-aware `AutomationRunner`, thread destination schema/store/state coverage.
- Automation preflight and templates: `TaskPreflightService.getAutomationPreflight()`, automation store preflight state, automation templates.
- MCP management, HTTP, capability summaries, zero-tool warnings, and tool-search deferral: April MCP multi-provider implementation plus `HttpTransport` and `McpManager.getRuntimeToolContext()`.
- Runtime plugin package manager: `src/main/plugins/plugin-package-manager.ts`, `plugin-source-resolver.ts`, runtime-plugin IPC handlers/channels, plugin page integration.
- Headless review: `npm run review`, `src/main/cli-entrypoints/review-command.ts`, stable JSON output helpers.
- Prompt-history recall: prompt-history schemas/types/service/store/search controller support thread, project, and all-project scopes.
- Provider diagnostics: provider-runtime event schemas, diagnostics handlers, child diagnostics, and the provider diagnostics panel.

Focused verification run:

```bash
npx vitest run src/main/automations/thread-wakeup-runner.spec.ts src/main/automations/automation-runner.spec.ts src/main/automations/automation-store.spec.ts src/main/automations/automation-schedule.spec.ts src/main/automations/automation-templates.spec.ts packages/contracts/src/schemas/__tests__/automation.schemas.spec.ts src/renderer/app/core/state/automation.store.spec.ts src/main/security/task-preflight-service.automation.spec.ts src/main/security/__tests__/task-preflight-service.spec.ts src/main/plugins/plugin-package-manager.spec.ts src/main/plugins/plugin-source-resolver.spec.ts src/main/plugins/plugin-validator.spec.ts src/main/ipc/handlers/runtime-plugin-handlers.spec.ts packages/contracts/src/channels/__tests__/runtime-plugin.channels.spec.ts packages/contracts/src/schemas/__tests__/plugin-schemas.spec.ts src/renderer/app/features/plugins/plugins-page.component.spec.ts src/renderer/app/core/services/ipc/plugin-ipc.service.spec.ts src/main/cli-entrypoints/review-command.spec.ts src/main/cli-entrypoints/review-command-output.spec.ts src/main/orchestration/cross-model-review-service.headless.spec.ts src/shared/validation/cross-model-review-schemas.spec.ts src/main/prompt-history/__tests__/prompt-history-service.spec.ts packages/contracts/src/schemas/__tests__/prompt-history.schemas.spec.ts src/shared/types/__tests__/prompt-history.types.spec.ts src/renderer/app/core/state/__tests__/prompt-history.store.spec.ts src/renderer/app/features/prompt-history/prompt-history-search.controller.spec.ts packages/contracts/src/schemas/__tests__/provider-runtime-events.schemas.spec.ts src/main/orchestration/child-diagnostics.spec.ts src/main/ipc/handlers/__tests__/diagnostics-handlers.spec.ts src/renderer/app/features/instance-detail/provider-diagnostics-panel.component.spec.ts src/main/mcp/transports/http-transport.spec.ts src/main/mcp/mcp-manager.spec.ts src/main/mcp/__tests__/multi-provider-service.spec.ts src/main/mcp/__tests__/mcp-core-services.spec.ts src/renderer/app/features/mcp/mcp-page.component.spec.ts src/renderer/app/features/mcp/state/mcp-multi-provider.store.spec.ts
```

Result: 36 files passed, 200 tests passed.
