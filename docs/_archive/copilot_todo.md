# AI Orchestrator cross-project improvement todo

Date: 2026-05-31

Scope: compared AI Orchestrator with sibling projects under `/Users/suas/work/orchestrat0r`, including Jean, OpenCode, CodePilot, T3Code, OpenClaw, NanoClaw, Oh My Codex, oh-my-opencode-slim, Hermes Agent, Agent Orchestrator, RTK, Storybloq, MemPalace, Copilot SDK, Claw Code, Codex, codex-plugin-cc, Actual Claude, and the smaller browser/desktop experiments.

Important repo rule: this is an unfinished planning/todo artifact. Keep it untracked unless James explicitly asks to commit it, or rename it with `_completed` after implementation and verification.

## 2026-05-31 deep-dive refresh shortlist

This pass re-read `ai-orchestrator` alongside Jean, OpenCode, Codex, OpenClaw, Hermes Agent, Agent Orchestrator, and related sibling projects. It also cross-checked the current app code in `README.md`, `DESIGN.md`, `DEVELOPMENT.md`, `src/main/index.ts`, `src/worker-agent/worker-agent.ts`, `src/renderer/app/features/setup/setup-center.component.ts`, `src/renderer/app/core/services/first-run.service.ts`, `src/preload/domains/diagnostics.preload.ts`, `src/preload/domains/runtime-plugin.preload.ts`, and `src/main/providers/provider-adapter-registry.ts`.

These are the highest-confidence improvements to prioritize next:

1. **Finish a provider-neutral live model catalog.**
   - **Why:** OpenCode, Hermes, and T3Code treat model metadata as a first-class runtime surface, not a partial overlay.
   - **Gap here:** AI Orchestrator already has model discovery and models.dev plumbing, but the picker/catalog path is still uneven across providers.
   - **Do next:** merge static models, CLI-discovered models, pricing/context overlays, capability flags, and deprecation status into one typed catalog that every picker uses.

2. **Create a canonical `ProviderRuntimeRegistry`.**
   - **Why:** T3Code and OpenCode keep runtime state in one authoritative registry with typed lifecycle events.
   - **Gap here:** status is split across startup checks, Doctor, picker logic, and provider services.
   - **Do next:** keep one record per provider/runtime pair, preserve degraded or unavailable shadow states, and emit explicit available/degraded/unavailable/refreshed events.

3. **Harden remote and mobile transport replay.**
   - **Why:** Jean, T3Code, and OpenClaw all lean on stronger replay semantics, scoped sequence handling, and idempotent side effects.
   - **Gap here:** worker nodes already have strong reconnect handling, but mobile and remote event consumers still look less resumable than they should be.
   - **Do next:** add per-client `lastSeq` resume, bounded per-instance replay buffers, typed event envelopes, and idempotency keys for create/respond/interrupt/terminate flows.

4. **Separate the always-on controller from the desktop shell more cleanly.**
   - **Why:** OpenClaw, Hermes Agent, and Agent Orchestrator make daemon or controller mode a first-class product surface.
   - **Gap here:** AI Orchestrator has strong remote-node foundations, but the product story is still mostly desktop-first.
   - **Do next:** formalize controller/worker mode, document headless node deployment, and make remote orchestration feel like a primary workflow instead of an advanced feature.

5. **Upgrade Doctor from probes into repairable incidents.**
   - **Why:** CodePilot and Hermes are better at turning failure detection into guided recovery.
   - **Gap here:** diagnostics and provider doctor surfaces exist, but they still feel more like reporting than repair.
   - **Do next:** add a shared error taxonomy, repair actions with command previews, redacted incident bundles, and tighter links from Setup Center to exact fixes.

6. **Finish main-thread offload and enforce it with a guardrail.**
   - **Why:** the current code already documents past Electron event-loop stalls, and sibling systems avoid synchronous hot-path storage work more aggressively.
   - **Gap here:** AI Orchestrator has moved important work off-thread, but the architecture docs still point to unfinished hot-path migrations.
   - **Do next:** complete the remaining prompt assembly and session-save offloads, then add CI checks that block new synchronous `better-sqlite3` usage in Electron hot paths.

7. **Add deterministic runtime receipts for integration tests.**
   - **Why:** T3Code and similar systems reduce flake by waiting on typed receipts rather than sleeps or indirect polling.
   - **Gap here:** AI Orchestrator already has strong focused specs, but loop, remote, and mobile flows would benefit from a shared scripted runtime harness.
   - **Do next:** add a scripted provider adapter plus `awaitReceipt` / `drainRuntime` helpers for end-to-end orchestration tests.

8. **Turn Setup Center into a self-healing onboarding and recovery flow.**
   - **Why:** CodePilot and OpenClaw are stronger at calm first-run guidance and recovery UX.
   - **Gap here:** Setup Center exists and is a good foundation, but it should become the main guided repair surface, not just a grouped readiness view.
   - **Do next:** detect conflicting CLI installs, expose progress across required setup steps, keep one-click re-checks, and route users straight into the exact fix path when possible.

9. **Make plugin extension points more explicit and example-driven.**
   - **Why:** OpenCode, Agent Orchestrator, and Claude Code benefit from clearer extension contracts and examples.
   - **Gap here:** runtime plugin plumbing and provider registration exist, but the public extension story is still harder to understand than it should be.
   - **Do next:** document stable extension seams for providers, transports, notifications, and workflow templates, then ship a few minimal example plugins.

10. **Promote reusable orchestration templates as first-class entry points.**
   - **Why:** sibling tools win by making common workflows obvious immediately.
   - **Gap here:** AI Orchestrator already has deep orchestration capability, but the top-level UX still emphasizes systems more than outcomes.
   - **Do next:** surface starter flows like verification swarm, debate and consensus review, research team, remote worker fleet, and recovery drill directly from the main entry experience.

11. **Tighten the install and README story around workflows.**
   - **Why:** Opencode and Codex are better at quickly telling a new user what to do first.
   - **Gap here:** `README.md` still leads with architecture breadth more than a clear first successful workflow.
   - **Do next:** reframe the top of the README around 3 to 5 concrete outcomes, then link setup, doctor, remote nodes, and workflow templates from there.

12. **Preserve the current correctness discipline while productizing the app.**
   - **Why:** this is where AI Orchestrator is already stronger than most siblings.
   - **Keep:** generated IPC channels, contract checks, import-boundary enforcement, smoke checks, shutdown cleanup, and the remote worker reconnect path.
   - **Do next:** treat these as non-negotiable guardrails while simplifying the user-facing experience elsewhere.

## Sources inspected

AI Orchestrator:
- `README.md`, `docs/architecture.md`, `package.json`
- `docs/plans/2026-05-29-backlog-deconfliction-and-sequencing.md`
- `docs/plans/2026-05-29-main-thread-offload-architecture_completed.md`
- `docs/plans/2026-05-30-loop-adapter-degraded-output-detection.md`
- `docs/plans/2026-05-28-first-class-remote-orchestration-plan.md`
- `docs/plans/2026-05-29-provider-model-auto-update-plan.md`
- `docs/mobile-app/2026-05-30-mobile-control-app-plan.md`
- `src/main/mobile-gateway/mobile-gateway-server.ts`
- `src/main/remote-node/rpc-event-router.ts`
- `src/main/remote-node/rpc-schemas.ts`
- `src/main/providers/models-dev-service.ts`
- `src/main/providers/model-discovery.ts`
- `src/main/providers/provider-doctor.ts`
- `src/main/diagnostics/doctor-service.ts`
- `src/main/automations/automation-scheduler.ts`
- `src/main/automations/automation-runner.ts`
- `src/renderer/app/features/models/dynamic-model-catalog.service.ts`
- `src/renderer/app/features/models/model-picker.controller.ts`
- `src/renderer/app/features/models/compact-model-picker.component.ts`

Sibling references:
- Jean: `README.md`, `docs/developer/architecture-guide.md`, `docs/developer/performance-patterns.md`, `docs/developer/state-management.md`, `docs/developer/command-system.md`, `src-tauri/src/http_server/server.rs`, `src-tauri/src/http_server/websocket.rs`, `src/hooks/useCliVersionCheck.ts`
- OpenCode: `README.md`, `specs/v2/provider-model.md`, `specs/v2/catalog-config-plugin-lifecycle.md`, `specs/v2/config.md`, `specs/v2/instructions.md`, `packages/core/src/catalog.ts`, `packages/core/src/plugin.ts`, `packages/core/src/agent.ts`, `packages/core/src/models-dev.ts`
- T3Code: `.docs/architecture.md`, `.docs/provider-architecture.md`, `apps/server/src/provider/providerMaintenance.ts`, `apps/server/src/provider/Layers/ProviderService.ts`, `apps/server/src/provider/Layers/ProviderInstanceRegistryLive.ts`
- CodePilot: `README.md`, `ARCHITECTURE.md`, `src/lib/agent-loop.ts`, `src/lib/task-scheduler.ts`, `src/lib/provider-doctor.ts`, `docs/handover/bridge-system.md`, `docs/handover/provider-error-doctor.md`
- OpenClaw: `README.md`, `docs/concepts/architecture.md`, `docs/concepts/agent-loop.md`, `docs/concepts/context-engine.md`, `docs/gateway/sandboxing.md`
- NanoClaw: `README.md`, `docs/architecture.md`, `src/container-runner.ts`, `src/channels/channel-registry.ts`, `src/session-manager.ts`
- Oh My Codex: `README.md`, `docs/STATE_MODEL.md`, `docs/contracts/team-runtime-state-contract.md`, `src/team/runtime.ts`, `src/cli/ultragoal.ts`
- oh-my-opencode-slim: `README.md`, `docs/session-goal.md`, `docs/todo-continuation.md`, `docs/subtask.md`, `src/hooks/todo-continuation/index.ts`
- Hermes Agent: `README.md`, `website/docs/developer-guide/architecture.md`, `website/docs/developer-guide/agent-loop.md`, `website/docs/developer-guide/context-engine-plugin.md`, `website/docs/developer-guide/provider-runtime.md`, `website/docs/developer-guide/cron-internals.md`, `docs/security/network-egress-isolation.md`
- Agent Orchestrator: `README.md`, `docs/ARCHITECTURE.md`, `docs/PLUGIN_SPEC.md`, `docs/observability.md`, `packages/core/src/lifecycle-state.ts`, `packages/core/src/types.ts`
- Other useful signal: `RTK.md`, RTK `README.md`, Storybloq `README.md`, MemPalace `README.md`, Actual Claude `Task.ts` and `cost-tracker.ts`, Copilot SDK `README.md`, Claw Code `README.md`, codex-plugin-cc `README.md`, online-orchestrator `PLAN.md` and browser extension worker.

## P0 - do first

### 1. Finish the model catalog and picker integration

Evidence from sibling projects:
- OpenCode has a first-class catalog service with provider/model transforms, policy filtering, model update events, and models.dev caching.
- T3Code adds provider maintenance metadata and update advisories.
- Hermes centralizes provider/model runtime resolution across CLI, gateway, cron, ACP, and auxiliary calls.

AI Orchestrator state:
- `ModelsDevService` currently syncs pricing/context overlay only.
- `DynamicModelCatalogService` only live-refreshes Copilot and Cursor, then falls back to static `getModelsForProvider`.
- The existing provider-model auto-update plan already calls out the open Phase 3-A picker gap.

First slice:
- Add a provider-neutral `ModelCatalogService` contract that merges static models, CLI-discovered models, and models.dev data.
- Emit a typed `model-catalog.updated` event after refresh.
- Include model id, display name, provider, context, output limit, pricing, capabilities, deprecated/disabled status, source, and last checked timestamp.
- Use the merged catalog in the compact picker for all providers, not just Copilot/Cursor.
- Keep static catalogs as offline fallback.

Verification:
- Unit tests for models.dev merge, stale/fallback behavior, deprecated filtering, and catalog update events.
- Renderer tests for picker refresh and fallback.
- One visual smoke check of the picker with static-only and live-discovered data.

### 2. Add a provider runtime registry with unavailable shadow snapshots

Evidence from sibling projects:
- T3Code's provider instance registry reconciles config diffs without disturbing unaffected instances and turns malformed drivers into unavailable snapshots instead of crashing startup.
- Agent Orchestrator uses explicit canonical session/runtime/PR state records.
- OpenCode v2 pushes toward small typed containers, domain events, private state, and plugin transforms.

AI Orchestrator state:
- Providers, CLI detection, update plans, instance lifecycle, and remote node events exist, but status ownership is split across several services.
- `ProviderDoctor` and `DoctorService` diagnose providers, but they are not the same thing as an authoritative provider runtime state registry.

First slice:
- Introduce `ProviderRuntimeRegistry` in main process with one scoped record per provider/runtime integration.
- Reconcile settings/CLI changes into records.
- Preserve an unavailable shadow record when a provider is installed incorrectly, missing auth, malformed, or version-incompatible.
- Emit typed lifecycle events for provider available, degraded, unavailable, refreshed, and removed.
- Route Doctor and picker status through this registry over time.

Verification:
- Tests where one provider is malformed and other providers still work.
- Tests for config change reconciliation.
- UI snapshot/diagnostic test showing unavailable provider state instead of silent disappearance.

### 3. Harden mobile and remote transport with sequence replay and idempotency

Evidence from sibling projects:
- Jean's HTTP server returns a scoped `/api/init` payload with bounded recent messages and WebSocket replay.
- T3Code uses typed JSON-RPC envelopes, monotonic sequence numbers, reconnect queueing, schema validation at the transport boundary, and replayLatest subscriptions.
- OpenClaw requires typed WS handshakes and idempotency keys for side effects.

AI Orchestrator state:
- Remote node RPC has Zod schemas and some `seq` guards for state/permission and terminal frames.
- Mobile gateway broadcasts live output over WS and has HTTP message replay capped at 300 messages, but WS clients do not resume from last seen sequence and side-effect POSTs do not appear to require idempotency keys.

First slice:
- Define shared mobile/remote event envelopes: `eventId`, `seq`, `scope`, `instanceId`, `timestamp`, `kind`, `payload`.
- Add per-client resume from `lastSeq`.
- Maintain a bounded per-instance ring buffer for output/prompt/state events.
- Require optional-but-supported idempotency keys for input, respond, interrupt, terminate, rename, and create-instance requests; make clients send them.
- Return structured decode/auth errors instead of generic 500s where possible.

Verification:
- Unit tests for reconnect after missed output.
- Tests for duplicate mobile input/respond suppression.
- Tests for stale remote frames being dropped independently per stream, not only per node global sequence.

### 4. Finish main-thread offload and add a guardrail

Evidence from sibling projects:
- NanoClaw uses one-writer SQLite invariants and short open/write/close operations to prevent cross-mount DB lock pain.
- Agent Orchestrator splits terminal WS into a separate process and coordinates through durable files/HTTP.
- Hermes keeps session storage in SQLite with explicit contention handling.

AI Orchestrator state:
- There is already a main-thread offload architecture plan.
- Conversation ledger has worker isolation tests and worker client code, but open plan items still mention create/resume prompt assembly, startup learning loads, session save, and guardrails.

First slice:
- Add a CI guard that fails on direct `better-sqlite3` imports or synchronous heavy services from Electron hot paths unless allowlisted.
- Add an event-loop lag budget smoke test around startup and instance spawn.
- Finish remaining prompt assembly/session-save worker moves from the existing plan.

Verification:
- `src/main/runtime/event-loop-lag-monitor.spec.ts` coverage extended to startup/spawn hot paths.
- `npx tsc --noEmit`, spec typecheck, targeted worker tests, then full test/lint after code changes.

### 5. Implement adapter-layer degraded-output detection

Evidence from sibling projects:
- CodePilot runs a native agent loop that intercepts every step before persisting or continuing.
- oh-my-opencode-slim has hooks for foreground fallback, delegate retries, JSON error recovery, and todo continuation safety gates.
- Jean documents provider-specific streaming parse and history repair rules.

AI Orchestrator state:
- There is a dedicated open plan for loop adapter degraded-output detection.
- Current loop recovery is strong, but the plan identifies delayed/batched/synthetic tool results, cancellation markers, and degraded CLI output as adapter-layer gaps.

First slice:
- Put detection in the shared CLI adapter layer before loop orchestration consumes events.
- Classify delayed tool result, synthetic result, cancellation marker, duplicate stale result, and partial replay.
- Tag `ProviderRuntimeEventEnvelope` with a degraded-output reason.
- Make loop coordinator either reissue, ask the adapter for a fresh state, or surface a blocked diagnostic.

Verification:
- Fixture tests per adapter family.
- Existing `loop-coordinator-degraded-retry.spec.ts` extended to prove degraded adapter events trigger the new path.

### 6. Finish evidence resolver and convergence cycle

Evidence from sibling projects:
- Oh My Codex gates completion on verification, review, and quality-gate artifacts.
- Agent Orchestrator keeps canonical lifecycle reasons for CI failure, review pending, changes requested, and merge-ready states.
- CodePilot keeps checkpoints and can rewind around tool steps.

AI Orchestrator state:
- Remote Piece B already names evidence-resolver, convergence cycle, and review quality as open work.
- `src/main/orchestration/evidence-resolver.ts` exists and has tests, but this still appears to be an active lane.

First slice:
- Persist evidence records with source, command/reviewer, artifact refs, status, confidence, and contradiction links.
- Make the loop treat "fixed", "verified", and "reviewed" as separate evidence states.
- If evidence contradicts the completion claim, schedule a fresh-eyes or verifier pass automatically.

Verification:
- Convergence specs proving fix -> verify -> review -> accept, and fix -> verify fail -> retry.
- Artifact export includes the evidence trail.

### 7. Add deterministic runtime receipts for tests

Evidence from sibling projects:
- T3Code uses RuntimeReceiptBus and DrainableWorker so tests wait on typed receipts instead of polling/timeouts.
- Claw Code documents a deterministic mock parity harness.
- Agent Orchestrator has broad lifecycle/session-manager tests around mocked plugins.

AI Orchestrator state:
- There are many focused Vitest specs, but end-to-end loop/mobile/remote flows still risk timing flake if they wait on process state indirectly.
- The deconfliction doc already recommends web-build E2E plus a scripted mock adapter.

First slice:
- Build a scripted provider adapter that emits typed runtime receipts for output, tool call, permission request, state change, completion, and error.
- Add `awaitReceipt` / `drainRuntime` helpers for loop, remote, mobile, and renderer tests.
- Prefer receipts over sleep/poll loops in new tests.

Verification:
- New integration test proves a full scripted flow: spawn, output, permission, mobile respond, verify, complete.
- Flaky timeout-prone tests use receipt drains where touched.

## P1 - high leverage next

### 8. Define a pluggable context engine boundary

Evidence:
- OpenClaw defines `ingest`, `assemble`, `compact`, `afterTurn`, optional subagent hooks, host requirements, quarantine, and fallback.
- Hermes exposes a ContextEngine ABC with lifecycle hooks, compression decisions, status, and optional context tools.
- MemPalace and Storybloq show value in durable, queryable, project-scoped continuity outside a single transcript.

AI Orchestrator state:
- AI Orchestrator already has context, memory, codemem, loop memory, and conversation ledger pieces.
- The missing piece is a single contract that lets strategies vary without each agent loop growing special cases.

First slice:
- Add `ContextEngine` interface with `ingest`, `assemble`, `compact`, `afterTurn`, `getStatus`, and optional tools.
- Wrap the current strategy as `legacy`.
- Add quarantine/fallback if an engine fails.
- Keep engine output typed and auditable in the conversation ledger.

Verification:
- Contract tests for legacy engine.
- Failure isolation test: bad engine fails closed and the agent continues with fallback context.

### 9. Upgrade Doctor from probes to repairable incidents

Evidence:
- CodePilot has a provider error classifier, Provider Doctor probes, repair actions, and redacted runtime logs.
- Actual Claude has dedicated doctor, plugin startup checks, usage/cost reporting, and CLI health commands.

AI Orchestrator state:
- `ProviderDoctor` already has CLI install/auth/shadow probes and recommendations.
- `DoctorService` aggregates startup, provider, CLI, browser, command, skill, instruction, and artifacts.

First slice:
- Add a provider error taxonomy shared by adapters, Doctor, and UI.
- Add repair actions with command previews and safety labels: install/update CLI, login, remove shadow install, refresh auth, select fallback provider, clear stale resume state.
- Add a redacted runtime log bundle per provider incident.

Verification:
- Provider Doctor tests for each error category and repair action.
- Redaction tests prove tokens, paths marked secret, and prompt bodies are not leaked.

### 10. Make automation scheduling resilient under repeated failure

Evidence:
- CodePilot's scheduler handles missed tasks, expiration, session-only tasks, exponential backoff, deterministic jitter, and auto-disable after repeated errors.
- Hermes cron uses a cross-process lock, fresh session isolation, fallback providers, credential pools, script timeouts, and recursion guards.

AI Orchestrator state:
- `AutomationScheduler` handles suspend/resume catch-up and rescheduling.
- `AutomationRunner` has idempotency input, pending queue promotion, output capture, plugin hooks, and channel delivery.

First slice:
- Audit current `AutomationStore` failure policy, then add only missing pieces: retry/backoff, deterministic jitter, max failure auto-disable, per-automation failure summary, and cross-process lock if multiple runners can exist.
- Make unattended permission/input failures actionable in the run record, not just terminal errors.

Verification:
- Tests for missed run catch-up, repeated failure auto-disable, retry backoff, duplicate fire suppression, and delivery failure recording.

### 11. Extract a first-class channel adapter SDK

Evidence:
- CodePilot's bridge system separates adapter registry, channel router, conversation engine, permission broker, delivery layer, and bridge manager.
- NanoClaw's channel adapters self-register and keep platform concerns isolated.
- Hermes supports many messaging platforms through a unified gateway.

AI Orchestrator state:
- Channels exist, and mobile/Discord/WhatsApp delivery appears active, but adapter behavior is not yet as uniformly specified as provider adapters.

First slice:
- Define `ChannelAdapter` contract with inbound message normalization, outbound delivery, ack/watermark, attachment capability, markdown capability, permission callback support, and rate-limit metadata.
- Add safe offset/watermark semantics for every platform that polls.
- Add a Markdown/attachment intermediate representation that can degrade per platform.

Verification:
- Contract tests with fake Discord/WhatsApp/mobile adapters.
- Duplicate inbound event test proves idempotency.
- Permission callback auth test proves external channel replies cannot answer another user's prompt.

### 12. Add a sandbox policy matrix for agent/tool execution

Evidence:
- OpenClaw documents sandbox modes `off`, `non-main`, and `all`, with Docker, SSH, and OpenShell backends.
- NanoClaw runs agents in containers with per-agent workspaces.
- Hermes supports local, Docker, SSH, Singularity, Modal, and Daytona terminal backends, plus network egress isolation guidance.

AI Orchestrator state:
- Remote nodes, directory sync, browser gateway grants, and yolo mode exist.
- What is missing is a single operator-visible policy matrix explaining where each agent/tool can execute and which boundaries apply.

First slice:
- Add a `SandboxPolicy` model: scope, backend, allowed roots, network policy, yolo compatibility, file sync mode, and permission default.
- Surface it when spawning child agents, remote agents, and automations.
- Add a safe default for non-main/remote/channel-originated sessions.

Verification:
- Tests that channel-originated and child-agent sessions cannot silently inherit unsafe local-yolo execution.
- UI/Doctor diagnostic showing current sandbox posture.

### 13. Centralize workflow state authority

Evidence:
- Oh My Codex has an explicit state model with authoritative files, lifecycle transitions, and compatibility rules.
- Agent Orchestrator has canonical session, PR, and runtime states.
- Actual Claude's task model has simple terminal-state helpers used to prevent injections into dead tasks.

AI Orchestrator state:
- Loop, automation, remote, provider, and instance statuses each have their own vocabulary.

First slice:
- Write a shared state authority contract for agent work: `not_started`, `working`, `needs_input`, `blocked`, `verifying`, `reviewing`, `done`, `failed`, `cancelled`, `superseded`.
- Map provider/loop/automation/remote states onto it without deleting local detail.
- Make terminal-state checks common helpers.

Verification:
- Transition tests prevent rollback from terminal states and prevent sending input to terminal/superseded instances.
- UI status chips use the canonical state plus detailed reason.

### 14. Add renderer state and render-performance conventions

Evidence:
- Jean has strong state layering rules: local UI state in components, global transient UI state in Zustand, backend data in TanStack Query, and `getState` in commands to avoid render cascades.
- Jean also documents primitive selectors, CSS visibility for stateful panels, and strategic memoization.

AI Orchestrator state:
- The Angular renderer already uses standalone OnPush components and signals.
- There are many stores/components and high-frequency output surfaces where broad signal reads can still cause cascades.

First slice:
- Write `docs/renderer-state-performance.md` for Angular signals: durable IPC data vs transient UI state, narrow computed selectors, no broad store reads in output rows, stable dimensions for high-frequency panes.
- Add a small render-count or mutation-load test around the output stream and instance list.
- Audit the largest components before adding new UI.

Verification:
- Focused tests or benchmarks around output streaming and instance list updates.
- No broad-signal regressions in touched UI code.

### 15. Add lightweight session goals and handovers

Evidence:
- oh-my-opencode-slim pins a session goal and keeps auto-continuation todo-driven.
- Storybloq turns handovers, tickets, lessons, and blockers into project-readable files.
- MemPalace emphasizes verbatim local recall, agent-specific diaries, and idempotent conversation mining.

AI Orchestrator state:
- AI Orchestrator has session recovery, conversation ledger, loop memory, and codemem.
- A lightweight operator-level goal/handover layer would improve long-running work without creating a full project manager.

First slice:
- Add optional `goal` and `handover` records per chat/instance/loop run.
- Make loop and child-agent prompts inherit the goal as context, but never auto-run from a goal alone.
- Add "latest handover" to resume/recover flows.

Verification:
- Tests that goal is inherited by child agents and remote workers.
- Tests that goal alone does not trigger loop continuation.

### 16. Improve terminal and session replay ergonomics

Evidence:
- Agent Orchestrator's Windows pty-host keeps a rolling 1000-line output buffer for attach/replay.
- Jean's HTTP server windows recent messages and supports event replay on reconnect.

AI Orchestrator state:
- Remote terminal manager and mobile replay exist, but replay semantics differ by surface.

First slice:
- Standardize rolling buffers for terminal, instance output, and mobile snapshots.
- Expose "attached from seq N" in diagnostics.
- Make new UI clients receive a bounded replay plus live stream without duplicate rows.

Verification:
- Reconnect tests for remote terminal and mobile clients.
- Snapshot tests for duplicate suppression.

### 17. Harden plugin lifecycle with hot reload and quarantine

Evidence:
- OpenCode v2 plans granular hot reload and plugin transform lifecycle.
- Hermes has plugin discovery, active provider plugin selection, and context/memory plugin boundaries.
- Actual Claude has plugin validation, startup checks, blocklists, cache, marketplace management, and installed plugin reconciliation.

AI Orchestrator state:
- AI Orchestrator has plugin hooks and command/skill diagnostics.

First slice:
- Add plugin lifecycle states: discovered, validated, active, degraded, quarantined.
- Add hot reload only for safe plugin surfaces first: commands, skills, output styles, non-mutating hooks.
- Doctor should show plugin startup failures and suggested repairs.

Verification:
- Plugin with invalid manifest is quarantined and cannot break app startup.
- Hot reload updates a command without restarting the app.

### 18. Expand usage, cost, and context analytics

Evidence:
- Actual Claude persists per-session cost, API duration, wall duration, line changes, model usage, cache read/write, and web-search request totals.
- RTK measures token savings by command category and can discover missed savings opportunities.

AI Orchestrator state:
- Usage and context UI exist, and models.dev pricing overlay is present.

First slice:
- Persist per-session model usage by model family, cost, context pressure, cache usage where available, CLI/API duration, tool duration, line changes, and retry/fallback counts.
- Show "unknown pricing" clearly when model catalog lacks rates.
- Add an operator report for high-noise command outputs and potential RTK-like compression opportunities.

Verification:
- Cost restore tests across resumed sessions.
- Pricing fallback tests with unknown model ids.

## P2 - useful, but not before P0/P1

### 19. Multi-model council as a productized review mode

Evidence:
- oh-my-opencode-slim has Council for deliberate multi-model consensus.
- online-orchestrator explores querying ChatGPT, Gemini, and Claude in parallel and merging.
- AI Orchestrator already has debate/consensus systems.

First slice:
- Productize existing consensus as a targeted UI action: "Ask council about this diff/plan/error."
- Keep it manual and cost-visible.

### 20. Native SDK/provider-server integrations where they reduce CLI fragility

Evidence:
- Copilot SDK exposes Copilot CLI server over JSON-RPC.
- Codex app-server and SDK surfaces are more structured than terminal scraping when available.

First slice:
- For providers with a stable server/SDK mode, add an adapter preference order: app-server/SDK first, CLI terminal fallback second.
- Doctor should show which mode is active.

### 21. Auto-generated architecture inventory

Evidence:
- Hermes and AI Orchestrator both have useful architecture docs, but AI Orchestrator changes quickly.
- Storybloq and MemPalace make state inspectable by agents.

First slice:
- Add a script that updates a generated subsystem inventory: directories, singleton entrypoints, IPC handlers, preload bindings, contracts, workers, and tests.
- Keep generated output in docs, not in runtime.

### 22. First-run setup center

Evidence:
- Hermes has `hermes setup`, `hermes doctor`, provider model switching, and migration.
- CodePilot has provider doctor and onboarding surfaces.
- OpenClaw emphasizes onboarding, pairing, allowlists, and sandbox defaults.

First slice:
- One setup surface for providers, model catalog, MCP, browser automation, remote nodes, mobile pairing, channels, and sandbox posture.
- Back it by Doctor sections and repair actions.

### 23. Visual/attachment observer path

Evidence:
- oh-my-opencode-slim has an optional Observer agent for screenshots, PDFs, and diagrams so the main model does not need to ingest raw media.
- AI Orchestrator supports attachments and browser/mobile surfaces.

First slice:
- Add an observer role for image/PDF/video attachment summarization with structured observations and artifact refs.
- Use it only when the selected model lacks multimodal support or when the attachment is too large.

## Things not to do right now

- Do not rewrite AI Orchestrator from Electron/Angular to Tauri/Rust just because Jean is Tauri. The better ideas from Jean are state/performance and headless init/replay patterns, not the framework switch.
- Do not replace AI Orchestrator's CLI-adapter model with a monolithic native agent loop. CodePilot and Hermes prove native loops are powerful, but AI Orchestrator's core value is coordinating existing CLIs. Prefer server/SDK modes where available, with terminal adapters as fallback.
- Do not adopt browser DOM scraping from online-orchestrator as a core integration strategy. It is useful as an experiment, but fragile selectors should stay outside the main provider path.
- Do not duplicate existing backlog lanes. Several high-priority items above are already named in current plans; the action is to finish them with the sibling mechanics called out here.

## Suggested implementation order

1. Finish P0 #1, #5, and #7 together: model catalog, degraded adapter detection, deterministic receipts. These improve provider correctness and make later tests less flaky.
2. Finish P0 #3 and #6 together: transport replay/idempotency plus evidence convergence. These are both about reliable long-running work across reconnects and verification cycles.
3. Finish P0 #4 in parallel when touching ledger/session prompt code. It is infrastructure risk reduction, not a feature UI lane.
4. Then choose one P1 operator experience lane: Doctor repairs (#9), automation resilience (#10), or channel SDK (#11).

## Verification standard for future changes

For code changes from this todo:
- Read the existing implementation and tests before editing.
- Add focused tests for the changed subsystem.
- Run `npx tsc --noEmit`.
- Run `npx tsc --noEmit -p tsconfig.spec.json`.
- Run `npm run lint` or targeted ESLint for touched files.
- Run targeted Vitest specs first; run full tests after multi-file/shared changes.
- For renderer work, run a UI smoke check or screenshot check when behavior/layout changes.
