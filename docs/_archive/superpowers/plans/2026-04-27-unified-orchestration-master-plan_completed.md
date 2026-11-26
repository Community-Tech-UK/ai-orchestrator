# Unified Orchestration — Master Roadmap

> **For agentic workers:** This is a **roadmap document**, not an executable plan. Each phase below should be expanded into its own plan file (using `superpowers:writing-plans`) immediately before execution, so the tasks reflect the current state of the code at that moment. Only Phase 1 has been fully expanded so far — see `2026-04-27-phase1-orchestration-protocol-tests_completed.md`.

**Source spec:** `unified.md` (top-level of the repo).

**Goal:** Extend the existing Electron/Angular/TypeScript orchestrator with the operating-contract guarantees, observability, automation surface, capability enforcement, recall, and cleanup features described in `unified.md`, **without** introducing parallel runtimes for plugins, automation, permissions, sessions, or providers.

**Non-Goals (explicitly out of scope):**

- Do **not** port a Hermes-style Python runtime.
- Do **not** add a second plugin manager.
- Do **not** add a second automation scheduler.
- Do **not** add a second permission/approval system.
- Do **not** route webhooks directly to unrestricted instance execution.
- Do **not** coordinate Copilot/Gemini/Codex through MCP chat wrappers when native child spawning is available.
- Do **not** store unbounded provider or automation output in renderer state or external channel messages.
- Do **not** use consensus for routine lookups or simple file navigation.

---

## Phase Inventory

Each phase produces a working, testable, shippable slice on its own. Implement in the listed order — later phases depend on the schema and plumbing introduced by earlier ones.

### Phase 1 — Stabilize the Orchestration Operating Contract  ✅ plan ready

- **Plan file:** `2026-04-27-phase1-orchestration-protocol-tests_completed.md`
- **Status of code today:** Prompt + protocol + parser + validator + renderer strip already exist in `src/main/orchestration/orchestration-protocol.ts` and `src/renderer/app/core/services/markdown.service.ts`. Today's `orchestration-handler.spec.ts` (213 lines) only covers streaming markers, user-action shapes, and consensus tracking. Prompt-content invariants and full per-action parser/validator coverage are missing.
- **Goal:** Lock the parent operating contract, command parsing, validation, and renderer stripping behind tests so prompt drift fails CI.
- **Exit criteria (from `unified.md` §Phase 1):**
  - Operating contract is test-covered.
  - Prompt changes fail tests when they remove core delegation, retrieval, or provider-routing guidance.
  - No new runtime system is introduced.

### Phase 2 — Extend Plugin Hooks for Lifecycle Observability

- **Plan file:** _to be written_
- **Status of code today:** `src/shared/types/plugin.types.ts` defines 16 typed hook payloads; `src/main/plugins/plugin-manager.ts` dispatches with a 5-second per-hook timeout, fail-open logging, and a public `emitHook()` broadcaster (lines 897–910). Lifecycle, command, child, consensus, and automation events are not yet emitted as plugin hooks.
- **Goal:** Add typed lifecycle hook events covering instance spawn/input, session archive/terminate, orchestration command/child/consensus, and automation runs. Emit from the existing managers — do **not** create a new event bus.
- **New hook events (extend `PluginHookPayloads`):**
  - `instance.spawn.before`, `instance.spawn.after`
  - `instance.input.before`, `instance.input.after`
  - `session.archived`, `session.terminated`
  - `orchestration.command.received`, `orchestration.command.completed`, `orchestration.command.failed`
  - `orchestration.child.started`, `orchestration.child.progress`, `orchestration.child.completed`, `orchestration.child.failed`, `orchestration.child.result.reported`
  - `orchestration.consensus.started`, `orchestration.consensus.completed`, `orchestration.consensus.failed`
  - `automation.run.started`, `automation.run.completed`, `automation.run.failed`
- **Exit criteria:**
  - Hook payloads compile end to end through `TypedOrchestratorHooks`.
  - Existing plugin tests cover each new event name and payload shape.
  - A fixture plugin can observe spawn, command, child, consensus, automation, archive, and termination lifecycles.
- **Files to touch (from `unified.md` §Phase 2):**
  - `src/shared/types/plugin.types.ts`
  - `src/main/plugins/plugin-manager.ts`
  - `src/main/instance/instance-lifecycle.ts`
  - `src/main/instance/instance-orchestration.ts`
  - `src/main/orchestration/orchestration-handler.ts`
  - `src/main/automations/automation-runner.ts`
  - `src/main/session/session-archive.ts`

### Phase 3 — Add Child Runtime Observability and Diagnostics

- **Plan file:** _to be written_
- **Status of code today:** `src/shared/types/agent-tree.types.ts` (56 lines) is minimal — no heartbeat, no last-activity timestamp, no spawn-prompt hash, no result/artifact counts. `agent-tree-persistence.ts` writes JSON snapshots per project (BFS rebuild on resume). No "child diagnostic bundle" type or store exists today.
- **Goal:** Extend persisted agent-tree nodes with runtime metadata (provider/model, parent/child ids, role, working dir, prompt hash, status timeline, heartbeats, last-activity, result id, artifact counts). Add a child-diagnostic-bundle type for stuck/failed children. Surface progress without scraping raw output. Emit Phase 2 hooks as state changes.
- **New types to add (extending existing files, not new packages):**
  - `AgentTreeNodeRuntime` (extends `AgentTreeNode`) with: `role`, `spawnPromptHash`, `statusTimeline`, `heartbeatAt`, `lastActivityAt`, `resultId`, `artifactCount`.
  - `ChildDiagnosticBundle` with: `parentInstanceId`, `childInstanceId`, `provider`, `model`, `workingDirectory`, `spawnTaskSummary`, `spawnPromptHash`, `statusTimeline`, `recentEvents`, `recentOutputTail`, `artifactsSummary`, `lastHeartbeatAt`, `timeoutReason`.
  - Bump `AGENT_TREE_SCHEMA_VERSION` from 1 → 2 with a forward-compatible loader.
- **Exit criteria:**
  - Parent/child relationships visible from persisted state alone.
  - Stuck children produce actionable local diagnostics.
  - Parents and users see progress from structured metadata, not transcript scraping.

### Phase 4 — Harden Native Cross-Provider Coordination

- **Plan file:** _to be written_
- **Status of code today:** `SpawnChildPayloadSchema` in `packages/contracts/src/schemas/orchestration.schemas.ts:12-19` validates provider as a fixed enum. `instance-orchestration.ts` uses `routingDecision` for model routing. `requestedProvider`/`actualProvider` is **not** recorded as a single audit pair today.
- **Goal:** Record requested vs routed provider/model on every spawn; include routing provenance in child start/completion metadata; validate provider/model through shared schemas; bound consensus output by default.
- **Exit criteria:**
  - Spawn routing is inspectable after the fact.
  - Provider/model schema validation catches invalid requests before spawn.
  - Consensus output stays compact and reports all-provider failure accurately.

### Phase 5 — Extend Automation Triggers, Output Retention, and Delivery

- **Plan file:** _to be written_
- **Status of code today:** `src/shared/types/automation.types.ts` defines `AutomationTrigger = 'scheduled' | 'catchUp' | 'manual'`. Full RLM-backed store, scheduler, runner, and catch-up coordinator already exist (`src/main/automations/`). External triggers, idempotency keys, and delivery-mode metadata are missing.
- **Goal:** Extend `AutomationTrigger` to include `'webhook' | 'channel' | 'providerRuntime' | 'orchestrationEvent'`. Add idempotency keys for externally triggered runs, trigger-source metadata, full local output retention, and delivery modes (`notify` / `silent` / `localOnly`). Preserve current scheduled/catch-up/manual behavior.
- **Exit criteria:**
  - Existing scheduled automations remain backward compatible.
  - External automation triggers are idempotent.
  - Full output is locally retrievable.
  - External channel messages stay bounded.

### Phase 6 — Add Secure Webhook Ingress

- **Plan file:** _to be written_
- **Status of code today:** `src/main/webhooks/` does **not exist**. No HTTP server is currently wired in the main process for ingress.
- **Goal:** Add a main-process webhook ingress service. Require HMAC by default; allow unsigned only via explicit dev opt-in. Enforce body limits, delivery-id idempotency with TTL, and event filters that gate which automations a webhook can trigger. Reuse existing rate-limiter patterns. Route accepted events into the **Phase 5** automation trigger path. IPC exposes only configuration, status, and recent delivery diagnostics — never an "execute prompt" passthrough.
- **Files to create:**
  - `src/main/webhooks/webhook-server.ts`
  - `src/main/webhooks/webhook-store.ts`
  - `src/main/webhooks/webhook-types.ts`
  - `src/main/ipc/handlers/webhook-handlers.ts`
  - `src/shared/types/webhook.types.ts`
  - schema additions in `packages/contracts/src/schemas/` and `src/shared/validation/ipc-schemas.ts`
- **Dependency:** Phase 5 must land first so the trigger path exists.
- **Exit criteria:**
  - Duplicate delivery IDs do not create duplicate automation runs.
  - Missing or invalid signatures are rejected unless dev opt-in is enabled.
  - Oversized bodies are rejected.
  - Webhooks cannot directly execute arbitrary instance prompts.

### Phase 7 — Enforce Role Capability Policies

- **Plan file:** _to be written_
- **Status of code today:** `src/main/orchestration/permission-registry.ts` is a Promise-based async permission resolver — it routes individual requests but does **not** declare capability profiles per role. Sandbox/filesystem/network policy already exists in `src/main/security/`.
- **Goal:** Define declarative capability profiles for `parent_orchestrator`, `worker`, `reviewer`, `verifier`, `recovery_agent`, `automation_runner`. Policy dimensions: child spawning, provider/model allowlists, filesystem write, command/tool categories, network/webhook access, consensus usage, user-action requests. Apply on spawn and command handling. Fail disallowed actions before provider execution. Treat existing user-approval / yolo / permission flows as inputs to policy resolution, not replacements.
- **Exit criteria:**
  - Role capabilities are explicit, typed, and test-covered.
  - Disallowed actions fail before execution.
  - Parent, worker, reviewer, verifier, recovery, and automation roles have clear defaults.

### Phase 8 — Build Searchable Session Recall

- **Plan file:** _to be written_
- **Status of code today:** RLM, observation store, code search, session archive, and child-result storage all exist. A focused recall query surface across them does not.
- **Goal:** Index session summaries, child-result summaries/artifacts, child diagnostic bundles, provider runtime events, archived session metadata, and automation run summaries/failures. Query APIs: prior failures by provider/model, prior fixes by repo path, prior review/verification decisions, stuck-session diagnostics, automation run history. Return compact summaries with source links; lazy-load full transcripts only on explicit request.
- **Dependency:** Phase 3 (child diagnostic bundles) and Phase 5 (automation run trigger metadata) make the index meaningfully populated.
- **Exit criteria:**
  - Users can search past orchestration work from persisted state.
  - Results include enough context to act.
  - Large outputs stay bounded and lazy-loaded.

### Phase 9 — Add Lifecycle-Aware Cleanup

- **Plan file:** _to be written_
- **Status of code today:** No central artifact-attribution system exists. Cleanup is ad-hoc per subsystem.
- **Goal:** Track generated artifacts by owner (instance id, session id, automation run id, worktree id, diagnostic bundle id). Add explicit cleanup policies with protected paths. Start with dry-run cleanup diagnostics. Never delete user worktrees or project files by default. Emit lifecycle hooks before/after cleanup candidates are removed.
- **Dependency:** Phases 3, 5, 8 all create artifacts that this phase will track.
- **Exit criteria:**
  - Temporary generated artifacts are attributable.
  - Cleanup candidates can be inspected before deletion.
  - Protected paths cannot be removed by policy mistakes.

---

## Recommended Execution Order

1. Phase 1 — orchestration protocol tests (foundation; smallest)
2. Phase 2 — plugin lifecycle hooks (enabler for 3, 5)
3. Phase 3 — child runtime observability + diagnostics
4. Phase 4 — native provider/model routing audit + consensus visibility
5. Phase 5 — automation trigger and delivery model
6. Phase 6 — secure webhook ingress (depends on 5)
7. Phase 7 — role capability policies
8. Phase 8 — searchable session recall (depends on 3, 5)
9. Phase 9 — lifecycle-aware cleanup (depends on 3, 5, 8)

## Verification Standard (Applies to Every Phase)

For every implementation slice:

1. Read affected files **and** adjacent tests before editing.
2. Add focused tests for changed behavior.
3. Run, in order, and require all pass:
   - `npx tsc --noEmit`
   - `npx tsc --noEmit -p tsconfig.spec.json`
   - `npm run lint` (or targeted ESLint for modified files)
   - targeted `vitest` specs for the touched subsystem
4. After multi-file changes, run the full relevant test suite **before** claiming the slice complete.

Schema-changing phases must additionally verify:

- IPC schemas and preload exposure stay in sync (`src/preload/preload.ts`, `src/shared/validation/ipc-schemas.ts`).
- Database migrations are forward-compatible (`src/main/persistence/rlm/rlm-schema.ts`).
- Packaged runtime aliases are updated when new `@contracts/*` subpaths are introduced (`tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, `vitest.config.ts`).
- Renderer stores and display processors handle old records gracefully.

## How to Use This Roadmap

When starting a phase:

1. Re-read the corresponding section in `unified.md` (the source spec).
2. Re-explore the listed files — they may have moved since this roadmap was written.
3. Run `superpowers:writing-plans` with the phase's section as the brief.
4. Save the resulting plan as `docs/superpowers/plans/<YYYY-MM-DD>-phase<N>-<slug>.md`.
5. Execute via `superpowers:subagent-driven-development` or `superpowers:executing-plans`.
6. Update this roadmap's "Plan file" reference to point to the saved plan.

---

**Version:** Initial draft, 2026-04-27.
**Source:** `unified.md` (verified against current repo state on the same date).
