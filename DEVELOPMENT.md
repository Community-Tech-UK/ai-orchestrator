# AI Orchestrator - Development Status

## Overview

A desktop application for managing multiple AI CLI instances (Claude, Gemini, Codex, Copilot) with hierarchical supervision, multi-agent coordination, session recovery, and a scalable UI.

## Current Status: Production-Ready Core

All foundational systems are implemented and wired into the app lifecycle.

### What's Built

```
src/
├── main/                              # Electron Main Process (37 domains, 325 files)
│   ├── index.ts                       # App entry point — initializes 18+ services
│   ├── window-manager.ts              # Window creation, IPC to renderer
│   ├── agents/                        # Agent management system
│   ├── api/                           # API handlers and routes
│   ├── browser-automation/            # Browser automation features
│   ├── cli/
│   │   ├── adapters/                  # CLI adapters (Claude, Codex, Gemini, Copilot)
│   │   └── ndjson-parser.ts           # NDJSON stream parsing
│   ├── commands/                      # Command execution system
│   ├── communication/                 # Cross-instance token-based messaging
│   ├── context/                       # Context compaction, JIT loading, window guards
│   ├── core/
│   │   ├── config/                    # Configuration management
│   │   └── system/                    # Health, stats, cost tracking
│   ├── history/                       # Conversation history tracking
│   ├── hooks/                         # Hook system (pre/post exec)
│   ├── indexing/                      # Code indexing and semantic search
│   ├── instance/                      # Instance lifecycle, communication, orchestration
│   │   ├── instance-lifecycle.ts      # Full lifecycle manager (~89K)
│   │   ├── instance-manager.ts        # Public API
│   │   ├── instance-communication.ts  # Inter-instance messaging
│   │   ├── instance-orchestration.ts  # Orchestration per instance
│   │   ├── instance-context.ts        # Context management per instance
│   │   ├── stuck-process-detector.ts  # Two-stage timeout detection
│   │   ├── warm-start-manager.ts      # Pre-spawned process pool
│   │   ├── instance-state-machine.ts  # State transition validation
│   │   └── session-diff-tracker.ts    # Conversation diff tracking
│   ├── ipc/                           # IPC handlers for all features
│   ├── learning/                      # ML/learning systems (GRPO, A/B testing)
│   ├── logging/                       # Structured logging with subsystem context
│   ├── mcp/                           # Model Context Protocol integration
│   ├── memory/                        # Memory system (episodic, procedural, semantic)
│   ├── observation/                   # Observation/telemetry pipeline
│   ├── orchestration/                 # Multi-agent coordination (27 files)
│   │   ├── multi-verify-coordinator.ts  # Verification with semantic clustering
│   │   ├── debate-coordinator.ts        # Multi-round debates
│   │   ├── consensus-coordinator.ts     # Agreement mechanisms
│   │   ├── orchestration-handler.ts     # Main orchestration logic
│   │   ├── parallel-worktree-coordinator.ts  # Distributed worktree execution
│   │   ├── embedding-service.ts         # Semantic embeddings
│   │   ├── voting.ts                    # Voting mechanisms
│   │   └── default-invokers.ts          # Wires LLM handlers to events
│   ├── persistence/                   # Data persistence (RLM database)
│   ├── plugins/                       # Plugin system
│   ├── process/                       # Process management
│   │   ├── supervisor-tree.ts         # Erlang OTP-style hierarchy
│   │   ├── supervisor-node.ts         # Individual supervision nodes
│   │   ├── circuit-breaker.ts         # Restart rate limiting
│   │   ├── resource-governor.ts       # Memory pressure response
│   │   ├── hibernation-manager.ts     # Idle instance hibernation
│   │   ├── pool-manager.ts            # Warm instance pool
│   │   └── load-balancer.ts           # Weighted instance selection
│   ├── providers/                     # Provider system
│   │   ├── provider-registry.ts       # Provider registration
│   │   ├── failover-manager.ts        # Automatic failover
│   │   ├── model-discovery.ts         # Available model detection
│   │   ├── anthropic-api-provider.ts  # Direct Anthropic API
│   │   ├── claude-cli-provider.ts     # Claude CLI wrapper
│   │   ├── codex-cli-provider.ts      # Codex CLI wrapper
│   │   └── gemini-cli-provider.ts     # Gemini CLI wrapper
│   ├── remote/                        # Remote observer server
│   ├── repo-jobs/                     # Repository job management
│   ├── rlm/                           # Reinforcement Learning from Memory
│   ├── routing/                       # Message routing
│   ├── security/                      # Secret detection, path validation, redaction
│   ├── session/                       # Session recovery system
│   │   ├── session-continuity.ts      # Auto-save, snapshots, resume (~37K)
│   │   ├── checkpoint-manager.ts      # Error recovery checkpoints
│   │   ├── fallback-history.ts        # Token-budget fallback for resume failures
│   │   ├── session-repair.ts          # Corrupted session recovery
│   │   ├── session-mutex.ts           # Per-instance concurrency protection
│   │   ├── session-archive.ts         # Session archival
│   │   ├── snapshot-index.ts          # Fast snapshot lookups
│   │   └── replay-continuity.ts       # Replay/resume logic
│   ├── skills/                        # Extensible skills framework
│   │   └── builtin/                   # Built-in orchestrator skills
│   ├── tasks/                         # Background tasks, todo management
│   ├── testing/                       # Test utilities
│   ├── tools/                         # External tools integration
│   ├── util/                          # Utilities
│   ├── vcs/                           # Version control integration
│   ├── workflows/                     # Workflow automation
│   └── workspace/                     # Worktree management
│
├── renderer/                          # Angular 21 Application (Zoneless)
│   ├── app/                           # 262 source files
│   │   ├── app.component.ts           # Root component
│   │   ├── app.config.ts              # Zoneless change detection
│   │   ├── core/
│   │   │   ├── state/                 # Signal-based stores (12 stores)
│   │   │   │   ├── instance/          # Instance state (list, output, messaging)
│   │   │   │   ├── verification/      # Verification state
│   │   │   │   ├── history.store.ts   # History state
│   │   │   │   ├── agent.store.ts     # Agent state
│   │   │   │   ├── cli.store.ts       # CLI state
│   │   │   │   ├── command.store.ts   # Command state
│   │   │   │   ├── hook.store.ts      # Hook state
│   │   │   │   ├── settings.store.ts  # Settings state
│   │   │   │   ├── skill.store.ts     # Skill state
│   │   │   │   └── todo.store.ts      # Todo state
│   │   │   └── services/
│   │   │       └── ipc/               # 39 feature-specific IPC services
│   │   └── features/                  # 48 feature modules
│   │       ├── agents/                # Agent management UI
│   │       ├── archive/               # Archive management
│   │       ├── cli-error/             # CLI error display
│   │       ├── codebase/              # Codebase browser
│   │       ├── commands/              # Command palette
│   │       ├── communication/         # Cross-instance communication UI
│   │       ├── context/               # Context management (compaction indicator)
│   │       ├── cost/                  # Cost tracking
│   │       ├── dashboard/             # Main layout (sidebar, header, footer)
│   │       ├── debate/                # Debate visualization (11 files)
│   │       ├── editor/                # Editor integration
│   │       ├── file-drop/             # File drop zone
│   │       ├── file-explorer/         # File browser
│   │       ├── history/               # History sidebar with restore
│   │       ├── hooks/                 # Hooks configuration
│   │       ├── instance-detail/       # Instance view (output stream, input panel)
│   │       ├── instance-list/         # Virtual scroll instance list
│   │       ├── logs/                  # Log viewer
│   │       ├── lsp/                   # LSP integration
│   │       ├── mcp/                   # MCP management
│   │       ├── memory/                # Memory browser, stats
│   │       ├── models/                # Model configuration
│   │       ├── multi-edit/            # Multi-file editing
│   │       ├── observations/          # Observation dashboard
│   │       ├── plan/                  # Plan management
│   │       ├── plugins/               # Plugin management
│   │       ├── providers/             # Provider management, model selector
│   │       ├── remote-access/         # Remote access UI
│   │       ├── remote-config/         # Remote configuration
│   │       ├── replay/                # Session replay
│   │       ├── review/                # Code review
│   │       ├── rlm/                   # RLM analytics, A/B testing UI
│   │       ├── routing/               # Routing management
│   │       ├── security/              # Security settings
│   │       ├── semantic-search/       # Semantic search UI
│   │       ├── settings/              # Settings panels
│   │       ├── skills/                # Skills browser
│   │       ├── snapshots/             # Snapshot management
│   │       ├── specialists/           # Specialist agents
│   │       ├── stats/                 # Statistics dashboard
│   │       ├── supervision/           # Supervision tree UI
│   │       ├── tasks/                 # Task management
│   │       ├── thinking/              # Thinking visualization
│   │       ├── training/              # Training dashboard (GRPO)
│   │       ├── vcs/                   # Version control UI
│   │       ├── verification/          # Multi-agent verification (28 files)
│   │       ├── workflow/              # Workflow management
│   │       └── worktree/              # Worktree management
│   └── styles.scss                    # Design token system (dark + light themes)
│
├── shared/                            # Shared types and utils
│   ├── types/                         # 47 TypeScript interface files
│   ├── constants/                     # System constants and limits
│   ├── utils/                         # ID generation, token counting, etc.
│   └── validation/                    # Zod IPC schemas
│
└── preload/
    └── preload.ts                     # Context bridge (~5,300 lines, 460+ IPC channels)
```

### Key Features Implemented

| Feature | Status | Notes |
|---------|--------|-------|
| Electron + Angular setup | Done | Zoneless Angular 21 |
| Multi-provider CLI adapters | Done | Claude, Gemini, Codex, Copilot |
| Provider failover & discovery | Done | Automatic failover, model detection |
| Instance Manager | Done | Create, terminate, restart, fork, hibernate |
| Signal-based state stores | Done | 12 stores, 50ms batched updates |
| Virtual scroll list | Done | Angular CDK, ready for 10k+ |
| Transcript virtual scroll | Done | CDK with variable-height strategy |
| Incremental display items | Done | Append-only processing, LRU markdown cache |
| Status color indicators | Done | Idle/busy/waiting/error/hibernated |
| Context usage bar | Done | Visual token usage |
| Output stream display | Done | Auto-scroll, message grouping, thought groups |
| Input panel | Done | Enter to send, Shift+Enter newline |
| File drag & drop | Done | Drop zone component |
| Image paste | Done | Clipboard image support |
| Dark/light theme | Done | CSS variable token system, system preference |
| macOS title bar | Done | Traffic light positioning |
| Supervisor tree | Done | Erlang OTP-inspired, auto-expand at 16 |
| Circuit breaker | Done | Restart rate limiting |
| Resource governor | Done | Memory pressure response, instance cap |
| Hibernation manager | Done | Idle detection, eviction scoring |
| Instance pool | Done | Warm pool with stale eviction |
| Load balancer | Done | Weighted scoring across instances |
| Cross-instance communication | Done | Token-based messaging |
| Multi-agent verification | Done | Semantic clustering, caching |
| Debate system | Done | Multi-round with synthesis |
| Consensus system | Done | Voting-based agreement |
| Session continuity | Done | Auto-save, snapshots, mutex protection |
| Session recovery | Done | Two-phase restore, fallback history |
| Checkpoint system | Done | 14 error patterns, transaction logging |
| Session repair | Done | Corrupted session recovery |
| History restore | Done | User-driven from history sidebar |
| Skills system | Done | Progressive loading, 5 built-in skills |
| Code indexing & search | Done | Semantic search with embeddings |
| Memory system | Done | Episodic, procedural, semantic types |
| Context compaction | Done | Native + restart strategies, JIT loading |
| Stuck process detection | Done | Two-stage timeout detection |
| Doom loop detection | Done | Agent loop breaking |
| Remote access | Done | Remote observer server |
| Plugin system | Done | Extensible plugin framework |
| Workflow automation | Done | Multi-step workflows |
| Training dashboard | Done | GRPO visualization, A/B testing |
| Orchestration inspectors | Done | Debate, verification, consensus UIs |

---

## Running the App

### Prerequisites
- Node.js 20+
- npm 10+
- At least one CLI installed: `claude`, `gemini`, `codex`, or `copilot`

### Commands

```bash
# Install dependencies
npm install

# Development (builds main, starts Angular + Electron)
npm run dev

# Build main process only (useful for quick testing)
npm run build:main

# Build everything for production
npm run build

# Package for macOS (unsigned)
npm run build && npm run electron:build -- --mac --config.mac.identity=null

# Run tests
npm run test

# Run linting
npm run lint

# TypeScript compilation check
npx tsc --noEmit
npx tsc --noEmit -p tsconfig.spec.json  # spec files too
```

### Troubleshooting

**"Cannot find module dist/main/index.js"**
- Run `npm run build:main` first, then `npm run dev`

**Port conflicts**
- Dev server uses port 4567 by default (configured in package.json start script)

**Native module errors (better-sqlite3)**
- Run `npm rebuild` when switching between Electron and system Node

---

## Architecture Decisions

### Why Zoneless Angular?
- Better performance for high-frequency updates
- Explicit change detection via signals
- No Zone.js overhead

### Why Signals over NgRx?
- Simpler for this use case
- Native Angular feature
- Less boilerplate
- Perfect for computed/derived state

### Why 50ms Batching?
- Balances responsiveness vs CPU usage
- 20 updates/second is smooth enough
- Prevents UI thrashing from rapid CLI output

### Why Hierarchical Supervision?
- Erlang/OTP proven pattern
- Scales to 10,000+ with 2-3 tree levels
- Natural fault isolation
- Easy to implement restart strategies

### Why Multi-Provider?
- Different models excel at different tasks
- Failover for reliability
- Cost optimization by routing to appropriate models
- User choice and flexibility

### Why User-Driven Session Restore?
- Auto-restoring CLI instances on startup would spawn processes unprompted
- Stale context burns tokens unnecessarily
- User picks which sessions matter from history sidebar
- Infrastructure supports both patterns if needed

---

## Contact

Built with Claude Code by James.
