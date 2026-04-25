import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../../../cli/adapters/adapter-factory';
import type { Instance } from '../../../../shared/types/instance.types';
import { RuntimeReadinessCoordinator } from '../runtime-readiness';

function makeAdapter(overrides: Partial<CliAdapter> = {}): CliAdapter {
  const adapter = new EventEmitter() as EventEmitter & Partial<CliAdapter> & {
    formatter?: { isWritable(): boolean } | null;
  };
  adapter.getName = vi.fn(() => 'codex-cli');
  Object.assign(adapter, overrides);
  return adapter as CliAdapter;
}

describe('RuntimeReadinessCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses adapter runtime capabilities when exposed', () => {
    const coordinator = new RuntimeReadinessCoordinator({
      getInstance: vi.fn(),
      getAdapter: vi.fn(),
    });
    const adapter = makeAdapter({
      getRuntimeCapabilities: () => ({
        supportsResume: true,
        supportsForkSession: true,
        supportsNativeCompaction: false,
        supportsPermissionPrompts: true,
        supportsDeferPermission: false,
      }),
    } as Partial<CliAdapter>);

    expect(coordinator.getAdapterRuntimeCapabilities(adapter)).toEqual({
      supportsResume: true,
      supportsForkSession: true,
      supportsNativeCompaction: false,
      supportsPermissionPrompts: true,
      supportsDeferPermission: false,
    });
  });

  it('treats output as a successful native resume health signal', async () => {
    const adapter = makeAdapter();
    const instance = {
      processId: 123,
      status: 'initializing',
    } as Pick<Instance, 'processId' | 'status'>;
    const coordinator = new RuntimeReadinessCoordinator({
      getInstance: () => instance,
      getAdapter: () => adapter,
    });

    const result = coordinator.waitForResumeHealth('instance-1', 500);

    adapter.emit('output', {
      id: 'message-1',
      type: 'assistant',
      content: 'ready',
      timestamp: Date.now(),
    });

    await expect(result).resolves.toBe(true);
  });

  it('treats session-not-found errors as failed native resume health', async () => {
    const adapter = makeAdapter();
    const instance = {
      processId: 123,
      status: 'initializing',
    } as Pick<Instance, 'processId' | 'status'>;
    const coordinator = new RuntimeReadinessCoordinator({
      getInstance: () => instance,
      getAdapter: () => adapter,
    });

    const result = coordinator.waitForResumeHealth('instance-1', 500);

    adapter.emit('error', new Error('No conversation found with session ID: missing'));

    await expect(result).resolves.toBe(false);
  });

  it('treats session-not-found output errors as failed native resume health', async () => {
    const adapter = makeAdapter();
    const instance = {
      processId: 123,
      status: 'initializing',
    } as Pick<Instance, 'processId' | 'status'>;
    const coordinator = new RuntimeReadinessCoordinator({
      getInstance: () => instance,
      getAdapter: () => adapter,
    });

    const result = coordinator.waitForResumeHealth('instance-1', 500);

    adapter.emit('output', {
      id: 'message-1',
      type: 'error',
      content: 'No conversation found with session ID: missing',
      timestamp: Date.now(),
    });

    await expect(result).resolves.toBe(false);
  });

  it('waits for Claude formatter writability', async () => {
    vi.useFakeTimers();
    let writable = false;
    const adapter = makeAdapter({
      getName: () => 'claude-cli',
      formatter: {
        isWritable: () => writable,
      },
    } as Partial<CliAdapter>);
    const coordinator = new RuntimeReadinessCoordinator({
      getInstance: vi.fn(),
      getAdapter: () => adapter,
    });

    const result = coordinator.waitForAdapterWritable('instance-1', 1000, 50);

    await vi.advanceTimersByTimeAsync(50);
    writable = true;
    await vi.advanceTimersByTimeAsync(50);

    await expect(result).resolves.toBe(true);
  });
});
