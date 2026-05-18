# AI Orchestrator Improvement Backlog

Generated after comparing AI Orchestrator with sibling projects. The first pass covered:

- `../t3code`
- `../opencode`

The expanded pass also covered the other source projects in `/Users/suas/work/orchestrat0r`:

- `../Actual Claude`
- `../CodePilot`
- `../CodexDesktop-Rebuild`
- `../OB1`
- `../agent-orchestrator`
- `../claude-code`
- `../claw-code`
- `../codex`
- `../codex-plugin-cc`
- `../copilot-sdk`
- `../hermes-agent`
- `../jean`
- `../mempalace-reference`
- `../nanoclaw`
- `../oh-my-codex`
- `../oh-my-opencode-slim`
- `../online-orchestrator`
- `../openclaw`
- `../rtk`
- `../storybloq`

`../userdata` and `../worktrees` were treated as support/data folders rather than separate source projects.

This is a backlog, not a claim that AI Orchestrator is missing everything below. In several areas AI already has the right primitives: generated IPC contracts, Zod schemas, a provider runtime event bus, an orchestration event store, shell validation, LSP services, compaction services, automation primitives, remote-node support, channel adapters, plugin validation, process supervision, and a bootstrap registry. The recommendations focus on tightening those systems and borrowing proven patterns where sibling projects show clearer implementation or stronger operational guardrails.

## Source Areas Reviewed

AI Orchestrator:

- `AGENTS.md`
- `package.json`
- `README.md`
- `DEVELOPMENT.md`
- `docs/architecture.md`
- `src/main/index.ts`
- `src/main/app/initialization-steps.ts`
- `src/main/bootstrap/index.ts`
- `src/main/providers/provider-interface.ts`
- `src/main/providers/provider-runtime-event-bus.ts`
- `src/main/providers/provider-adapter-registry.ts`
- `src/main/orchestration/event-store/*`
- `src/main/security/bash-validation/*`
- `src/main/instance/*`
- `src/main/cli/adapters/*`
- `src/renderer/app/features/*`

t3code:

- `AGENTS.md`
- `README.md`
- `REMOTE.md`
- `apps/server/src/server.ts`
- `apps/server/src/provider/Services/ProviderAdapter.ts`
- `apps/server/src/provider/Layers/ProviderService.ts`
- `apps/server/src/provider/Layers/EventNdjsonLogger.ts`
- `apps/server/src/orchestration/Layers/OrchestrationEngine.ts`
- `apps/server/src/orchestration/decider.ts`
- `apps/server/src/orchestration/projector.ts`
- `apps/server/src/orchestration/Layers/ProjectionPipeline.ts`
- `packages/contracts/src/providerRuntime.ts`
- `packages/shared/src/KeyedCoalescingWorker.ts`
- `oxlint-plugin-t3code/rules/no-inline-schema-compile.ts`

opencode:

- `packages/opencode/AGENTS.md`
- `packages/opencode/src/effect/run-service.ts`
- `packages/opencode/src/effect/instance-state.ts`
- `packages/opencode/src/bus/index.ts`
- `packages/opencode/src/provider/provider.ts`
- `packages/opencode/src/provider/transform.ts`
- `packages/opencode/src/tool/registry.ts`
- `packages/opencode/src/tool/shell.ts`
- `packages/opencode/src/permission/index.ts`
- `packages/opencode/src/lsp/lsp.ts`
- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/script/schema.ts`
- `packages/opencode/test/server/httpapi-query-schema-drift.test.ts`
- `packages/opencode/src/v2/provider-parity-checklist.md`

Additional sibling projects:

- `../agent-orchestrator/README.md`, `ARCHITECTURE.md`, `DESIGN.md`, `packages/*`, runtime/plugin/session docs
- `../CodePilot/README.md`, `ARCHITECTURE.md`, `src/lib/provider-doctor.ts`, `src/lib/error-classifier.ts`, `src/lib/runtime-log.ts`, `src/lib/bridge/*`, `src/lib/channels/*`
- `../CodexDesktop-Rebuild/README.md`, `package.json`, upstream sync/build scripts
- `../claw-code/README.md`, `PHILOSOPHY.md`, `PARITY.md`, deterministic mock-provider and scenario-harness notes
- `../nanoclaw/README.md`, `CLAUDE.md`, session container, channel, vault, and one-process host notes
- `../Actual Claude/bridge/remoteBridgeCore.ts`, `bridge/sessionRunner.ts`, `remote/RemoteSessionManager.ts`, `services/diagnosticTracking.ts`, `Tool.ts`
- `../openclaw/AGENTS.md`, `VISION.md`, plugin manifest registry, channel turn pipeline, durable delivery, dependency and boundary guard scripts
- `../codex/AGENTS.md`, `codex-rs/app-server/README.md`, `codex-rs/thread-store/README.md`, `codex-rs/process-hardening/README.md`, `codex-rs/thread-store/src/live_thread.rs`, `codex-rs/rollout-trace/src/writer.rs`
- `../copilot-sdk/README.md`, scenario fixtures for transports, auth, prompts, sessions, callbacks, permissions, tools, and SDK lifecycle
- `../hermes-agent/README.md`, `AGENTS.md`, command registry, tool registry, session search, curator, context compressor, gateway/TUI notes
- `../jean/README.md`, `CLAUDE.md`, `src-tauri/src/http_server/dispatch.rs`, `src/store/chat-store.ts`
- `../mempalace-reference/README.md`, `ROADMAP.md`, `pyproject.toml`, local-first verbatim memory and retrieval benchmark docs
- `../rtk/README.md`, `CLAUDE.md`, `Cargo.toml`, output filtering, tee, discovery, and token-savings notes
- `../oh-my-codex/README.md`, `src/team/*`, `src/hooks/extensibility/*`, `src/cli/doctor.ts`, `src/wiki/*`, `src/mcp/*`
- `../oh-my-opencode-slim/README.md`, `src/agents/orchestrator.ts`, `src/council/council-manager.ts`, `src/hooks/todo-continuation/*`, `src/hooks/task-session-manager/*`, `src/config/*`
- `../storybloq/README.md`, `src/autonomous/state-machine.ts`, `src/autonomous/guide.ts`, `src/autonomous/review-lenses/*`, `src/core/project-loader.ts`, `src/mcp/tools.ts`
- `../codex-plugin-cc/README.md`, `plugins/codex/scripts/lib/app-server.mjs`, `plugins/codex/scripts/lib/tracked-jobs.mjs`, command and hook scripts
- `../claude-code/README.md`, `plugins/README.md`, `plugins/hookify/core/rule_engine.py`, hook/plugin examples
- `../OB1/README.md`, `schemas/agent-memory/README.md`, `integrations/agent-memory-api/README.md`, OpenClaw memory recipes
- `../online-orchestrator/PLAN.md`, `multi-ai-query/background/service-worker.js`, `multi-ai-query/content-scripts/*`, `multi-ai-query/shared/utils.js`

Second-pass AI Orchestrator deep dive:

- `src/main/session/session-repair.ts`, `session-continuity.ts`, `artifact-attribution-store.ts`, `git-checkpoint-store.ts`
- `src/main/process/resource-governor.ts`, `supervisor-tree.ts`
- `src/main/plugins/plugin-validator.ts`, `plugin-package-manager.ts`
- `src/main/mcp/redaction-service.ts`, `mcp-lifecycle-manager.ts`
- `src/main/remote-node/security-filter.ts`, `directory-sync-service.ts`
- `src/main/automations/catch-up-coordinator.ts`
- `src/main/browser-gateway/browser-profile-registry.ts`, `browser-approval-store.ts`
- `src/main/learning/prompt-enhancer.ts`, `ab-testing.ts`
- `src/main/observation/policy-adapter.ts`
- `src/main/review/review-execution-host.ts`
- `src/main/diagnostics/doctor-service.ts`, `operator-artifact-exporter.ts`
- `src/main/git/branch-freshness.ts`
- `src/main/logging/logger.ts`
- `src/main/persistence/rlm/rlm-schema.ts`, `rlm-database.ts`

Second-pass sibling implementation details:

- `../hermes-agent/hermes_cli/commands.py`, `tools/registry.py`, `agent/context_compressor.py`, `agent/curator.py`
- `../oh-my-codex/src/hooks/extensibility/dispatcher.ts`, `src/team/state/events.ts`, `src/cli/doctor.ts`
- `../storybloq/src/core/project-loader.ts`, `src/autonomous/review-lenses/orchestrator.ts`
- `../codex-plugin-cc/plugins/codex/scripts/lib/app-server.mjs`, `tracked-jobs.mjs`
- `../online-orchestrator/multi-ai-query/*`

Third-pass AI Orchestrator deep dive:

- `src/main/core/migration-manager.ts`, `src/main/core/config/settings-export.ts`
- `src/main/webhooks/webhook-server.ts`, `webhook-store.ts`
- `src/worker-agent/worker-agent.ts`, `local-instance-manager.ts`, `path-sandbox.ts`, `sync-handler.ts`, `service/*`
- `src/main/runtime/main-process-watchdog.ts`, `bounded-async-queue.ts`
- `src/main/cli/cli-update-service.ts`, `src/main/core/system/provider-quota-service.ts`
- `src/main/services/voice/voice-service.ts`, voice provider implementations
- `src/main/tools/tool-runner-child.ts`
- `src/main/window-manager.ts`, `src/preload/preload.ts`, `electron-builder.json`, `scripts/electron-smoke-check.js`
- `src/main/util/feature-gates.ts`, `feature-flag-evaluator.ts`, `src/shared/constants/feature-flags.ts`
- `src/main/testing/singleton-reset.ts`

Third-pass sibling implementation details:

- `../Actual Claude/services/analytics/sink.ts`, `sinkKillswitch.ts`, `migrations/migrateAutoUpdatesToSettings.ts`, `services/voiceStreamSTT.ts`
- `../CodePilot/src/lib/update-release.ts`, `electron/updater.ts`
- `../jean/src/lib/cli-update.ts`, `src/lib/transport.ts`
- `../nanoclaw/src/webhook-server.ts`, `src/db/migrations/index.ts`
- `../agent-orchestrator/packages/cli/src/lib/update-check.ts`, `src/commands/migrate-storage.ts`
- `../openclaw/docs/concepts/queue.md`, `src/agents/queued-file-writer.ts`, `src/agents/pi-embedded-runner/replay-state.ts`, `extensions/speech-core/src/audio-transcode.ts`, `src/security/audit-sandbox-browser.test.ts`
- `../copilot-sdk/docs/features/steering-and-queueing.md`, `docs/features/streaming-events.md`

## P0 - Structural Improvements

### 1. Finish extracting oversized coordinators and adapters

AI Orchestrator still has several load-bearing files above 1,500 to 3,000 lines. The architecture docs already say CLI adapter entrypoints should stay orchestration-focused, and the repo already has `check:ts-max-loc`; the remaining work is to make that rule meaningful by reducing the current exceptions.

Primary targets:

- `src/main/instance/instance-lifecycle.ts`
- `src/main/cli/adapters/codex-cli-adapter.ts`
- `src/main/channels/channel-message-router.ts`
- `src/main/instance/instance-manager.ts`
- `src/main/browser-gateway/browser-gateway-service.ts`
- `src/main/instance/instance-communication.ts`
- `src/main/cli/adapters/claude-cli-adapter.ts`
- `src/main/cli/adapters/acp-cli-adapter.ts`
- `src/main/persistence/rlm/rlm-schema.ts`
- `src/renderer/app/features/instance-list/instance-list.component.ts`
- `src/renderer/app/features/instance-detail/input-panel.component.ts`

Recommended shape:

- Split adapters into request construction, runtime event parsing, resume/session recovery, timeout/heartbeat handling, attachment handling, and provider-specific quirks.
- Split `channel-message-router` into access gating, route resolution, intent parsing, delivery streaming, and command handlers.
- Split renderer feature components into container, state facade, presentational controls, and focused dialogs.
- Keep public entrypoints thin and covered by behavior tests before tightening the file-length budget.

Borrowed from:

- t3code's separation between provider adapter interface, provider service, runtime ingestion, and projection pipeline.
- opencode's provider transform and tool registry boundaries.

Validation:

- Add focused unit tests around each extracted module before deleting old logic.
- Run `npm run typecheck`, `npm run typecheck:spec`, `npm run lint`, and the affected test suites.
- Tighten `scripts/check-ts-max-loc.ts` after each extraction wave.

### 2. Move startup wiring into the existing bootstrap registry

AI already has `src/main/bootstrap/index.ts` with domain modules, dependency ordering, failure modes, and teardown. However, `src/main/app/initialization-steps.ts` still contains a long manual startup array with many dynamic `require` blocks and warning-level fallbacks.

Recommended shape:

- Convert more initialization steps into explicit bootstrap modules with `name`, `domain`, `dependencies`, `failureMode`, `init`, and `teardown`.
- Make `createInitializationSteps` a thin adapter that invokes the bootstrap graph plus a small number of truly app-level steps.
- Remove dynamic `require` calls where static imports do not create cycles.
- Generate startup diagnostics from the graph: skipped, degraded, critical failure, startup duration, teardown duration.
- Add cycle and missing-dependency tests for bootstrap modules.

Borrowed from:

- t3code's Effect Layer composition in `apps/server/src/server.ts`, where service dependencies and shutdown behavior are visible at composition time.
- AI's own `bootstrapAll` registry, which should become the default path instead of a partial mechanism.

Validation:

- Tests for dependency order, cycle detection, degraded module handling, critical module failure, and reverse-order teardown.
- Electron smoke start after conversion.

### 3. Promote event sourcing to the default mutation path

AI has `src/main/orchestration/event-store/*`, command receipts, duplicate command tests, and projection concepts. t3code applies the command -> event -> projection -> receipt model as the core mutation path and uses projection snapshots/read models for recovery.

Recommended shape:

- Route all user-visible orchestration mutations through the orchestration engine: loops, debate, review, verification, workflow starts/stops, pause/resume, approvals, and retries.
- Persist rejected command receipts, not only successful events, so the UI can explain invariant failures after restart.
- Treat duplicate command IDs as idempotent by returning the original receipt.
- Move renderer-facing orchestration views toward materialized projections instead of reconstructing state from service memory.
- Add replay tests that rebuild read models from the event log and compare them to live projections.

Borrowed from:

- t3code's `OrchestrationEngine`, `decider`, `projector`, and `ProjectionPipeline`.

Validation:

- Duplicate command ID tests for every public orchestration command.
- Crash recovery test after append-before-projector and after projector-before-UI-notification.
- Replay-from-empty-projections test for a representative workflow.

### 4. Add provider instance routing and canonical event logs

AI's `provider-runtime-event-bus` already normalizes and coalesces runtime events. t3code goes further by binding provider sessions to provider instance IDs, tracking recovery cursors, and writing native/canonical/orchestration NDJSON logs.

Recommended shape:

- Persist provider instance identity, provider kind, cwd, model, resume handle, runtime payload, and last event cursor per thread or AI instance.
- Dynamically subscribe and unsubscribe provider adapters as registry membership changes.
- Write rotating per-thread logs for native provider events, canonical provider runtime events, and orchestration events.
- Redact secrets and high-risk tool payloads before logs hit disk.
- Make recovery choose between resume, rebuild, or mark degraded using persisted binding data.

Borrowed from:

- t3code's `ProviderService`, provider runtime contract, and `EventNdjsonLogger`.
- AI's existing runtime event bus, which can stay the canonical in-process publisher.

Validation:

- Rebuild/restart tests that recover provider bindings.
- Log rotation and redaction tests.
- Tests proving stale provider sessions are stopped when a thread is rebound.

## P1 - Provider, Tooling, and Contract Quality

### 5. Centralize provider request transformation and model option handling

AI has provider capabilities, model discovery, and adapter-specific reasoning handling. opencode has a single provider transform layer that handles provider quirks before dispatch.

Recommended shape:

- Add a shared provider request transform module used by CLI, API, and session adapters before sending a request.
- Normalize unsupported image/file modalities into explicit user-visible fallback text where needed.
- Sanitize invalid unicode surrogates before provider calls.
- Centralize tool-call ID cleanup, provider-specific message ordering fixes, prompt cache hints, temperature/topP/topK compatibility, and reasoning-effort mapping.
- Keep provider quirks tested as golden fixtures instead of buried inside large adapters.

Borrowed from:

- opencode's `packages/opencode/src/provider/transform.ts`.

Validation:

- Golden tests for OpenAI/Codex, Anthropic/Claude, Gemini, Copilot, Cursor, and ACP-compatible providers.
- Tests for unsupported attachments, empty messages, invalid unicode, tool-call ordering, and reasoning effort variants.

### 6. Add parser-backed shell permission extraction

AI has a substantial `src/main/security/bash-validation` area and tool execution gates. opencode adds a parser-backed layer using tree-sitter Bash and PowerShell to identify command paths and external-directory access more accurately.

Recommended shape:

- Add a parser stage before policy classification for Bash and PowerShell commands.
- Extract command invocations, path-like arguments, redirections, dynamic path expressions, and shell-specific execution forms.
- Keep AI's existing validators as the policy layer after parsing.
- Mark dynamic or unresolved expressions as higher risk instead of silently accepting them.
- Cover PowerShell, Windows path forms, cygpath-style paths, chained commands, subshells, and redirections.

Borrowed from:

- opencode's `packages/opencode/src/tool/shell.ts`.

Validation:

- Preserve existing bash-validation test coverage.
- Add parser fixture tests for Bash, PowerShell, Windows paths, redirection, external directories, and dynamic expressions.
- Add end-to-end tests through `tool-execution-gate`.

### 7. Introduce a shared keyed coalescing worker

AI already coalesces some provider runtime events. t3code has a reusable keyed coalescing worker that keeps the latest value per key and supports scoped draining.

Recommended shape:

- Add a shared keyed worker utility for noisy per-key work.
- Use it for provider context/status refresh, file watcher events, indexing, remote-node metrics, renderer state batches, or MCP/config reloads where only the latest value matters.
- Require explicit drain behavior in tests so shutdown does not drop the last known value.

Borrowed from:

- t3code's `packages/shared/src/KeyedCoalescingWorker.ts`.

Validation:

- Tests for latest-value wins, multi-key fairness, drainKey behavior, shutdown behavior, and error propagation.

### 8. Add schema and API drift harnesses beyond generated IPC checks

AI already has generated IPC channels, Zod schemas, `verify:ipc`, `verify:exports`, and contract checks. opencode has drift tests that compare public API schemas against generated OpenAPI/runtime behavior.

Recommended shape:

- Add an IPC contract exercise harness that verifies each advertised channel has a schema, handler registration, preload exposure, and renderer-facing type.
- Compare channel constants, generated preload APIs, handler registrations, and Zod schemas in one test suite.
- Add drift tests for high-risk transport types in `packages/contracts`.
- Make tests fail when a channel is added without a schema or when schema/type/docs exports diverge.

Borrowed from:

- opencode's `httpapi-query-schema-drift.test.ts` and schema generation approach.

Validation:

- A negative fixture proving the drift harness fails on missing handler, missing schema, and type/schema mismatch.
- Existing `npm run verify:ipc`, `npm run verify:exports`, and `npm run check:contracts`.

### 9. Add custom lint rules for local hot-path footguns

t3code ships a custom oxlint rule to catch inline schema compiler calls inside functions. AI has hot IPC/provider/event paths where similar rules would prevent performance and safety regressions.

Recommended shape:

- Add custom lint rules or an ESLint plugin for AI-specific constraints:
  - no inline Zod schema creation or repeated parsing setup inside hot handlers
  - no raw IPC channel strings outside typed channel modules
  - no unvalidated `JSON.parse` on IPC/provider/tool payloads
  - no EventEmitter listener registration without cleanup in long-lived services
  - no direct provider invocation bypassing the transform layer
- Start as warnings, then ratchet to errors after cleanup.

Borrowed from:

- t3code's `oxlint-plugin-t3code/rules/no-inline-schema-compile.ts`.

Validation:

- Rule tests with positive and negative fixtures.
- CI integration through `npm run lint:fast` or a dedicated script.

### 10. Create a provider parity checklist and bind tests to it

opencode keeps an explicit provider parity checklist. AI supports multiple AI CLIs/providers and would benefit from a maintained compatibility matrix.

Recommended shape:

- Add `docs/provider-parity-checklist.md`.
- Track per provider: auth, model discovery, resume, interrupt, approvals, attachments, reasoning effort, token usage, MCP/tooling, compaction, streaming events, error normalization, and recovery behavior.
- Link parity rows to tests or mark them as untested.
- Require new providers to update the checklist.

Borrowed from:

- opencode's `packages/opencode/src/v2/provider-parity-checklist.md`.

Validation:

- CI check that provider IDs in code appear in the checklist.
- Adapter parity tests for critical rows.

## P1 - Runtime Isolation and Agent UX

### 11. Add per-workspace scoped service state with disposal

AI uses many singleton-style services. opencode uses per-directory scoped state with automatic disposal when an instance closes, which reduces cross-project leakage.

Recommended shape:

- Introduce project/workspace scoped state caches for services that should not be global.
- Candidates: file watchers, indexes, LSP clients, MCP discovery state, prompt history, terminal/session temp resources, permission decisions, provider recovery cursors, and remote-node subscriptions.
- Tie disposal to instance/workspace lifecycle and test cleanup explicitly.

Borrowed from:

- opencode's `InstanceState` and `makeRuntime` patterns.

Validation:

- Multi-project tests proving isolated state.
- Disposal tests proving file watchers, LSP clients, timers, and subscriptions are cleaned up.

### 12. Make LSP a first-class agent tool surface

AI already has LSP-related services and renderer features. opencode exposes LSP capabilities as a usable service/tool surface for diagnostics, hover, definitions, references, symbols, and call hierarchy.

Recommended shape:

- Expose diagnostics, hover, definition, references, document symbols, workspace symbols, and call hierarchy as agent tools.
- Gate LSP tool calls through the same permission and workspace boundary model as shell/file tools.
- Feed LSP diagnostics into review/verification workflows.
- Add UI affordances only after the backend tool contract is stable.

Borrowed from:

- opencode's `packages/opencode/src/lsp/lsp.ts`.

Validation:

- Fake LSP server tests for diagnostics, hover, definition, references, and shutdown.
- Integration tests showing a provider can request diagnostics through the tool registry.

### 13. Strengthen compaction summaries with a fixed anchored template

AI has compaction/session/context-continuity components. opencode's compaction flow is especially strict about summary sections, prior-summary anchoring, tail-turn selection, and pruning noisy tool output.

Recommended shape:

- Standardize a summary template with sections for objective, current state, decisions, files touched, pending work, blockers, commands run, and verification status.
- Preserve the previous summary as an anchor and only add deltas.
- Track a tail-start marker equivalent so compaction can keep recent turns verbatim.
- Prune old tool output while retaining command names, exit status, and relevant excerpts.
- Allow plugin/hook participation only through a typed compaction contract.

Borrowed from:

- opencode's `packages/opencode/src/session/compaction.ts`.

Validation:

- Tests for preserving decisions, blockers, file paths, and verification state across repeated compactions.
- Token-budget tests that prove noisy tool output is pruned before important state.

### 14. Improve remote node access and pairing runbooks

AI has remote-node and observer capabilities. t3code has a clearer operator-facing `REMOTE.md` with LAN, Tailscale, SSH launch, pairing, and security notes.

Recommended shape:

- Add a remote access runbook covering LAN, Tailscale, SSH launch, pairing codes/links, trusted networks, revocation, and troubleshooting.
- Surface Doctor checks for common remote failures: unreachable endpoint, stale pairing, certificate/auth mismatch, unsupported host shell, and blocked port.
- Make revoking a paired remote obvious in both docs and UI.

Borrowed from:

- t3code's `REMOTE.md`.

Validation:

- Documentation links from README/Doctor.
- Smoke tests for pairing lifecycle if remote pairing is implemented in code.

## P2 - Product and Maintenance Polish

### 15. Add a durable session todo model

opencode has a small DB-backed todo list per session with ordered items and update events. AI can use a similar primitive to make long-running orchestration work more recoverable and visible.

Recommended shape:

- Persist todos per AI instance/session/workflow with order, status, source, timestamps, and optional linked command IDs.
- Emit todo update events to the renderer.
- Let orchestration workflows and verification/review loops update todos through a typed command, not by mutating UI state directly.
- Consider importing this file's backlog into that model later.

Borrowed from:

- opencode's `packages/opencode/src/session/todo.ts`.

Validation:

- Persistence tests across restart.
- UI event tests for add/update/reorder/complete.

### 16. Reduce renderer feature size through registries and facades

Several renderer feature files are large enough that state, UI, and orchestration concerns are hard to reason about together.

Recommended shape:

- Move feature state into small facades or signal stores.
- Register feature nav, commands, empty states, and route metadata through a feature registry.
- Keep components focused on rendering and user interaction.
- Prefer shared typed IPC facades over direct bridge calls in feature components.

Borrowed from:

- opencode's separation of server APIs, bus events, and frontend consumers.
- t3code's stronger contract package boundary.

Validation:

- Component tests around facades instead of full large component tests.
- Route/feature registry tests for required metadata.

### 17. Build a public contract artifact for advanced integrations

AI has strong internal contracts, but opencode generates schema artifacts for external users and t3code keeps contracts as a first-class package.

Recommended shape:

- Generate a machine-readable artifact for IPC/channel contracts, provider runtime events, and orchestration commands.
- Use it for docs, tests, and any future plugin/remote SDK.
- Keep comments/descriptions close to schemas so generated docs stay useful.

Borrowed from:

- opencode's `script/schema.ts`.
- t3code's `packages/contracts` package discipline.

Validation:

- Generated artifact checked for determinism.
- Drift tests between artifact, schemas, and registered handlers.

## P1 - Additional Findings From The Full Sibling Scan

### 18. Add a Provider Doctor with structured diagnostics and repair actions

AI has many provider, CLI, MCP, remote-node, channel, and native dependency paths. CodePilot and oh-my-codex show the value of one operator-facing doctor that runs concrete probes and returns structured findings, not just logs.

Recommended shape:

- Add `src/main/diagnostics/provider-doctor` or similar with probe modules for provider auth, model discovery, CLI binaries, native ABI, MCP connectivity, remote-node pairing, browser gateway readiness, channel delivery, and stale session bindings.
- Return typed findings with `severity`, stable `code`, user-facing message, diagnostic details, and optional repair actions.
- Include a redacted runtime ring buffer so the doctor can attach recent warnings/errors without leaking API keys, bearer tokens, home paths, or command payload secrets.
- Add "real smoke" probes for high-risk providers, not only configuration shape checks. For example: list models, start a tiny provider session, verify a local MCP handshake, or perform a remote-node health RPC.
- Make Doctor output available from the renderer and from a CLI/script so support and CI can use the same probe contract.

Borrowed from:

- CodePilot's `provider-doctor.ts`, `error-classifier.ts`, and `runtime-log.ts`.
- oh-my-codex's `omx doctor` and real `omx exec` readiness guidance.
- CodexDesktop-Rebuild's native/Electron rebuild and upstream compatibility checks.

Validation:

- Unit tests for each probe and repair action.
- Redaction tests with representative API keys, bearer tokens, auth URLs, and home paths.
- A smoke test fixture that proves "doctor green" requires at least one real runtime call for configured critical providers.

### 19. Standardize a runtime error taxonomy

AI has retries, failover, crash diagnostics, provider adapters, and channel delivery. A shared error taxonomy would make UI recovery, telemetry, and provider parity less ad hoc.

Recommended shape:

- Add a typed `RuntimeErrorCategory` covering auth missing/rejected/forbidden, auth-style mismatch, rate limit, endpoint unreachable, model unavailable, context too long, unsupported feature, CLI missing, CLI too old, provider stream failure, MCP failure, remote-node failure, channel delivery failure, browser automation failure, permission timeout, and unknown.
- Map provider/CLI/native/channel errors into this taxonomy close to the boundary where raw errors are observed.
- Attach retryability, user-facing action hints, and recovery actions.
- Use stable category codes in logs, telemetry, Doctor, and renderer banners.
- Keep raw error messages accessible only in debug detail panes with redaction.

Borrowed from:

- CodePilot's structured error classifier.
- Codex app-server's JSON-RPC error codes and busy/backpressure handling.
- OpenClaw's diagnostics and plugin doctor surfaces.

Validation:

- Golden classifier fixtures for each supported provider and CLI.
- Tests proving retry managers consume taxonomy fields rather than string-matching raw stderr.
- UI snapshot tests for the highest-frequency categories.

### 20. Build a deterministic provider and agent parity harness

The existing provider parity checklist should be backed by a deterministic harness that can run provider and agent scenarios without depending on live accounts.

Recommended shape:

- Add a mock OpenAI/Anthropic/Codex/OpenCode-compatible provider server that can script streaming deltas, tool calls, permission prompts, context-length failures, rate limits, malformed JSON, cancellation, resume, and empty responses.
- Define scenario manifests for provider adapters and orchestration flows.
- Run the same scenario through Codex, Claude, Gemini, ACP, browser, channel, and remote-node paths where applicable.
- Record expected canonical runtime events and compare them against actual events.
- Keep live-provider smoke tests separate from deterministic parity tests.

Borrowed from:

- claw-code's mock Anthropic-compatible service and scenario parity plan.
- copilot-sdk's transport/auth/session/tool scenario suite.
- Codex app-server schema and notification opt-out tests.

Validation:

- CI harness that runs without external API keys.
- Golden canonical-event snapshots for streaming, tool calls, approvals, interrupts, resume, compaction, and provider errors.
- Negative tests for adapter drift when a provider returns unexpected event ordering.

### 21. Expose a local app-server/control-plane API

AI already has generated IPC and remote-node RPC. Codex, Jean, and copilot-sdk suggest a clean local control-plane API would make external clients, browser extensions, mobile views, SDKs, and test harnesses easier to build.

Recommended shape:

- Add an optional local JSON-RPC or WebSocket app-server with an `initialize` handshake, client info, advertised capabilities, and notification opt-outs.
- Surface stable operations for threads/sessions, turns, items/events, providers/models, file/process operations, permissions, automations, channels, and diagnostics.
- Add bounded queues and explicit backpressure errors instead of allowing external clients to flood Electron main.
- Gate experimental methods behind an `experimentalApi` capability.
- Generate TypeScript client types and JSON schema from the same contracts as IPC.

Borrowed from:

- Codex `app-server` and `thread-store` boundaries.
- copilot-sdk's CLI-managed JSON-RPC lifecycle.
- Jean's Tauri invoke plus WebSocket dispatch parity model.
- codex-plugin-cc's app-server broker client.

Validation:

- Protocol handshake tests.
- Backpressure tests with bounded queue exhaustion.
- Schema drift tests between IPC, app-server, and generated client types.
- Native IPC <-> app-server parity tests for every shared operation.

### 22. Add trace bundles and replayable session transcripts

AI has event stores and log writers. Several sibling projects add a stronger "debug bundle" model where raw payloads, canonical events, and replay metadata can be collected without guessing from normal logs.

Recommended shape:

- Write per-session trace bundles with a manifest, canonical event log, redacted raw-provider payload files, tool payload references, runtime metadata, and app version/build info.
- Store payload files before referencing them in events so a partial trace is still replay-safe.
- Add a replay reducer that rebuilds session/read-model state from a trace bundle.
- Expose "Export debug bundle" in the UI with redaction and size caps.
- Link trace bundle IDs from crash diagnostics and Doctor results.

Borrowed from:

- Codex `rollout-trace` writer.
- Actual Claude's session transcript JSONL and activity/stderr ring buffers.
- t3code's native/canonical/orchestration NDJSON logs.

Validation:

- Trace replay tests that rebuild a representative session.
- Crash-after-payload-before-event and crash-after-event tests.
- Redaction and size-limit tests for exported bundles.

### 23. Strengthen remote supervision and channel delivery semantics

AI already has Discord, WhatsApp, channel routing, remote-node, and observer pieces. OpenClaw, CodePilot, NanoClaw, and Actual Claude show a clearer model for durable channel turns, permission brokerage, and remote supervision.

Recommended shape:

- Split channel routing into admission/preflight, identity binding, bot-loop protection, permission brokerage, durable outbound intent, delivery attempt, and read-model projection.
- Make permission prompts durable and always reply with either allow/deny/error/timeout so upstream sessions never hang.
- Add delivery status states: visible, no-send, queued, sent, failed, expired, and cancelled.
- Add channel-specific capability descriptors for markdown, cards, buttons, media, threading, edits, mentions, and permission replies.
- Add inbound debounce and self/bot-loop suppression for chat channels.

Borrowed from:

- OpenClaw's channel turn pipeline and durable delivery.
- CodePilot's IM bridge permission broker and adapter capabilities.
- NanoClaw's inbound/outbound DB lanes and channel-installed adapters.
- Actual Claude's `RemoteSessionManager` unsupported-control error replies.

Validation:

- Channel replay tests from inbound message to outbound delivery status.
- Permission timeout tests proving sessions do not hang.
- Bot-loop and duplicate-delivery tests.

### 24. Add optional hardened worker isolation for high-risk agents

AI has process supervision, remote nodes, and worker-agent builds. NanoClaw, Codex, and OpenClaw point toward a stronger isolation mode for untrusted or high-risk work.

Recommended shape:

- Define a worker execution profile: local process, sandboxed process, container, or remote node.
- For high-risk agents, mount only the intended workspace paths, pass only scoped capabilities, and route credentials through a broker rather than environment variables.
- Add a strict worker manifest that declares tools, cwd, network policy, writable paths, credential needs, and timeout/resource limits.
- Add process-hardening hooks for helper CLIs: remove dangerous env vars, disable core dumps where possible, and prevent unintended debugger/ptrace attach where supported.
- Surface isolation mode in the UI and trace bundles so users know what trust boundary was used.

Borrowed from:

- NanoClaw's per-session container model and OneCLI Agent Vault.
- Codex `process-hardening`.
- OpenClaw's plugin security and boundary discipline.

Validation:

- Tests proving workers cannot read outside mounted scopes.
- Credential broker tests proving raw keys are not passed into worker context.
- Process cleanup tests for cancelled and crashed workers.

### 25. Harden plugin boundaries and package ownership

AI already has plugin validation. OpenClaw and oh-my-codex go further with package-boundary reports, plugin public surface baselines, manifest-root checks, hook isolation, and dependency ownership gates.

Recommended shape:

- Reject plugin manifests that point outside their canonical root, use absolute paths where only relative paths are allowed, cross hardlink boundaries, or request undeclared capabilities.
- Add a generated plugin inventory with plugin ID, origin, capabilities, exported commands, hooks, channels, MCP servers, and dependencies.
- Enforce no deep imports from plugins into core and no core imports from plugin internals except SDK facades.
- Track the public plugin SDK surface with a baseline file.
- Add dependency ownership metadata for plugin/runtime packages and fail CI on unowned dependency changes.

Borrowed from:

- OpenClaw's manifest registry, plugin boundary reports, SDK surface baselines, and dependency ownership gates.
- oh-my-codex's hook plugin runner, lifecycle dedupe, and plugin bundle single-source checks.
- claude-code's plugin-dev validation patterns.

Validation:

- Malicious manifest fixtures for path traversal, hardlinks, absolute paths, undeclared capabilities, and duplicate IDs.
- Import-boundary tests across core/plugin/packages.
- SDK baseline drift tests.

### 26. Add isolated hook/plugin runner semantics

AI's plugins and hooks should be able to participate in lifecycle events without making app stability depend on plugin behavior.

Recommended shape:

- Run lifecycle hook plugins in isolated child processes or worker threads with timeouts, structured stdin/stdout, and a stable result envelope.
- Record hook dispatch logs as JSONL with event, source, plugin ID, status, duration, and redacted error detail.
- Add lifecycle-event dedupe for session-start, stop, session-end, compaction, and keyword/command detections.
- Disable side effects automatically when a hook runs inside a worker/team context unless explicitly allowed.
- Make failed hook plugins visible in Doctor and plugin settings without crashing the host.

Borrowed from:

- oh-my-codex's hook extensibility dispatcher and plugin runner.
- claude-code hookify's rule engine and hook event mapping.
- Storybloq's PreCompact and SessionStart hook patterns.

Validation:

- Timeout, invalid-export, malformed-output, duplicate-event, and side-effect-disabled tests.
- UI/Doctor tests for failed hook visibility.

### 27. Add a single-source command/action/agent registry

AI has commands, plugins, provider tools, channels, and UI actions. Hermes and oh-my-opencode-slim show that one registry can drive CLI help, gateway dispatch, UI command palettes, autocomplete, permissions, docs, and telemetry.

Recommended shape:

- Define a central registry record for each command/action/agent capability: ID, label, scope, owner, input schema, output schema, permissions, availability probe, channels, shortcuts, docs path, and telemetry category.
- Generate renderer command palettes, slash commands, channel command help, and docs from the registry.
- Make plugin-contributed commands register through the same schema.
- Add availability probes with TTL and generation counters so UI state is fresh without expensive repeated checks.
- Require commands to declare whether they mutate project state, session state, provider state, or external services.

Borrowed from:

- Hermes's `COMMAND_REGISTRY` and self-registering tool registry.
- oh-my-opencode-slim's dynamic agent filtering and disabled-agent prompt generation.
- agent-orchestrator's explicit plugin slots.

Validation:

- Registry schema tests.
- Snapshot tests for generated help/docs/command palette metadata.
- Availability cache invalidation tests.

### 28. Add cost-aware specialist delegation profiles and session reuse

AI Orchestrator's core value is coordinating multiple agents. oh-my-opencode-slim and oh-my-codex have practical rules for when to delegate, when to reuse a child session, and when consensus is too expensive.

Recommended shape:

- Add delegation profiles for explorer/researcher, implementer, reviewer, designer, debugger, verifier, and council/consensus.
- Track specialist cost, expected latency, permissions, context needs, and best/worst use cases.
- Add child-session reuse rules keyed by agent role, project, files read, task label, and recency.
- Enforce subagent depth limits and maximum active worker counts per workspace.
- Add explicit "manual only" or "ask before use" flags for expensive consensus/council paths.

Borrowed from:

- oh-my-opencode-slim's orchestrator prompt, council manager, task session manager, and todo continuation hook.
- oh-my-codex's team phase role routing and event cursors.
- agent-orchestrator's Runtime/Agent/Workspace/Tracker plugin slots.

Validation:

- Routing tests for tasks that should and should not delegate.
- Session reuse tests proving stale or unrelated sessions are not reused.
- Cost/depth limit tests for council and parallel workers.

### 29. Promote project-level workflow state, handovers, and lessons

AI has sessions, automations, continuity, snapshots, and todos. Storybloq adds a durable project-level state model that is easy for humans and agents to inspect in Git.

Recommended shape:

- Add an optional `.ai-orchestrator/` project state folder for tickets/tasks, issues, notes, lessons, handovers, snapshots, and workflow receipts.
- Keep one record per file for merge-friendly diffs.
- Use schemas, atomic writes, lock files, symlink/path guards, and forward-only transaction recovery.
- Add session-start recap and pre-compaction snapshot hooks.
- Add "handover required" prompts when a long-running workflow stops with open work.

Borrowed from:

- Storybloq's `.story/` model, project loader, autonomous state machine, session handovers, snapshots, and lessons.
- oh-my-codex's `.omx/` state folders and wiki.
- OB1/OpenClaw TaskFlow Work Log recipes.

Validation:

- Corrupt-record and strict-mode tests.
- Transaction recovery tests.
- Recap/handover tests across compaction and restart.

### 30. Add governed operational memory with provenance and review

AI has memory/bootstrap/observation pieces and session recall. OB1, MemPalace, Hermes, and Storybloq suggest separating raw recall, operational lessons, and instruction-grade memory.

Recommended shape:

- Store agent-created memories with provenance, source references, confidence, scope, review status, and use policy.
- Default agent-written memory to evidence-only pending review. Do not let it become instruction-grade without user confirmation or trusted import.
- Add recall traces that record what was retrieved, what was used, what was ignored, and why.
- Keep verbatim local artifacts available where exact recall matters, and use summaries only as indexes or handover aids.
- Add project/workspace/person/channel scopes and never auto-promote personal or channel memory to team/workspace scope.

Borrowed from:

- OB1 Agent Memory schema/API and OpenClaw memory recipes.
- mempalace-reference's local-first verbatim memory and retrieval benchmarks.
- Hermes session search and skill curator.
- Storybloq lessons and handovers.

Validation:

- Memory write-back policy tests blocking raw transcripts, secrets, reasoning traces, and large code dumps.
- Recall trace tests.
- Retrieval quality benchmarks for project/session continuity.

### 31. Add FTS and artifact-aware session search

AI already stores session and artifact data. Hermes, MemPalace, and Storybloq show that search should be a first-class recovery path, not only a UI convenience.

Recommended shape:

- Add SQLite FTS over session titles, messages, tool summaries, file paths, decisions, handovers, lessons, and artifact references.
- Group results by session/workflow and return excerpts around matches.
- Add filters for project, provider, agent role, date, file path, command, tool, and outcome.
- Use an auxiliary summarizer only after deterministic search narrows results.
- Expose session search to agents as a permissioned tool.

Borrowed from:

- Hermes FTS5 session search.
- MemPalace hybrid/verbatim recall.
- Storybloq recap/recommend/export flows.

Validation:

- FTS indexing and migration tests.
- Query relevance fixtures for exact path, decision, error text, and command output.
- Permission tests for cross-project search boundaries.

### 32. Add command and tool output compression with raw-output tee

AI integrates RTK and already has compaction/logging. rtk gives a concrete pattern for reducing context waste while preserving full output when needed.

Recommended shape:

- Add a tool-output filtering stage before command output enters agent context.
- Preserve command, cwd, exit code, duration, and filtered excerpts in context.
- Tee full output to a trace/artifact file, especially for failures or long-running commands.
- Track estimated token savings by tool/command/provider/session.
- Add a "discover token drains" report that identifies commands or tools producing the most context noise.

Borrowed from:

- rtk's smart filtering, tee, token-savings SQLite stats, and discover/gain commands.
- Hermes context compressor's tool-output pruning.
- opencode's compaction and output pruning rules.

Validation:

- Golden filters for npm, vitest, tsc, eslint, git, rg, docker, and generic shell output.
- Tests proving failed-command full output is retained.
- Token-savings regression tests.

### 33. Add IDE/LSP diagnostic baselines before edits

AI has LSP services and review/verification workflows. Actual Claude's diagnostic tracker adds a useful invariant: capture diagnostics before the edit and report only new diagnostics after the edit.

Recommended shape:

- Capture baseline diagnostics for touched files before an agent applies edits.
- After edits, compare diagnostics against baseline and surface only new or worsened diagnostics by default.
- Feed new diagnostics into verification, code review, and fix loops.
- Store baseline and post-edit diagnostic snapshots in trace bundles.
- Add language-server unavailable/degraded states so workflows do not falsely pass.

Borrowed from:

- Actual Claude's `diagnosticTracking.ts`.
- opencode's LSP service.
- Storybloq's verify/build/test stages.

Validation:

- Fake LSP tests for added, removed, unchanged, and worsened diagnostics.
- Workflow tests proving new diagnostics block finalization unless explicitly waived.

### 34. Add multi-lens review orchestration

AI has review execution host functionality. Storybloq demonstrates a structured multi-lens review pipeline that activates only relevant lenses, packages per-lens context, fans out parallel reviews, validates findings, merges, and judges final blockers.

Recommended shape:

- Add review lenses for security, concurrency, error handling, API design, test quality, performance, accessibility, and clean code.
- Activate lenses based on changed files, diff content, project rules, and explicit user requirements.
- Give each lens a finding schema and severity/blocking policy.
- Cache lens findings by artifact hash, rules, and lens version.
- Add a merger/judge stage that deduplicates findings and decides blockers.

Borrowed from:

- Storybloq's `review-lenses` orchestrator.
- claude-code PR review toolkit agents.
- CodePilot and OpenClaw review-oriented agent roles.

Validation:

- Lens activation tests.
- Finding schema validation tests.
- Cache hit/miss tests.
- End-to-end review tests with synthetic diffs.

### 35. Add selector/adapter resilience checks for browser and web UIs

AI has a browser gateway and channel adapters. online-orchestrator's browser extension is small, but it highlights a practical maintenance problem: DOM selectors and response-completion heuristics drift frequently.

Recommended shape:

- Move browser/chat-service selectors into versioned adapter descriptors with fallback selectors and capability probes.
- Add response-completion strategies: stop button disappearance, DOM stability, streaming indicator removal, explicit API events, and timeout fallback.
- Add "adapter health" checks to Doctor for browser gateway and web UI integrations.
- Keep selectors and heuristics covered by fixture DOM tests.
- Surface degraded adapter states in UI before users attempt a long browser task.

Borrowed from:

- online-orchestrator's per-service content scripts, fallback selectors, readiness registration, response stability checks, and merge workflow.
- CodePilot's channel capability probes.

Validation:

- Fixture DOM tests for ChatGPT, Claude, Gemini, and AI's own browser gateway targets.
- Timeout and stale-tab tests.
- Doctor adapter-health tests.

### 36. Add native IPC, remote WebSocket, and app-server parity gates

AI is likely to keep multiple control paths: Electron IPC, remote-node RPC, app-server/WebSocket, and channels. Jean shows that every backend command added to one path must be registered in the others or users hit inconsistent behavior.

Recommended shape:

- Maintain a generated transport matrix for each backend operation: IPC handler, preload exposure, renderer facade, remote RPC/app-server method, channel command if applicable, schema, tests, docs.
- Fail CI when a shared operation exists in one transport but not the declared equivalent transports.
- Use explicit "not supported" entries with reasons instead of silent omissions.
- Add camelCase/snake_case serialization conventions and tests if remote protocols need a different shape from persisted storage.

Borrowed from:

- Jean's Tauri command plus WebSocket dispatch registration rule.
- Codex app-server generated schemas.
- AI's existing generated IPC checks.

Validation:

- Transport matrix drift tests.
- Serialization roundtrip tests.
- Negative fixture proving a missing remote dispatch fails CI.

### 37. Add frontend state performance guardrails

AI has large renderer components and signal-heavy Angular state. Jean's lessons are directly relevant: no-op guards and state layering prevent expensive rerender cascades.

Recommended shape:

- Document state ownership: component-local signals, feature facade/store, persistent query-backed data, and main-process source of truth.
- Add no-op guards to repeated store/signal updates where incoming payloads can be identical.
- Split streaming token state from durable session state so high-frequency updates do not rerender unrelated panels.
- Add render-count or performance tests for the hottest panes: instance list, detail panel, terminal, browser gateway, channel feed, and logs.
- Prefer cache invalidation after background operations instead of optimistic UI mutations that duplicate main-process state.

Borrowed from:

- Jean's state-onion and no-op update guidance.
- agent-orchestrator's dashboard performance and status-token design notes.
- OpenClaw startup/performance budget scripts.

Validation:

- Component/facade tests proving identical events do not update state.
- Browser/performance smoke tests for high-frequency streaming and channel events.

### 38. Add cross-platform policy helpers and lint checks

AI supports Electron, native modules, worker binaries, shell validation, remote nodes, and Windows-specific behavior. Multiple projects centralize platform checks instead of scattering `process.platform` branches.

Recommended shape:

- Add a small platform policy module for Windows/macOS/Linux detection, shell selection, path behavior, terminal behavior, process-tree termination, file encoding, and binary lookup.
- Ban raw `process.platform === "win32"` outside the platform module, tests, and build scripts.
- Document platform support boundaries for native modules, CLI providers, worker SEA builds, remote nodes, and channel adapters.
- Add Windows-focused fixtures for path parsing, shell commands, child-process cleanup, and UTF-8 file reads.

Borrowed from:

- agent-orchestrator's `isWindows()` rule and cross-platform docs.
- Jean's Windows silent-command and serialization guidance.
- Hermes's Windows encoding lint and psutil process handling.
- codex-plugin-cc's Windows process-tree termination handling.

Validation:

- Custom lint or import-boundary rule for platform checks.
- Windows path and shell fixture tests.
- Process termination tests for spawned CLI adapters.

### 39. Add supply-chain and dependency drift guardrails

AI has native dependencies, Electron, provider SDKs, plugins, worker binaries, and browser automation. Several sibling projects add stronger dependency gates.

Recommended shape:

- Add dependency ownership metadata for runtime, build, plugin, provider, browser, and native dependencies.
- Fail CI on dependency changes without ownership review.
- Pin or constrain high-risk dependency categories and document why.
- Add minimum-release-age or delayed-upgrade policy for plugin/runtime dependencies if the package manager supports it.
- Generate native ABI/Electron compatibility reports and provider SDK drift reports during release preparation.

Borrowed from:

- OpenClaw dependency ownership, pin, vulnerability, and startup/perf gates.
- NanoClaw's minimum release age and trusted built dependency list.
- Hermes's exact pin/lazy optional dependency policy.
- CodexDesktop-Rebuild's native ABI and upstream-sync focus.

Validation:

- CI check for dependency ownership.
- Lockfile diff tests or release checks.
- Native ABI compatibility smoke after Electron upgrades.

### 40. Add skill and prompt lifecycle curation

AI has plugins, commands, prompt history, learning, and observation systems. Hermes and oh-my-codex show that skills/prompts need lifecycle management or they become stale and contradictory.

Recommended shape:

- Track installed/generated skills and prompts with owner, source, version, last used, last verified, and superseded-by metadata.
- Add a background curator that can propose archive/patch/restore actions for AI-created skills, but never silently delete user-authored content.
- Pin critical skills/prompts so automated cleanup cannot remove them.
- Add prompt inventory and contract tests for core workflow prompts.
- Add release-time checks that plugin-bundled skills and mirrored skills stay in sync.

Borrowed from:

- Hermes's skill curator.
- oh-my-codex's prompt inventory, plugin mirror, skill catalog hygiene, and generated catalog checks.
- claude-code plugin-dev skill validation patterns.

Validation:

- Curator dry-run tests.
- Pinned skill protection tests.
- Prompt/skill mirror drift tests.

## P2 - Second-Pass Operational Hardening

### 41. Add session corruption fuzzing and repair observability

AI has `SessionRepair` with JSON truncation recovery, transcript repair, quarantine, and tmp cleanup. That should become a visible reliability surface rather than a hidden startup behavior.

Recommended shape:

- Add a corpus of malformed session, snapshot, approval, and transcript files that exercises truncation, duplicate roots, orphaned tool calls, non-monotonic timestamps, missing schema versions, and unknown future versions.
- Record each repair action as a durable repair event with before/after metadata, not only a log line.
- Surface quarantined files and repair counts in Doctor and diagnostics bundles.
- Add a "repair dry-run" mode for support that reports what would be repaired without writing.
- Add migration fixtures for every session schema version.

Borrowed from:

- AI's existing `session-repair.ts` and `session-continuity.ts`.
- Storybloq's best-effort corrupt-record loading plus strict mode.
- Codex `LiveThread` init guard/discard behavior.

Validation:

- Fuzz tests for corrupted JSON and transcript ordering.
- Snapshot migration tests across every schema version.
- Doctor tests proving repair/quarantine counts are reported.

### 42. Add a resource budget scheduler across instances, workers, and providers

AI has a memory `ResourceGovernor`, process supervision, and per-node capacity checks, but scheduling should coordinate memory, CPU, provider concurrency, channel limits, browser sessions, and automation jobs together.

Recommended shape:

- Add a central `ResourceBudgetManager` with budgets for local instances, remote instances, browser contexts, MCP servers, automation jobs, provider requests, and channel sends.
- Make every long-running job acquire a lease with priority, owner, estimated cost, timeout, and cancellation behavior.
- Add backpressure decisions: enqueue, reject with reason, pause, hibernate, or evict idle work.
- Surface queue state and budget pressure in the UI and Doctor.
- Feed budget decisions into trace bundles and runtime events.

Borrowed from:

- AI's `ResourceGovernor`, `SupervisorTree`, `PoolManager`, and automations.
- Codex app-server bounded queue/backpressure model.
- oh-my-codex team event cursors and worker-state polling.

Validation:

- Concurrency tests for lease acquisition/release.
- Starvation tests for high-priority user actions.
- Memory-critical tests proving idle evictions are deterministic and visible.

### 43. Make supervision recovery policies explicit and user-visible

AI's supervisor tree can restart, escalate, and emit health events. The next step is to turn restart behavior into a policy matrix that users and tests can inspect.

Recommended shape:

- Define per-worker restart policies: never, transient, always, max attempts, exponential backoff, cooldown, and escalation target.
- Persist restart history and exhaustion state per instance.
- Add UI labels for restarting, unhealthy, exhausted, hibernated, and manually stopped.
- Add recovery recipes that can be selected by provider/agent role: resume provider session, rebuild adapter, restore checkpoint, restart remote node, or mark degraded.
- Require every automatic restart to include a reason and previous exit signal/code.

Borrowed from:

- AI's `SupervisorTree`, `SupervisorNode`, `RecoveryRecipeEngine`, and `StuckProcessDetector`.
- agent-orchestrator's stale runtime reconciliation and `runtime_lost` state.
- oh-my-codex team worker state events.

Validation:

- Restart-policy unit tests for each policy.
- Crash-loop tests proving max attempts and cooldown behavior.
- Renderer tests for exhausted/degraded state display.

### 44. Add a checkpoint safety preview and restore transaction model

AI has `GitCheckpointStore` with git and shadow checkpoints. Restore is powerful enough that it needs preview, conflict handling, and audit records before users trust it.

Recommended shape:

- Add restore preview showing files added/modified/deleted, current dirty files that would be overwritten, and ignored/untracked files at risk.
- Require a restore transaction record with checkpoint ID, target directory, actor, reason, and result.
- Support partial restore by path when only one artifact or file needs rollback.
- Add a pre-restore emergency checkpoint so accidental restore can be undone.
- Add shadow-checkpoint cleanup and retention policies.

Borrowed from:

- AI's `git-checkpoint-store.ts`.
- Storybloq's transaction journal and forward recovery.
- Hermes rollback/snapshot command surfaces.

Validation:

- Tests for git repo and shadow repo restore previews.
- Dirty-work protection tests.
- Undo-restore roundtrip tests.

### 45. Expand artifact attribution into a lineage graph

AI has an artifact attribution store with owner, kind, path, and metadata. It can become a full provenance layer that ties outputs back to sessions, tools, provider calls, approvals, checkpoints, and source inputs.

Recommended shape:

- Store artifact edges: created_by, derived_from, read_by, sent_to_channel, attached_to_prompt, checkpointed_by, exported_in_bundle.
- Add artifact content hashes and size/type metadata.
- Let cleanup policies protect artifacts referenced by active sessions, approvals, trace bundles, memory records, or handovers.
- Add a UI inspector for artifact lineage and cleanup eligibility.
- Include artifact lineage in diagnostics bundles.

Borrowed from:

- AI's `ArtifactAttributionStore` and cleanup service.
- OB1 source-reference and provenance sidecars.
- Codex trace bundle payload-before-event model.

Validation:

- Graph integrity tests.
- Cleanup protection tests for referenced artifacts.
- Diagnostics bundle tests for lineage manifests.

### 46. Add automation idempotency keys and catch-up ledgers

AI has automations, catch-up sweeps, and skipped-run recording. Missed-run and resume behavior should be idempotent and explainable when the app starts after being offline.

Recommended shape:

- Assign every scheduled fire a deterministic idempotency key from automation ID, scheduledAt, trigger type, and destination.
- Persist a catch-up ledger before running or skipping missed jobs.
- Add policies for burst limits, maximum missed runs, coalescing window, quiet hours, and user confirmation for stale jobs.
- Make one-time automations complete only after the run or skip record is durable.
- Show catch-up decisions in the automation UI.

Borrowed from:

- AI's `CatchUpCoordinator`.
- Codex app-server request IDs and backpressure semantics.
- Storybloq autonomous liveness/resume markers.

Validation:

- Restart-during-catch-up tests.
- Duplicate-fire prevention tests.
- Policy matrix tests for `runOnce`, `notify`, skip, stale, and quiet-hours behavior.

### 47. Add MCP config diff, dry-run, and rollback

AI has MCP record storage, lifecycle phases, redaction, shared/orchestrator scopes, and lifecycle reports. It needs safer workflows for changing MCP configs.

Recommended shape:

- Add an MCP config planner that shows added/removed/changed servers, changed env/header secrets by presence only, scope changes, and provider target changes.
- Add dry-run connect probes before committing config changes.
- Keep last-known-good MCP config and allow rollback from UI and Doctor.
- Add per-server lifecycle history: transport, initialize, discover, ready, degraded, retries, last error category.
- Add compatibility notes when a server's tool schema changes.

Borrowed from:

- AI's `McpLifecycleManager` and `RedactionService`.
- OpenClaw plugin/config doctor checks.
- Hermes `/reload-mcp` and tool registry generation counters.

Validation:

- MCP config diff snapshot tests.
- Rollback tests.
- Redaction tests proving secrets are presence-only in diffs.

### 48. Unify approval policy across shell, browser, MCP, files, and channels

AI has durable approvals, browser approvals, shell validation, MCP permissions, and channel policies. These should share one policy engine so the same operation is treated consistently across surfaces.

Recommended shape:

- Define a canonical `ActionRequest` with actor, session, tool, resource, origin, target path/URL, action class, risk score, proposed grant, expiry, and source channel.
- Route shell/file/browser/MCP/channel approvals through a shared policy evaluator.
- Add a policy simulator explaining "why would this be allowed or blocked?"
- Support scoped grants: once, session, project, profile, origin, tool, or time-boxed.
- Persist audit records for every automatic allow/deny and every user decision.

Borrowed from:

- AI's `DurableApprovalStore`, `BrowserApprovalStore`, bash validation, and channel access policy store.
- CodePilot's permission broker.
- NanoClaw's role/group privilege model.
- OpenClaw channel admission gates.

Validation:

- Cross-surface approval matrix tests.
- Policy simulator golden tests.
- Audit-log tests for auto and manual decisions.

### 49. Add browser profile lifecycle and credential isolation

AI has managed browser profiles and approvals. Browser profiles can accumulate cookies, permissions, downloads, and sensitive state, so lifecycle and isolation need first-class treatment.

Recommended shape:

- Track profile owner, purpose, allowed origins, created/last-used timestamps, storage size, download directory, and active sessions.
- Add expiration and cleanup policies for temporary profiles.
- Add per-profile permission grants and revoke-all behavior.
- Keep browser downloads and screenshots under artifact attribution with cleanup policies.
- Add "profile health" checks for missing directories, outside-root paths, stale locks, and oversized storage.

Borrowed from:

- AI's `BrowserProfileRegistry` and browser approval records.
- online-orchestrator's tab readiness and stale-tab handling.
- CodePilot's media/channel resource download safeguards.

Validation:

- Profile path containment tests.
- Temporary profile cleanup tests.
- Permission revoke and stale-lock tests.

### 50. Make remote directory sync resumable and conflict-aware

AI's remote directory sync has scan, compare, transfer, and complete phases. It should become crash-resumable before being used for large or high-risk remote work.

Recommended shape:

- Persist sync job manifests, phase, file cursor, per-file result, source/target hashes, and transfer method.
- Write target files through temp paths plus atomic rename on both local and remote sides.
- Add conflict detection when target changed after scan.
- Support resume and retry of failed files.
- Add a dry-run report that estimates transfer bytes and delete risk before any write.

Borrowed from:

- AI's `DirectorySyncService` and rolling-checksum files.
- Storybloq transaction journal recovery.
- t3code remote-node operational docs.

Validation:

- Restart mid-transfer tests.
- Conflict-after-scan tests.
- Atomic temp-file cleanup tests.

### 51. Centralize redaction as a reusable data-safety pipeline

AI has MCP redaction, diagnostics redaction, logger sanitization, browser approvals, channel payloads, and trace/export needs. A single redaction pipeline would reduce inconsistent leaks.

Recommended shape:

- Define a `RedactionPolicy` with contexts: UI preview, local log, diagnostics bundle, channel send, trace bundle, provider prompt, and test snapshot.
- Support field-aware secret classification plus free-text scanning.
- Emit redaction markers with reason codes, not only a generic sentinel.
- Add taint labels for values known to contain secrets so downstream loggers and exporters cannot accidentally reveal them.
- Add a redaction audit test suite shared by MCP, diagnostics, logs, channels, browser, and provider payloads.

Borrowed from:

- AI's `RedactionService`, diagnostics `redactValue`, and structured logger sanitizer.
- CodePilot runtime log scrubbing.
- OB1 unsafe write-back blocking.

Validation:

- Shared redaction fixture corpus.
- Tests proving every export/log path uses the shared pipeline.
- Snapshot tests for marker reason codes.

### 52. Add learning and prompt-enhancement governance

AI has prompt enhancement, observations, outcome tracking, and A/B testing. Those systems should be governed like product experiments because bad learned prompts can silently degrade agent behavior.

Recommended shape:

- Default learned prompt enhancement and experiments to explainable, user-visible, and reversible.
- Record every injected learned observation/enhancement with source, confidence, token cost, and outcome.
- Add kill switches per task type, provider, workspace, and experiment.
- Require minimum samples and confidence before auto-promoting any enhancement.
- Add "show me what was injected" in session detail and diagnostics bundles.

Borrowed from:

- AI's `PromptEnhancer`, `ABTestingEngine`, and `PolicyAdapter`.
- OB1 memory review/use-policy model.
- Hermes curator's pinned/paused/recoverable lifecycle.

Validation:

- Experiment promotion tests.
- Injection audit tests.
- Kill-switch tests proving no learned content is injected.

### 53. Add retention, privacy, and storage quota controls

AI stores sessions, logs, snapshots, artifacts, browser profiles, memory, observations, automations, channel messages, and diagnostics bundles. Users need explicit retention controls by data class.

Recommended shape:

- Add retention policies for logs, traces, session bodies, snapshots, artifacts, browser profiles, channel messages, memories, observations, and diagnostics bundles.
- Show current storage usage by class and project.
- Add manual purge and dry-run purge.
- Preserve protected artifacts and active session dependencies.
- Add privacy mode presets: normal, minimal history, no session bodies, and ephemeral.

Borrowed from:

- AI's artifact cleanup and snapshot retention primitives.
- CodePilot's privacy-sensitive runtime log buffer.
- MemPalace local-first storage emphasis.
- OB1 use-policy and source-reference separation.

Validation:

- Quota accounting tests.
- Purge dry-run tests.
- Protected dependency tests.

### 54. Add code index freshness and stale-result warnings

AI has code indexing, codebase mining status, LSP, RLM, and project memory. Search and agent context should say when results may be stale.

Recommended shape:

- Track index freshness by git HEAD, working-tree hash, file mtimes, ignored paths, index schema version, and last successful scan.
- Add stale labels to search/code-memory results when the workspace changed after indexing.
- Let agents request refresh or accept stale results explicitly.
- Add per-project indexing health to Doctor.
- Add degraded mode when an index is missing, too old, or built with a previous parser/schema.

Borrowed from:

- AI's RLM/codebase indexing tables and `branch-freshness.ts`.
- MemPalace stale index detection roadmap.
- oh-my-codex wiki lint/refresh/query model.

Validation:

- Fresh/stale index state tests.
- Git HEAD and dirty-worktree fixtures.
- Agent tool tests proving stale warnings are included.

### 55. Build a release readiness matrix by subsystem

AI's `verify` script is broad, but release confidence should be broken down by subsystem so gaps are visible and future work can add targeted gates.

Recommended shape:

- Add `docs/release-readiness.md` or generated JSON with rows for providers, IPC/contracts, renderer, session persistence, RLM, MCP, plugins, browser gateway, remote nodes, channels, automations, diagnostics, packaging, and native ABI.
- Link each row to tests, smoke commands, owners, and last successful run.
- Require a reason for any waived row.
- Include deterministic provider parity, Electron smoke, native ABI, and packaging checks.
- Keep release notes tied to readiness output.

Borrowed from:

- OpenClaw release-readiness docs and boundary/perf/dependency scripts.
- oh-my-codex QA and release-readiness reports.
- CodexDesktop-Rebuild upstream/build compatibility focus.

Validation:

- CI check that every subsystem has an owner and verification command.
- Readiness report generation snapshot test.

### 56. Add an operator incident timeline

AI has lifecycle traces, Doctor, diagnostics bundles, logs, approvals, and session events. An incident timeline would let a user answer "what happened?" without searching five stores.

Recommended shape:

- Correlate logs, provider events, approvals, session state changes, process restarts, MCP lifecycle events, channel deliveries, browser approvals, automation runs, and remote-node events by session/request IDs.
- Render a chronological timeline in diagnostics and the UI.
- Support filters by subsystem, severity, session, provider, and time.
- Include timeline excerpts in operator artifact exports.
- Link timeline events to trace bundle payloads or artifact lineage records.

Borrowed from:

- AI's `OperatorArtifactExporter`, lifecycle trace, approval stores, and structured logger contexts.
- Codex rollout trace sequence numbers.
- Actual Claude activity/stderr ring buffers.

Validation:

- Correlation tests with synthetic multi-subsystem events.
- Export tests proving timeline redaction.

### 57. Add provider and channel cost/budget enforcement

AI records token stats and context usage, but budgeting should happen before expensive actions run.

Recommended shape:

- Add workspace/session/provider/channel budgets for tokens, dollars, time, spawned workers, browser actions, and remote sync bytes.
- Estimate cost before dispatch when model metadata is available.
- Enforce soft and hard limits with user-visible decisions.
- Add budget tags to trace events, provider requests, automations, and child sessions.
- Show budget burn-down in long-running orchestration views.

Borrowed from:

- AI's `token_stats`, context usage, and resource-governor primitives.
- oh-my-opencode-slim's quality/speed/cost delegation guidance.
- rtk token-savings analytics.

Validation:

- Budget enforcement tests for soft/hard limits.
- Provider metadata fixtures.
- UI tests for budget exceeded/degraded state.

### 58. Add native CLI profile sandbox tests

Provider/CLI integrations often fail because the CLI sees a different HOME, PATH, config file, auth store, or shell than the app expected.

Recommended shape:

- Add fixture HOME directories for Codex, Claude, Gemini, Copilot, Cursor, and OpenCode-style CLIs.
- Test provider discovery and smoke commands under clean env, custom HOME, project config, missing auth, invalid base URL, and multiple install conflicts.
- Include Windows shell variants and Git Bash availability.
- Have Doctor report exactly which config/auth path was used.
- Add CLI update compatibility checks before auto-updating or advising updates.

Borrowed from:

- oh-my-codex false-green readiness troubleshooting.
- CodePilot provider doctor probes.
- codex-plugin-cc app-server broker and config reuse.
- CodexDesktop-Rebuild upstream sync checks.

Validation:

- Fixture-env provider discovery tests.
- Doctor report path assertions.
- Multiple-install conflict tests.

### 59. Add import/export portability for memory, workflows, and settings

AI has local storage, RLM, plugins, automations, channels, and project memory. A portable export/import story would make the system safer to migrate and easier to debug.

Recommended shape:

- Define portable bundles for project memory, session handovers, automations, provider settings without secrets, plugin manifests, command registry metadata, and learned observations.
- Keep secrets out of default exports and represent them as required-secret placeholders.
- Add import dry-run with conflict detection and migration plan.
- Include schema version and compatibility checks.
- Support project-scoped export separate from global app export.

Borrowed from:

- Storybloq export/status/validate model.
- OB1 Agent Memory API storage portability notes.
- OpenClaw generated protocol/config artifacts.

Validation:

- Roundtrip export/import tests.
- Secret-placeholder tests.
- Version mismatch tests.

### 60. Add accessibility and keyboard regression gates for the operator UI

AI Orchestrator is an operator console with dense workflows: approvals, channels, session trees, terminals, diagnostics, browser actions, and automations. Accessibility should be tested as a workflow requirement, not only style polish.

Recommended shape:

- Add keyboard-only flows for creating sessions, approving/denying actions, switching instances, opening diagnostics, reviewing automations, and navigating channel messages.
- Add ARIA labels and focus management contracts for approval modals, command palettes, tabs, split panes, tree views, and live logs.
- Add color contrast tokens for severity/status states.
- Add screen-reader-friendly text for streaming and background job status changes.
- Run automated accessibility checks in Playwright for critical views.

Borrowed from:

- agent-orchestrator's dashboard accessibility/performance design requirements.
- Storybloq review-lens accessibility checks.
- Claude Code/frontend-design plugin guidance.

Validation:

- Playwright keyboard navigation tests.
- Automated axe or equivalent checks for core views.
- Component tests for focus trap and live-region behavior.

## P2 - Third-Pass Reliability, Distribution, and Edge-Case Hardening

### 61. Add a transaction-backed migration framework for every durable store

AI has a small config `MigrationManager`, RLM migrations, worker config migration, and session migrations, but the migration story is split by subsystem. Make migrations auditable and reversible before the storage surface grows further.

Recommended shape:

- Use a shared migration ledger with migration ID, name, checksum, applied time, app version, store name, dry-run summary, and rollback hint.
- Run each migration inside a transaction where the backing store supports it.
- Add preflight checks for active sessions, active worker nodes, open files, and insufficient disk space.
- Add dry-run and rollback commands for app settings, RLM, worker service config, project state, and webhook storage.
- Emit migration events into diagnostics and operator incident timelines.

Borrowed from:

- NanoClaw's name-keyed `schema_version` table and transaction-wrapped migrations.
- agent-orchestrator's `migrate-storage --dry-run` and `--rollback` workflow.
- Actual Claude's idempotent, logged one-shot settings migrations.

Validation:

- Migration idempotency tests.
- Crash-before-ledger, crash-after-ledger, and rollback fixture tests.
- Dry-run snapshots that prove no files or rows changed.

### 62. Make settings import/export previewable, typed, and secret-safe

`settings-export.ts` currently exports app settings, channel credentials, channel policies, and remote node identities into one JSON payload. That is useful, but it should not become the only backup and migration path without stronger safety controls.

Recommended shape:

- Validate imports with Zod schemas before applying anything.
- Add an import preview with grouped changes, conflicts, unknown fields, downgraded fields, and destructive changes.
- Replace raw secrets in default exports with secret placeholders or encrypted vault references.
- Let users opt into secret export explicitly with a clear storage and sharing warning.
- Apply imports in phases with rollback records: settings, credentials, channel policies, remote node identities, automations, and plugins.

Borrowed from:

- OpenClaw doctor preview and repair warnings.
- agent-orchestrator's dry-run migration UX.
- Actual Claude migrations that preserve user intent while moving configuration between stores.

Validation:

- Secret-placeholder tests for channel tokens, node tokens, API keys, and webhook signing secrets.
- Import conflict tests.
- Partial-failure rollback tests.

### 63. Harden webhooks as a public ingress surface

AI's webhook server has HMAC validation, body limits, rate limits, delivery IDs, and idempotency. The next pass should treat webhooks as hostile network ingress, even if the default bind is localhost.

Recommended shape:

- Add timestamped HMAC signatures with configurable clock skew and replay windows.
- Support signing-secret rotation with current and previous secrets.
- Store secrets through the shared secret store, not reversible base64 inside route rows.
- Add route-scoped source rules: allowed event types, allowed automation IDs, optional IP/CIDR allowlists, and max concurrency.
- Record webhook security decisions as audit events with redacted payload hashes.

Borrowed from:

- AI's current `WebhookServer` and delivery ledger.
- NanoClaw's shared webhook adapter routing.
- OpenClaw's webhook and gateway security documentation.

Validation:

- Signature timestamp, replay, rotation, body-limit, and rate-limit tests.
- Tests proving secrets never appear in route list, diagnostics, or export payloads.
- End-to-end webhook to automation idempotency tests.

### 64. Add webhook adapter templates and payload mappers

The current webhook path accepts generic JSON with `event` or `type`. That is flexible, but users will expect safe built-ins for common automation sources.

Recommended shape:

- Add route templates for GitHub, GitLab, Linear, Stripe, Slack slash commands, and generic signed JSON.
- Convert provider-specific payloads into a canonical `WebhookTriggerSource` with provider, event, delivery ID, actor, resource, URL, and redacted summary.
- Let automations filter on canonical fields instead of raw payload paths.
- Add payload sample fixtures and a "test delivery" button.
- Make unknown provider payload fields available only to explicitly permissioned automations.

Borrowed from:

- NanoClaw's Chat SDK adapter model.
- OpenClaw plugin webhook documentation and channel-specific doctor checks.
- copilot-sdk scenario fixtures for transport and event contracts.

Validation:

- Fixture tests for each built-in provider.
- Canonical mapping snapshot tests.
- Permission tests for raw payload access.

### 65. Add worker-node output replay and acknowledgment semantics

`WorkerAgent` queues critical state and permission messages while disconnected, but ordinary output batches can still be dropped when the socket is unavailable. Remote workers need the same replay discipline as first-class session transports.

Recommended shape:

- Assign monotonic sequence numbers to every worker output, state, context, permission, and exit event.
- Persist a small per-instance worker event journal on the node.
- Have the coordinator acknowledge the last applied sequence per instance.
- Replay missed events after reconnect and dedupe stale events on the coordinator.
- Distinguish ephemeral streaming chunks from persisted events so replay does not duplicate transient UI effects.

Borrowed from:

- Jean's WebSocket transport sequence replay for sessions and terminal output.
- copilot-sdk's persisted versus ephemeral session event envelope.
- AI's existing `rpc-event-router` stale sequence handling.

Validation:

- Disconnect mid-output replay tests.
- Duplicate-event dedupe tests.
- Permission-request replay tests proving no prompt is lost or duplicated.

### 66. Add worker service update rollback with health gates

The worker service code has versioned binary directories and a symlink switch, but update activation should be treated as a transactional deployment.

Recommended shape:

- Install worker binaries into versioned directories with checksums, build metadata, platform, architecture, and minimum coordinator version.
- Stage an update, run a local health check, then atomically promote it.
- Keep previous-current and rollback pointers.
- Add service status checks after restart and auto-rollback when the worker cannot reconnect within a timeout.
- Surface worker update state in Doctor and the remote nodes UI.

Borrowed from:

- `src/worker-agent/service/rollback.ts` and platform service managers.
- agent-orchestrator's install-method-aware update service.
- OpenClaw's update-phase repair deferral.

Validation:

- Failed-health rollback tests.
- Checksum mismatch tests.
- Windows junction, macOS launchd, and Linux systemd fixture tests.

### 67. Add remote worker token rotation and revocation drills

Worker enrollment persists node tokens and supports revocation, but a reliable remote fleet needs planned rotation and recovery procedures.

Recommended shape:

- Add token age, last-used time, last-rotated time, and issuer metadata to worker identities.
- Support rotate-now and rotate-on-next-connect flows.
- Add a revocation drill mode that verifies a revoked worker cannot reconnect and shows how to re-enroll it.
- Keep old tokens valid only inside a short grace window during rotation.
- Add Doctor findings for stale tokens, missing node IDs, duplicated node IDs, and config files with unsafe permissions.

Borrowed from:

- AI's worker enrollment and `WORKER_AGENT_SETUP.md` re-enrollment workflow.
- Jean's token validation and URL token cleanup.
- CodePilot bridge security validators and rate limiter patterns.

Validation:

- Rotation success and rollback tests.
- Revoked-token reconnect tests.
- File permission checks for worker config paths.

### 68. Add watchdog stall forensics and escalation policies

AI has a main-process watchdog and renderer unresponsive sample capture. Those should feed a durable forensic record instead of isolated log lines.

Recommended shape:

- Persist stall reports with app version, PID, focused window, active sessions, worker queues, event-loop lag, provider bus metrics, and recent high-severity logs.
- Classify stalls as renderer hang, main-process event-loop stall, worker starvation, IPC flood, provider stream stall, or unknown.
- Add escalation policy: log only, capture sample, restart worker, pause background jobs, or prompt user to restart.
- Include prior-run stall reports in Doctor and diagnostics bundles.
- Add rate limits so repeated stalls do not fill the diagnostics directory.

Borrowed from:

- AI's `MainProcessWatchdog` and `WindowManager` sample capture.
- Actual Claude activity/stderr ring buffer patterns.
- OpenClaw stuck-session queue diagnostics.

Validation:

- Synthetic watchdog report tests.
- Renderer unresponsive sample path tests.
- Diagnostics export tests with redaction and size caps.

### 69. Standardize bounded queues and lane policies

AI has `BoundedAsyncQueue`, provider concurrency limiting, channel rate limiting, automations, and worker queues. The queue policy should be explicit per lane instead of implicit per implementation.

Recommended shape:

- Add a queue registry with lane name, owner, concurrency, max size, timeout, drop policy, retry policy, and metrics.
- Support lane types such as user-visible, background, provider, remote worker, channel, webhook, automation, and indexing.
- Require every drop to produce a structured event with reason and affected work ID.
- Add dead-letter handling for failed or expired work.
- Surface queue depth, oldest age, and drop counts in Doctor and debug panels.

Borrowed from:

- AI's `BoundedAsyncQueue`.
- OpenClaw's lane-aware command queue and per-session run serialization.
- Jean's bounded WebSocket command queue and liveness timer.

Validation:

- Queue saturation tests for every drop policy.
- Dead-letter tests.
- Metrics snapshot tests.

### 70. Harden the local tool runner protocol and module trust boundary

`tool-runner-child.ts` isolates crashes but still loads an arbitrary module path in a Node child process. The protocol should make the trust boundary explicit.

Recommended shape:

- Only load tools registered through a manifest or signed plugin inventory.
- Validate `toolFilePath` against canonical roots, realpaths, symlinks, package ownership, and declared capabilities.
- Validate args and output with the tool schema before crossing the process boundary.
- Capture stdout/stderr separately from structured progress messages.
- Add timeout, memory, cwd, env, and network policy fields to the runner request.

Borrowed from:

- AI's plugin validator and tool registry.
- OpenClaw sandbox and browser-container security audits.
- oh-my-codex hook runner isolation.

Validation:

- Malicious module path fixtures.
- Schema mismatch tests.
- Timeout and memory-limit tests.

### 71. Make CLI update actions install-method aware and reversible

AI has a CLI update service, but update commands should be chosen from the install method, package manager, target version, and user policy instead of broad latest-package assumptions.

Recommended shape:

- Detect install method per CLI: npm, pnpm, bun, Homebrew, GitHub extension, self-update, source checkout, managed bundle, or unknown.
- Prefer the CLI's self-update command when that is the supported path.
- Treat Homebrew and system package managers as manual-only unless the user explicitly opts in.
- Add target-version support, rollback instructions, and post-update smoke detection.
- Cache update checks by CLI, install method, channel, and current version.

Borrowed from:

- Jean's shared `cli-update` action resolver.
- agent-orchestrator's install-method and channel-aware update cache.
- CodePilot's release asset selection helpers.

Validation:

- Install-path classification fixtures.
- Update-plan snapshots per CLI and package manager.
- Post-update version verification tests.

### 72. Add app update and release-channel policy

AI's Electron packaging has smoke checks, fuses, signing checks, and platform resources. It still needs an operator-facing release policy before automatic or semi-automatic updates are safe.

Recommended shape:

- Add release channels: manual, stable, preview, and nightly.
- Score release assets by platform, architecture, file type, signature, checksum, and minimum app version.
- Require checksum and signing metadata for any in-app recommended update.
- Surface notarization, hardened runtime, Electron fuse, native ABI, preload-channel, and packaging status in release readiness.
- Keep native auto-update disabled until the signed asset and rollback story is complete.

Borrowed from:

- CodePilot's explicit disabled native updater and release asset scorer.
- CodexDesktop-Rebuild update check scripts.
- AI's `electron-builder.json`, fuse script, and smoke check.

Validation:

- Release asset scorer tests.
- Missing checksum/signature rejection tests.
- Packaged smoke checks on every target platform.

### 73. Persist provider quota snapshots and connect them to dispatch

`ProviderQuotaService` emits warnings and exhausted events in memory. Quotas should influence routing decisions before work is dispatched.

Recommended shape:

- Persist quota snapshots with source, confidence, provider, model, window, reset time, and last probe error.
- Feed quota state into model routing, provider selection, automations, and delegation profiles.
- Add policy actions: warn, require confirmation, route elsewhere, delay until reset, or block.
- Distinguish hard limits from inferred or stale limits.
- Show quota decisions in trace bundles and provider diagnostics.

Borrowed from:

- AI's quota probes and token stats.
- agent-orchestrator's cached update state scoping pattern.
- oh-my-opencode-slim's cost and speed delegation rules.

Validation:

- Stale quota decision tests.
- Routing tests that avoid exhausted providers.
- UI tests for hard versus inferred quota state.

### 74. Add voice mode privacy, provider, and transcript controls

AI has voice service primitives, temporary OpenAI keys, macOS local TTS, and OpenAI realtime transcription. Voice needs clearer privacy and lifecycle controls before it becomes a default workflow.

Recommended shape:

- Show a per-provider privacy label: local, provider-cloud, or CLI-native.
- Add transcript retention policies separate from normal text sessions.
- Track whether raw audio, partial transcripts, final transcripts, or TTS output were stored.
- Support local STT adapters as first-class providers when available.
- Add finalization outcomes for streaming STT so silent drops and timeout-finalized transcripts are visible.

Borrowed from:

- AI's `VoiceService`.
- Actual Claude's voice stream keepalive, finalize source, endpoint, interim promotion, and keyterms handling.
- OpenClaw speech-core's discriminated audio transcode outcomes.

Validation:

- Microphone permission and missing-key tests.
- Transcript retention tests.
- STT finalize timeout and partial-transcript tests.

### 75. Add a media transcoding and attachment safety pipeline

AI handles images, voice, browser downloads, channel media, and file attachments in several places. Media should pass through one safety pipeline before it reaches providers, channels, or the filesystem.

Recommended shape:

- Detect MIME type from content, not only file extension.
- Enforce per-media size, duration, dimension, and pixel-count limits.
- Strip EXIF and location metadata by default.
- Transcode audio and images into channel/provider-compatible formats with typed failure reasons.
- Register all generated media in artifact attribution with cleanup eligibility.

Borrowed from:

- OpenClaw's audio transcode outcome model.
- AI's image resolver/cache and artifact attribution store.
- CodePilot media/channel resource safeguards.

Validation:

- MIME spoofing fixtures.
- Oversized image/audio rejection tests.
- Metadata stripping tests.

### 76. Add an Electron shell and renderer security audit gate

`WindowManager` uses `contextIsolation`, sandboxed preload, and navigation guards. A formal audit gate should keep those settings from regressing as more browser, voice, and external-link features land.

Recommended shape:

- Add tests that assert `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`, and restricted DevTools in packaged builds.
- Restrict `shell.openExternal` through URL parsing, protocol allowlists, and dangerous URL rejection.
- Block non-app navigation, unexpected file URLs, and window-open attempts by default.
- Verify CSP, preload API shape, and permission handlers in the Electron smoke check.
- Add a security audit report row for browser gateway and renderer permissions.

Borrowed from:

- AI's `WindowManager`, preload domains, and CSP.
- OpenClaw's sandbox browser security audit tests.
- Electron packaging smoke checks.

Validation:

- Electron config snapshot tests.
- Dangerous external URL tests.
- Packaged smoke test that checks preload, CSP, and permission handlers.

### 77. Add notification routing, quiet hours, and alert dedupe

AI sends notifications for completed agents and action requests. As quotas, automations, webhooks, workers, and channels become noisier, notifications need policy rather than direct calls.

Recommended shape:

- Add a notification center with categories: action required, agent completed, quota, automation, remote worker, webhook, provider outage, and diagnostics.
- Add quiet hours, per-category toggles, severity thresholds, and max repeat intervals.
- Deduplicate repeated alerts by category, session, provider, and route.
- Keep in-app notifications even when native notifications are disabled.
- Add "take me there" routing for each notification.

Borrowed from:

- AI's `notifyAgentCompleted` and `notifyUserActionRequest`.
- Actual Claude notifier and tip scheduling patterns.
- Provider quota warning/exhausted events.

Validation:

- Dedupe and quiet-hours tests.
- Native-notification disabled tests.
- Click-routing tests.

### 78. Add feature flag ownership, expiry, and rollout audit

AI has compile-time and runtime feature flags, persisted overrides, and environment overrides. The next step is to make flags accountable so experiments do not become permanent unknowns.

Recommended shape:

- Track owner, description, default, rollout percent, creation date, expiry date, and removal issue for every flag.
- Add stale-flag Doctor findings for expired or ownerless flags.
- Add a flag change audit log with actor, old value, new value, and reason.
- Support kill switches for high-risk runtime systems such as learning injection, webhooks, worker nodes, voice, browser gateway, and plugins.
- Fail CI when a flag is referenced but not declared in the flag registry.

Borrowed from:

- AI's `FeatureFlagEvaluator` and `ORCHESTRATION_FEATURES`.
- Actual Claude's per-sink analytics killswitch and cached feature gates.
- OpenClaw dangerous config flag audits.

Validation:

- Flag registry drift tests.
- Expired-flag Doctor tests.
- Kill-switch enforcement tests.

### 79. Add telemetry and event governance with local-first defaults

AI includes OpenTelemetry dependencies and many structured event sources. Before any telemetry grows, define what is collected, where it goes, and how users disable it.

Recommended shape:

- Classify events as local-only diagnostics, product telemetry, performance metrics, security audit, or support bundle.
- Default to local-only unless the user explicitly enables external telemetry.
- Add per-sink kill switches and sampling controls.
- Strip sensitive fields before any external sink and test the redaction corpus against telemetry exporters.
- Make every emitted event carry a stable event name, schema version, subsystem, and privacy classification.

Borrowed from:

- Actual Claude's analytics sink routing, sampling, proto-field stripping, and sink killswitch.
- AI's structured logger and diagnostics redaction.
- OpenClaw security audit event discipline.

Validation:

- Telemetry schema snapshot tests.
- Opt-out and sink-kill tests.
- Redaction tests for every external sink.

### 80. Add singleton and timer leak detection to the test harness

AI has a large manual singleton reset file. That is useful, but it is easy for new services to miss registration and leak state between tests.

Recommended shape:

- Require every singleton service to register itself with a reset registry.
- Add an after-each leak detector for timers, EventEmitter listeners, file watchers, WebSockets, worker threads, and background queues.
- Fail tests when a singleton has no `_resetForTesting` or is not registered.
- Add scoped test harnesses for main-process services, renderer stores, worker agents, and remote-node services.
- Generate a singleton inventory so reviewers can see new global state.

Borrowed from:

- AI's `singleton-reset.ts`.
- Jean's transport cleanup and liveness timer patterns.
- OpenClaw's focused security and runtime fixture tests.

Validation:

- Intentional leak fixture tests.
- Singleton inventory drift tests.
- Parallel test isolation tests.

## Suggested Execution Order

1. Extract oversized files around tests that already exist.
2. Move startup modules into the bootstrap registry.
3. Centralize provider transforms before adding more provider parity.
4. Extend event sourcing and provider instance recovery.
5. Add shell parser support and contract drift tests.
6. Add Provider Doctor, runtime error taxonomy, and deterministic parity harnesses so future changes are measurable.
7. Add trace bundles, tool-output tee/filtering, and IDE diagnostic baselines to improve debug and verification loops.
8. Add scoped service state, LSP tools, compaction improvements, and remote docs.
9. Harden plugin boundaries, hook isolation, supply-chain ownership, and worker isolation.
10. Add app-server/control-plane APIs only after IPC/contracts are stable enough to generate external client artifacts.
11. Promote project-level workflow state, handovers, governed memory, and FTS search once the event/logging foundation is reliable.
12. Add multi-lens reviews, delegation profiles, and frontend performance guardrails after the core runtime contracts stop drifting.
13. Add resource budgets, supervision policies, approval unification, and retention controls before scaling background/remote work.
14. Add release-readiness, incident timelines, portability, and accessibility gates before treating AI Orchestrator as a reliable operator console.
15. Add migration, webhook, worker replay, CLI update, and Electron security gates before exposing more remote or ingress surfaces.
16. Add feature-flag, telemetry, notification, voice, media, and test-leak governance before turning experimental subsystems into defaults.

## Verification Commands For Future Work

Use the smallest relevant subset during each task, then run the broader suite after multi-file changes:

- `npm run typecheck`
- `npm run typecheck:spec`
- `npm run lint`
- `npm run lint:fast`
- `npm test`
- `npm run verify`
- `npm run smoke:electron`
