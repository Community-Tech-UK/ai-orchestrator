# Architecture Reference

Read this file when you need to understand the codebase structure, domain locations, or subsystem details.

## Key Directories

- `src/main/` - Electron main process (Node.js) — 325 source files across 37 domains
- `src/renderer/` - Angular frontend — 262 source files, 48 feature modules
- `src/shared/` - Shared types (47 files), constants, validation schemas
- `src/preload/` - Electron preload bridge (~5,300 lines, 460+ IPC channels)

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
├── process/          # Supervisor tree, resource governor, pool, hibernation
├── providers/        # Provider registry, failover, model discovery
├── remote/           # Remote observer server
├── repo-jobs/        # Repository job management
├── rlm/              # Reinforcement Learning from Memory
├── routing/          # Message routing
├── security/         # Secret detection, path validation, redaction
├── session/          # Session continuity, checkpoints, recovery
├── skills/           # Extensible skills framework
├── tasks/            # Background tasks, todo management
├── tools/            # External tools integration
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

## Provider System

Located in `src/main/providers/`:

- **ProviderRegistry** — registers all available providers
- **FailoverManager** — automatic failover between providers on error
- **ModelDiscovery** — detects available models across providers
- Providers: Anthropic API (direct), Claude CLI, Codex CLI, Gemini CLI

## Process Management

Located in `src/main/process/`:

- **SupervisorTree** — Erlang OTP-inspired hierarchical supervision, auto-expand at 16 children
- **ResourceGovernor** — listens to MemoryMonitor events, pauses creation on warning, terminates idle on critical
- **HibernationManager** — idle instance detection with hysteresis cooldown, eviction scoring
- **PoolManager** — warm instance pool with configurable size, auto-eviction of stale instances
- **LoadBalancer** — weighted scoring (active tasks, context usage, memory pressure)
- **CircuitBreaker** — restart rate limiting and fault tolerance

All wired into `index.ts` at startup and cleaned up on shutdown.

## Session Recovery

Located in `src/main/session/`:

- **SessionContinuityManager** — auto-save on configurable intervals, snapshot management, resume
- **CheckpointManager** — bridges error recovery with session continuity, transaction logging
- **FallbackHistory** — token-budget-aware fallback history for resume failures
- **SessionRepair** — recovery mechanisms for corrupted/failed sessions
- **SessionMutex** — per-instance async mutex for state protection
- **SessionArchive** — archival and retrieval of past sessions
- **SnapshotIndex** — fast in-memory snapshot lookups with atomic filesystem writes

Session tracking is wired into instance lifecycle: `startTracking()` on create, `stopTracking()` on remove, `shutdown()` before app exit.

## Instance Lifecycle

Located in `src/main/instance/`:

- **InstanceLifecycleManager** (`instance-lifecycle.ts`, ~89K) — full creation-to-cleanup lifecycle
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
