# AI Orchestrator — Validated Unified Plan

This document consolidates the still-useful parts of `codex_plan.md` and
`copilot_plan.md` after validating them against the current repository.

It is intentionally opinionated:
- keep work that is still missing,
- reuse infrastructure that already exists,
- avoid parallel subsystems and speculative rewrites.

## Current State Summary

The repository already contains substantial infrastructure that both plans
partly describe as missing:

- Bootstrap module registry with `critical` vs `degraded` failure modes:
  `src/main/bootstrap/index.ts`
- Domain bootstrap modules:
  `src/main/bootstrap/*.ts`
- Event-store primitives, feature flag, IPC handlers, and tests:
  `src/main/orchestration/event-store/*`,
  `src/shared/constants/feature-flags.ts`,
  `src/main/ipc/handlers/event-store-handlers.ts`
- Permission engine, persistence, rule sets, session rules, and renderer UI:
  `src/main/security/permission-manager.ts`,
  `src/main/security/permission-decision-store.ts`,
  `src/main/instance/instance-manager.ts`,
  `src/renderer/app/features/instance-detail/user-action-request.component.ts`,
  `src/renderer/app/features/settings/permissions-settings-tab.component.ts`
- Sandbox, filesystem policy, and network policy:
  `src/main/security/sandbox-manager.ts`,
  `src/main/security/filesystem-policy.ts`,
  `src/main/security/network-policy.ts`
- Typed tool definition path and streaming executor:
  `src/main/tools/define-tool.ts`,
  `src/main/tools/streaming-tool-executor.ts`
- Plugin manifest loading and validation:
  `src/main/plugins/plugin-manager.ts`
- Structured child artifact storage:
  `src/main/orchestration/child-result-storage.ts`
- Existing error classification and recovery layers:
  `src/main/core/error-recovery.ts`,
  `src/main/core/failover-error.ts`,
  `src/main/orchestration/utils/coordinator-error-handler.ts`

That means the highest-value work is mostly completion and consolidation,
not greenfield subsystem creation.

## What Should Be Done First

### 1. Finish bootstrap and shutdown consolidation

Why:
- `src/main/index.ts` still manually initializes many steps even though a
  bootstrap registry already exists.
- Shutdown order is still ad hoc.
- `ChannelManager.shutdown()` is called twice in `cleanup()`.
- `teardownAll()` exists in `src/main/bootstrap/index.ts` but is not used.

Do:
- Move remaining app boot steps in `src/main/index.ts` into explicit bootstrap
  modules where practical.
- Keep app-specific wiring in `index.ts`, but reduce it to orchestration of
  modules rather than direct singleton setup.
- Introduce a shutdown runner that uses registered teardown ordering.
- Remove duplicate channel shutdown.

Exit criteria:
- Startup failures are classified through the existing bootstrap contract.
- Teardown order is explicit and testable.
- Channel shutdown happens exactly once.

### 2. Type the orchestration invocation boundary

Why:
- `src/main/orchestration/default-invokers.ts` still accepts `payload: any`
  for verification, review, debate, and workflow events.
- Callback contracts differ by event and are not schema-validated.
- `requestId` exists in some paths, but there is no single typed invocation
  envelope or normalized correlation model.

Do:
- Add shared Zod-backed invocation schemas and types for:
  - verification agent invocation,
  - debate response / critique / defense / synthesis,
  - workflow agent invocation,
  - review invocation.
- Normalize callback/result shapes.
- Carry a stable correlation ID through invoker entry, logs, and telemetry.

Primary files:
- `src/main/orchestration/default-invokers.ts`
- `src/main/orchestration/multi-verify-coordinator.ts`
- `src/main/orchestration/debate-coordinator.ts`
- `src/main/workflows/workflow-manager.ts`
- new shared schema/type files under `src/shared/` and `src/main/orchestration/`

Exit criteria:
- No `payload: any` remains on default orchestration invoker listeners.
- Invalid invocation payloads fail at the boundary.
- Tests assert a single callback contract per invocation family.

### 3. Wire the existing event ledger into production behind the flag

Why:
- The event store, bridge, tests, feature flag, and IPC handlers already exist.
- The missing piece is production wiring.

Do:
- Initialize `OrchestrationEventStore` during startup only when
  `EVENT_SOURCING` is enabled.
- Wire `CoordinatorEventBridge` to verification and debate coordinators.
- Register `registerEventStoreHandlers(...)` in production IPC setup.
- Keep the feature off by default until soak-tested.

Primary files:
- `src/main/index.ts`
- `src/main/ipc/ipc-main-handler.ts`
- `src/main/orchestration/event-store/*`

Exit criteria:
- Flag off: no behavior change.
- Flag on: events are persisted and queryable.
- No duplicate event-store implementation is introduced.

### 4. Unify provider registration and improve failover selection

Why:
- Built-in providers are registered twice today:
  once in `register-built-in-providers.ts` and again in
  `ProviderInstanceManager.registerBuiltinProviders()`.
- `ProviderInstanceManager` accepts `adapterRegistry` but still does not use it
  as the authoritative creation path.
- `FailoverManager` is still priority-based; it does not score candidates using
  capabilities plus current health.

Do:
- Make `ProviderAdapterRegistry` the single source of truth for built-ins.
- Remove duplicate factory registration from `ProviderInstanceManager`.
- Teach failover to rank candidates by:
  - availability,
  - circuit state,
  - health,
  - required capabilities,
  - policy default priority.
- Log structured failover reasoning.

Primary files:
- `src/main/providers/provider-adapter-registry.ts`
- `src/main/providers/register-built-in-providers.ts`
- `src/main/providers/provider-instance-manager.ts`
- `src/main/providers/failover-manager.ts`

Exit criteria:
- Built-ins register once.
- Instance creation flows through the registry.
- Failover decisions are explainable and test-covered.

### 5. Extend the existing failure taxonomy instead of creating a parallel one

Why:
- The repo already has broad error categories, failover reasons, and a shared
  coordinator error handler.
- The gap is orchestration-specific classification depth, not absence.

Do:
- Extend existing classifiers with orchestration-relevant categories such as:
  - provider-runtime,
  - prompt-delivery,
  - stale-branch/worktree,
  - tool-runtime,
  - permission,
  - session-replay/resume,
  - validation.
- Keep recovery recipes attached to the current recovery framework rather than
  inventing a separate recovery subsystem.
- Emit structured failure events that observability can consume.

Primary files:
- `src/main/core/error-recovery.ts`
- `src/main/core/failover-error.ts`
- `src/main/orchestration/utils/coordinator-error-handler.ts`

Exit criteria:
- Coordinator failures classify consistently.
- Retry / reroute / escalate decisions are deterministic and logged.
- Unknown failures remain explicit.

## Follow-On Work After The Above

### 6. Add idempotent command receipts only after event sourcing is live

Why:
- `OrchestrationEngine` is currently a thin queue that appends events.
- It has no `commandId`, no receipt store, and no replay-safe command boundary.
- This work is useful, but only once the event ledger is actually wired.

Do:
- Add `commandId` to the command envelope.
- Persist accepted/rejected receipts keyed by `commandId`.
- Return previous receipts for duplicate commands.

Primary files:
- `src/main/orchestration/orchestration-engine.ts`
- `src/main/orchestration/event-store/*`

### 7. Improve async determinism for tests and long-running flows

Why:
- `DrainableQueue` already exists.
- Many orchestration tests still rely on `setTimeout(...)`.
- There is no runtime receipt bus for higher-level orchestration milestones.

Do:
- Replace sleep-based coordinator tests with deterministic drain/wait helpers.
- Introduce typed lifecycle receipts only where real coordination needs them.
- Avoid a separate receipt bus unless the existing queue/event model proves
  insufficient.

Primary files:
- `src/main/testing/drainable-queue.ts`
- orchestration coordinator tests
- selected runtime coordination flows

### 8. Normalize tool result contracts by extending the current tool layer

Why:
- Tool typing work has started already.
- Return shapes are still not uniformly normalized across all execution paths.

Do:
- Build on `defineTool()` and `StreamingToolExecutor` rather than replacing them.
- Standardize tool outputs, truncation metadata, and telemetry emission.
- Keep migration incremental.

Primary files:
- `src/main/tools/define-tool.ts`
- `src/main/tools/streaming-tool-executor.ts`
- `src/main/tools/tool-registry.ts`
- `src/main/util/tool-output-truncation.ts`

## Work That Should Be Reframed Or Deferred

### Do not build a second permission/approval system

Reason:
- The repo already has rule-based permissions, user-decision persistence,
  renderer prompts, batch approval UI, and inheritance constraints.

If anything is needed here, it should be:
- tightening inheritance semantics,
- improving live prompt ergonomics,
- reducing duplicated approval surfaces.

### Do not build a second sandbox subsystem

Reason:
- `SandboxManager` plus filesystem/network policy already exists.

If sandbox work is prioritized, it should be:
- enforcing the current sandbox model on actual execution paths,
- adding platform-specific adapters inside the existing security package,
- not creating a parallel `security/sandbox/` tree beside `sandbox-manager.ts`.

### Do not merge `remote/` and `remote-node/` by default

Reason:
- `remote/observer-server.ts` is a read-only observer surface.
- `remote-node/` is distributed worker-node execution, sync, and RPC.

They may share helpers, but they are not the same subsystem.

### Do not introduce a YAML super-manifest yet

Reason:
- Plugins already support `plugin.json` manifests with schema validation.
- Skills, commands, agents, and plugins are distinct runtime concepts today.

Only unify them if there is a demonstrated product need and a migration story.

### Container runtime is optional, not prerequisite

Reason:
- There is no existing `docker/` runtime in this repo.
- It is a deployment/product decision, not an immediate architectural blocker.

Treat it as a later platform initiative unless explicitly prioritized.

## Documentation And Operational Gaps Worth Filling

These are low-risk, high-signal additions:

- `CHANGELOG.md`
- `docs/INCIDENT_RESPONSE.md`
- `docs/REMOTE.md`
- a lightweight `/doctor` command if users need easier diagnostics

## Recommended Execution Order

1. Bootstrap/shutdown consolidation
2. Typed orchestration invocation boundary
3. Event-store production wiring
4. Provider registry and failover unification
5. Extend failure taxonomy within existing recovery system
6. Idempotent command receipts
7. Async determinism / runtime receipts where justified
8. Tool contract normalization
9. Optional platform/container work

## Validation Notes

- Use `npm` / `npx tsc --noEmit` / `npm run lint` / `npm run test` for
  verification in this repository.
- Do not introduce `pnpm`-specific steps into implementation slices unless the
  repo tooling changes first.
