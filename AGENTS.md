# Claude Code Instructions for AI Orchestrator

## Project Overview

This is an Electron + Angular desktop application that orchestrates multiple AI CLI instances (Claude, Gemini, Codex, Copilot). It provides multi-agent coordination, verification, debate systems, session recovery, resource governance, and memory management.

## Tech Stack

- **Frontend**: Angular 21 (zoneless) with signals-based state management
- **Backend**: Electron 40 (Node.js) with TypeScript 5.9
- **CLI Integration**: Multi-provider adapters (Claude, Gemini, Codex, Copilot)
- **Database**: better-sqlite3 for RLM/persistence
- **Validation**: Zod 4 for IPC payload schemas
- **Build**: Angular CLI + Electron Builder
- **Testing**: Vitest

## Development Commands

```bash
# Development
npm run dev                  # Start Electron app in dev mode
npm run build               # Build for production

# Quality Checks (ALWAYS run after changes)
npx tsc --noEmit            # TypeScript compilation check
npx tsc --noEmit -p tsconfig.spec.json  # Spec files must also compile
npm run lint                # ESLint check (uses ng lint)
npm run test                # Run tests (uses vitest)
```

## Critical Rules

- **NEVER commit or push** unless the user explicitly asks you to
- **NEVER modify code on a server** — always make changes locally so we can deploy through the proper pipeline and code does not get out of sync

## Implementation Requirements

### After Making Code Changes

**ALWAYS verify your changes compile and lint correctly:**

1. Run `npx tsc --noEmit` - Must pass with no errors
2. Run `npx tsc --noEmit -p tsconfig.spec.json` - Spec/test files must also compile
3. Run `npm run lint` or `npx eslint <modified-files>` - Fix any errors introduced
4. If tests exist for modified code, run them

### Code Style

- Use `const` instead of `let` when variables aren't reassigned
- Use generic type arguments on constructors, not variable declarations:
  ```typescript
  // Good
  private cache = new Map<string, Entry>();

  // Bad
  private cache: Map<string, Entry> = new Map();
  ```
- Remove unused imports
- Don't use type annotations when types can be inferred from literals

## Architecture

For detailed architecture, domain map, and subsystem docs, read `docs/architecture.md`.

Key directories: `src/main/` (Electron/Node), `src/renderer/` (Angular), `src/shared/` (types), `src/preload/` (IPC bridge).

## Bigchange Implementation Process

When implementing features from `bigchange_*.md` files:

1. **Read the plan thoroughly** before starting
2. **Check existing code** - features may already be partially implemented
3. **Implement incrementally** - complete one phase at a time
4. **Verify each change**:
   - `npx tsc --noEmit` - TypeScript must pass
   - `npx tsc --noEmit -p tsconfig.spec.json` - Spec files must also compile
   - `npm run lint` - Fix any lint errors
5. **Audit integration** - Ensure new code is actually used:
   - Imports are added where needed
   - Singletons are initialized in `src/main/index.ts`
   - Event listeners are connected
   - IPC handlers are registered

## Common Patterns

- **Singletons**: Lazy `getInstance()` + `getXxx()` convenience getter + `_resetForTesting()`. See any existing service for the pattern.
- **Logging**: `const logger = getLogger('MyService');` — use `logger.info/warn/error`.
- **DI (main process)**: Access singletons via `getXxx()` helpers. Use constructor injection for parent-passed deps.
- **DI (Angular)**: Use `inject()` function. Stores are injectable signal-based services.
- **IPC**: Handlers in `src/main/ipc/`, exposed via `src/preload/preload.ts`. Validate payloads with Zod schemas from `src/shared/validation/ipc-schemas.ts`.
- **Angular components**: Standalone, `OnPush` change detection, signals for state.
- **Testing singletons**: Call `MyService._resetForTesting()` in `beforeEach`.
