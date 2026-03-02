# Architectural Remediation Design

**Date:** 2026-03-02
**Scope:** Full codebase remediation across 5 workstreams
**Assessment:** 5 blockers, 13 major issues, 15 minor issues across 565 TypeScript files

## Context

A thorough 6-agent architectural review identified systemic issues in the Claude Orchestrator:

- **Orchestration:** Debate system is non-functional (no LLM invokers registered), verification merge strategy hangs, semantic clustering unused
- **IPC:** Security boundary undermined by generic escape hatches, 78% of handlers unvalidated, no path sandboxing
- **Error handling:** Comprehensive frameworks built but not wired in, 179 console calls bypass structured logging, 89 silent catch blocks
- **Main process:** 83+ singletons with 3 inconsistent patterns, no explicit init sequence, extreme coupling via service locator
- **Testing:** ~31 test files for 565 source files, zero tests for InstanceManager, CLI adapters, IPC handlers, supervisor tree, security

## Approach

Hybrid severity-within-subsystem-groups. Five workstreams ordered by blocker/major density. Each workstream is a clean checkpoint.

---

## WS1: Orchestration — Fix Non-Functional Features

**Issues addressed:** B1, B2, M7, m1, m3, m13, m14

### Changes

1. **Register debate LLM invokers** in `src/main/orchestration/default-invokers.ts`
   - Mirror the existing `registerDefaultMultiVerifyInvoker()` pattern
   - Register handlers for all 4 debate events: `debate:generate-response`, `debate:generate-critiques`, `debate:generate-defense`, `debate:generate-synthesis`
   - Each handler creates an ephemeral CLI adapter, sends the prompt, returns the response via callback

2. **Refactor `merge` synthesis strategy** in `multi-verify-coordinator.ts`
   - Replace the event-based `verification:synthesize` callback pattern with direct CLI adapter invocation
   - This eliminates the hanging Promise and is consistent with how ConsensusCoordinator works

3. **Wire semantic clustering into verification pipeline**
   - In `analyzeResponses()`, replace `clusterKeyPoints()` call with `clusterResponsesSemantically()` (fix typo too)
   - Make configurable: add `useSemanticClustering: boolean` to verification config, default `true`

4. **Wire embedding cache**
   - Call `addToCache()` in `getSimpleEmbeddings()` after computing
   - Call `getFromCache()` before computing to check for cached result

5. **Parallelize debate initial responses**
   - Change `for...of` with `await` in `runInitialRound` to `Promise.all()`
   - Same for `runCritiqueRound` and `runDefenseRound`

6. **Centralize token counting**
   - Create `src/shared/utils/token-counter.ts` with `countTokens(text: string): number`
   - Wrapper around `LLMService.countTokens()` with fallback to `Math.ceil(length / 4)` when LLM service unavailable
   - Replace all inline `length / 4` estimates across orchestration files

---

## WS2: IPC Security & Validation Hardening

**Issues addressed:** B3, B4, M8, M9, m4, m5, m6, m15

### Changes

1. **Remove generic `invoke`/`on`/`once` from preload**
   - Delete the 3 generic methods (lines ~4168-4190 of preload.ts)
   - Add typed wrappers for the ~100 channels currently only reachable via generic invoke
   - Group new methods by subsystem (matching the handler file organization)

2. **Create `validatedHandler()` utility**
   - New file: `src/main/ipc/validated-handler.ts`
   - Wraps `ipcMain.handle` with automatic Zod validation and standardized error envelope
   - ```typescript
     function validatedHandler<T>(schema: z.ZodSchema<T>, fn: (validated: T) => Promise<IpcResponse>)
     ```

3. **Apply Zod validation to all 25 remaining handler files**
   - Use the `validatedHandler()` wrapper for each endpoint
   - Add schemas to `ipc-schemas.ts` for any missing payload types
   - Priority order: security-handlers, file-handlers (most dangerous), then remaining

4. **Add path sandboxing for file operations**
   - New file: `src/main/security/path-validator.ts`
   - Validates paths against allowed directories (project working dir, user data path, temp)
   - Applied to: `FILE_READ_DIR`, `FILE_READ_TEXT`, `FILE_WRITE_TEXT`, `FILE_OPEN_PATH`, VCS handlers
   - Blocks path traversal (resolve + startsWith check)

5. **Deduplicate IPC channel definitions**
   - Single source of truth: `src/shared/types/ipc.types.ts`
   - Build script generates preload-compatible constants file
   - Preload imports generated file instead of maintaining duplicate

6. **Move hard-coded channel strings to IPC_CHANNELS**
   - Replace ~12 string literals in `webContents.send()` calls
   - Add missing channel constants for: plugins, watcher, cost, user-action, rlm events

7. **Extend auth token to sensitive handlers**
   - File operations, security operations, plugin management
   - Either wire up rate limiting or remove the dead `enforceRateLimit()` code

---

## WS3: Error Handling & Logging

**Issues addressed:** B5, M4, M5, M6, m7, m8

### Changes

1. **Wire ErrorRecoveryManager as IPC middleware**
   - Simplify the tiered degradation model (FULL/CORE/BASIC/MINIMAL is overkill for local app)
   - Keep: error classification, retry with backoff, structured error responses
   - Remove: tier-based feature gating, recovery plans, checkpoints
   - Apply as middleware in the `validatedHandler()` utility from WS2
   - Consolidate `CliErrorManager` patterns into `ErrorRecoveryManager`

2. **Migrate 179 `console.*` calls to structured logger**
   - Mechanical bulk change across ~40 files
   - Add `getLogger('subsystem')` import where missing
   - Map: `console.log` → `logger.info`, `console.warn` → `logger.warn`, `console.error` → `logger.error`

3. **Audit and fix 89 empty `catch {}` blocks**
   - Add `logger.warn('description', error)` to all
   - For failure recovery paths in supervisor-node.ts: log + emit metric, don't rethrow
   - For truly ignorable cases (shutdown cleanup): add explicit comment explaining why

4. **Fix ContextualLogger**
   - Change `SubsystemLogger` fields from `private` to `protected`
   - Remove `(this as any)` casts in `ContextualLogger`

5. **Switch to async log writes**
   - Replace `fs.appendFileSync` with `fs.promises.appendFile`
   - Add write queue to prevent interleaving

---

## WS4: Main Process Architecture

**Issues addressed:** M1, M2, M3, M10, M12, M13, m9, m10, m11, m12

### Changes

1. **Standardize singleton pattern**
   - Choose Style A (static class, private constructor) as the standard
   - Add `_resetForTesting()` to all singletons that lack it
   - Remove dead `getInstanceManager()` module-level accessor
   - Use `Type | null = null` consistently for the static field

2. **Create explicit startup manifest**
   - New method in `AIOrchestratorApp`: `private async initializeServices()`
   - Named steps with error boundaries and logging
   - Replace side-effect-only `getObserverAgent()` / `getReflectorAgent()` calls with explicit init
   - Log each step's success/failure for debuggability

3. **Extend dependency injection interface pattern**
   - Start with `InstanceLifecycleManager` (worst offender, 9 deps)
   - Create `LifecycleDependencies` interface, inject via constructor
   - Apply same pattern to `InstanceOrchestrationManager` and `InstanceContextManager`

4. **Fix SupervisorTree bugs**
   - Add visited-set cycle detection in `getTreeStats()` parentId traversal
   - Make `reset()` and `destroy()` async, properly await `shutdown()`

5. **Deprecate IPC facade**
   - Add `@deprecated` JSDoc to `IpcFacadeService`
   - Migrate stores that import `ElectronIpcService` alias to domain-specific services
   - This is incremental — no need to do all at once

6. **Consolidate dual skill caches**
   - `SkillLoader` becomes the single cache owner
   - `SkillRegistry` delegates to `SkillLoader` for cached lookups

7. **Fix renderer coupling issues**
   - Replace `document.querySelector()` with `viewChild()` in InputPanel and InstanceDetail
   - Fix `SettingsStore` to use `SettingsIpcService`
   - Fix `ProviderStateService` to read from `SettingsStore` instead of duplicate IPC call

---

## WS5: Test Coverage

**Issues addressed:** M11

### Test files to create

| Target | Test File | Key Scenarios |
|--------|-----------|---------------|
| InstanceManager | `instance/instance-manager.spec.ts` | create, terminate, state transitions, event forwarding |
| ClaudeCliAdapter | `cli/adapters/claude-cli-adapter.spec.ts` | spawn, message, terminate, NDJSON parse, error handling |
| Instance IPC handlers | `ipc/handlers/instance-handlers.spec.ts` | CRUD operations, validation, error responses |
| File IPC handlers | `ipc/handlers/file-handlers.spec.ts` | read, write, path validation, sandboxing |
| SupervisorTree | `process/supervisor-tree.spec.ts` | add/remove, restart strategies, cycle detection, health |
| ErrorRecoveryManager | `core/error-recovery.spec.ts` | classification, retry, structured responses |
| DebateCoordinator | `orchestration/debate-coordinator.spec.ts` | round flow, parallel execution, consensus |
| MultiVerifyCoordinator | `orchestration/multi-verify-coordinator.spec.ts` | agent spawning, semantic clustering, analysis |

### Test patterns
- Mock all singletons via `_resetForTesting()` in beforeEach
- Mock Claude CLI via `vi.mock()` for adapter tests
- Mock `ipcMain.handle` for IPC handler tests
- Use dependency injection interfaces for unit isolation

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Wire ErrorRecovery as IPC middleware | All user-facing errors surface at IPC boundary |
| Style A singletons everywhere | Private constructor prevents accidental `new` |
| Keep ConsensusManager and VotingSystem separate | Different abstraction levels, consolidation is high-risk low-reward |
| Build-step for preload channels | Simpler and more auditable than bundler config |
| Refactor merge strategy, not add synthesize handler | Direct invocation is cleaner than event-callback for synthesis |
| Simplify tiered degradation | FULL/CORE/BASIC/MINIMAL is overkill for local Electron app |

## Verification

After each workstream:
- `npx tsc --noEmit` — must pass
- `npx tsc --noEmit -p tsconfig.spec.json` — spec files must compile
- `npm run lint` — no new lint errors
- `npm test` — existing tests must pass, new tests must pass
