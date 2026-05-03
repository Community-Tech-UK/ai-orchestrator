import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompactionCoordinator } from '../context/compaction-coordinator';
import type { InstanceManager } from '../instance/instance-manager';
import type { WindowManager } from '../window-manager';
import { setupCompactionCoordinator } from './compaction-runtime';

function makeWindowManager(): WindowManager {
  return {
    sendToRenderer: vi.fn(),
  } as unknown as WindowManager;
}

describe('setupCompactionCoordinator', () => {
  beforeEach(() => {
    CompactionCoordinator._resetForTesting();
  });

  afterEach(() => {
    CompactionCoordinator._resetForTesting();
    vi.restoreAllMocks();
  });

  it('uses adapter compactContext directly instead of routing /compact through sendInput', async () => {
    const compactContext = vi.fn(async () => true);
    const sendInput = vi.fn(async () => undefined);
    const instanceManager = {
      getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: true })),
      getAdapter: vi.fn(() => ({ compactContext })),
      getInstance: vi.fn(() => undefined),
      sendInput,
      emitOutputMessage: vi.fn(),
    } as unknown as InstanceManager;

    setupCompactionCoordinator(instanceManager, makeWindowManager());

    const result = await CompactionCoordinator.getInstance().compactInstance('inst-1');

    expect(result.success).toBe(true);
    expect(result.method).toBe('native');
    expect(compactContext).toHaveBeenCalledOnce();
    expect(sendInput).not.toHaveBeenCalled();
  });

  it('sends provider-native slash compaction directly to adapters that do not expose compactContext', async () => {
    const adapterSendInput = vi.fn(async () => undefined);
    const managerSendInput = vi.fn(async () => undefined);
    const instanceManager = {
      getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: true })),
      getAdapter: vi.fn(() => ({ sendInput: adapterSendInput })),
      getInstance: vi.fn(() => undefined),
      sendInput: managerSendInput,
      emitOutputMessage: vi.fn(),
    } as unknown as InstanceManager;

    setupCompactionCoordinator(instanceManager, makeWindowManager());

    const result = await CompactionCoordinator.getInstance().compactInstance('inst-1');

    expect(result.success).toBe(true);
    expect(result.method).toBe('native');
    expect(adapterSendInput).toHaveBeenCalledWith('/compact');
    expect(managerSendInput).not.toHaveBeenCalled();
  });
});
