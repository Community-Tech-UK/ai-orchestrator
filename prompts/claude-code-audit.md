# Prompt: Claude Code Audit for Orchestrator Improvements

Copy everything below the line and paste as your opening message.

---

## Deep-Dive Audit: Learn from Claude Code to Improve AI Orchestrator

We have two codebases in `/Users/suas/work/orchestrat0r/`:

1. **Actual Claude Code** — `Actual Claude/` — the real Claude Code CLI source (TypeScript/React/Ink). Key files:
   - `src/main.tsx` (~803KB) — initialization, CLI routing, plugin system
   - `src/QueryEngine.ts` (~46KB) — message pipeline, tool execution, retries, coordinator mode
   - `src/Tool.ts` (~29KB) — tool interface, permission model, progress types
   - `src/Task.ts` (~3KB) — task types, state machine, ID generation
   - `src/tasks.ts` — task registry, feature-gated loading
   - Plus 56 subdirectories (commands, components, tools, services, state, hooks, types, etc.)

2. **Claude Orchestrator** — `claude-orchestrator/` — our Electron + Angular app managing multiple AI CLI instances. Key areas:
   - `src/main/orchestration/` — debate, consensus, verification, parallel worktree coordinators
   - `src/main/instance/` — instance lifecycle, communication, state machine
   - `src/main/process/` — supervisor tree, resource governor, circuit breaker, hibernation
   - `src/main/session/` — checkpoint manager, session continuity, recovery
   - `src/main/cli/` — multi-provider CLI adapters
   - `src/main/core/` — error recovery, failover, retry
   - `src/main/security/` — permissions, path validation, secret detection
   - `src/shared/types/` — shared type definitions

### What I Want

**Phase 1 — Research (no code changes)**

Explore both codebases in parallel. For each major subsystem in the Actual Claude code, compare it against the equivalent orchestrator subsystem. Look for:

- **Patterns the orchestrator is missing** — error handling, retry logic, permission models, state machines, concurrency control, streaming patterns, etc.
- **Bugs or fragility** in the orchestrator — race conditions, silent error suppression, missing validation, resource leaks
- **Architectural improvements** — better abstractions, separation of concerns, feature gating, lazy loading
- **Security gaps** — permission models, input validation, sandboxing patterns

Focus areas to compare (prioritize what's changed since the last audit):
- Tool execution pipeline & permission model
- Task/instance lifecycle & state machines
- Error classification & retry strategies
- Session persistence & recovery
- Concurrency control & resource management
- Streaming/progress reporting patterns
- Plugin/skill extensibility patterns

**Phase 2 — Prioritized Report**

Produce a prioritized list of improvements with:
- P0 (critical bugs), P1 (high-value), P2 (architectural), P3 (polish)
- For each item: the Claude Code pattern, the orchestrator gap, concrete fix with file paths
- Parallelization plan (which items can be done simultaneously)

**Phase 3 — Implementation**

After I approve the plan, implement all items:
- Run P0 items in parallel (different files, no conflicts)
- Then P1, P2, P3 in sequence
- Verify `npx tsc --noEmit` after each phase
- Use subagents for parallel independent work

### Previous Audit Results (for reference)

The last audit (2026-04-01) implemented these 10 improvements — skip anything already done unless it needs refinement:

1. Wired `ErrorRecoveryManager` into all 4 coordinators (debate, consensus, worktree, verify)
2. Fixed checkpoint manager race condition (async createCheckpoint, snapshot-before-checkpoint)
3. Fixed silent worktree cleanup failures (log + emit + continue merges)
4. Created shared `coordinator-error-handler.ts` utility
5. Added `generatePrefixedId()` / `generateInstanceId(provider)` for type-prefixed IDs
6. Added debate divergence detection + early termination
7. Created granular tool permission model (`tool-permission.types.ts` + `tool-permission-checker.ts`)
8. Added `streamDebate()` async generator to debate coordinator
9. Added lazy loading for coordinators with feature flags
10. Created typed `CoordinatorProgress` events + `ToolValidator` for input validation

### Constraints

- Read before writing. Investigate before guessing. Verify before claiming done.
- Don't modify code you haven't fully read.
- Match existing codebase patterns — singleton pattern, `getLogger()`, EventEmitter conventions.
- Run `npx tsc --noEmit` after every phase. Fix all errors before proceeding.
- Keep changes focused — no scope creep beyond what the audit identifies.
