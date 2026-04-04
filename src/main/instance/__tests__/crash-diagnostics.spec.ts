/**
 * Crash Diagnostics Tests
 *
 * Tests that queueUpdate accepts an ErrorInfo param and includes it in
 * batched InstanceStateUpdatePayload objects so the renderer receives
 * structured crash context when a CLI adapter process exits with an error.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

vi.mock('../../logging/logger', () => ({
  getLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: vi.fn(() => ({
    getAll: vi.fn(() => ({})),
    get: vi.fn(),
    on: vi.fn(),
  })),
}));

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

import { InstanceStateManager } from '../instance-state';
import type { ErrorInfo } from '../../../shared/types/ipc.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getPendingUpdates(manager: InstanceStateManager) {
  return (manager as unknown as { pendingUpdates: Map<string, unknown> }).pendingUpdates;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('InstanceStateManager – crash diagnostics (queueUpdate error param)', () => {
  let manager: InstanceStateManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new InstanceStateManager();
  });

  afterEach(() => {
    manager.destroy();
    vi.useRealTimers();
  });

  it('stores ErrorInfo in the pending update when provided', () => {
    const err: ErrorInfo = {
      code: 'EXIT_1',
      message: 'Process exited with code 1',
      timestamp: 1000,
    };

    manager.queueUpdate('inst-1', 'error', undefined, undefined, undefined, err);

    const pending = getPendingUpdates(manager);
    const update = pending.get('inst-1');
    expect(update).toBeDefined();
    expect((update as { error?: ErrorInfo }).error).toEqual(err);
  });

  it('does not set error field when none is provided', () => {
    manager.queueUpdate('inst-2', 'error');

    const pending = getPendingUpdates(manager);
    const update = pending.get('inst-2') as { error?: ErrorInfo } | undefined;
    expect(update).toBeDefined();
    expect(update?.error).toBeUndefined();
  });

  it('preserves existing error when a subsequent update omits it', () => {
    const err: ErrorInfo = {
      code: 'SIGNAL_SIGTERM',
      message: 'Killed by SIGTERM',
      timestamp: 2000,
    };

    manager.queueUpdate('inst-3', 'error', undefined, undefined, undefined, err);
    // Second update without error (e.g., status polling) should retain previous error
    manager.queueUpdate('inst-3', 'error', undefined, undefined, undefined, undefined);

    const pending = getPendingUpdates(manager);
    const update = pending.get('inst-3') as { error?: ErrorInfo } | undefined;
    expect(update?.error).toEqual(err);
  });

  it('overwrites existing error when a newer error is provided', () => {
    const firstErr: ErrorInfo = { code: 'EXIT_1', message: 'first crash', timestamp: 1000 };
    const secondErr: ErrorInfo = { code: 'EXIT_2', message: 'second crash', timestamp: 2000 };

    manager.queueUpdate('inst-4', 'error', undefined, undefined, undefined, firstErr);
    manager.queueUpdate('inst-4', 'error', undefined, undefined, undefined, secondErr);

    const pending = getPendingUpdates(manager);
    const update = pending.get('inst-4') as { error?: ErrorInfo } | undefined;
    expect(update?.error).toEqual(secondErr);
  });

  it('includes error in the BatchUpdatePayload emitted on flush', () => {
    const err: ErrorInfo = {
      code: 'EXIT_137',
      message: 'OOM killed',
      timestamp: 3000,
    };

    const emitted: unknown[] = [];
    manager.on('batch-update', (payload) => emitted.push(payload));

    manager.queueUpdate('inst-5', 'error', undefined, undefined, undefined, err);

    // Trigger the batch flush by advancing past the batch interval
    vi.advanceTimersByTime(1000);

    expect(emitted).toHaveLength(1);
    const batch = emitted[0] as { updates: { instanceId: string; error?: ErrorInfo }[] };
    const found = batch.updates.find((u) => u.instanceId === 'inst-5');
    expect(found?.error).toEqual(err);
  });
});
