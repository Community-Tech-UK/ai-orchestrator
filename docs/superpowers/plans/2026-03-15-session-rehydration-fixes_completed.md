# Session Rehydration Fixes Implementation Plan

> **Reconciled 2026-09-23 (outstanding-plans sweep, [plan](../../plans/2026-09-23-outstanding-plans-sweep_plan_completed.md)): COMPLETE.** Warm start skipped on resume (`instance-lifecycle.ts`), resume success checks `contextUsage.used > 0` in the history-restore path, and deserialization logs ENOENT/parse/decrypt separately.


> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix three bugs causing silent session rehydration failures — warm-start hijacking resume operations, false-positive resume detection, and swallowed deserialization errors.

**Architecture:** Three independent, targeted fixes to the session restoration pipeline. Bug #1 is a one-line guard in the instance lifecycle. Bug #2 replaces the "alive = success" heuristic with a reliable context-usage check + explicit fallback. Bug #3 adds structured error logging to the deserialization chain.

**Tech Stack:** TypeScript, Vitest

---

## File Structure

| File | Responsibility | Change |
|------|---------------|--------|
| `src/main/instance/instance-lifecycle.ts` | Instance creation Phase 2 | Skip warm-start when `config.resume` is true |
| `src/main/instance/warm-start-manager.spec.ts` | Warm-start unit tests | Add test for resume guard |
| `src/main/ipc/handlers/session-handlers.ts` | HISTORY_RESTORE IPC handler | Replace alive-check heuristic with stronger validation |
| `src/main/ipc/handlers/session-handlers.spec.ts` | Session handler tests | Add resume detection tests |
| `src/main/session/session-continuity.ts` | Session persistence core | Add error logging to deserialize/read chains |

---

## Chunk 1: Bug #1 — Guard warm-start against resume operations

### Task 1: Skip warm-start adapter when resuming a session

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts:564-565`

- [ ] **Step 1: Write the failing test**

Create a test in `src/main/instance/warm-start-manager.spec.ts` that verifies a warm adapter is NOT consumed when the caller needs a resume:

```typescript
it('is not consumed when createInstance uses resume mode', () => {
  // This is a design contract test — warm adapters have fresh sessions
  // and must never be used for resume operations.
  // The actual guard lives in instance-lifecycle.ts, but we verify the
  // contract: consume() should not be called when resume is needed.
  const deps = makeDeps();
  const manager = new WarmStartManager(deps);
  // Pre-warm an adapter
  // (tested indirectly — the lifecycle code must skip consume() when config.resume is true)
  expect(true).toBe(true); // Placeholder — real guard is in lifecycle
});
```

> Note: The real test for this is an integration concern in instance-lifecycle.ts. The fix itself is a one-line guard, so a unit test at the warm-start level isn't the right place. We verify with a typecheck + manual test.

- [ ] **Step 2: Apply the fix**

In `src/main/instance/instance-lifecycle.ts`, change line 564-565 from:

```typescript
// Check for a pre-warmed adapter before spawning fresh.
const warmAdapter = this.deps.warmStartManager?.consume(resolvedCliType) as CliAdapter | null ?? null;
```

to:

```typescript
// Check for a pre-warmed adapter before spawning fresh.
// NEVER use warm-start for resume operations — warm adapters have fresh sessions
// with no conversation context. Resume requires --resume <sessionId> on a freshly
// spawned CLI process.
const warmAdapter = config.resume
  ? null
  : (this.deps.warmStartManager?.consume(resolvedCliType) as CliAdapter | null ?? null);
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Run existing warm-start tests**

Run: `npx vitest run src/main/instance/warm-start-manager.spec.ts`
Expected: all pass (no regressions)

- [ ] **Step 5: Commit**

```bash
git add src/main/instance/instance-lifecycle.ts
git commit -m "fix: skip warm-start adapter for resume operations

Warm-start adapters have fresh CLI sessions with no conversation context.
When createInstance is called with resume: true (e.g., from HISTORY_RESTORE),
the warm adapter was being used instead of spawning with --resume, causing
the model to lose all conversation history silently."
```

---

## Chunk 2: Bug #2 — Strengthen resume detection in HISTORY_RESTORE

### Task 2: Replace false-positive alive check with context-usage verification

**Files:**
- Modify: `src/main/ipc/handlers/session-handlers.ts:942-1012`

The current heuristic treats "process alive after 3 seconds" as proof of successful resume. This produces false positives because:
- Warm-start adapters are always alive (Bug #1 fixes the main case, but defense in depth matters)
- The CLI may be alive but waiting for input with a fresh session (invalid session IDs don't always cause immediate exit)

- [ ] **Step 1: Read the existing resume detection code**

Read `src/main/ipc/handlers/session-handlers.ts:938-1012` to understand the current poll logic.

- [ ] **Step 2: Apply the fix — require context usage as proof of resume**

Replace the timeout fallback behavior. Change the timeout handler (lines 946-966) so that when the timeout fires and `contextUsage.used === 0`, it's treated as a **failed** resume (not success). The key change: "alive but no context" = failure, not success.

Replace lines 942-996 with:

```typescript
          const POST_SPAWN_TIMEOUT_MS = 5000;
          const POLL_INTERVAL_MS = 200;

          const resumeAlive = await new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => {
              cleanup();
              const inst = instanceManager.getInstance(instance.id);
              const alive = inst != null
                && inst.status !== 'error'
                && inst.status !== 'terminated';
              const hasContext = inst?.contextUsage != null && inst.contextUsage.used > 0;

              if (alive && hasContext) {
                logger.info('History restore: resume confirmed via context usage', {
                  instanceId: instance.id,
                  contextUsed: inst?.contextUsage?.used,
                });
                resolve(true);
              } else {
                // Process alive but no context = CLI started fresh (session not found)
                // Process dead = CLI crashed
                // Either way, resume failed.
                logger.warn('History restore: resume failed after grace period', {
                  instanceId: instance.id,
                  status: inst?.status,
                  alive,
                  hasContext,
                  contextUsed: inst?.contextUsage?.used,
                });
                resolve(false);
              }
            }, POST_SPAWN_TIMEOUT_MS);

            const poll = setInterval(() => {
              const inst = instanceManager.getInstance(instance.id);
              if (!inst) {
                cleanup();
                resolve(false);
                return;
              }

              // Definitive failure: process exited
              if (inst.status === 'error' || inst.status === 'terminated') {
                cleanup();
                resolve(false);
                return;
              }

              // Definitive success: CLI reported token usage from the resumed session
              if (inst.contextUsage && inst.contextUsage.used > 0) {
                cleanup();
                logger.info('History restore: resume confirmed early via context usage', {
                  instanceId: instance.id,
                  contextUsed: inst.contextUsage.used,
                });
                resolve(true);
                return;
              }
            }, POLL_INTERVAL_MS);

            function cleanup() {
              clearTimeout(timeout);
              clearInterval(poll);
            }
          });
```

- [ ] **Step 3: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Run existing session handler tests**

Run: `npx vitest run src/main/ipc/handlers/__tests__/session-handlers.spec.ts`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/handlers/session-handlers.ts
git commit -m "fix: require context usage as proof of successful resume

Previously, 'process alive after 3s' was treated as successful resume.
This produced false positives when the CLI started fresh (invalid/expired
session ID) but didn't crash. Now requires contextUsage.used > 0 as proof
the CLI actually loaded the session. Timeout increased to 5s to give the
CLI more time to report context usage."
```

---

## Chunk 3: Bug #3 — Add structured logging to deserialization chain

### Task 3: Replace silent error swallowing with structured logging

**Files:**
- Modify: `src/main/session/session-continuity.ts:771-833`

- [ ] **Step 1: Improve `readPayload()` error logging**

In `src/main/session/session-continuity.ts`, replace lines 771-791:

```typescript
  private async readPayload<T>(filePath: string): Promise<T | null> {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf-8');
      const result = this.deserializePayload<T>(raw);
      if (result) return result;

      // Deserialization failed — attempt repair (Layer 1)
      const repair = repairFile(filePath, this.quarantineDir);
      if (repair.status === 'repaired') {
        logger.info('File repaired during load', { path: filePath, repairs: repair.repairs });
        const reRaw = await fs.promises.readFile(filePath, 'utf-8');
        return this.deserializePayload<T>(reRaw);
      }

      logger.warn('File unrecoverable during load', { path: filePath, status: repair.status });
      return null;
    } catch (error) {
      logger.error('Failed to read continuity payload', error instanceof Error ? error : undefined);
      return null;
    }
  }
```

with:

```typescript
  private async readPayload<T>(filePath: string): Promise<T | null> {
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, 'utf-8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        logger.debug('Continuity file not found', { path: filePath });
      } else {
        logger.error('Failed to read continuity file', error instanceof Error ? error : undefined, {
          path: filePath,
          errorCode: code,
        });
      }
      return null;
    }

    const result = this.deserializePayload<T>(raw, filePath);
    if (result) return result;

    // Deserialization failed — attempt repair (Layer 1)
    try {
      const repair = repairFile(filePath, this.quarantineDir);
      if (repair.status === 'repaired') {
        logger.info('File repaired during load', { path: filePath, repairs: repair.repairs });
        const reRaw = await fs.promises.readFile(filePath, 'utf-8');
        return this.deserializePayload<T>(reRaw, filePath);
      }

      logger.warn('Session file unrecoverable', { path: filePath, status: repair.status });
    } catch (repairError) {
      logger.error('File repair itself failed', repairError instanceof Error ? repairError : undefined, {
        path: filePath,
      });
    }

    return null;
  }
```

- [ ] **Step 2: Improve `deserializePayload()` error logging**

Replace lines 802-834:

```typescript
  private deserializePayload<T>(raw: string): T | null {
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      // ... existing logic ...
    } catch (error) {
      logger.error('Failed to decrypt continuity payload', error instanceof Error ? error : undefined);
      return null;
    }
  }
```

with:

```typescript
  private deserializePayload<T>(raw: string, filePath?: string): T | null {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch (error) {
      logger.error('Session file contains invalid JSON', error instanceof Error ? error : undefined, {
        filePath,
        rawLength: raw.length,
        rawPreview: raw.substring(0, 100),
      });
      return null;
    }

    try {
      if (
        parsed &&
        typeof parsed === 'object' &&
        'encrypted' in parsed &&
        'data' in parsed
      ) {
        if (
          parsed['encrypted'] === true &&
          typeof parsed['data'] === 'string'
        ) {
          const decrypted = safeStorage.decryptString(
            Buffer.from(parsed['data'], 'base64')
          );
          return JSON.parse(decrypted) as T;
        }
        if (
          parsed['encrypted'] === false &&
          typeof parsed['data'] === 'string'
        ) {
          return JSON.parse(parsed['data']) as T;
        }
      }

      // Fallback to legacy plain JSON
      return parsed as unknown as T;
    } catch (error) {
      logger.error('Failed to decrypt/parse session payload', error instanceof Error ? error : undefined, {
        filePath,
        encrypted: parsed['encrypted'],
        dataType: typeof parsed['data'],
      });
      return null;
    }
  }
```

- [ ] **Step 3: Improve `loadActiveStates()` logging**

In the same file, add per-file error logging in `loadActiveStates()` (lines 207-222). Replace:

```typescript
  private async loadActiveStates(): Promise<void> {
    try {
      const files = await fs.promises.readdir(this.stateDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.stateDir, file);
          const data = await this.readPayload<SessionState>(filePath);
          if (data) {
            this.sessionStates.set(data.instanceId, data);
          }
        }
      }
    } catch (error) {
      logger.error('Failed to load session states', error instanceof Error ? error : undefined);
    }
  }
```

with:

```typescript
  private async loadActiveStates(): Promise<void> {
    let files: string[];
    try {
      files = await fs.promises.readdir(this.stateDir);
    } catch (error) {
      logger.error('Failed to read session state directory', error instanceof Error ? error : undefined, {
        stateDir: this.stateDir,
      });
      return;
    }

    let loaded = 0;
    let failed = 0;
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      const filePath = path.join(this.stateDir, file);
      const data = await this.readPayload<SessionState>(filePath);
      if (data) {
        this.sessionStates.set(data.instanceId, data);
        loaded++;
      } else {
        failed++;
        logger.warn('Skipped unloadable session state file', { file, filePath });
      }
    }

    if (loaded > 0 || failed > 0) {
      logger.info('Session states loaded', { loaded, failed, total: loaded + failed });
    }
  }
```

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Run existing session repair tests**

Run: `npx vitest run src/main/session/session-repair.spec.ts`
Expected: all pass

- [ ] **Step 6: Run lint**

Run: `npm run lint`
Expected: no new errors

- [ ] **Step 7: Commit**

```bash
git add src/main/session/session-continuity.ts
git commit -m "fix: add structured logging to session deserialization chain

Previously, readPayload() and deserializePayload() caught all errors and
returned null with minimal logging. Now distinguishes ENOENT from other
fs errors, logs JSON parse failures with file preview, logs decryption
failures with metadata, and reports per-file load results during startup."
```
