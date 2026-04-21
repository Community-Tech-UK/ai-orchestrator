# AI Orchestrator — Cross-Repo Remediation Program Plan

**Date:** 2026-04-20
**Status:** Complete on 2026-04-21
**Scope:** Turn the cross-repo audit and the 2026-04-16 design work into an executable, sequenced program of record for AI Orchestrator.
**Primary references:**

- `docs/superpowers/specs/2026-04-16-ai-orchestrator-cross-repo-improvements-design.md`
- `docs/plans/2026-04-15-ai-orchestrator-improvement-plan.md`
- `docs/superpowers/plans/2026-04-17-wave1-contracts-subpath-exports.md`
- `docs/superpowers/plans/2026-04-17-wave2-provider-normalization.md`

**Completion note:** This document is retained as the historical program plan. The release-manager checklist in section 12 was verified against the landed code and the full repo validation run on 2026-04-21.

---

## 0. Executive Summary

The freshest code audit confirms the same broad thesis as the 2026-04-16 design doc: **AI Orchestrator already contains many of the right abstractions, but too many hot paths still bypass them**.

The biggest gaps are not “missing features” so much as **non-authoritative contracts**:

- `InstanceStateMachine` exists, but invalid transitions still mutate state.
- `BaseProvider`, normalized provider events, and provider registries exist, but the runtime still relies heavily on legacy adapter event flows.
- generic MCP infrastructure exists, but it still exposes only coarse status and lacks phased degraded-mode reporting.
- plugin manifest validation exists, but runtime hook payloads and SDK parity are still hand-maintained.
- session/checkpoint systems work, but storage and checkpointing remain mostly app-specific instead of git-native and project-rooted.
- bootstrap modularization has started, but startup ordering still depends on manual sequencing.

This plan therefore focuses on making the existing abstractions **load-bearing** and sequencing the work so that later improvements rest on stable contracts instead of shifting behavior.

The program is organized into **11 waves**:

1. Baseline + contract/export hygiene
2. Lifecycle spine
3. Provider runtime convergence
4. Orchestration event source + deterministic async
5. Session persistence, storage layout, and auto-compaction
6. Git-backed checkpoints
7. MCP + plugin lifecycle hardening
8. Permissions, recovery recipes, and stale-branch safety
9. Plugin slot architecture + SDK parity
10. Remote pairing for remote nodes
11. Bootstrap dependency ordering + UI decomposition

If we execute only the first five waves, AI Orchestrator becomes materially more reliable. If we execute all eleven, the platform becomes much easier to extend, verify, and recover.

---

## 1. Current-State Corrections from the Fresh Audit

The earlier design doc is directionally right, but a few assumptions are now stale. This plan uses the current codebase as the source of truth.

| Topic               | Earlier assumption                                                 | Current repo truth                                                                                                                                        | Planning implication                                                                                     |
| ------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| MCP                 | Generic MCP infrastructure did not exist yet                       | `src/main/mcp/` and `src/shared/types/mcp.types.ts` now provide a generic MCP manager and shared types                                                    | Wave 7 hardens and re-scopes existing MCP infrastructure instead of introducing it from scratch          |
| Lifecycle           | AI Orchestrator needed a state machine concept                     | `src/main/instance/instance-state-machine.ts` already defines a strong transition map                                                                     | Wave 2 must make it authoritative rather than invent a second lifecycle model                            |
| Provider runtime    | Provider normalization was still mostly conceptual                 | `src/main/providers/provider-interface.ts`, `src/main/providers/event-normalizer.ts`, and `src/main/providers/provider-instance-manager.ts` already exist | Wave 3 consolidates the live path onto these abstractions and removes split-brain behavior               |
| Deterministic async | The repo needed a new test-drain primitive                         | `src/main/testing/drainable-queue.ts` already exists                                                                                                      | Wave 4 should adopt and spread this pattern, not create a competing primitive                            |
| Plugins             | Plugin hardening was mostly about manifest validation              | `PluginManifestSchema` and the public SDK already exist                                                                                                   | Wave 9 focuses on runtime payload parity, slot typing, and load reports                                  |
| Storage layout      | Session and checkpoint work could layer on the current path layout | many subsystems still write independently to Electron `userData`                                                                                          | Wave 5 introduces a shared path service and per-project roots before more persistence is added           |
| Bootstrap           | Startup was still monolithic                                       | `src/main/bootstrap/index.ts` and domain bootstraps already exist                                                                                         | Wave 11 finishes dependency ordering and adoption instead of starting bootstrap modularization from zero |

---

## 2. Program Goals

By the end of this program, AI Orchestrator should satisfy all of the following:

1. **Authoritative lifecycle discipline** — instance state changes can only happen through one transition service and one event language.
2. **One canonical provider event envelope** — downstream consumers never special-case raw adapter events.
3. **Deterministic orchestration and recovery** — high-risk flows can be verified without `sleep()`-based tests or live CLI flakiness.
4. **Project-rooted persistence** — session, checkpoint, and related artifacts are organized by project/workspace instead of many unrelated `userData` folders.
5. **Git-native checkpoint visibility** — checkpoints are inspectable, diffable, and restorable with familiar git semantics.
6. **Partial failure tolerance** — MCP servers and plugins can fail independently without collapsing the entire runtime.
7. **Explicit safety modes and recovery recipes** — permission posture and automatic recovery are declared, typed, and observable.
8. **Slot-based plugin architecture** — providers, skills, channels, MCP bindings, notifiers, and telemetry exporters have clear runtime contracts.
9. **Clean package boundaries** — contracts and SDKs are consumed through explicit subpath exports, not barrels or deep relative imports.
10. **Smaller startup and renderer hotspots** — the main process startup path and the largest Angular containers are easier to audit and change.

---

## 3. Non-Goals

This plan explicitly does **not** include:

- rewriting AI Orchestrator around Rust, Effect, Bun, or a different desktop framework
- a full renderer redesign while runtime contracts are still shifting
- a plugin marketplace or public extension ecosystem launch
- cloud-hosted multi-tenancy or orchestrator-as-a-service
- adding multiple new AI providers during the remediation itself
- replacing OTLP/observability backends

---

## 4. Delivery Guardrails

These rules apply to every wave and every PR in the program.

### 4.1 Migration rules

- Prefer **shadow write / shadow read / compare / cut over** over big-bang swaps.
- Keep a **compatibility window of at least one release** when changing any externally consumed shape.
- Land **contracts first**, then adapters, then consumers, then deletion.
- Do not mix broad UI redesign with runtime remediation in the same PR.
- Treat each new abstraction as incomplete until at least one high-volume hot path actually uses it.

### 4.2 Verification rules

- Add **characterization tests before structural refactors** whenever behavior is already relied on.
- Prefer **deterministic queue draining** over time-based waits.
- Validate the repo after each wave with:
  - `npx tsc --noEmit`
  - `npx tsc --noEmit -p tsconfig.spec.json`
  - `npm run lint`
  - `npm run test`
- For waves that affect user-visible runtime behavior, perform a manual smoke check in the Electron app before closing the wave.

### 4.3 Rollout rules

- Gate major migrations behind explicit flags, for example:
  - `authoritativeLifecycle`
  - `providerRuntimeV2`
  - `orchestrationEventStore`
  - `sessionJsonlDualWrite`
  - `gitCheckpointStore`
  - `phasedMcpLifecycle`
  - `pluginSlotRegistry`
  - `remotePairingV1`
- Remove flags only after:
  - parity verification passes
  - telemetry or logs show no regression trend
  - rollback instructions are documented

---

## 5. Priority Matrix

| Priority | Issue                                              | Why it matters now                                                                         | Wave |
| -------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------ | ---- |
| P0       | Authoritative lifecycle state machine              | Current runtime can enter impossible states because invalid transitions still mutate state | 2    |
| P0       | Provider runtime convergence                       | The runtime still has two provider event stacks and weak sequence guarantees               | 3    |
| P0       | Contract/export hygiene                            | Future waves add new contracts; package boundaries must stop drifting first                | 1    |
| P1       | Orchestration event source                         | Deterministic testing, replay, checkpointing, and recovery all depend on it                | 4    |
| P1       | Session/storage cleanup + compaction               | Persistence will get harder to reason about if added on top of current scattered paths     | 5    |
| P1       | Git-backed checkpoints                             | Users already think in git; current checkpoints are app-specific                           | 6    |
| P1       | MCP + plugin degraded lifecycle                    | Multi-MCP and plugin startup need partial-failure semantics                                | 7    |
| P2       | Permission tiers + recovery recipes + stale branch | Safety and recovery should be policy-driven instead of ad hoc                              | 8    |
| P2       | Plugin slot architecture + SDK parity              | Extension growth needs typed runtime contracts, not manifest-only validation               | 9    |
| P2       | Bootstrap dependency ordering + UI decomposition   | Current structure is hard to audit but should wait until runtime contracts settle          | 11   |
| P3       | Remote pairing                                     | Valuable, but not on the critical path for core reliability                                | 10   |

---

## 6. Recommended Sequence

The recommended order differs slightly from the 2026-04-16 design: the fresh audit shows that **lifecycle correctness** is urgent enough to move ahead of some deeper orchestration work.

### Serial backbone

1. Wave 1 — Baseline + contract/export hygiene
2. Wave 2 — Lifecycle spine
3. Wave 3 — Provider runtime convergence
4. Wave 4 — Orchestration event source + deterministic async

### After Wave 4, parallelizable lanes open

- Wave 5 — Session persistence, storage layout, and auto-compaction
- Wave 6 — Git-backed checkpoints
- Wave 7 — MCP + plugin lifecycle hardening

### Then finish platform hardening

- Wave 8 — Permissions, recovery recipes, and stale-branch safety
- Wave 9 — Plugin slot architecture + SDK parity

### Lower-priority and follow-through work

- Wave 10 — Remote pairing for remote nodes
- Wave 11 — Bootstrap dependency ordering + UI decomposition

### Why this order

- **Wave 1 first** because all later waves add contracts, exports, or lint/verification rules.
- **Wave 2 before Wave 3** because invalid lifecycle writes are a live correctness bug today.
- **Wave 3 before Wave 4** because the orchestration event store should consume one provider event language, not two.
- **Wave 4 before Waves 5–8** because event-driven reactors make compaction, checkpoints, MCP recovery, and recipe execution much simpler and more testable.
- **Wave 11 last** because decomposition work benefits from all earlier contracts being stable.

---

## 7. Detailed Wave Plans

## Wave 1 — Baseline + Contract / Export Hygiene

### Objective

Lock down current behavior, finish package-boundary discipline, and create the verification scaffolding that later waves will rely on.

### Primary files

- `packages/contracts/package.json`
- `packages/sdk/package.json`
- `src/shared/validation/ipc-schemas.ts`
- `scripts/verify-package-exports.js` (new)
- targeted tests under `src/main/**/__tests__/`

### Problems solved

- prevents later waves from deepening import-path debt
- creates a stable before/after baseline for lifecycle and provider behavior
- removes ambiguity about which contract surface is authoritative

### PR slices

#### PR 1.1 — Characterization tests for current hot paths

- Capture current behavior for:
  - lifecycle restart and termination flows
  - normalized provider event ordering
  - checkpoint create/restore happy path
  - MCP startup success and failure paths
- Prefer focused scenario tests over snapshot-heavy tests.
- Reuse `src/main/testing/drainable-queue.ts` where possible.

#### PR 1.2 — Explicit contract/package subpath exports

- Finish subpath export discipline in `packages/contracts` and `packages/sdk`.
- Rewrite remaining internal imports that still use deprecated barrels or deep source paths.
- Keep the deprecation shim temporarily, but add a path to remove it.

#### PR 1.3 — Export verification and lint guards

- Add `scripts/verify-package-exports.js` to fail on bare package imports without subpaths.
- Add a lightweight rule or CI check to flag deep relative imports into `packages/contracts/src/*` and `packages/sdk/src/*`.
- Document the approved import styles.

### Risks

- import rewrites can break runtime alias resolution if `tsconfig`, Vitest aliases, and main-process alias registration drift
- broad codemods may create churn in unrelated files if not narrowly scoped

### Verification

- `npx tsc --noEmit`
- `npx tsc --noEmit -p tsconfig.spec.json`
- `npm run lint`
- `npm run test`

### Exit criteria

- package consumers use explicit subpath exports for new and migrated contracts
- characterization tests exist for the first two runtime waves
- there is a clear CI guard against regressing into barrel/deep-import sprawl

---

## Wave 2 — Lifecycle Spine

### Objective

Make `InstanceStateMachine` the only legal path for instance status changes and emit typed lifecycle events for every transition.

### Primary files

- `src/main/instance/instance-state-machine.ts`
- `src/main/instance/instance-lifecycle.ts`
- `src/main/instance/instance-communication.ts`
- `packages/contracts/src/instanceEvents.ts` (new)
- `src/main/instance/instance-event-aggregator.ts` (new)
- renderer store consumers under `src/renderer/app/core/state/instance/`

### Problems solved

- invalid transitions stop mutating state after merely logging a warning
- recovery and telemetry get structured lifecycle events instead of inferred status changes
- future extraction of `instance-lifecycle.ts` becomes structural, not stylistic

### PR slices

#### PR 2.1 — Contracts for lifecycle and failure taxonomy

- Add `InstanceEventKind`, `InstanceFailureClass`, and `InstanceEvent` contracts.
- Export them via `packages/contracts` subpaths.
- Keep the existing 16 lifecycle states unless a full audit proves collapse is safe.

#### PR 2.2 — Extend the state machine to emit events

- Teach `InstanceStateMachine` to emit events and maintain a per-instance event sequence.
- Add `IllegalTransitionError` and stop silent mutation on invalid transitions.
- Introduce a central per-instance bus or aggregator so renderer IPC, telemetry, and recovery consume the same stream.

#### PR 2.3 — Replace direct writes in the hot paths

- Audit and migrate direct status mutation sites in:
  - create/spawn
  - restart/respawn
  - hibernate/wake
  - permission waiting
  - termination/cleanup
  - resume/recovery
- Replace them with `stateMachine.transition(...)` calls carrying structured event metadata.

#### PR 2.4 — Add discipline checks

- Add a verification script or lint guard that fails if instance state is mutated outside the state machine.
- In dev builds, optionally wrap state with an assertion layer to catch direct mutation.

#### PR 2.5 — Update consumers

- Update renderer state, telemetry, and any IPC channels that currently derive lifecycle semantics from loose status writes.
- Ensure event consumers can reconstruct final state from the event stream.

### Risks

- some UI paths may rely on intermediate invalid states today without realizing it
- terminate/restart paths are usually the most brittle because they combine process, session, and UI cleanup

### Verification

- transition table unit tests for every legal and illegal transition
- restart/resume characterization tests from Wave 1
- event replay tests that rebuild final state from an event log
- full repo verification commands

### Exit criteria

- invalid transitions throw or fail fast instead of mutating state
- all major lifecycle paths emit typed events
- no hot-path direct status writes remain outside the approved transition layer

---

## Wave 3 — Provider Runtime Convergence

### Objective

Collapse the current split provider stack into one canonical downstream event surface and remove legacy sequencing gaps.

### Primary files

- `src/main/cli/adapters/base-cli-adapter.ts`
- `src/main/providers/event-normalizer.ts`
- `src/main/providers/provider-interface.ts`
- `src/main/providers/provider-instance-manager.ts`
- `src/main/providers/register-built-in-providers.ts`
- `src/main/instance/instance-communication.ts`
- `packages/contracts/src/provider-runtime-events.ts`
- `packages/contracts/src/schemas/provider-runtime-events.schemas.ts`

### Problems solved

- the runtime no longer has to understand both raw adapter events and normalized provider envelopes
- `seq = 0` fallback behavior disappears from the live path
- new providers can be added without editing telemetry, orchestration, renderer, and recovery logic separately

### PR slices

#### PR 3.1 — Canonical runtime event surface

- Reconcile the existing provider runtime contracts with the newer cross-repo design.
- Decide the authoritative shape for:
  - session events
  - turn events
  - content streaming events
  - permission/input request events
  - runtime warnings/errors/auth status
- Ensure every event has consistent IDs, timestamps, provider kind, instance ID, and sequence.

#### PR 3.2 — Real sequencing in the bridge path

- Remove the `seq = 0` fallback by assigning per-instance monotonic sequences in the adapter bridge.
- Ensure sequence monotonicity across pause/resume/restart boundaries.
- Make event normalization reject or explicitly classify malformed provider payloads.

#### PR 3.3 — Move consumers to normalized envelopes only

- Migrate orchestration, telemetry, renderer dispatch, and session/recovery listeners off raw adapter events.
- Keep compatibility adapters temporarily, but ensure no new consumer is allowed to subscribe to raw provider shapes.

#### PR 3.4 — Switch instance creation to provider registry/manager

- Route instance startup through the provider registry and `ProviderInstanceManager` instead of direct legacy adapter construction where practical.
- Keep provider-specific spawn wiring isolated behind provider interfaces.

#### PR 3.5 — Delete or fence legacy special cases

- Once parity tests are green, delete dead raw-event branches.
- If a branch cannot be removed immediately, mark it legacy and add an expiry note.

### Risks

- provider resume behavior may depend on fields that are not yet carried in the normalized envelope
- streaming output chunk boundaries can shift when normalization becomes stricter
- permission and input request semantics can regress if request IDs are inconsistent across providers

### Verification

- provider parity tests for Claude, Codex, Gemini, and Copilot
- event ordering tests across spawn, stream, permission prompt, resolve, and exit
- targeted tests for resume, error, and interrupt flows
- full repo verification commands

### Exit criteria

- downstream provider consumers observe one canonical envelope only
- real monotonic sequences exist in the live path
- adding a provider requires adapter mapping plus registration, not downstream branching

---

## Wave 4 — Orchestration Event Source + Deterministic Async

### Objective

Introduce an append-only orchestration event store, command bus, projections, and reactors so recovery, replay, checkpoints, and test determinism stop depending on mutable imperative state.

### Primary files

- `src/main/orchestration/orchestration-engine.ts` (new)
- `src/main/orchestration/` decider/projector/reactor files (new and existing)
- `src/main/testing/drainable-queue.ts`
- persistence backing for the event store
- scenario tests under `src/main/orchestration/__tests__/` and adjacent areas

### Problems solved

- high-risk orchestration flows become replayable and testable without live timing assumptions
- recovery reactors and checkpoint reactors gain a single place to subscribe
- future persistence features can build off commands and events instead of ad hoc callbacks

### PR slices

#### PR 4.1 — Shadow event store

- Introduce an append-only `OrchestrationEventStore` backed by sqlite or a pluggable interface.
- Emit orchestration events from existing imperative flows without changing behavior yet.
- Include command ID, causation, correlation, aggregate type, and JSON payload.

#### PR 4.2 — Deterministic drain hooks

- Add `drain()` hooks to orchestration queues, reactors, and relevant event buses.
- Replace sleep-based tests in selected orchestration areas with deterministic draining.
- Establish the preferred test helper pattern for future waves.

#### PR 4.3 — Command bus + decider + projections

- Introduce a small command bus and decider for core commands such as:
  - `turn.start`
  - `turn.interrupt`
  - `permission.respond`
  - `_internal.provider.event`
  - `_internal.checkpoint.finalized`
- Build initial projections for instance state, turn state, and checkpoint counts.

#### PR 4.4 — Provider ingestion reactor

- Subscribe normalized provider events and dispatch them into the orchestration engine.
- Keep a reversible adapter path until the command bus proves stable.

#### PR 4.5 — Scenario harness for WS5-style flows

- Add deterministic scenario tests for:
  - streaming text roundtrip
  - permission request approved
  - permission request denied
  - native resume success
  - native resume failure with replay fallback
  - interrupt and respawn
  - MCP tool lifecycle
  - plugin hook roundtrip

### Risks

- the first projection model can become too broad if it tries to replace everything at once
- a store that is too implementation-specific will be hard to swap if sqlite behavior disappoints later

### Verification

- targeted event-store tests
- deterministic scenario tests with queue draining
- startup/shutdown smoke checks with the shadow event store enabled
- full repo verification commands

### Exit criteria

- there is an append-only orchestration log in shadow or primary use
- key orchestration tests drain queues instead of sleeping
- later waves can subscribe to typed orchestration events/reactors instead of bespoke callbacks

---

## Wave 5 — Session Persistence, Storage Layout, and Auto-Compaction

### Objective

Centralize project-rooted storage, dual-write session events in append-only form, and move compaction from a manual edge feature to a policy-driven subsystem.

### Primary files

- `src/main/session/session-continuity.ts`
- `src/main/session/checkpoint-manager.ts`
- `src/main/session/agent-tree-persistence.ts`
- `src/main/session/compact/`
- `src/main/storage/` (new)
- `src/main/session/compaction-policy.ts` (new)

### Problems solved

- persistence stops spreading across many unrelated `userData` locations
- long sessions gain structured compaction and event history instead of opaque growth
- future checkpoint and replay logic can rely on consistent path conventions

### PR slices

#### PR 5.1 — Shared path service and per-project roots

- Introduce a `ProjectStoragePaths` or `PathService` abstraction.
- Derive storage roots from workspace root and/or project identity.
- Keep path creation deterministic and collision-resistant.
- Start routing new persistence writes through this service.

#### PR 5.2 — Session JSONL dual-write

- Keep the current session snapshot flow intact.
- Also append session events to JSONL with rotation.
- Treat the JSONL stream as diagnostic and replay infrastructure first, not primary truth yet.

#### PR 5.3 — Auto-compaction policy and compactor interface

- Formalize compaction decisions with thresholds, preserved recent messages, and minimum compactable message counts.
- Wrap existing compaction logic behind a `Compactor` interface.
- Prepare for provider-native compaction when a provider supports it.

#### PR 5.4 — Event-driven session compaction reactor

- Subscribe to turn-completed events from Wave 4.
- Run compaction decisions automatically when thresholds are crossed.
- Record compaction decisions and summaries in a dedicated log.

#### PR 5.5 — Migrate scattered persistence writers

- Move session-adjacent systems that currently write directly to `userData` onto the shared path service.
- Prioritize:
  - session continuity
  - checkpoints
  - agent tree persistence
  - any resume-critical metadata

### Risks

- storage migration can strand old data if path translation is not carefully tested
- compaction can corrupt conversational continuity if tool-use/tool-result pairs are split

### Verification

- migration tests from the old path layout to the new path service
- compaction threshold boundary tests
- session rebuild tests from JSONL + snapshot
- full repo verification commands

### Exit criteria

- a shared path service owns new persistence paths
- session writes are dual-written to snapshot + append-only stream
- auto-compaction exists behind a policy and can be safely enabled

---

## Wave 6 — Git-Backed Checkpoints

### Objective

Make checkpoints inspectable and restorable through git refs while preserving current app-level checkpointing until parity is proven.

### Primary files

- `src/main/session/checkpoint-manager.ts`
- `src/main/session/git-checkpoint-store.ts` (new)
- checkpoint contracts under `packages/contracts/src/`
- checkpoint UI surfaces in the renderer

### Problems solved

- checkpoints become familiar and externally inspectable
- restore survives app failure because state is represented in git
- diff summaries and restore operations no longer depend entirely on proprietary snapshot formats

### PR slices

#### PR 6.1 — Checkpoint contracts and summary model

- Add `CheckpointSummary`, `CheckpointStatus`, and file diff summary types.
- Ensure they can be emitted through the orchestration event stream.

#### PR 6.2 — Git checkpoint store for git workspaces

- Create a `GitCheckpointStore` that snapshots worktree state into refs under `refs/orchestrator/checkpoints/...`.
- Never touch user branches or push anything.

#### PR 6.3 — Non-git fallback via shadow repository

- For non-git workspaces, create a hidden shadow repo under orchestrator-managed storage.
- Keep it fully isolated from user repos.

#### PR 6.4 — Dual-write and compare with current checkpoints

- Run both the git-backed and current checkpoint flows in parallel for one release.
- Compare summary outputs and restore behavior before cutover.

#### PR 6.5 — UI integration and git-oriented affordances

- Add actions such as:
  - open diff
  - show checkpoint ref
  - restore from ref
  - compare against worktree
- Keep the existing viewer until git-backed parity is proven.

### Risks

- careless implementation could intrude on user repos or create unexpected repo growth
- restore semantics differ between hard reset and stash-then-restore strategies

### Verification

- round-trip create/modify/restore tests
- checkpoint GC policy tests
- worktree isolation tests when multiple agent worktrees exist
- manual smoke test in a real git workspace
- full repo verification commands

### Exit criteria

- checkpoints exist as real git refs or shadow-git refs
- users can inspect and diff them without relying on app-only formats
- the legacy checkpoint path is no longer the only restore mechanism

---

## Wave 7 — MCP + Plugin Lifecycle Hardening

### Objective

Upgrade MCP and plugin startup to phased lifecycle management with partial-failure reporting, retries, and degraded capability awareness.

### Primary files

- `src/main/mcp/mcp-manager.ts`
- `src/shared/types/mcp.types.ts`
- `src/main/mcp/mcp-lifecycle-manager.ts` (new)
- `src/main/plugins/plugin-manager.ts`
- plugin lifecycle support files (new)

### Problems solved

- one failed MCP server no longer takes down the rest of the tool surface
- plugin load failures gain explicit phase classification instead of generic startup errors
- the UI can describe what still works instead of showing only “error”

### PR slices

#### PR 7.1 — MCP lifecycle contracts

- Add phase enums, phase results, and degraded reports.
- Keep current coarse status mapping for compatibility, but make it derived from the richer model.

#### PR 7.2 — Wrap the existing MCP manager in a phased lifecycle manager

- Reuse the current generic `mcp-manager.ts` instead of replacing it.
- Introduce per-phase timing, error surfaces, and server-level reports.

#### PR 7.3 — Add one structured recovery attempt

- Permit one automatic recovery attempt for failed or timed-out startup phases.
- Feed recovery results into the lifecycle report instead of burying them in logs.

#### PR 7.4 — Apply the same model to plugin startup

- Classify plugin phases such as:
  - manifest load
  - validation
  - instantiation
  - hook registration
  - ready
  - shutdown
- Ensure plugin failures do not collapse unrelated plugins.

#### PR 7.5 — Degraded capability surface in the UI

- Show a banner or status area summarizing working servers/plugins, failed ones, missing tools, and retry options.
- Use capability probes so features dependent on failed MCP servers can disable themselves cleanly.

### Risks

- UI code may assume MCP or plugin status is a single string rather than a phased report
- recovery attempts can hide repeat failures if phase reporting is not explicit enough

### Verification

- tests with N servers where one fails or times out
- recovery tests for one automatic retry then escalation/degraded state
- plugin phased load tests, including `detect()`-style failures once Wave 9 lands
- full repo verification commands

### Exit criteria

- MCP and plugin startup report partial success explicitly
- one server/plugin can fail without collapsing unrelated capabilities
- recovery is structured, measured, and user-visible

---

## Wave 8 — Permissions, Recovery Recipes, and Stale-Branch Safety

### Objective

Unify permission posture into explicit modes, encode recovery as typed recipes, and catch stale or diverged branches before they become opaque failures.

### Primary files

- `src/main/security/permission-manager.ts`
- `src/main/security/permission-mapper.ts`
- `src/main/security/path-validator.ts`
- `src/main/security/bash-validation/`
- `src/main/recovery/`
- `src/main/git/branch-freshness.ts` (new)

### Problems solved

- users gain explicit safety modes they can understand and trust
- recovery stops being an ad hoc grab bag and becomes observable, typed, and limited
- stale branches are reported as first-class conditions instead of generic test or compile failures

### PR slices

#### PR 8.1 — Permission mode and enforcer abstraction

- Introduce `PermissionMode` and `EnforcementResult` contracts.
- Wrap existing path and bash validators in a unified `PermissionEnforcer`.
- Preserve current safety behavior while making mode semantics explicit.

#### PR 8.2 — Prompting and decision persistence

- Integrate permission requests from the provider event flow with the enforcer and decision store.
- Support “remember this decision” semantics where appropriate.
- Ensure permission prompts carry stable request IDs.

#### PR 8.3 — Typed recovery recipes and engine

- Convert builtin recovery recipes into typed `RecoveryRecipe` and `RecoveryStep` contracts.
- Build a `RecoveryEngine` that subscribes to failures from the orchestration event stream.
- Enforce the “one automatic attempt, then escalate” rule.

#### PR 8.4 — Stale-branch checker and policy

- Add branch freshness detection with policies such as warn, block, auto-rebase, or merge-forward.
- Use it as a pre-flight or verification-stage check for agent workspaces.

#### PR 8.5 — Recovery telemetry and operator visibility

- Record scenario, recipe chosen, steps taken, and final result.
- Expose enough information in logs or UI for a human to understand why a recovery escalated.

### Risks

- prompt mode can become noisy if per-tool memory and batching are weak
- stale-branch detection must distinguish “intentionally divergent” from “dangerously stale”

### Verification

- permission matrix tests across mode/tool/input combinations
- recovery engine tests for max-attempt enforcement and event ordering
- git fixture tests for fresh/stale/diverged branches
- full repo verification commands

### Exit criteria

- safety posture is declared in one explicit mode model
- recovery behavior is typed and observable
- stale branches are recognized and handled as a first-class scenario

---

## Wave 9 — Plugin Slot Architecture + SDK Parity

### Objective

Move from “plugin = thing with hooks” to an explicit slot taxonomy with runtime contracts, load reports, and SDK parity tests.

### Primary files

- `packages/contracts/src/plugins.ts`
- `packages/sdk/src/plugins.ts`
- `src/main/plugins/plugin-manager.ts`
- `src/main/plugins/plugin-registry.ts` (new)
- `src/main/skills/`
- built-in channel/notification integrations

### Problems solved

- extension points become understandable and enforceable
- runtime hook payload drift between SDK and implementation is caught automatically
- built-in integrations can be migrated into the same architecture used by third-party extensions

### PR slices

#### PR 9.1 — Slot taxonomy and manifest/schema updates

- Introduce slots such as:
  - provider
  - channel
  - mcp
  - skill
  - hook
  - tracker
  - notifier
  - telemetry exporter
- Extend manifest validation accordingly.

#### PR 9.2 — Registry by slot with back-compat defaults

- Split `PluginManager` responsibilities so a registry owns slot dispatch.
- Backfill existing plugins without `slot` to a compatible default, likely `hook`.

#### PR 9.3 — Promote existing subsystems into slots

- Move provider adapters into the `provider` slot contract.
- Move skills into the `skill` slot contract.
- Convert one built-in communication channel as a proof point.

#### PR 9.4 — Add `detect()` and structured load reports

- Let plugins declare whether required binaries or dependencies exist.
- Report failures by phase and plugin name instead of generic startup messages.

#### PR 9.5 — SDK parity tests

- Add tests that ensure public SDK exports and runtime payload shapes stay aligned.
- Mirror the discipline seen in sibling repos that test export subpaths explicitly.

### Risks

- retrofitting slots onto existing plugin/skill code can create temporary duplication
- converting built-in channels too early can distract from the core contract work

### Verification

- manifest validation tests
- slot-type load tests
- `detect()` failure tests
- SDK export/parity tests
- full repo verification commands

### Exit criteria

- every plugin-capable subsystem has a declared slot
- runtime payloads and SDK types are checked for parity
- plugin failures are phased and comprehensible

---

## Wave 10 — Remote Pairing for Remote Nodes

### Objective

Replace ad hoc shared-secret assumptions with a one-time pairing and authenticated-session flow for remote nodes.

### Primary files

- `src/worker-agent/worker-agent.ts`
- `src/main/auth/remote-auth.ts` (new)
- remote pairing IPC handlers and renderer settings panels
- storage for client session credentials

### Problems solved

- remote orchestration can pair a new device without manually distributing long-lived secrets
- client sessions gain revocation and lifecycle visibility
- remote-node trust becomes closer to the pairing flows users already understand

### PR slices

#### PR 10.1 — Pairing contracts and auth service

- Add pairing credential, authenticated session, and pairing payload contracts.
- Implement a main-process auth service that issues one-time pairing links.

#### PR 10.2 — Worker-agent handshake migration

- Teach the worker agent to exchange a one-time token for a session token.
- Store session tokens in OS-appropriate secure storage where possible.

#### PR 10.3 — Coordinator validation and revocation

- Validate WebSocket upgrades against authenticated sessions.
- Add session listing and revocation.

#### PR 10.4 — Settings UI and operator flows

- Add a remote devices panel showing current sessions, last-seen data, pairing links, expiry, and revoke controls.

### Risks

- secure storage support differs across platforms
- pairing URLs or QR flows need clear replay/expiry handling

### Verification

- one-time token invalidation tests
- TTL expiry tests
- revoked-session reconnect rejection tests
- role separation tests
- manual remote-node smoke check

### Exit criteria

- new remote devices can pair without long-lived shared secrets
- paired sessions can be viewed and revoked
- the worker-agent handshake is session-based after pairing

---

## Wave 11 — Bootstrap Dependency Ordering + UI Decomposition

### Objective

Finish the bootstrap modularization already started in the main process and break down the largest Angular containers without redesigning product behavior.

### Primary files

- `src/main/bootstrap/index.ts`
- `src/main/index.ts`
- existing bootstrap registration files
- `src/renderer/app/features/instance-list/instance-list.component.ts`
- `src/renderer/app/features/instance-detail/instance-detail.component.ts`
- `src/renderer/app/features/instance-detail/output-stream.component.ts`
- supporting renderer stores/selectors

### Problems solved

- startup order stops depending on manual file-order assumptions
- teardown becomes explicit and testable
- the largest renderer containers become easier to reason about once backend contracts are stable

### PR slices

#### PR 11.1 — Dependency-aware bootstrap ordering

- Make `bootstrapAll()` honor declared dependencies through a topological sort.
- Detect cycles and fail with actionable diagnostics.

#### PR 11.2 — Move remaining startup logic out of `src/main/index.ts`

- Migrate remaining singleton init and shutdown wiring into bootstrap modules.
- Keep each bootstrap contract explicit: init, teardown, dependencies, failure mode.

#### PR 11.3 — Startup observability and failure reporting

- Record bootstrap timing, dependencies, and failures so startup issues are easier to diagnose.

#### PR 11.4 — Renderer hotspot decomposition

- Split the largest container components into smaller presenters/selectors/store helpers.
- Preserve UX and behavior; do not redesign layouts or flows.

### Risks

- startup changes can break subtle initialization order assumptions
- large Angular files often hide coupled state and template assumptions

### Verification

- bootstrap unit tests including cycle detection and dependency ordering
- component and store tests for decomposed renderer areas
- manual smoke test of startup, instance list, instance detail, and output streaming
- full repo verification commands

### Exit criteria

- `src/main/index.ts` is materially smaller and mostly orchestration-free
- bootstrap dependencies are enforced by code
- large renderer containers are smaller without behavioral regressions

---

## 8. Parallelization Plan

This program is large enough to benefit from multiple contributors once the backbone waves land.

### Suggested lanes

- **Lane A — Core runtime backbone**
  - Wave 1
  - Wave 2
  - Wave 3

- **Lane B — Persistence**
  - Wave 5
  - Wave 6
  - starts after Wave 4 foundations are stable

- **Lane C — Lifecycle hardening / recovery**
  - Wave 7
  - Wave 8
  - starts after Waves 3–4 provide stable event inputs

- **Lane D — Extension architecture**
  - Wave 9
  - starts after Wave 7 is defined enough to avoid dueling plugin abstractions

- **Lane E — Optional remote and decomposition work**
  - Wave 10
  - Wave 11
  - ideally after core runtime churn slows down

### What should not run in parallel

- Wave 2 and Wave 3 should not be split across competing designs.
- Wave 4 should remain centrally owned; it is the keystone for later reactors.
- Wave 11 renderer decomposition should not start while Wave 2 or Wave 3 still changes event/store semantics aggressively.

---

## 9. Decisions Needed Before Execution

These should be resolved early to prevent churn.

1. **Event store backing** — stick with sqlite directly or formalize a pluggable store interface from day one.
2. **Compatibility window** — confirm whether one release is enough for legacy provider and plugin shapes.
3. **Checkpoint strategy in non-git workspaces** — confirm shadow repo behavior and storage budget.
4. **Permission mode names** — align any UI vocabulary before wiring them deeply into IPC and telemetry.
5. **Remote pairing storage** — confirm per-platform credential storage approach and acceptable fallbacks.
6. **Plugin slot scope** — decide whether `tracker` and `telemetry_exporter` ship in the first slot wave or land as reserved slots first.
7. **Bootstrap/UI ownership** — decide whether Wave 11 remains one wave or is split into separate backend and renderer streams.

---

## 10. Suggested First 30 Days

If the team wants the highest-return month of work, this is the recommended first block.

### Week 1

- Land Wave 1 characterization tests.
- Finish package export discipline and CI guards.
- Write the lifecycle direct-mutation audit list.

### Week 2

- Land Wave 2 lifecycle contracts and state-machine event emission.
- Migrate the highest-risk transition paths first: restart, terminate, resume.

### Week 3

- Land Wave 3 canonical provider envelope finalization.
- Eliminate `seq = 0` from the bridge path.
- Move one or two heavy downstream consumers fully onto the normalized envelope.

### Week 4

- Start Wave 4 shadow orchestration event store.
- Add queue draining to the first deterministic scenario harness.
- Prepare the path service skeleton so Wave 5 can start cleanly.

This first month will not finish the whole program, but it will remove the most dangerous correctness gaps and create the platform needed for the later waves.

---

## 11. Definition of Done for the Full Program

The program is complete only when all of the following are true:

- instance lifecycle transitions are authoritative and evented
- provider runtime consumers rely on one normalized envelope
- orchestration has an append-only event log and deterministic drain-based tests
- session persistence uses shared project-rooted storage conventions
- checkpoints are git-backed or shadow-git-backed and inspectable
- MCP and plugin startup tolerate partial failure with degraded-mode reporting
- permission posture and recovery recipes are explicit and typed
- plugin slots and SDK parity tests exist and pass
- remote pairing is session-based for remote nodes
- startup dependency ordering is enforced
- the main process entrypoint and largest renderer containers are materially easier to audit

---

## 12. Completion Checklist by Issue

Use this checklist as the release-manager view for the whole series.

- [x] Contract/export hygiene complete and guarded in CI
- [x] Lifecycle state machine authoritative
- [x] Provider stack converged on normalized runtime events
- [x] Orchestration event store and deterministic scenario harness in place
- [x] Path service introduced and core session data migrated
- [x] Auto-compaction policy implemented and verified
- [x] Git-backed checkpoint store dual-written, compared, and promoted
- [x] MCP phased lifecycle and degraded reports live
- [x] Plugin phased lifecycle and degraded reports live
- [x] Permission modes unified behind `PermissionEnforcer`
- [x] Recovery recipes and engine typed and event-driven
- [x] Stale-branch detection and policy live
- [x] Plugin slot registry and SDK parity tests live
- [x] Remote pairing flow shipped
- [x] Bootstrap dependency ordering enforced
- [x] Renderer hotspots decomposed without UX drift

---

## 13. Summary

The main takeaway from the audit is simple:

**AI Orchestrator does not need a ground-up rewrite. It needs its existing abstractions to become authoritative.**

The first five waves deliver the highest leverage:

1. export/contract hygiene
2. lifecycle discipline
3. provider event convergence
4. orchestration event source
5. persistence/checkpoint modernization

The remaining waves turn that backbone into a platform that can tolerate partial failure, support cleaner extensions, and scale its codebase without becoming harder to trust.
