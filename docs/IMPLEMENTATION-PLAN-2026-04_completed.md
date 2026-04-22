# AI Orchestrator Implementation Plan

**Date:** 2026-04-22  
**Supersedes:** `docs/IMPROVEMENT-OPPORTUNITIES-2026-04.md`

## Executive Summary

This plan replaces the earlier improvement-opportunities document with a code-backed implementation sequence.

The main finding from the deep dive is that several proposed "missing" systems already exist:

- Keybindings exist, but they are separate from the main command system.
- The instance lifecycle already has a real state machine, but handshake readiness is implicit.
- Permission enforcement and bash validation already exist, but logic is split across multiple layers.
- Remote pairing/authentication already exists at the protocol level, but the UX is still token-heavy.
- MCP lifecycle tracking already exists.
- The orchestration event store already exists, but it does not yet model lane/worktree/branch lifecycle.

The roadmap should therefore prioritize consolidation and seam cleanup before adding new protocol or UX layers.

## Planning Principles

- Do not build duplicate systems where partial ones already exist.
- Prefer extracting shared seams over adding provider-specific logic.
- Keep the existing provider event envelope as the runtime backbone.
- Make each phase independently shippable with narrow verification gates.
- Land infrastructure work before ACP, remote UX, or structured elicitation.

## Current-State Corrections

### Commands and keybindings are fragmented, not absent

Relevant files:

- [src/main/commands/command-manager.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/commands/command-manager.ts)
- [src/main/commands/markdown-command-registry.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/commands/markdown-command-registry.ts)
- [src/main/ipc/handlers/command-handlers.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/ipc/handlers/command-handlers.ts)
- [src/main/instance/instance-manager.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/instance/instance-manager.ts)
- [src/renderer/app/core/services/keybinding.service.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/renderer/app/core/services/keybinding.service.ts)
- [src/renderer/app/features/settings/keyboard-settings-tab.component.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/renderer/app/features/settings/keyboard-settings-tab.component.ts)

The command system already exists, but slash-command expansion is embedded inside `InstanceManager.sendInput()`, while keyboard shortcuts remain renderer-local. The real work is to unify action resolution.

### Lifecycle states exist, but readiness is too implicit

Relevant files:

- [src/main/instance/instance-state-machine.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/instance/instance-state-machine.ts)
- [src/main/instance/instance-lifecycle.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/instance/instance-lifecycle.ts)
- [src/shared/types/instance.types.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/shared/types/instance.types.ts)
- [src/main/cli/adapters/base-cli-adapter.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/cli/adapters/base-cli-adapter.ts)

`readyPromise` already protects background initialization, but there is no explicit adapter-level "safe to accept first prompt" event boundary. That gap should be fixed without replacing the existing state machine.

### Security exists, but through multiple overlapping paths

Relevant files:

- [src/main/security/permission-enforcer.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/security/permission-enforcer.ts)
- [src/main/security/permission-manager.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/security/permission-manager.ts)
- [src/main/security/tool-permission-checker.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/security/tool-permission-checker.ts)
- [src/main/security/tool-validator.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/security/tool-validator.ts)
- [src/main/security/bash-validation/index.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/security/bash-validation/index.ts)

The platform already has meaningful enforcement. The work is to make one path authoritative for all tool execution and permission decisions.

### Remote auth and MCP lifecycle already exist

Relevant files:

- [src/main/auth/remote-auth.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/auth/remote-auth.ts)
- [src/main/remote-node/worker-node-connection.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/remote-node/worker-node-connection.ts)
- [src/main/ipc/handlers/remote-node-handlers.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/ipc/handlers/remote-node-handlers.ts)
- [src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts)
- [src/main/mcp/mcp-manager.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/mcp/mcp-manager.ts)
- [src/main/mcp/mcp-lifecycle-manager.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/mcp/mcp-lifecycle-manager.ts)

Remote pairing and MCP tracking should be treated as UX and operability work, not net-new backend systems.

### The event store exists, but the event model is too narrow

Relevant files:

- [src/main/orchestration/event-store/orchestration-events.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/orchestration/event-store/orchestration-events.ts)
- [src/main/orchestration/event-store/orchestration-event-store.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/orchestration/event-store/orchestration-event-store.ts)
- [src/main/orchestration/event-store/coordinator-event-bridge.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/orchestration/event-store/coordinator-event-bridge.ts)

The infrastructure is present. The missing piece is broader lifecycle coverage for lanes, branches, worktrees, and user-visible outcomes.

## Recommended Phase Order

1. Command and keybinding unification
2. Handshake readiness and security consolidation
3. ACP as an optional transport
4. Lane-event expansion and startup capability probing
5. Remote pairing UX and smaller MCP health-surface polish

This order minimizes rework. ACP, structured elicitation, richer audit events, and remote pairing all benefit from having one command model and one permission path first.

## Phase 1: Command And Keybinding Unification

### Goal

Create a single action model that powers:

- slash commands
- command-palette actions
- markdown-defined commands
- keybindings

### Primary files

- [src/main/commands/command-manager.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/commands/command-manager.ts)
- [src/main/commands/markdown-command-registry.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/commands/markdown-command-registry.ts)
- [src/main/ipc/handlers/command-handlers.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/ipc/handlers/command-handlers.ts)
- [src/main/instance/instance-manager.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/instance/instance-manager.ts)
- [src/shared/types/command.types.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/shared/types/command.types.ts)
- [src/shared/types/keybinding.types.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/shared/types/keybinding.types.ts)
- [src/renderer/app/core/services/keybinding.service.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/renderer/app/core/services/keybinding.service.ts)
- [src/renderer/app/features/settings/keyboard-settings-tab.component.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/renderer/app/features/settings/keyboard-settings-tab.component.ts)

### Concrete changes

- Move slash-command parsing and template resolution out of `InstanceManager.sendInput()`.
- Introduce a shared command/action registry keyed by stable command IDs.
- Make keyboard shortcuts dispatch command IDs instead of renderer-local callbacks.
- Add `when`-style eligibility checks for keybindings and UI actions.
- Preserve markdown command support by resolving markdown commands into the same registry shape.
- Keep existing custom-command persistence, but align it with the new registry contract.

### Deliverables

- One source of truth for executable user actions
- One IPC path for command execution
- One renderer path for keybinding dispatch
- Backward-compatible support for existing custom and markdown commands

### Main risk

Command behavior regression during migration from embedded send-path logic to centralized resolution.

### Verification

- Unit tests for built-in command resolution
- Unit tests for markdown command resolution
- Unit tests for keybinding condition evaluation
- Manual verification:
  - execute a built-in slash command
  - execute a markdown command
  - trigger a custom keybinding from settings

## Phase 2: Handshake Readiness And Security Consolidation

### Goal

Make readiness explicit and force all tool execution through one permission/enforcement path.

### Primary files

- [src/main/instance/instance-lifecycle.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/instance/instance-lifecycle.ts)
- [src/main/instance/instance-state-machine.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/instance/instance-state-machine.ts)
- [src/shared/types/instance.types.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/shared/types/instance.types.ts)
- [src/main/cli/adapters/base-cli-adapter.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/cli/adapters/base-cli-adapter.ts)
- [src/main/cli/adapters/claude-cli-adapter.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/cli/adapters/claude-cli-adapter.ts)
- other provider adapters under [src/main/cli/adapters](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/cli/adapters)
- [src/main/security/permission-enforcer.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/security/permission-enforcer.ts)
- [src/main/security/permission-manager.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/security/permission-manager.ts)
- [src/main/security/tool-permission-checker.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/security/tool-permission-checker.ts)
- [src/main/security/tool-validator.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/security/tool-validator.ts)
- [src/main/security/bash-validation/index.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/security/bash-validation/index.ts)

### Concrete changes

- Add an explicit adapter readiness signal or event instead of relying solely on background initialization.
- Gate first prompt delivery on that readiness boundary.
- Standardize how defer/approval/deny states are surfaced across providers.
- Collapse tool validation and permission checks into one authoritative pre-execution path.
- Ensure bash validation runs as part of the same gate, not as an optional side path.
- Emit one consistent runtime event shape for permission allow, deny, and defer outcomes.

### Deliverables

- Explicit first-prompt readiness semantics
- One permission path for all providers
- One approval lifecycle that works for direct tool calls and deferred tool calls

### Main risks

- Introducing duplicate readiness waits
- Re-prompting users due to overlapping enforcement layers
- Breaking provider-specific defer behavior during consolidation

### Verification

- Unit tests for readiness gating before first input
- Unit tests for approval, denial, and deferred resume
- Unit tests for destructive bash blocking
- Regression checks for at least Claude, Codex, and Gemini paths if they use different tool lifecycles

## Phase 3: ACP As An Optional Transport

### Goal

Add ACP support without disturbing the current adapter architecture.

### Primary files

- new `src/main/cli/adapters/acp-cli-adapter.ts`
- [src/main/providers/provider-interface.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/providers/provider-interface.ts)
- [src/shared/types/cli.types.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/shared/types/cli.types.ts)
- [src/main/orchestration/permission-registry.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/orchestration/permission-registry.ts)

### Concrete changes

- Implement ACP stdio transport as a new adapter.
- Translate ACP session updates into the existing provider runtime event model.
- Reuse the consolidated permission path from Phase 2.
- Support structured elicitation later without requiring a second event model.

### Deliverables

- ACP-compatible provider entrypoint
- Compatibility with the existing runtime event stream
- No regression to bespoke CLI adapters

### Main risk

Creating a second permission or event lifecycle instead of adapting ACP into the first one.

### Verification

- Mocked ACP transport tests
- Session-update translation tests
- Permission request round-trip tests
- Basic multi-turn session test through the ACP adapter

## Phase 4: Lane Events And Startup Capability Probe

### Goal

Expand observability using the existing event-store infrastructure and add a structured startup capability probe.

### Primary files

- [src/main/orchestration/event-store/orchestration-events.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/orchestration/event-store/orchestration-events.ts)
- [src/main/orchestration/event-store/orchestration-event-store.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/orchestration/event-store/orchestration-event-store.ts)
- [src/main/orchestration/event-store/coordinator-event-bridge.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/orchestration/event-store/coordinator-event-bridge.ts)
- new `src/shared/types/lane-events.ts`
- new `src/main/bootstrap/capability-probe.ts`
- [src/main/bootstrap/index.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/bootstrap/index.ts)
- [src/main/index.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/index.ts)
- [src/main/providers/provider-doctor.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/providers/provider-doctor.ts)

### Concrete changes

- Expand the event taxonomy from verification/debate/consensus-only to lane/worktree/branch lifecycle.
- Preserve the existing append-only event-store design.
- Add a startup probe for native module readiness, provider binary availability, and optional subsystem capability.
- Emit one structured startup capability event to the renderer.
- Gate optional services from probe results where reasonable.

### Deliverables

- Broader audit/observability model
- Structured degraded-startup surface
- Cleaner diagnosis of packaging/runtime failures

### Main risks

- Event taxonomy bloat
- Multiple competing health surfaces across bootstrap, providers, and MCP

### Verification

- Unit tests for new event types and persistence
- Unit tests for probe result aggregation
- Manual degraded-startup simulation where practical

## Phase 5: Remote Pairing UX And MCP Health Surface Polish

### Goal

Keep the current backend transport model but simplify the user-facing pairing flow and make health easier to interpret.

### Primary files

- [src/main/auth/remote-auth.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/auth/remote-auth.ts)
- [src/main/ipc/handlers/remote-node-handlers.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/ipc/handlers/remote-node-handlers.ts)
- [src/renderer/app/core/services/ipc/remote-node-ipc.service.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/renderer/app/core/services/ipc/remote-node-ipc.service.ts)
- [src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/renderer/app/features/settings/remote-nodes-settings-tab.component.ts)
- [src/main/mcp/mcp-manager.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/mcp/mcp-manager.ts)
- [src/main/mcp/mcp-lifecycle-manager.ts](/Users/suas/work/orchestrat0r/ai-orchestrator/src/main/mcp/mcp-lifecycle-manager.ts)

### Concrete changes

- Replace the renderer's "enrollment token" primary UX with issued one-time pairing credentials.
- Support connection link and QR presentation in the settings flow.
- Keep the legacy enrollment token path as a compatibility fallback until remote workers are migrated.
- Improve renderer visibility for node health, reconnect status, and pairing lifecycle.
- Limit MCP work here to health-surface polish, not subsystem redesign.

### Deliverables

- Simpler pairing flow
- Clearer remote-node onboarding
- Better health visibility for both remote nodes and MCP servers

### Main risk

Breaking existing remote-node registration flows if the old token path is removed too early.

### Verification

- Manual pair-new-node flow
- Manual reconnect-existing-node flow
- Manual revoke-node flow
- Manual degraded/recovered node-health flow

## Deferred Work

- Schema generation for IPC/Zod contracts
- Structured elicitation UI after ACP lands
- Oxlint evaluation
- Any broad build-system or monorepo migration

## What This Plan Explicitly Does Not Recommend

- Replacing the existing lifecycle state machine wholesale
- Building a second permission system
- Rebuilding MCP lifecycle from scratch
- Replacing remote-node auth instead of fixing the pairing UX
- Creating a parallel audit/event store
- Pursuing Bun/Turborepo or container-per-agent architecture in this codebase

## Execution Checklist

- Phase 1 depends on no earlier infrastructure work and should start first.
- Phase 2 should begin immediately after Phase 1 because ACP and remote UX depend on it.
- Phase 3 should not begin until the permission path is consolidated.
- Phase 4 can begin once Phases 1 and 2 have stabilized.
- Phase 5 should land after the foundational seams are stable, not before.

## Verification Expectations For Implementation Work

For code changes made under this plan, the expected verification baseline is:

- `npx tsc --noEmit`
- `npx tsc --noEmit -p tsconfig.spec.json`
- `npm run lint`
- targeted tests for touched areas

For documentation-only updates, those checks are not required.
