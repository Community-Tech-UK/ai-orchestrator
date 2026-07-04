# Architecture Reference

Read this file when you need to understand the codebase structure, domain locations, or subsystem details.

## Key Directories

- `src/main/` - Electron main process (Node.js) — about 975 TypeScript files across provider, orchestration, diagnostics, persistence, and workspace domains
- `src/renderer/` - Angular frontend — about 410 TypeScript files under `src/renderer/app`, including overlay, picker, HUD, Doctor, and settings features
- `src/shared/` - Shared types (about 125 TypeScript files), constants, validation schemas
- `src/preload/` - Electron preload bridge with generated channel constants and typed domain factories (775 generated IPC channels)

## Main Process Domains

```
src/main/
├── agents/           # Agent management system
├── api/              # API handlers and routes
├── browser-automation/ # Browser automation features
├── cli/              # Multi-provider CLI adapters
│   └── adapters/     #   Claude, Codex, Gemini, Copilot
├── commands/         # Command execution system
├── communication/    # Cross-instance token-based messaging
├── context/          # Context compaction, JIT loading, window guards
├── core/             # Config, health monitoring, cost tracking
├── diagnostics/      # Doctor reports, command/skill/instruction diagnostics, redacted artifact export
├── display-items/    # Main-side display marker renderers for transcript events
├── git/              # Git helpers used by workspace/session features
├── history/          # Conversation history tracking
├── hooks/            # Hook system (pre/post exec)
├── indexing/         # Code indexing and semantic search
├── instance/         # Instance lifecycle, communication, orchestration
├── ipc/              # IPC handlers for all features
├── learning/         # ML systems (GRPO, A/B testing)
├── logging/          # Structured logging with subsystem context
├── mcp/              # Model Context Protocol integration
├── memory/           # Memory system (episodic, procedural, semantic)
├── observation/      # Observation/telemetry pipeline
├── orchestration/    # Multi-agent coordination (see below)
├── persistence/      # Data persistence (RLM database)
├── plugins/          # Plugin system
├── prompt-history/   # Prompt recall persistence and delta emission
├── process/          # Supervisor tree, resource governor, pool, hibernation
├── providers/        # Provider registry, failover, model discovery
├── remote/           # Remote observer server
├── remote-node/      # Remote node pairing, service control, and filesystem bridge
├── repo-jobs/        # Repository job management
├── rlm/              # Reinforcement Learning from Memory
├── routing/          # Message routing
├── security/         # Secret detection, path validation, redaction
├── session/          # Session continuity, checkpoints, recovery
├── skills/           # Extensible skills framework
├── tasks/            # Background tasks, todo management
├── tools/            # External tools integration
├── usage/            # Command/session/model/prompt/resume usage and frecency tracking
├── util/             # Utilities
├── vcs/              # Version control integration
├── workflows/        # Workflow automation
└── workspace/        # Worktree management
```

## Multi-Agent Coordination Systems

Located in `src/main/orchestration/` (27 files):

1. **Multi-Verification** (`multi-verify-coordinator.ts`)
   - Spawns multiple agents to verify responses
   - Uses embedding-based semantic clustering
   - Caches results for efficiency

2. **Debate System** (`debate-coordinator.ts`)
   - Multi-round debates between agents
   - Critique and defense rounds
   - Consensus synthesis via `synthesis-agent.ts`

3. **Consensus** (`consensus-coordinator.ts`, `consensus.ts`)
   - Multi-agent agreement mechanisms
   - Voting-based consensus (`voting.ts`)

4. **Parallel Worktree** (`parallel-worktree-coordinator.ts`)
   - Distributed execution across git worktrees

5. **Skills System** (`src/main/skills/`)
   - Progressive skill loading
   - Built-in orchestrator skills in `src/main/skills/builtin/`
   - Skills must be in subdirectories with `SKILL.md` files

6. **Default Invokers** (`default-invokers.ts`)
   - Wires LLM invocation handlers to debate, verification, review, and workflow events

7. **Orchestration HUD + verdicts**
   - HUD state and quick-action bundles are derived in orchestration services and consumed by renderer orchestration components
   - Verification verdicts are derived by `verification-verdict-deriver.ts` and pushed through `verification:verdict-ready` with raw responses preserved

8. **Loop Mode planning and audit envelope**
   - `loop-coordinator.ts` owns iteration scheduling, completion seams, preflight execution, final-audit gating, and state transitions.
   - Loop-owned artifacts are scoped under `.aio-loop-state/<loopRunId>/`: `LOOP_TASKS.md`, `ROADMAP.md`, `PRE_FLIGHT.md`, `AUDIT.md`, `repo-baseline.json`, and `phases/`.
   - Repo baselines are captured by `loop-repo-state.ts`; comparisons use single-revision working-tree diffs so tracked, staged, unstaged, and untracked files are visible while `.aio-loop-control/`, `.aio-loop-attachments/`, `.aio-loop-state/`, `.git/`, and `node_modules/` stay excluded.
   - Audit config modes are explicit: `finalAuditMode` is `off`, `observe`, or `gate`; `preflightMode` is `off`, `record`, or `block`; `planPacketMode` is `off` or `prompted`; `cleanlinessScan` controls added-line scans for conflict markers, focused tests, and debug statements.
   - Preflight runs once before the first child iteration when enabled. `record` stores `PRE_FLIGHT.md` and continues on red; `block` pauses before implementation if verification is red.
   - Completion authority remains machine-owned: verify/fresh-eyes evidence and existing gates are resolved by `evidence-resolver.ts`; in `gate` mode, `loop-final-audit.ts` can reject completion or stop as `completed-needs-review`. In `observe` mode, audit findings are persisted but do not change completion.
   - Plan packets are prompted during PLAN mode by `loop-stage-machine.ts` and parsed by `loop-plan-packet.ts` for final-audit coverage. Malformed packets require review; transcript markers from Supergoal or native `/goal` are not used.

## Provider System

Located in `src/main/providers/`:

- **ProviderRegistry** — registers all available providers
- **FailoverManager** — automatic failover between providers on error
- **ModelDiscovery** — detects available models across providers
- **UnifiedModelCatalogService** — the authoritative available-model surface for desktop and mobile pickers. It merges static provider defaults, models.dev enrichment, local/remote catalog overrides, user custom models, and CLI-discovered models; stale stored selections are resolved lazily to provider defaults with a visible session note. `npm run sync:model-catalog` only refreshes the committed models.dev offline snapshot for pricing/context metadata and offline safety. It is no longer required for a newly available model to appear when the CLI, custom-model, or override sources report it.
- Providers: Anthropic API (direct), Claude CLI, Codex CLI, Gemini CLI

## CLI Adapters

Located in `src/main/cli/adapters/`:

- **Adapter entrypoints** (`*-cli-adapter.ts`) own provider lifecycle, process state, and event emission.
- **Provider helper directories** keep protocol details out of adapter entrypoints. For Codex, `src/main/cli/adapters/codex/` owns app-server transport, exec transcript parsing, stderr diagnostics, attachment capability checks, reasoning dedupe, session scanning, and MCP-free `CODEX_HOME` setup.
- Adapter entrypoints should stay orchestration-focused. Prefer extracting pure parsing/formatting helpers or direct-testable coordinators before adding new long private-method blocks.

## MCP Multi-Provider

Main-process layer managing MCP servers across Claude Code, Codex, Gemini, and Copilot plus two Orchestrator-owned scopes: Shared and Orchestrator.

Key files:
- `src/main/mcp/cli-mcp-config-service.ts` - high-level multi-provider state and provider user-scope writes.
- `src/main/mcp/shared-mcp-coordinator.ts` - shared-server fan-out, drift detection, and drift resolution.
- `src/main/mcp/orchestrator-injection-reader.ts` - spawn-time Orchestrator MCP bundle reader.
- `src/main/mcp/adapters/*-mcp-adapter.ts` - provider-native config readers/writers.
- `src/main/mcp/write-safety-helper.ts` - atomic writes, backups, and parent-permission guard.
- `src/main/mcp/secret-storage.ts` - `safeStorage` wrapper with explicit plaintext quarantine fallback.

Renderer writes flow through `McpPageComponent` -> `McpIpcService` -> MCP IPC handlers -> `CliMcpConfigService` or `SharedMcpCoordinator` -> provider adapter -> `WriteSafetyHelper` -> disk.

Disk/read flow uses provider adapters to build `McpMultiProviderStateDto`; renderer state lives in `McpMultiProviderStore` and receives `mcp:multi-provider-state-changed` updates.

## Process Management

Located in `src/main/process/`:

- **SupervisorTree** — Erlang OTP-inspired hierarchical supervision, auto-expand at 16 children
- **ResourceGovernor** — listens to MemoryMonitor events, pauses creation on warning, terminates idle on critical
- **HibernationManager** — idle instance detection with hysteresis cooldown, eviction scoring
- **PoolManager** — warm instance pool with configurable size, auto-eviction of stale instances
- **LoadBalancer** — weighted scoring (active tasks, context usage, memory pressure)
- **CircuitBreaker** — restart rate limiting and fault tolerance

All wired into `index.ts` at startup and cleaned up on shutdown.

## Command, Picker, And Usage Surfaces

- **Command registry** (`src/main/commands/`, `src/renderer/app/features/commands/`) merges built-in, stored, markdown, and skill-derived commands. Registry diagnostics feed Doctor.
- **Overlay shell** (`src/renderer/app/features/overlay/`) provides shared keyboard navigation and projection slots for command, session, model, agent, and resume pickers.
- **UsageTracker / UsageStore** (`src/main/usage/`, `src/renderer/app/core/state/usage.store.ts`) provides frecency scoring for commands and downstream pickers.
- **Prompt history** (`src/main/prompt-history/`, `src/renderer/app/core/state/prompt-history.store.ts`) persists per-instance prompt recall and reverse search.

## Diagnostics And Support Artifacts

- **DoctorService** (`src/main/diagnostics/doctor-service.ts`) composes startup, provider, CLI, browser automation, command, skill, and instruction diagnostics.
- **OperatorArtifactExporter** writes local zip bundles with centralized redaction in `src/main/diagnostics/redaction.ts`.
- **CLI update pill** state is polled in the main process and bridged to the renderer through diagnostics IPC.
- **Runbooks** live in `docs/runbooks/` and are opened from Doctor with `app:open-docs`.

## IPC And Contracts

- IPC channel names are sourced from `packages/contracts/src/channels/*` and generated into `src/preload/generated/channels.ts`.
- Schema subpath imports under `@contracts/schemas/*` must be synchronized across `tsconfig.json`, `tsconfig.electron.json`, `src/main/register-aliases.ts`, and `vitest.config.ts`.
- `scripts/check-contracts-aliases.ts` is part of `prebuild` and `prestart` to catch missing runtime aliases before packaging.

## Session Recovery

Located in `src/main/session/`:

- **SessionContinuityManager** — auto-save on configurable intervals, snapshot management, resume
- **SessionAutoSaveCoordinator** — isolated periodic dirty-state save scheduling, per-session timers, and post-resume deferral
- **CheckpointManager** — bridges error recovery with session continuity, transaction logging
- **FallbackHistory** — token-budget-aware fallback history for resume failures
- **SessionRepair** — recovery mechanisms for corrupted/failed sessions
- **SessionMutex** — per-instance async mutex for state protection
- **SessionArchive** — archival and retrieval of past sessions
- **SnapshotIndex** — fast in-memory snapshot lookups with atomic filesystem writes

Session tracking is wired into instance lifecycle: `startTracking()` on create, `stopTracking()` on remove, `shutdown()` before app exit.

## Instance Lifecycle

Located in `src/main/instance/`:

- **InstanceLifecycleManager** (`instance-lifecycle.ts`) — high-level creation, restart, hibernation, and respawn orchestration
- **Lifecycle coordinators** (`src/main/instance/lifecycle/`) — focused pieces for instance-record construction, spawning, session recovery, idle monitoring, interrupt respawn, runtime readiness, termination cleanup, and shared tool-permission spawn config
- **InstanceManager** (`instance-manager.ts`) — public API for instance operations
- **InstanceCommunication** — inter-instance messaging
- **InstanceOrchestration** — orchestration coordination per instance
- **InstanceContext** — context window management per instance
- **StuckProcessDetector** — two-stage timeout detection
- **WarmStartManager** — pre-spawned process pool for instant creation
- **InstanceStateMachine** — state transition validation (idle, busy, waiting, error, hibernated, initializing, waking)

## CLAUDE.md Loading

Instance lifecycle automatically loads CLAUDE.md files:
- Global: `~/.claude/CLAUDE.md`
- Project: `.claude/CLAUDE.md`

Content is prepended to instance system prompts.
