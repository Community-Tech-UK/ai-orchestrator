# Architectural Remediation Implementation Plan

> **Reconciled 2026-09-23 (outstanding-plans sweep, [plan](2026-09-23-outstanding-plans-sweep_plan_completed.md)): COMPLETE.** Verified task by task
> against the executing code. WS1 (debate invokers, merge synthesis, semantic clustering, parallel
> debate rounds, token counting), WS2 Tasks 7–10 and 13, WS3 (ErrorRecoveryManager, ContextualLogger,
> console migration — only benchmark/logger-internal/entry uses remain and ESLint enforces
> `no-console` — and empty catches), WS4 Tasks 22–26 and WS5 tests were already done. Finished in
> this sweep: Task 11 (Zod validation for the remaining payload handlers: auxiliary-LLM, debug,
> cost, mobile-gateway revoke, circuit breaker, LSP feedback, state resync, `cli:check`,
> `cli:scan-all-installs`), Task 12 (literal channel strings replaced in the CLI-verification
> handler and event forwarding and the cost budget channels; 7 missing constants added), Task 14
> step 2 (file and security handlers answer only the main window via `createTrustedIpcRegistrar`),
> Task 21 (the last 17 `private static instance: Foo;` declarations are now `Foo | null = null` with
> plain resets), and a unit spec for `path-validator.ts`, which also fixed a symlink escape
> (`validatePath` now checks the real path). Task 26's `IpcFacadeService` deprecation is
> incremental by this plan's own terms (24 files still use it, marked `@deprecated`).

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 5 blockers, 13 major issues, and 15 minor issues identified in the architectural review, organized into 5 workstreams.

**Architecture:** Phased remediation grouped by subsystem. Each workstream produces a clean, verifiable checkpoint. Changes are additive — no workstream depends on another being complete first, though WS2 Task 2 (`validatedHandler`) is used by WS3 Task 1.

**Tech Stack:** TypeScript 5.9, Angular 21, Electron 40, Vitest, Zod 4.3

**Verification after every workstream:**
```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json && npm run lint && npm test
```

---

## WS1: Orchestration — Fix Non-Functional Features

### Task 1: Register Debate LLM Invokers

**Files:**
- Modify: `src/main/orchestration/default-invokers.ts` (124 lines)

**Step 1: Read the existing invoker pattern**

Study `registerDefaultMultiVerifyInvoker()` (lines 25-74). The debate invokers follow the same pattern: listen for event, create CLI adapter, send prompt, return via callback.

**Step 2: Add `registerDefaultDebateInvoker()`**

After line 123 in `default-invokers.ts`, add a new export function that registers handlers for all 4 debate events. The handler pattern is identical to the verification invoker — create adapter, send message, call callback with response.

The 4 events to handle:
- `debate:generate-response` — payload: `{ debateId, agentId, prompt, systemPrompt?, model?, callback }`
- `debate:generate-critiques` — payload: `{ debateId, agentId, prompt, systemPrompt?, model?, callback }`
- `debate:generate-defense` — payload: `{ debateId, agentId, prompt, systemPrompt?, model?, callback }`
- `debate:generate-synthesis` — payload: `{ debateId, agentId, prompt, systemPrompt?, model?, callback }`

Each handler should:
1. Check callback exists
2. Resolve CLI type from settings
3. Create adapter via `createCliAdapter()`
4. Build spawn options with model, systemPrompt, timeout
5. Call `adapter.sendMessage()` with the prompt
6. Call `callback(null, response.content, response.usage?.totalTokens || 0, 0)`
7. Terminate adapter in finally block

Use a shared helper `createDebateEventHandler(eventName)` to avoid duplicating the same handler 4 times.

**Step 3: Wire into initialization**

Modify `src/main/index.ts` line ~53. After `registerDefaultMultiVerifyInvoker(this.instanceManager)`, add:
```typescript
registerDefaultDebateInvoker(this.instanceManager);
```

Import the new function at the top of index.ts.

**Step 4: Run tests**

```bash
npx tsc --noEmit
npm test -- --grep "debate"
```

**Step 5: Commit**

```bash
git add src/main/orchestration/default-invokers.ts src/main/index.ts
git commit -m "feat: register default debate LLM invokers for all 4 debate events"
```

---

### Task 2: Refactor Merge Synthesis Strategy

**Files:**
- Modify: `src/main/orchestration/multi-verify-coordinator.ts` (lines 846-902)

**Step 1: Replace event-based synthesis with direct CLI invocation**

The `synthesizeMerge()` method (lines 846-902) currently emits `verification:synthesize` and waits for a callback that never comes. Refactor it to directly create a CLI adapter and send the synthesis prompt, matching how `ConsensusCoordinator` works.

Replace lines 890-901 (the event emit + Promise) with:
1. Import `createCliAdapter` from the adapter factory
2. Create an ephemeral adapter with the synthesis prompt
3. Send the prompt via `adapter.sendMessage()`
4. Extract response text and return it
5. Terminate adapter in finally block

Keep the prompt construction (lines 851-887) unchanged — it's well-designed.

**Step 2: Remove the now-unused `verification:synthesize` event references**

Search for any other references to `verification:synthesize` and remove them. Check `default-invokers.ts` to ensure no handler was partially added.

**Step 3: Verify and commit**

```bash
npx tsc --noEmit
git add src/main/orchestration/multi-verify-coordinator.ts
git commit -m "fix: refactor merge synthesis to direct CLI invocation, fixing hang"
```

---

### Task 3: Wire Semantic Clustering into Verification

**Files:**
- Modify: `src/main/orchestration/multi-verify-coordinator.ts`
- Modify: `src/main/orchestration/embedding-service.ts`

**Step 1: Fix the typo**

Rename `clusterResponsesSemanticaly` to `clusterResponsesSemantically` in multi-verify-coordinator.ts (method definition around line 619) and all call sites.

**Step 2: Wire embedding cache in EmbeddingService**

In `embedding-service.ts`, modify `getSimpleEmbeddings()` (lines 179-185):
- Before computing, check `getFromCache()` for each text
- After computing, call `addToCache()` for each result
- This is straightforward — the cache methods already exist at lines 684-714

**Step 3: Replace bag-of-words with semantic clustering in `analyzeResponses()`**

In `multi-verify-coordinator.ts`, modify `analyzeResponses()` at line 539. Replace:
```typescript
const clusters = this.clusterKeyPoints(validResponses);
```
with a call to `clusterResponsesSemantically()` when configured, falling back to `clusterKeyPoints()`:
```typescript
const clusters = config.useSemanticClustering !== false
  ? await this.clusterResponsesSemantically(validResponses)
  : this.clusterKeyPoints(validResponses);
```

Adapt the downstream code to work with `ResponseCluster[]` from semantic clustering. The cluster format differs from the Map returned by `clusterKeyPoints()`, so add a conversion function.

**Step 4: Verify and commit**

```bash
npx tsc --noEmit
git add src/main/orchestration/multi-verify-coordinator.ts src/main/orchestration/embedding-service.ts
git commit -m "feat: wire semantic clustering and embedding cache into verification"
```

---

### Task 4: Parallelize Debate Rounds

**Files:**
- Modify: `src/main/orchestration/debate-coordinator.ts`

**Step 1: Parallelize `runInitialRound()`**

Lines 173-177 run agents sequentially with `for...of` + `await`. Change to:
```typescript
const responses = await Promise.all(
  debate.agents.map(async (agent) => {
    const temp = this.getAgentTemperature(agent, 'initial');
    return this.generateInitialResponse(debate, agent, temp);
  })
);
```

**Step 2: Parallelize `runCritiqueRound()` and `runDefenseRound()`**

Apply the same `Promise.all()` transformation to critique generation (lines 200-201) and defense generation (lines 235-239).

**Step 3: Verify and commit**

```bash
npx tsc --noEmit
git add src/main/orchestration/debate-coordinator.ts
git commit -m "perf: parallelize debate rounds with Promise.all()"
```

---

### Task 5: Centralize Token Counting

**Files:**
- Create: `src/shared/utils/token-counter.ts`
- Modify: `src/main/orchestration/debate-coordinator.ts`
- Modify: `src/main/orchestration/embedding-service.ts`
- Modify: `src/main/orchestration/multi-verify-coordinator.ts`

**Step 1: Create shared token counter utility**

```typescript
/**
 * Estimate token count for text content.
 * Uses character-based approximation (4 chars per token).
 * For accurate counting, use LLMService.countTokens() directly.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
```

Keep it simple — the `LLMService.countTokens()` is a singleton with heavy deps. The shared utility provides the estimate with a clear name that communicates it's an approximation.

**Step 2: Replace inline `Math.ceil(content.length / 4)` across orchestration files**

Search for `length / 4` in orchestration files and replace with `estimateTokens()`. Import from `@shared/utils/token-counter`.

**Step 3: Verify and commit**

```bash
npx tsc --noEmit
git add src/shared/utils/token-counter.ts src/main/orchestration/
git commit -m "refactor: centralize token estimation in shared utility"
```

---

### Task 6: WS1 Checkpoint

```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json && npm run lint && npm test
```

Commit any remaining fixes needed to pass all checks.

---

## WS2: IPC Security & Validation Hardening

### Task 7: Create `validatedHandler()` Utility

**Files:**
- Create: `src/main/ipc/validated-handler.ts`

**Step 1: Write the utility**

```typescript
import { z } from 'zod';
import { IpcMainInvokeEvent } from 'electron';
import { getLogger } from '../logging/logger';

const logger = getLogger('IPC');

export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; timestamp: number };
}

/**
 * Creates a validated IPC handler that:
 * 1. Validates payload against Zod schema
 * 2. Wraps execution in try/catch with structured errors
 * 3. Logs validation failures
 */
export function validatedHandler<TInput, TOutput = unknown>(
  channel: string,
  schema: z.ZodSchema<TInput>,
  fn: (validated: TInput, event: IpcMainInvokeEvent) => Promise<IpcResponse<TOutput>>
): (event: IpcMainInvokeEvent, payload: unknown) => Promise<IpcResponse<TOutput>> {
  return async (event: IpcMainInvokeEvent, payload: unknown) => {
    try {
      const result = schema.safeParse(payload);
      if (!result.success) {
        const errors = result.error.issues
          .map((e) => `${e.path.join('.')}: ${e.message}`)
          .join('; ');
        logger.warn(`IPC validation failed for ${channel}`, { errors });
        return {
          success: false,
          error: { code: 'VALIDATION_FAILED', message: `Validation failed for ${channel}: ${errors}`, timestamp: Date.now() }
        };
      }
      return await fn(result.data, event);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`IPC handler error for ${channel}`, error instanceof Error ? error : undefined);
      return {
        success: false,
        error: { code: `${channel}_FAILED`, message, timestamp: Date.now() }
      };
    }
  };
}
```

**Step 2: Verify compilation**

```bash
npx tsc --noEmit
```

**Step 3: Commit**

```bash
git add src/main/ipc/validated-handler.ts
git commit -m "feat: add validatedHandler utility for DRY IPC validation"
```

---

### Task 8: Create Path Validator

**Files:**
- Create: `src/main/security/path-validator.ts`

**Step 1: Write path sandboxing utility**

```typescript
import * as path from 'path';
import { app } from 'electron';

const ALLOWED_ROOTS: string[] = [];

export function initializePathValidator(): void {
  ALLOWED_ROOTS.push(
    app.getPath('userData'),
    app.getPath('temp'),
    process.cwd()
  );
}

export function addAllowedRoot(dir: string): void {
  const resolved = path.resolve(dir);
  if (!ALLOWED_ROOTS.includes(resolved)) {
    ALLOWED_ROOTS.push(resolved);
  }
}

export function validatePath(filePath: string): { valid: boolean; resolved: string; error?: string } {
  const resolved = path.resolve(filePath);

  // Block null bytes (path traversal attack)
  if (filePath.includes('\0')) {
    return { valid: false, resolved, error: 'Path contains null byte' };
  }

  // Check against allowed roots
  const isAllowed = ALLOWED_ROOTS.some(root => resolved.startsWith(root + path.sep) || resolved === root);
  if (!isAllowed && ALLOWED_ROOTS.length > 0) {
    return { valid: false, resolved, error: `Path outside allowed directories: ${resolved}` };
  }

  return { valid: true, resolved };
}
```

The path validator should also be called when instances set a working directory (via `addAllowedRoot`), so project directories are automatically allowed.

**Step 2: Verify and commit**

```bash
npx tsc --noEmit
git add src/main/security/path-validator.ts
git commit -m "feat: add path sandboxing validator for file operations"
```

---

### Task 9: Apply Validation to Security Handlers

**Files:**
- Modify: `src/main/ipc/handlers/security-handlers.ts` (390 lines)
- Modify: `src/shared/validation/ipc-schemas.ts`

**Step 1: Add missing Zod schemas for security payloads**

In `ipc-schemas.ts`, add schemas for:
- `SecurityDetectSecretsPayloadSchema` — `{ content: z.string().max(500_000), contentType?: z.enum(['env', 'text']) }`
- `SecurityRedactContentPayloadSchema` — same structure plus options
- Any other security handler payloads

**Step 2: Apply `validatedHandler()` to each endpoint in security-handlers.ts**

Replace the inline type annotations with `validatedHandler()` calls. For each `ipcMain.handle()`, wrap the handler function.

**Step 3: Verify and commit**

```bash
npx tsc --noEmit
git add src/main/ipc/handlers/security-handlers.ts src/shared/validation/ipc-schemas.ts
git commit -m "fix: add Zod validation to security IPC handlers"
```

---

### Task 10: Apply Validation to File/App Handlers

**Files:**
- Modify: `src/main/ipc/handlers/app-handlers.ts`
- Modify: `src/shared/validation/ipc-schemas.ts`

**Step 1: Add schemas for file operations**

- `FileReadTextPayloadSchema` — `{ path: z.string().min(1).max(4096), maxBytes?: z.number().int().min(1).max(5_242_880) }`
- `FileWriteTextPayloadSchema` — `{ path: z.string().min(1).max(4096), content: z.string().max(50_000_000), createDirs?: z.boolean() }`

**Step 2: Apply `validatedHandler()` AND path validation**

For `FILE_READ_TEXT` and `FILE_WRITE_TEXT`, after Zod validation, call `validatePath()` on the path and reject if invalid.

**Step 3: Apply validation to remaining app handler endpoints**

Go through all `ipcMain.handle()` calls in app-handlers.ts and add schema validation.

**Step 4: Verify and commit**

```bash
npx tsc --noEmit
git add src/main/ipc/handlers/app-handlers.ts src/shared/validation/ipc-schemas.ts
git commit -m "fix: add Zod validation and path sandboxing to file operation handlers"
```

---

### Task 11: Apply Validation to All Remaining Handler Files

**Files:**
- Modify: All remaining unvalidated handler files in `src/main/ipc/handlers/`
- Modify: Additional handler files in `src/main/ipc/` (verification, learning, training, etc.)
- Modify: `src/shared/validation/ipc-schemas.ts` as needed

This is a mechanical task. For each handler file:

1. Identify all `ipcMain.handle()` registrations
2. Check if a Zod schema exists in `ipc-schemas.ts` — if not, create one
3. Wrap the handler with `validatedHandler()` or add `validateIpcPayload()` call
4. Apply path validation where file paths are accepted

Handler files to process (in priority order):
1. `provider-handlers.ts` — includes PLUGINS_INSTALL (code loading)
2. `session-handlers.ts` — includes file import/export paths
3. `command-handlers.ts` — already partially validated, complete it
4. `stats-handlers.ts`
5. `cost-handlers.ts`
6. `debug-handlers.ts`
7. `search-handlers.ts`
8. `supervision-handlers.ts`
9. `recent-directories-handlers.ts`
10. `mcp-handlers.ts`
11. `lsp-handlers.ts`
12. `codebase-handlers.ts` — already partially validated, complete it
13. `src/main/ipc/ipc-main-handler.ts` — USER_ACTION_REQUEST handler
14. `src/main/ipc/verification-ipc-handler.ts`
15. `src/main/ipc/learning-ipc-handler.ts`
16. `src/main/ipc/training-ipc-handler.ts`
17. `src/main/ipc/orchestration-ipc-handler.ts`
18. `src/main/ipc/specialist-ipc-handler.ts`
19. `src/main/ipc/memory-ipc-handler.ts` — partially done, complete it
20. `src/main/ipc/observation-ipc-handler.ts`
21. `src/main/ipc/llm-ipc-handler.ts`
22. `src/main/ipc/cli-verification-ipc-handler.ts`

**Commit after every 3-4 files:**

```bash
git commit -m "fix: add Zod validation to [handler-group] IPC handlers"
```

---

### Task 12: Move Hard-Coded Channel Strings to IPC_CHANNELS

**Files:**
- Modify: `src/shared/types/ipc.types.ts`
- Modify: `src/main/ipc/handlers/provider-handlers.ts`
- Modify: `src/main/ipc/handlers/file-handlers.ts`
- Modify: `src/main/ipc/ipc-main-handler.ts`
- Modify: `src/main/ipc/cost-handlers.ts` (if it has hard-coded strings)

**Step 1: Search for all hard-coded channel strings**

```bash
grep -rn "webContents\.send(" src/main/ | grep -v "IPC_CHANNELS"
```

**Step 2: Add missing constants to IPC_CHANNELS in `ipc.types.ts`**

Known missing:
- `PLUGINS_LOADED`, `PLUGINS_UNLOADED`, `PLUGINS_ERROR`
- `WATCHER_ERROR`
- `COST_USAGE_RECORDED`
- `USER_ACTION_REQUEST` (the dynamic `user-action-request` string)
- `RLM_STORE_UPDATED`, `RLM_SECTION_ADDED`, `RLM_SECTION_REMOVED`, `RLM_QUERY_COMPLETE`

**Step 3: Replace string literals with constants**

**Step 4: Verify and commit**

```bash
npx tsc --noEmit
git commit -m "refactor: replace hard-coded IPC channel strings with constants"
```

---

### Task 13: Remove Generic invoke/on/once from Preload

**Files:**
- Modify: `src/preload/preload.ts`

**Step 1: Identify channels currently only reachable via generic invoke**

Compare `IPC_CHANNELS` in `ipc.types.ts` against the typed methods in preload.ts. Any channel with no typed wrapper needs one.

**Step 2: Add typed wrappers for missing channels**

Group by subsystem (matching the handler organization). Each wrapper follows the existing pattern:
```typescript
channelName: (payload) => ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_NAME, payload),
```

**Step 3: Remove the generic `invoke`, `on`, `once` methods**

Delete lines 4164-4190 (the generic escape hatch).

**Step 4: Update renderer's ElectronIpcService**

The `ElectronIpcService` in `src/renderer/app/core/services/ipc/electron-ipc.service.ts` uses the generic `invoke` (lines 95-106). Migrate those calls to use the new typed methods.

**Step 5: Verify and commit**

```bash
npx tsc --noEmit
git commit -m "security: remove generic IPC escape hatch, add typed wrappers for all channels"
```

---

### Task 14: Clean Up Rate Limiting and Auth

**Files:**
- Modify: `src/main/ipc/ipc-main-handler.ts`

**Step 1: Either wire rate limiting or remove dead code**

Decision: Remove `enforceRateLimit()` and `ipcRateLimits` — it's dead code that creates false confidence. If rate limiting is needed later, add it as middleware in `validatedHandler()`.

**Step 2: Extend `ensureAuthorized()` to file and security handlers**

Pass the `ensureAuthorized` function to `registerFileHandlers()` and `registerSecurityHandlers()`, then call it at the start of sensitive handlers.

**Step 3: Fix the `user-action-response` handler**

Replace `ipcMain.on` (line 354) with `ipcMain.handle`. Use IPC_CHANNELS constant. Add payload validation.

**Step 4: Verify and commit**

```bash
npx tsc --noEmit
git commit -m "fix: remove dead rate limiting, extend auth to sensitive handlers"
```

---

### Task 15: WS2 Checkpoint

```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json && npm run lint && npm test
```

---

## WS3: Error Handling & Logging

### Task 16: Simplify and Wire ErrorRecoveryManager

**Files:**
- Modify: `src/main/core/error-recovery.ts`
- Remove or consolidate: `src/main/cli/cli-error-handler.ts`

**Step 1: Simplify ErrorRecoveryManager**

Remove the tiered degradation system (DegradationTier, TIER_FEATURES, `degrade()`, `upgrade()`, `isFeatureAvailable()`). Keep:
- Error classification (`classifyError()`)
- Retry logic with exponential backoff
- Structured error responses
- Consecutive failure tracking

**Step 2: Consolidate CLI error patterns**

Move the CLI-specific error patterns from `CliErrorManager` (NOT_INSTALLED, CONTEXT_OVERFLOW, etc.) into `ErrorRecoveryManager`'s classification system. The goal is one unified error classification.

**Step 3: Add a `withRetry()` helper**

Export a `withRetry(fn, options)` from error-recovery.ts that wraps any async function with configurable retry + backoff. This can be used in IPC handlers and orchestration code.

**Step 4: Verify and commit**

```bash
npx tsc --noEmit
git commit -m "refactor: simplify ErrorRecoveryManager, consolidate CLI error patterns"
```

---

### Task 17: Fix ContextualLogger

**Files:**
- Modify: `src/main/logging/logger.ts`

**Step 1: Change SubsystemLogger fields from private to protected**

The `manager` and `subsystem` constructor parameters on SubsystemLogger (around line 74) need to be `protected` instead of `private`, so `ContextualLogger` can access them without `(this as any)` casts.

**Step 2: Remove `(this as any)` casts in ContextualLogger**

Lines 118, 122, 126, 130, 134 — change `(this as any).manager` to `this.manager` and `(this as any).subsystem` to `this.subsystem`.

**Step 3: Switch to async log file writes**

In the `writeToFile` method (line 304), replace `fs.appendFileSync` with `fs.promises.appendFile`. Add a write queue (simple promise chain) to prevent interleaving:

```typescript
private writeQueue = Promise.resolve();

private writeToFile(entry: LogEntry): void {
  this.writeQueue = this.writeQueue.then(async () => {
    try {
      await fs.promises.appendFile(this.logFilePath, JSON.stringify(entry) + '\n');
    } catch (err) {
      console.error('Failed to write log:', err);
    }
  });
}
```

**Step 4: Verify and commit**

```bash
npx tsc --noEmit
git commit -m "fix: remove unsafe casts in ContextualLogger, switch to async log writes"
```

---

### Task 18: Migrate console.* Calls to Structured Logger

**Files:**
- Modify: ~40+ files in `src/main/` (see top-10 list below)

This is a mechanical bulk change. Priority files (by console call count):

| File | console calls |
|------|--------------|
| `src/main/instance/instance-communication.ts` | 43 |
| `src/main/ipc/cli-verification-ipc-handler.ts` | 19 |
| `src/main/instance/instance-context.ts` | 19 |
| `src/main/rlm/summarization-worker.ts` | 15 |
| `src/main/rlm/episodic-rlm-store.ts` | 14 |
| `src/main/rlm/context/context-storage.ts` | 13 |
| `src/main/process/supervisor-tree.ts` | ~10 |
| `src/main/process/supervisor-node.ts` | ~8 |
| `src/main/process/circuit-breaker.ts` | ~6 |
| `src/main/index.ts` | ~5 |

**For each file:**
1. Add `import { getLogger } from '../logging/logger';` (adjust path)
2. Add `const logger = getLogger('SubsystemName');` at module level
3. Replace `console.log(...)` → `logger.info(...)`
4. Replace `console.warn(...)` → `logger.warn(...)`
5. Replace `console.error(...)` → `logger.error(...)`
6. Convert string concatenation to structured data: `console.log('foo:', bar)` → `logger.info('foo', { bar })`

**Skip:** Load test files (`src/main/indexing/__tests__/load/`) — console output is expected in benchmarks.

**Commit after every 5 files:**

```bash
git commit -m "refactor: migrate console calls to structured logger in [area]"
```

---

### Task 19: Audit and Fix Empty Catch Blocks

**Files:**
- Modify: ~30 files with empty `catch {}` blocks

**Step 1: Search for all empty catches**

```bash
grep -rn "catch {" src/main/ --include="*.ts" | grep -v node_modules | grep -v ".spec."
```

**Step 2: For each empty catch, apply one of 3 fixes:**

1. **Log the error** (default): `catch (error) { logger.warn('description', error instanceof Error ? error : undefined); }`
2. **Explicit ignore comment** (shutdown cleanup): `catch { /* intentionally ignored: shutdown cleanup */ }`
3. **Rethrow** (when the error matters): `catch (error) { logger.error('critical failure', error instanceof Error ? error : undefined); throw error; }`

**Priority targets:**
- `src/main/process/supervisor-node.ts` (8 empty catches in restart/shutdown paths)
- `src/main/process/supervisor-tree.ts`
- `src/main/instance/` files
- `src/main/rlm/` files

**Step 3: Verify and commit**

```bash
npx tsc --noEmit
git commit -m "fix: add logging to empty catch blocks across main process"
```

---

### Task 20: WS3 Checkpoint

```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json && npm run lint && npm test
```

---

## WS4: Main Process Architecture

### Task 21: Standardize Singleton Pattern

**Files:**
- Modify: All singleton classes in `src/main/`

**Step 1: Define the standard pattern**

Every singleton must follow Style A:
```typescript
export class MyService {
  private static instance: MyService | null = null;

  static getInstance(): MyService {
    if (!this.instance) {
      this.instance = new MyService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private constructor() { /* ... */ }
}

export function getMyService(): MyService {
  return MyService.getInstance();
}
```

**Step 2: Remove dead `getInstanceManager()` accessor**

In `src/main/instance/instance-manager.ts`, remove the module-level singleton at lines 42-43 and the `getInstanceManager()` function at lines 966-971. The `InstanceManager` is created via `new` in `index.ts` and passed to consumers — it's not a lazy singleton.

**Step 3: Add `_resetForTesting()` to singletons that lack it**

Search for all `static getInstance()` patterns and ensure each class has `_resetForTesting()`. Update `src/main/testing/singleton-reset.ts` to include all resettable singletons.

**Step 4: Use `Type | null = null` consistently**

Replace any `private static instance: Foo;` (uninitialized) with `private static instance: Foo | null = null;`.

**Commit in batches by directory:**

```bash
git commit -m "refactor: standardize singleton pattern in [directory]"
```

---

### Task 22: Create Explicit Startup Manifest

**Files:**
- Modify: `src/main/index.ts`

**Step 1: Replace implicit initialization with named steps**

Rewrite the `initialize()` method (lines 31-64) as:

```typescript
async initialize(): Promise<void> {
  const logger = getLogger('App');

  const steps: Array<{ name: string; fn: () => Promise<void> | void }> = [
    { name: 'IPC handlers', fn: () => this.ipcHandler.registerHandlers() },
    { name: 'Hook approvals', fn: () => getHookManager().loadApprovals() },
    { name: 'Event forwarding', fn: () => this.setupInstanceEventForwarding() },
    { name: 'Verification invokers', fn: () => registerDefaultMultiVerifyInvoker(this.instanceManager) },
    { name: 'Review invokers', fn: () => registerDefaultReviewInvoker(this.instanceManager) },
    { name: 'Debate invokers', fn: () => registerDefaultDebateInvoker(this.instanceManager) },
    { name: 'Plugin manager', fn: () => getOrchestratorPluginManager().initialize(this.instanceManager) },
    { name: 'Observation ingestor', fn: () => getObservationIngestor().initialize(this.instanceManager) },
    { name: 'Observer agent', fn: () => { getObserverAgent().initialize(); } },
    { name: 'Reflector agent', fn: () => { getReflectorAgent().initialize(); } },
    { name: 'Path validator', fn: () => initializePathValidator() },
  ];

  for (const step of steps) {
    try {
      logger.info(`Initializing: ${step.name}`);
      await step.fn();
      logger.info(`Initialized: ${step.name}`);
    } catch (error) {
      logger.error(`Failed to initialize: ${step.name}`, error instanceof Error ? error : undefined);
      // Non-critical services: log and continue. Critical: rethrow.
      if (['IPC handlers', 'Event forwarding'].includes(step.name)) {
        throw error;
      }
    }
  }

  await this.windowManager.createMainWindow();
}
```

**Step 2: Remove debug console.log lines**

Remove the debug console.log spam in `setupInstanceEventForwarding()` (lines 90-95).

**Step 3: Verify and commit**

```bash
npx tsc --noEmit
git commit -m "refactor: create explicit startup manifest with named init steps"
```

---

### Task 23: Fix SupervisorTree Bugs

**Files:**
- Modify: `src/main/process/supervisor-tree.ts`

**Step 1: Add cycle detection to `getTreeStats()`**

Add a `visited` Set to the parentId chain traversal (lines 466-477):

```typescript
const visited = new Set<string>();
let current = reg;
while (current.parentId) {
  if (visited.has(current.parentId)) break; // cycle detected
  visited.add(current.parentId);
  depth++;
  const parent = this.instances.get(current.parentId);
  if (!parent) break;
  current = parent;
}
```

**Step 2: Make `reset()` and `destroy()` async**

```typescript
async reset(): Promise<void> {
  await this.shutdown();
  this.config = { ...DEFAULT_TREE_CONFIG };
}

async destroy(): Promise<void> {
  await this.shutdown();
  this.removeAllListeners();
}
```

Update all call sites that invoke `reset()` or `destroy()` to `await` them.

**Step 3: Verify and commit**

```bash
npx tsc --noEmit
git commit -m "fix: add cycle detection to SupervisorTree, make reset/destroy async"
```

---

### Task 24: Consolidate Skill Caches

**Files:**
- Modify: `src/main/skills/skill-registry.ts`
- Modify: `src/main/skills/skill-loader.ts`

**Step 1: Make SkillLoader the single cache owner**

SkillLoader already has LRU eviction and token tracking. SkillRegistry should delegate to SkillLoader for cache operations instead of maintaining its own `loadedSkills` Map.

In `skill-registry.ts`:
- Replace `this.loadedSkills.get(name)` with `this.loader.getLoadedSkill(name)`
- Replace `this.loadedSkills.set(name, skill)` with the loader's cache
- Remove the `private loadedSkills` Map
- Inject or access `SkillLoader` via singleton

**Step 2: Verify and commit**

```bash
npx tsc --noEmit
git commit -m "refactor: consolidate dual skill caches into SkillLoader"
```

---

### Task 25: Fix Renderer Coupling Issues

**Files:**
- Modify: `src/renderer/app/features/instance-detail/instance-detail.component.ts`
- Modify: `src/renderer/app/features/instance-detail/input-panel.component.ts`
- Modify: `src/renderer/app/core/state/settings.store.ts`
- Modify: `src/renderer/app/core/services/provider-state.service.ts`

**Step 1: Replace document.querySelector with viewChild()**

In `instance-detail.component.ts` (line 576):
```typescript
// Add to class
private nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');

// Replace querySelector
this.nameInput()?.nativeElement.focus();
```

In `input-panel.component.ts` (lines 928, 960):
```typescript
// Add to class
private messageInput = viewChild<ElementRef<HTMLTextAreaElement>>('messageInput');

// Replace querySelector
const textarea = this.messageInput()?.nativeElement;
if (textarea) { textarea.style.height = 'auto'; }
```

Add `#nameInput` and `#messageInput` template references to the respective templates.

**Step 2: Fix SettingsStore to use SettingsIpcService**

In `settings.store.ts`, replace the `getApi()` bypass (lines 19-20) with:
```typescript
private settingsIpc = inject(SettingsIpcService);
```

Update all `getApi().settingsXxx()` calls to use `this.settingsIpc.xxx()`.

**Step 3: Fix ProviderStateService to use SettingsStore**

In `provider-state.service.ts`, inject `SettingsStore` instead of making a duplicate `getSettings()` IPC call:
```typescript
private settingsStore = inject(SettingsStore);
```

Read provider/model from the store's signal instead of loading independently.

**Step 4: Verify and commit**

```bash
npx tsc --noEmit
git commit -m "refactor: fix renderer coupling issues (viewChild, settings DI)"
```

---

### Task 26: Deprecate IPC Facade

**Files:**
- Modify: `src/renderer/app/core/services/ipc/index.ts`

**Step 1: Add @deprecated annotations**

Add JSDoc `@deprecated Use domain-specific IPC service instead` to:
- The `IpcFacadeService` class
- The `ElectronIpcService` alias export

**Step 2: Identify and migrate top consumers**

Search for `ElectronIpcService` imports in the renderer. For each, replace with the appropriate domain-specific IPC service (e.g., `InstanceIpcService`, `SettingsIpcService`).

This is incremental — don't need to migrate all 200+ usages at once. Target stores first (they have the most concentrated IPC usage).

**Step 3: Commit**

```bash
git commit -m "refactor: deprecate IpcFacadeService, begin migration to domain services"
```

---

### Task 27: WS4 Checkpoint

```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json && npm run lint && npm test
```

---

## WS5: Test Coverage

### Task 28: Test Infrastructure Setup

**Files:**
- Modify: `src/main/testing/singleton-reset.ts`

**Step 1: Update `resetAllSingletonsForTesting()` to cover all singletons**

After WS4 Task 21 standardizes singletons, this function should reset all of them. Group by subsystem:

```typescript
export function resetAllSingletonsForTesting(): void {
  // Process
  SupervisorTree._resetForTesting();
  // Orchestration
  EmbeddingService._resetForTesting();
  DebateCoordinator._resetForTesting();
  MultiVerifyCoordinator._resetForTesting();
  ConsensusCoordinator._resetForTesting();
  // Memory
  RLMContextManager._resetForTesting();
  UnifiedMemoryController._resetForTesting();
  // ... all others added in WS4 Task 21
}
```

**Step 2: Commit**

```bash
git commit -m "test: update singleton reset to cover all services"
```

---

### Task 29: InstanceManager Tests

**Files:**
- Create: `src/main/instance/__tests__/instance-manager.spec.ts`

**Key test scenarios:**

```typescript
describe('InstanceManager', () => {
  describe('createInstance', () => {
    it('creates instance with valid config');
    it('assigns unique ID');
    it('emits instance:created event');
    it('registers with supervisor tree');
  });

  describe('terminateInstance', () => {
    it('terminates running instance');
    it('cleans up adapter');
    it('emits instance:removed event');
    it('handles already-terminated instance gracefully');
  });

  describe('sendMessage', () => {
    it('forwards message to adapter');
    it('queues message if instance is busy');
    it('rejects message for non-existent instance');
  });

  describe('event forwarding', () => {
    it('forwards instance:output events');
    it('forwards instance:state-update events');
    it('batches rapid updates');
  });
});
```

Mock: Claude CLI adapter (spawn/terminate/send), SettingsManager, SupervisorTree, HookManager.

---

### Task 30: CLI Adapter Tests

**Files:**
- Create: `src/main/cli/adapters/__tests__/claude-cli-adapter.spec.ts`

**Key test scenarios:**

```typescript
describe('ClaudeCliAdapter', () => {
  describe('spawn', () => {
    it('spawns child process with correct args');
    it('sets up NDJSON stream parser');
    it('configures environment (removes CLAUDECODE)');
    it('handles spawn failure gracefully');
  });

  describe('sendMessage', () => {
    it('sends message and receives response');
    it('handles streaming output');
    it('respects timeout');
  });

  describe('terminate', () => {
    it('sends SIGTERM then SIGKILL after timeout');
    it('cleans up event listeners');
    it('handles already-terminated process');
  });

  describe('NDJSON parsing', () => {
    it('parses complete NDJSON lines');
    it('handles split lines across chunks');
    it('handles malformed JSON gracefully');
  });
});
```

Mock: `child_process.spawn` with EventEmitter-based fake process.

---

### Task 31: SupervisorTree Tests

**Files:**
- Create: `src/main/process/__tests__/supervisor-tree.spec.ts`

**Key test scenarios:**

```typescript
describe('SupervisorTree', () => {
  describe('registerInstance', () => {
    it('adds instance to tree');
    it('tracks parent-child relationships');
    it('auto-expands when capacity reached');
  });

  describe('getTreeStats', () => {
    it('calculates correct depth');
    it('handles circular parentId references (cycle detection)');
    it('counts root instances correctly');
  });

  describe('restart strategies', () => {
    it('one-for-one restarts only failed worker');
    it('one-for-all restarts all workers');
    it('rest-for-one restarts failed and subsequent');
  });

  describe('lifecycle', () => {
    it('shutdown terminates all workers');
    it('reset awaits shutdown before clearing config');
    it('destroy removes all listeners');
  });
});
```

---

### Task 32: IPC Handler Tests

**Files:**
- Create: `src/main/ipc/handlers/__tests__/instance-handlers.spec.ts`
- Create: `src/main/ipc/handlers/__tests__/file-handlers.spec.ts`

**Key test scenarios:**

```typescript
describe('instance-handlers', () => {
  it('validates payload with Zod schema');
  it('rejects invalid payload with structured error');
  it('creates instance on valid INSTANCE_CREATE');
  it('returns serialized instance data');
});

describe('file-handlers', () => {
  it('validates file path against sandbox');
  it('rejects path traversal attempts');
  it('reads file content within size limit');
  it('writes file content with createDirs');
});
```

Mock: `ipcMain.handle` registration, InstanceManager, file system operations.

---

### Task 33: Orchestration Tests

**Files:**
- Create: `src/main/orchestration/__tests__/debate-coordinator.spec.ts`
- Expand: `src/main/orchestration/__tests__/multi-verify-coordinator.spec.ts`

**Key test scenarios for debate:**

```typescript
describe('DebateCoordinator', () => {
  it('runs 4-phase debate (initial, critique, defense, synthesis)');
  it('runs initial round in parallel');
  it('calculates consensus score');
  it('stops early when convergence threshold reached');
  it('handles agent failure gracefully');
  it('respects timeout');
});
```

**Key test scenarios for multi-verify:**

```typescript
describe('MultiVerifyCoordinator', () => {
  it('uses semantic clustering when configured');
  it('falls back to key-point clustering');
  it('synthesizes via direct CLI (merge strategy)');
  it('detects outlier agents');
  it('calculates consensus strength');
});
```

---

### Task 34: ErrorRecoveryManager Tests

**Files:**
- Create: `src/main/core/__tests__/error-recovery.spec.ts`

**Key test scenarios:**

```typescript
describe('ErrorRecoveryManager', () => {
  describe('classifyError', () => {
    it('classifies rate limit errors');
    it('classifies network errors');
    it('classifies auth errors');
    it('classifies context overflow');
    it('classifies unknown errors');
  });

  describe('withRetry', () => {
    it('retries on transient failure');
    it('applies exponential backoff');
    it('stops after max retries');
    it('does not retry non-recoverable errors');
  });
});
```

---

### Task 35: WS5 Checkpoint and Final Verification

```bash
npx tsc --noEmit && npx tsc --noEmit -p tsconfig.spec.json && npm run lint && npm test
```

Ensure all new tests pass. Report coverage for the newly tested areas.

**Final commit:**

```bash
git commit -m "test: add test coverage for critical paths"
```

---

## Summary

| Workstream | Tasks | Key Outcomes |
|------------|-------|-------------|
| WS1: Orchestration | 1-6 | Debate functional, semantic clustering wired, parallel rounds |
| WS2: IPC Security | 7-15 | All handlers validated, path sandboxing, generic escape removed |
| WS3: Error Handling | 16-20 | Unified error classification, structured logging everywhere |
| WS4: Architecture | 21-27 | Standard singletons, startup manifest, coupling fixes |
| WS5: Testing | 28-35 | Tests for 7 critical untested areas |

**Total: 35 tasks across 5 workstreams.**
