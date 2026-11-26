# Codex Timeout & Auto-Title Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two Codex bugs — app-server init hangs indefinitely, and auto-title never upgrades from folder name.

**Architecture:** Bug 1 wraps `initAppServerMode()` with a 30s Promise.race timeout so it falls back to exec mode instead of hanging. Bug 2 changes `AutoTitleService` to always pick the fastest available CLI for title generation instead of following the session's provider.

**Tech Stack:** TypeScript, Vitest

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/main/cli/adapters/codex-cli-adapter.ts` | Modify | Add 30s timeout around `initAppServerMode()` |
| `src/main/cli/adapters/codex-cli-adapter.spec.ts` | Modify | Add test for init timeout fallback |
| `src/main/instance/auto-title-service.ts` | Modify | Fast-provider resolution, remove `requestedProvider` param |
| `src/main/instance/auto-title-service.spec.ts` | Modify | Update tests for new provider resolution |
| `src/main/instance/instance-lifecycle.ts` | Modify | Remove provider arg from `triggerAutoTitle` |

---

### Task 1: Add init-phase timeout to Codex app-server

**Files:**
- Modify: `src/main/cli/adapters/codex-cli-adapter.ts:378-390`
- Test: `src/main/cli/adapters/codex-cli-adapter.spec.ts`

- [ ] **Step 1: Write the failing test**

Add a test that verifies the adapter falls back to exec mode when `initAppServerMode` takes too long. Add this test to the existing spec file:

```typescript
it('falls back to exec mode when app-server init times out', async () => {
  // Mock checkStatus to report app-server available
  vi.spyOn(adapter as any, 'checkStatus').mockResolvedValue({
    available: true,
    metadata: { appServerAvailable: true },
  });

  // Mock initAppServerMode to hang forever (never resolve)
  vi.spyOn(adapter as any, 'initAppServerMode').mockReturnValue(new Promise(() => {}));

  // Mock prepareCleanCodexHome for exec fallback
  vi.spyOn(adapter as any, 'prepareCleanCodexHome').mockReturnValue(undefined);

  // Use fake timers to advance past the 30s timeout
  vi.useFakeTimers();
  const spawnPromise = adapter.spawn();
  await vi.advanceTimersByTimeAsync(31_000);
  const pid = await spawnPromise;
  vi.useRealTimers();

  expect(pid).toBeGreaterThan(0);
  expect((adapter as any).useAppServer).toBe(false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/cli/adapters/codex-cli-adapter.spec.ts -t "falls back to exec mode when app-server init times out"`
Expected: FAIL — the test will hang because there's no timeout on `initAppServerMode()`.

- [ ] **Step 3: Implement the init timeout**

In `src/main/cli/adapters/codex-cli-adapter.ts`, find the `spawn()` method around line 378-390. Replace:

```typescript
    if (appServerAvailable) {
      // App-server mode: persistent JSON-RPC connection
      try {
        await this.initAppServerMode();
        this.useAppServer = true;
        logger.info('Codex adapter using app-server mode');
      } catch (err) {
        logger.warn('App-server initialization failed, falling back to exec mode', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.useAppServer = false;
        this.prepareCleanCodexHome();
      }
    }
```

With:

```typescript
    if (appServerAvailable) {
      // App-server mode: persistent JSON-RPC connection
      try {
        await Promise.race([
          this.initAppServerMode(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Codex app-server initialization timed out after 30s')), 30_000)
          ),
        ]);
        this.useAppServer = true;
        logger.info('Codex adapter using app-server mode');
      } catch (err) {
        logger.warn('App-server initialization failed, falling back to exec mode', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.useAppServer = false;
        this.prepareCleanCodexHome();
      }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/main/cli/adapters/codex-cli-adapter.spec.ts -t "falls back to exec mode when app-server init times out"`
Expected: PASS

- [ ] **Step 5: Run full adapter test suite**

Run: `npx vitest run src/main/cli/adapters/codex-cli-adapter.spec.ts`
Expected: All tests pass

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/main/cli/adapters/codex-cli-adapter.ts src/main/cli/adapters/codex-cli-adapter.spec.ts
git commit -m "fix: add 30s timeout to codex app-server initialization

Prevents the session from hanging indefinitely when the Codex
app-server fails to respond during initialization. Falls back
to exec mode gracefully on timeout."
```

---

### Task 2: Make auto-title always use the fastest available CLI

**Files:**
- Modify: `src/main/instance/auto-title-service.ts:99-165`
- Test: `src/main/instance/auto-title-service.spec.ts`

- [ ] **Step 1: Write the failing test — fast provider preference**

Replace the existing test in `auto-title-service.spec.ts` with tests for the new behavior. The file needs updated mocks since we now import `isCliAvailable`:

```typescript
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCreateCliAdapter, mockResolveCliType, mockSendMessage, mockIsCliAvailable } = vi.hoisted(() => {
  const sendMessage = vi.fn();

  return {
    mockSendMessage: sendMessage,
    mockCreateCliAdapter: vi.fn(() => ({
      sendMessage,
    })),
    mockResolveCliType: vi.fn(),
    mockIsCliAvailable: vi.fn(),
  };
});

vi.mock('../cli/adapters/adapter-factory', () => ({
  createCliAdapter: mockCreateCliAdapter,
  resolveCliType: mockResolveCliType,
}));

vi.mock('../cli/cli-detection', () => ({
  isCliAvailable: mockIsCliAvailable,
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: vi.fn(() => ({
    getAll: vi.fn(() => ({ defaultCli: 'codex' })),
  })),
}));

vi.mock('../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  })),
}));

import { AutoTitleService } from './auto-title-service';

describe('AutoTitleService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSendMessage.mockResolvedValue({ content: 'AI generated title' });
    AutoTitleService._resetForTesting();
  });

  it('prefers claude for title generation even when session uses codex', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'claude' || type === 'codex',
    }));
    mockResolveCliType.mockResolvedValue('claude');

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the broken deployment and summarize the fix.',
      applyTitle,
      false,
    );

    // Should resolve to claude, not codex
    expect(mockCreateCliAdapter).toHaveBeenCalledWith('claude', expect.objectContaining({
      model: expect.any(String),
    }));
    // Phase 1 instant title
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'Investigate the broken deployment and summarize the...');
    // Phase 2 AI title
    expect(applyTitle).toHaveBeenCalledWith('instance-1', 'AI generated title');
  });

  it('falls back to gemini when claude is not available', async () => {
    mockIsCliAvailable.mockImplementation(async (type: string) => ({
      installed: type === 'gemini' || type === 'codex',
    }));
    mockResolveCliType.mockResolvedValue('gemini');

    const applyTitle = vi.fn();

    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Investigate the broken deployment and summarize the fix.',
      applyTitle,
      false,
    );

    expect(mockCreateCliAdapter).toHaveBeenCalledWith('gemini', expect.objectContaining({
      model: expect.any(String),
    }));
  });

  it('does not accept requestedProvider parameter (removed)', async () => {
    mockIsCliAvailable.mockImplementation(async () => ({ installed: true }));
    mockResolveCliType.mockResolvedValue('claude');

    const applyTitle = vi.fn();

    // maybeGenerateTitle should only accept 4 args now (no requestedProvider)
    await AutoTitleService.getInstance().maybeGenerateTitle(
      'instance-1',
      'Some long enough message for title.',
      applyTitle,
      false,
    );

    expect(applyTitle).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/instance/auto-title-service.spec.ts`
Expected: FAIL — `isCliAvailable` is not imported yet, tests reference new behavior.

- [ ] **Step 3: Implement fast-provider resolution**

In `src/main/instance/auto-title-service.ts`, make these changes:

Add the import for `isCliAvailable`:

```typescript
import { isCliAvailable } from '../cli/cli-detection';
```

Add the `FAST_PROVIDER_PREFERENCE` constant after the existing constants:

```typescript
/** Provider preference order for title generation (fastest first) */
const FAST_PROVIDER_PREFERENCE: Array<Parameters<typeof resolveCliType>[0]> = [
  'claude', 'gemini', 'copilot', 'codex',
];
```

Replace the `maybeGenerateTitle` signature — remove `requestedProvider` (the 5th parameter):

```typescript
  async maybeGenerateTitle(
    instanceId: string,
    message: string,
    applyTitle: (instanceId: string, title: string) => void,
    isRenamed?: boolean,
  ): Promise<void> {
```

Replace the Phase 2 provider resolution block (lines ~124-133) with:

```typescript
    // Phase 2: Upgrade with AI-generated title via CLI adapter
    try {
      const truncatedMessage = message.length > MAX_INPUT_LENGTH
        ? message.slice(0, MAX_INPUT_LENGTH) + '...'
        : message;

      // Pick the fastest available CLI — title generation doesn't need
      // provider consistency with the session.
      let cliType: Awaited<ReturnType<typeof resolveCliType>> | null = null;
      for (const candidate of FAST_PROVIDER_PREFERENCE) {
        try {
          const info = await isCliAvailable(candidate as Parameters<typeof isCliAvailable>[0]);
          if (info.installed) {
            cliType = await resolveCliType(candidate);
            break;
          }
        } catch {
          // Skip unavailable providers
        }
      }

      if (!cliType) {
        logger.debug('No CLI available for AI title generation');
        return;
      }

      const model = resolveModelForTier('fast', cliType);
```

The rest of the method (adapter creation, sendMessage, title application) stays the same — just remove `requestedProvider` from the signature.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/instance/auto-title-service.spec.ts`
Expected: All tests pass

- [ ] **Step 5: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/main/instance/auto-title-service.ts src/main/instance/auto-title-service.spec.ts
git commit -m "fix: auto-title uses fastest available CLI instead of session provider

Codex exec has significant cold-start overhead that exceeds the 15s
title timeout. Now the service tries claude first, then gemini, then
copilot, using codex only as a last resort."
```

---

### Task 3: Update callers to remove requestedProvider argument

**Files:**
- Modify: `src/main/instance/instance-lifecycle.ts:356-370`

- [ ] **Step 1: Update triggerAutoTitle in instance-lifecycle.ts**

In `src/main/instance/instance-lifecycle.ts`, find the `triggerAutoTitle` method (line 356). Change:

```typescript
  private triggerAutoTitle(instance: Instance, message: string): void {
    getAutoTitleService().maybeGenerateTitle(
      instance.id,
      message,
      (id, title) => {
        logger.debug('Auto-title callback (lifecycle)', { id, title, isRenamed: instance.isRenamed });
        if (!instance.isRenamed) {
          instance.displayName = title;
          this.deps.queueUpdate(id, instance.status, instance.contextUsage, undefined, title);
          getSessionContinuityManager().updateState(id, { displayName: title });
        }
      },
      instance.isRenamed,
      instance.provider,
    ).catch(() => { /* non-critical */ });
  }
```

To:

```typescript
  private triggerAutoTitle(instance: Instance, message: string): void {
    getAutoTitleService().maybeGenerateTitle(
      instance.id,
      message,
      (id, title) => {
        logger.debug('Auto-title callback (lifecycle)', { id, title, isRenamed: instance.isRenamed });
        if (!instance.isRenamed) {
          instance.displayName = title;
          this.deps.queueUpdate(id, instance.status, instance.contextUsage, undefined, title);
          getSessionContinuityManager().updateState(id, { displayName: title });
        }
      },
      instance.isRenamed,
    ).catch(() => { /* non-critical */ });
  }
```

The `instance-manager.ts` call site (line 831) already doesn't pass a provider, so no change needed there.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Typecheck spec files**

Run: `npx tsc --noEmit -p tsconfig.spec.json`
Expected: No errors

- [ ] **Step 4: Lint**

Run: `npm run lint`
Expected: No errors

- [ ] **Step 5: Run all affected tests**

Run: `npx vitest run src/main/instance/auto-title-service.spec.ts src/main/cli/adapters/codex-cli-adapter.spec.ts`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/main/instance/instance-lifecycle.ts
git commit -m "refactor: remove requestedProvider arg from auto-title callers"
```
