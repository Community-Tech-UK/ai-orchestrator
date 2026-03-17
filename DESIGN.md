# AI Orchestrator - Design Document

## Overview

AI Orchestrator is a high-performance desktop environment for managing, monitoring, and coordinating multiple AI CLI instances (Claude, Gemini, Codex, Copilot). It bridges the gap between command-line power and graphical usability, scaling from individual agent interactions to orchestrated swarms of concurrent instances with hierarchical supervision, multi-agent debate/verification, and session recovery.

## Core Goals

1. **Multi-Provider CLI Integration** - Encapsulate Claude, Gemini, Codex, and Copilot CLIs within a unified GUI with automatic failover.
2. **Massive Scalability** - Support parallel execution of 10,000+ instances via hierarchical supervision, virtual scroll, and resource governance.
3. **Agent Coordination** - Enable instances to communicate, delegate tasks, and form complex supervisor hierarchies with debate, verification, and consensus systems.
4. **Rich Visual Telemetry** - Real-time status indicators, token usage metrics, streaming output, orchestration inspectors, and training dashboards.
5. **Session Resilience** - Automatic session tracking, checkpoint/snapshot management, and user-driven restore from conversation history.
6. **Cross-Platform Compatibility** - macOS native integration primary, with planned Windows and Linux support.

---

## Architecture

### Technology Stack

- **Electron 40** - Desktop application framework
- **Angular 21** - Zoneless frontend with signals-based reactivity
- **TypeScript 5.9** - Full-stack type safety with shared interfaces
- **better-sqlite3** - Persistence for RLM and memory systems
- **Zod 4** - Runtime validation for all IPC payloads
- **Multi-Provider CLIs** - Claude, Gemini, Codex, Copilot as spawned child processes

### Process Model

```
┌─────────────────────────────────────────────────────────────┐
│                      Main Process                           │
│                                                             │
│  ┌──────────┐ ┌──────────────┐ ┌───────────┐ ┌──────────┐  │
│  │ Window   │ │  Instance    │ │    IPC    │ │ Provider │  │
│  │ Manager  │ │  Manager     │ │  Handler  │ │ Registry │  │
│  └──────────┘ └──────┬───────┘ └───────────┘ └──────────┘  │
│                      │                                      │
│  ┌───────────────────┼───────────────────────┐              │
│  │    Orchestration   │   Process Mgmt       │              │
│  │  ┌──────────────┐  │  ┌────────────────┐  │              │
│  │  │ Debate       │  │  │ Supervisor     │  │              │
│  │  │ Verification │  │  │ Resource Gov.  │  │              │
│  │  │ Consensus    │  │  │ Hibernation    │  │              │
│  │  └──────────────┘  │  │ Pool / LB      │  │              │
│  └────────────────────┘  └────────────────┘  │              │
│                      │                                      │
│         ┌────────────┼────────────────┐                     │
│         ▼            ▼                ▼                     │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐              │
│  │ Claude CLI │ │ Gemini CLI │ │ Codex CLI  │              │
│  │ Adapter    │ │ Adapter    │ │ Adapter    │              │
│  └────────────┘ └────────────┘ └────────────┘              │
└─────────────────────────────────────────────────────────────┘
                          │
                    (IPC Bridge — 460+ channels)
                          │
┌─────────────────────────────────────────────────────────────┐
│                    Renderer Process                          │
│  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌────────────┐  │
│  │ Instance  │ │  Output   │ │   Input   │ │ Orchestr.  │  │
│  │  Store    │ │  Stream   │ │   Panel   │ │ Inspectors │  │
│  └───────────┘ └───────────┘ └───────────┘ └────────────┘  │
│                                                             │
│  48 feature modules • 39 IPC services • 12 state stores    │
└─────────────────────────────────────────────────────────────┘
```

### Hierarchical Supervisor Tree

Inspired by Erlang OTP, instances are organized in a supervision hierarchy:

```
                    ┌─────────────┐
                    │   Root      │
                    │ Supervisor  │
                    └──────┬──────┘
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
    │  Project A  │ │  Project B  │ │  Project C  │
    │ Supervisor  │ │ Supervisor  │ │ Supervisor  │
    └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
           │               │               │
     ┌─────┼─────┐   ┌─────┼─────┐   ┌─────┼─────┐
     ▼     ▼     ▼   ▼     ▼     ▼   ▼     ▼     ▼
   [Worker instances for each project]
```

Auto-expansion at 16 children per node. Three restart strategies: one-for-one, one-for-all, rest-for-one.

---

## Features

### Instance Management
- **Lifecycle Control**: Create, terminate, restart, fork, hibernate instances
- **Multi-Provider**: Claude, Gemini, Codex, Copilot with automatic failover and model discovery
- **Hierarchical**: Parent-child relationships with configurable termination policies (terminate-children, orphan-children, reparent-to-root)
- **Context Inheritance**: Children inherit working directory, environment, YOLO mode, agent settings
- **State Machine**: idle, busy, waiting, error, hibernated, initializing, waking states

### Visual Feedback
- **Status Indicators**: Color-coded states (idle/busy/waiting/error/hibernated)
- **Context Metrics**: Visual token usage bar with budget tracking
- **Output Streaming**: Low-latency rendering with incremental display item processing
- **Virtual Scroll**: CDK-based virtual scrolling for transcript with variable-height rows
- **Dark/Light Theme**: CSS variable token system with system preference detection

### Multi-Agent Coordination
- **Verification**: Spawns multiple agents to independently verify responses, uses embedding-based semantic clustering
- **Debate**: Multi-round debates with critique, defense, and synthesis rounds
- **Consensus**: Voting-based agreement mechanisms across agents
- **Parallel Worktrees**: Distributed execution across git worktrees
- **Orchestration Inspectors**: Full UI for monitoring debates, verifications, and training

### Session Recovery
- **Auto-Save**: Configurable interval session tracking (default 60s)
- **Snapshots**: Point-in-time session state capture (max 50, 30-day retention)
- **History Restore**: Two-phase restore — attempt native CLI `--resume`, fall back to message replay
- **Checkpoint System**: 14 error patterns with checkpoint create/restore
- **Session Repair**: Recovery mechanisms for corrupted sessions
- **Mutex Protection**: Per-instance async mutex for concurrent state safety

### Resource Governance
- **ResourceGovernor**: Listens to MemoryMonitor — pauses creation on warning, terminates idle on critical, requests GC
- **HibernationManager**: Auto-hibernation of idle instances with hysteresis cooldown and eviction scoring
- **PoolManager**: Warm instance pool with configurable size and stale eviction
- **LoadBalancer**: Weighted scoring (active tasks, context usage, memory pressure) for instance selection
- **CircuitBreaker**: Restart rate limiting and fault tolerance
- **Context Compaction**: Native + restart-based compaction strategies with JIT loading

### Input/Output
- **Interactive Console**: Text input with Enter to send, Shift+Enter newline
- **File Integration**: Drag & drop support for file context
- **Rich Media**: Clipboard image paste support
- **Structured Parsing**: Real-time NDJSON stream parsing
- **Markdown Cache**: LRU cache (200 entries, 50K max) for rendered markdown

### Persistence & Export
- **Session Export**: JSON and Markdown formats
- **Session Import**: Restore from exported JSON
- **Instance Forking**: Fork at specific message point
- **Output Storage**: Gzip-compressed disk persistence, 100-message chunks, 500MB limit
- **Templates**: Built-in orchestration templates (research team, code review, debate, verification)

### Additional Systems
- **Code Indexing**: Semantic search with embedding-based indexing
- **Memory System**: Episodic, procedural, semantic memory types with RLM database
- **Plugin System**: Extensible plugin framework
- **Workflow Automation**: Multi-step workflow execution
- **Hook System**: Pre/post execution hooks
- **Remote Access**: Remote observer server for external monitoring
- **Security**: Secret detection, path validation, redaction
- **MCP Integration**: Model Context Protocol support
- **Training Dashboard**: GRPO training visualization and analytics

### Native App Experience
- **macOS Integration**: Native traffic lights and window controls
- **Draggable Windows**: Native-feeling window management
- **Vibrancy Effects**: Platform-specific visual polish

---

## UI Components

### Sidebar (Left Panel)
```
┌─────────────────────────┐
│  AI Orchestrator        │
│  [+ New Instance]       │
├─────────────────────────┤
│  [Filter...] [Status ▼] │
├─────────────────────────┤
│  ● Instance 1      0%   │
│  ● Instance 2     45%   │
│  ○ Instance 3     12%   │  ← hibernated
│  ◉ Instance 4     78%   │
├─────────────────────────┤
│  4 instances   32% ctx  │
└─────────────────────────┘
```

### Detail View (Right Panel)
```
┌─────────────────────────────────────────────┐
│  ● Instance 1                               │
│  Session: abc-123  •  ~/projects/myapp      │
│  [Restart] [Terminate] [Fork] [+ Child]     │
├─────────────────────────────────────────────┤
│  ████████░░░░░░░░░░░░  45,000 / 200,000    │
├─────────────────────────────────────────────┤
│                                             │
│  YOU                              10:30:45  │
│  Help me refactor this function             │
│                                             │
│  CLAUDE                           10:30:48  │
│  I'll help you refactor that. Let me...     │
│                                             │
├─────────────────────────────────────────────┤
│  [Send a message...]                  [↑]   │
│  Press Enter to send, Shift+Enter new line  │
└─────────────────────────────────────────────┘
```

### Feature Modules (48 total)
agents, archive, cli-error, codebase, commands, communication, context, cost, dashboard, debate, editor, file-drop, file-explorer, history, hooks, instance-detail, instance-list, logs, lsp, mcp, memory, models, multi-edit, observations, plan, plugins, providers, remote-access, remote-config, replay, review, rlm, routing, security, semantic-search, settings, skills, snapshots, specialists, stats, supervision, tasks, thinking, training, vcs, verification, workflow, worktree

---

## Data Flow

### Creating an Instance

```
User clicks "New Instance"
        │
        ▼
┌─────────────────┐
│ Renderer:       │
│ store.create()  │
└────────┬────────┘
         │ IPC: instance:create
         ▼
┌─────────────────┐     ┌─────────────────┐
│ InstanceManager │────▶│ SessionContinuity│
│ .createInstance  │     │ .startTracking() │
└────────┬────────┘     └─────────────────┘
         │ spawn child process
         ▼
┌─────────────────┐
│ CLI Adapter     │  (Claude/Gemini/Codex/Copilot)
│ --print         │
│ --stream-json   │
└────────┬────────┘
         │ IPC: instance:created
         ▼
┌─────────────────┐
│ Renderer:       │
│ store updates   │
│ UI re-renders   │
└─────────────────┘
```

### Sending a Message

```
User types message, presses Enter
        │
        ▼
┌─────────────────┐
│ InputPanel:     │
│ emit(message)   │
└────────┬────────┘
         │ IPC: instance:send-input
         ▼
┌─────────────────┐
│ InstanceManager │
│ adapter.send()  │
└────────┬────────┘
         │ stdin (JSON)
         ▼
┌─────────────────┐
│ CLI Process     │
│ processes input │
└────────┬────────┘
         │ stdout (NDJSON stream)
         ▼
┌─────────────────┐
│ CLIAdapter:     │
│ parse & emit    │
└────────┬────────┘
         │ IPC: instance:output
         ▼
┌─────────────────┐
│ DisplayItem     │
│ Processor       │  (incremental append-only)
│ → virtual scroll│
└─────────────────┘
```

### Session Recovery

```
User clicks "Restore" in history sidebar
        │
        ▼
┌─────────────────┐
│ HISTORY_RESTORE │  IPC handler (two-phase)
└────────┬────────┘
         │
    Phase 1: Try native CLI --resume
         │
    ┌────┴────┐
    │ Success │────▶ Instance with full context
    │ Failure │
    └────┬────┘
         │
    Phase 2: Fresh instance + message replay
         │
    ┌────┴────────────┐
    │ FallbackHistory │  Token-budget-aware
    │ builder         │  message selection
    └────┬────────────┘
         │
         ▼
    New instance with replay messages + system note
```

---

## CLI Integration

### Command Format
```bash
claude \
  --print \
  --output-format stream-json \
  --input-format stream-json \
  --verbose \
  --session-id <uuid>
```

### Input Format (stdin)
```json
{"type":"user","message":{"role":"user","content":"Hello Claude"}}
```

### Output Format (stdout NDJSON)
```json
{"type":"system","subtype":"init","session_id":"...","tools":[...]}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hello!"}]}}
{"type":"result","subtype":"success","duration_ms":1234,"total_cost_usd":0.001}
```

---

## Configuration

### Default Limits
```typescript
const LIMITS = {
  MAX_CHILDREN_PER_NODE: 12,         // supervisor tree
  MAX_RESTARTS: 5,                   // circuit breaker
  RESTART_WINDOW_MS: 60000,          // 1 minute
  OUTPUT_BUFFER_MAX_SIZE: 2000,      // messages per instance
  OUTPUT_BATCH_INTERVAL_MS: 50,      // batching frequency
  DEFAULT_MAX_CONTEXT_TOKENS: 200000,
  IPC_TIMEOUT_MS: 30000,
  MAX_TOTAL_INSTANCES: 50,           // resource governor hard cap
  MAX_INSTANCE_MEMORY_MB: 512,       // resource governor soft cap
  IDLE_THRESHOLD_MS: 1800000,        // 30 min hibernation threshold
  POOL_MAX_SIZE: 5,                  // warm instance pool
  MARKDOWN_CACHE_SIZE: 200,          // LRU cache entries
  MAX_SNAPSHOTS: 50,                 // session snapshots
  SNAPSHOT_RETENTION_DAYS: 30,
};
```

---

## Error Handling

### Failure Modes
- **Launch Failure**: CLI fails to spawn — instance enters 'error' state with accessible stderr logs
- **Process Crash**: Unexpected termination triggers checkpoint save + error event
- **API Errors**: Rate limits or API failures rendered distinctly in output stream
- **Stuck Process**: Two-stage timeout detection (busy-too-long → force terminate)
- **Session Corruption**: Automatic session repair with mutex protection

### Recovery Strategies
- **Auto-Restart**: Supervisor tree with one-for-one, one-for-all, rest-for-one strategies
- **Circuit Breaker**: Rate-limited restarts to prevent thrashing
- **Session Continuity**: Auto-save + checkpoint restore
- **Resource Governor**: Memory pressure detection with automated response (pause creation, terminate idle, request GC)
- **Doom Loop Detection**: Detects and breaks infinite agent loops

---

## Security Considerations

### Isolation & Sandboxing
- **Process Isolation**: Each CLI instance runs in a dedicated child process
- **Context Bridge**: Renderer communicates via secure IPC only (460+ validated channels)
- **Preload Hardening**: Context isolation enabled, no direct Node.js access in UI
- **Zod Validation**: All IPC payloads validated with runtime schemas

### Access Control
- **Tokenized Communication**: Instances require explicit capabilities to interact
- **Path Validation**: Filesystem paths validated and scoped per instance
- **Secret Detection**: Automatic redaction of sensitive content
- **No Direct IO**: Renderer cannot access filesystem directly

---

## Development

### Project Structure
```
claude-orchestrator/
├── src/
│   ├── main/              # Electron Main Process — 37 domains, 325 files
│   ├── preload/           # Secure Context Bridge — 5,300 lines
│   ├── renderer/          # Angular 21 Frontend — 48 features, 262 files
│   └── shared/            # Types (47), Constants, Validation
├── docs/plans/            # Architecture docs and benchmarks
├── benchmarks/            # Performance benchmark harness
└── package.json
```

### Scripts
```bash
npm run dev        # Launch in Development Mode
npm run build      # Compile for Production
npm run build:main # Recompile Main Process only
npm run test       # Run tests (Vitest)
npm run lint       # ESLint check (ng lint)
npx tsc --noEmit   # TypeScript compilation check
```

---

Built with Claude Code by James.
