import { describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { HookManager } from '../hooks/hook-manager';
import type { SubsystemLogger } from '../logging/logger';
import {
  assertInstanceLifecycleHookAllowed,
  dispatchInstanceLifecycleHook,
} from './instance-lifecycle-hooks';

describe('recovery lifecycle hook redaction', () => {
  it('omits recovery session identity from hook context and hook failure logs', async () => {
    const cursor = 'native-cursor-fixture-placeholder';
    const triggerLifecycleHooks = vi.fn(async () => {
      throw new Error(`hook failed for ${cursor}`);
    });
    const errorLog = vi.fn();
    const logger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: errorLog,
    } as unknown as SubsystemLogger;
    const instance = {
      id: 'replacement-fixture',
      sessionId: cursor,
      providerSessionId: cursor,
      workingDirectory: '/fixture',
      metadata: { reason: 'crash-recovery', continuityRevival: true },
    } as unknown as Instance;

    dispatchInstanceLifecycleHook(
      'SessionStart',
      instance,
      { sessionId: cursor, stopReason: 'ready' },
      logger,
      { triggerLifecycleHooks } as unknown as HookManager,
    );

    await vi.waitFor(() => expect(logger.error).toHaveBeenCalledOnce());
    expect(triggerLifecycleHooks).toHaveBeenCalledWith(
      'SessionStart',
      expect.not.objectContaining({ sessionId: cursor }),
    );
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(cursor);
  });

  it('redacts recovery identity nested in arbitrary hook context fields', async () => {
    const cursor = 'hook-context-cursor-fixture-placeholder';
    const triggerLifecycleHooks = vi.fn().mockResolvedValue({ blocked: false });
    const instance = {
      id: 'replacement-fixture', sessionId: cursor, providerSessionId: cursor,
      workingDirectory: '/fixture',
      metadata: { reason: 'crash-recovery', continuityRevival: true },
    } as unknown as Instance;

    dispatchInstanceLifecycleHook(
      'StopFailure',
      instance,
      {
        errorMessage: `adapter failed for ${cursor}`,
        stopReason: 'adapter-error',
      },
      { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as SubsystemLogger,
      { triggerLifecycleHooks } as unknown as HookManager,
    );

    await vi.waitFor(() => expect(triggerLifecycleHooks).toHaveBeenCalledOnce());
    expect(JSON.stringify(triggerLifecycleHooks.mock.calls)).not.toContain(cursor);
  });

  it('redacts a recovery identity from a blocking hook error', async () => {
    const cursor = 'hook-block-cursor-fixture-placeholder';
    const instance = {
      id: 'replacement-fixture', sessionId: cursor, providerSessionId: cursor,
      workingDirectory: '/fixture',
      metadata: { reason: 'crash-recovery', continuityRevival: true },
    } as unknown as Instance;
    const hookManager = {
      triggerLifecycleHooks: vi.fn().mockResolvedValue({
        blocked: true,
        message: `blocked operation for ${cursor}`,
      }),
    } as unknown as HookManager;

    const error = await assertInstanceLifecycleHookAllowed(
      'PreToolUse', instance, {}, hookManager,
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(cursor);
  });
});
