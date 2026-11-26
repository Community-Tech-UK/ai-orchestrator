# AI Orchestrator: Cross-Project Improvement Recommendations

Based on a review of the surrounding peer projects (`opencode`, `t3code`, `openclaw`), here is a list of architectural, tooling, and feature improvements that can be applied to `ai-orchestrator`.

## 1. Monorepo and Tooling Modernization

*   **Current State:** `ai-orchestrator` uses `npm` workspaces with simple `concurrently` scripts for local development and standard ESLint/Prettier for formatting.
*   **Improvement:** Migrate to **Bun** or **pnpm** combined with **Turborepo** (`turbo.json`).
    *   Both `opencode` and `t3code` heavily leverage `bun` and `turbo` for lightning-fast, cached monorepo task execution.
    *   `openclaw` successfully uses `pnpm` workspaces.
    *   Replace `eslint` and `prettier` with **Oxlint** (`.oxlintrc.json`) and **Oxfmt** for orders-of-magnitude faster linting and formatting, aligning with the standards set by `opencode`, `t3code`, and `openclaw`.

## 2. Abstraction of AI Providers (Multi-Provider Support)

*   **Current State:** The architecture relies on a "Claude CLI adapter layer" (`src/main/cli/`), which tightly couples the orchestrator to Claude.
*   **Improvement:** Implement a generalized Provider or Plugin SDK interface.
    *   **Reference `t3code`:** It features a robust `providerManager.ts` that abstracts Codex, Claude, and OpenCode, allowing the GUI to remain agnostic of the underlying CLI agent.
    *   **Reference `openclaw`:** It utilizes a strict core-vs-plugin boundary with a `plugin-sdk` (`src/plugin-sdk/*`), ensuring the core orchestrator loop is provider/channel agnostic. `ai-orchestrator` should adopt a similar `AgentProvider` interface so that OpenCode, Codex, or arbitrary custom CLI agents can be seamlessly swapped or coordinated alongside Claude.

## 3. Adoption of Functional TypeScript Patterns (`effect`)

*   **Current State:** Uses standard TypeScript with Node.js APIs and manual error handling boundaries.
*   **Improvement:** Introduce **Effect-TS** (`effect`) for complex backend orchestration.
    *   Both `opencode` and `t3code` use the `@effect/*` ecosystem (`@effect/platform-node`, `@effect/schema`, `@effect/opentelemetry`).
    *   Given `ai-orchestrator` manages "Hierarchical Supervision - Erlang OTP-inspired supervisor trees", using `effect` would provide robust primitives for concurrency, retries, interruption, and context propagation that map perfectly to OTP concepts.

## 4. UI/UX Expansion (CLI & Web Alternatives)

*   **Current State:** A desktop application built with Electron and Angular.
*   **Improvement:** Decouple the orchestration engine to support alternative UIs.
    *   **Terminal UI:** `opencode` uses `@opentui/*` and `ink` to provide a rich terminal experience. An orchestration CLI monitor could be highly valuable for users running headless swarms.
    *   **Web/Remote Mode:** Similar to `t3code` (React web app served via a local Node.js WebSocket server), `ai-orchestrator` could separate its core into a local daemon that serves a web UI, reducing the heavy Electron footprint for users who prefer working directly in the browser or terminal.

## 5. Standardized IPC & Contract Schemas

*   **Current State:** IPC verification relies on custom scripts (`scripts/verify-ipc-channels.js`).
*   **Improvement:** Use a shared schema library for strict end-to-end type safety between the UI, main process, and worker agents.
    *   **Reference `t3code`:** Maintains a `packages/contracts` workspace specifically for Zod/Effect schemas and TypeScript contracts (WebSocket protocols, event shapes). `ai-orchestrator` could formalize its IPC payloads in a standalone `packages/contracts` workspace to guarantee strict boundaries.

## 6. Zero-Configuration Runtime Isolation

*   **Current State:** Configuration and runtime state are likely tied to local directories or explicit static configs.
*   **Improvement:** Adopt a hash-based session and worktree isolation model.
    *   **Reference `agent-orchestrator`:** It uses a minimal configuration file (`agent-orchestrator.yaml`) to auto-derive project hashes and unique session names (e.g., `~/.agent-orchestrator/{hash}-{projectId}`). This decouples versioned repo data from runtime metadata, making session handling completely automatic, stateless, and conflict-free across checkouts.

## 7. Robust Persistence with SQLite

*   **Current State:** Uses simple file-based storage or JSON logs for session/context metadata.
*   **Improvement:** Transition to a robust local database like `better-sqlite3` running in WAL mode.
    *   **Reference `CodePilot`:** Leverages `better-sqlite3` with structured tables (sessions, tasks, media generations, bridge integrations). This provides ACID transactional integrity, complex querying, and much higher performance for long-running agents compared to basic JSON files.

## 8. Provider Diagnostics & Self-Healing

*   **Current State:** Basic retry mechanisms or error logging for AI APIs.
*   **Improvement:** Implement a centralized "Provider Doctor" for diagnostics and automated recovery.
    *   **Reference `CodePilot`:** Uses an `error-classifier.ts` and `provider-doctor.ts` to actively probe AI providers, classify structured errors, and attempt self-healing actions (e.g., auth refresh, fallbacks) automatically.

## 9. IM/Chat Integration (Bridge Subsystem)

*   **Current State:** Operates solely through its native desktop UI/CLI.
*   **Improvement:** Build a "Bridge" subsystem to allow remote messaging control.
    *   **Reference `CodePilot`:** Features a plugin-based bridge system for Telegram and Feishu (`src/lib/bridge/`). `ai-orchestrator` could implement similar adapters, allowing users to monitor headless orchestrator swarms, issue commands, and receive alerts directly via Slack, Discord, or Telegram.

## 10. Long-Term Project Memory Continuity

*   **Current State:** Context is kept mostly in ongoing conversation buffers or ephemeral sessions.
*   **Improvement:** Persist long-term "lessons" and "handovers" physically inside the repository context.
    *   **Reference `storybloq`:** Maintains a `.story/` folder that tracks project memory, tickets, and lessons learned. Adopting this means new instances of `ai-orchestrator` automatically pick up where previous sessions or other agents left off, massively enhancing multi-agent collaboration.

## 11. Advanced Browser Automation

*   **Current State:** Lacks native, stealthy deep-web interaction tools.
*   **Improvement:** Equip agents with dedicated, stealth-capable browser environments for web interaction.
    *   **Reference `hermes-agent`:** Integrates `@askjo/camofox-browser` and `agent-browser` to execute complex web traversal and tool-calling with high anti-bot bypass success. This is crucial for agents requiring intense web-research or the ability to log into complex web apps.