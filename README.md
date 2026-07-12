# Harness

A high-performance desktop application for managing, monitoring, and coordinating multiple AI CLI instances. Built with Electron and Angular, it scales from individual agent interactions to orchestrated swarms of thousands of concurrent instances.

## Features

- **Multi-Instance Management** - Create, monitor, and coordinate multiple AI CLI instances
- **Hierarchical Supervision** - Erlang OTP-inspired supervisor trees with configurable restart strategies
- **Multi-Agent Verification** - Spawn multiple agents to verify responses with semantic clustering
- **Debate System** - Multi-round debates between agents with critique, defense, and consensus synthesis
- **Real-Time Telemetry** - Token usage metrics, context visualization, and streaming output
- **Skills System** - Progressive skill loading with built-in orchestrator skills

## Tech Stack

- **Frontend**: Angular 21 with signals-based state management
- **Backend**: Electron (Node.js) with TypeScript
- **CLI Integration**: Multi-provider CLI adapters for spawning AI instances
- **Build**: Angular CLI + Electron Builder
- **Testing**: Vitest

## Prerequisites

- Node.js 22+
- npm 10+
- At least one supported AI CLI installed and configured, such as Claude, Codex, Gemini/Antigravity, Copilot, or Cursor

## Installation

```bash
npm install
```

## Development

```bash
# Start the app in development mode
npm run dev

# Build for production
npm run build

# Package for macOS (local ad-hoc signed)
npm run build && npm run electron:build -- --mac --config.mac.identity=null

# Run tests
npm run test

# Run linting
npm run lint

# TypeScript compilation check
npx tsc --noEmit
```

## Project Structure

```
ai-orchestrator/
├── src/
│   ├── main/           # Electron main process (Node.js)
│   │   ├── cli/        # Multi-provider CLI adapter layer
│   │   ├── instance/   # Instance state management
│   │   ├── ipc/        # IPC event handlers
│   │   ├── orchestration/ # Multi-agent coordination
│   │   ├── security/   # Sandbox and permission management
│   │   └── skills/     # Skills system
│   ├── preload/        # Secure context bridge
│   ├── renderer/       # Angular frontend
│   │   └── app/
│   │       ├── core/   # Services, stores, models
│   │       └── features/ # Feature modules
│   └── shared/         # Shared interfaces & types
├── docs/               # Documentation and plans
└── benchmarks/         # Performance benchmarks
```

## Documentation

- [CLAUDE.md](./CLAUDE.md) - Development conventions and architecture notes
- [DESIGN.md](./docs/DESIGN.md) - Detailed design document and roadmap
- [DEVELOPMENT.md](./docs/DEVELOPMENT.md) - Development guide
- [aio-mcp CLI](./docs/AIO_MCP_CLI.md) - Human guide for the bundled Harness CLI and repair commands
- [aio-mcp LLM reference](./docs/llm/AIO_MCP_CLI_REFERENCE.md) - Compact command reference for spawned agents

## License

MIT
