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

  it('uses adapter compactContext directly when the adapter exposes a programmatic hook', async () => {
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

  it('does NOT fall back to sending /compact as user text when no compactContext exists', async () => {
    // Regression: the runtime used to call `adapter.sendInput("/compact")` in
    // this case. For Claude CLI in `--input-format stream-json` mode that text
    // was delivered to the model as a normal user message and the model
    // replied with an explanation of `/compact` instead of compacting.
    // The native strategy must now report failure (false) so the coordinator
    // falls through to the restart-with-summary strategy that actually
    // performs compaction.
    const adapterSendInput = vi.fn(async () => undefined);
    const managerSendInput = vi.fn(async () => undefined);
    const restartInstance = vi.fn(async () => undefined);
    const emitOutputMessage = vi.fn();
    const instance = {
      id: 'inst-1',
      outputBuffer: [
        { id: 'm1', type: 'user' as const, content: 'Build a feature.', timestamp: 1 },
        { id: 'm2', type: 'assistant' as const, content: 'Plan: do X.', timestamp: 2 },
      ],
    };

    const instanceManager = {
      getAdapterRuntimeCapabilities: vi.fn(() => ({ supportsNativeCompaction: true })),
      getAdapter: vi.fn(() => ({ sendInput: adapterSendInput })),
      getInstance: vi.fn(() => instance),
      sendInput: managerSendInput,
      restartInstance,
      emitOutputMessage,
    } as unknown as InstanceManager;

    setupCompactionCoordinator(instanceManager, makeWindowManager());

    const result = await CompactionCoordinator.getInstance().compactInstance('inst-1');

    // No fake `/compact` user message must reach the adapter under any
    // circumstance.
    expect(adapterSendInput).not.toHaveBeenCalled();

    // Manual compaction must still produce a real result. The native strategy
    // returned false (no programmatic hook), so the coordinator falls through
    // to restart-with-summary which actually compacts.
    expect(result.success).toBe(true);
    expect(result.method).toBe('restart-with-summary');
    expect(restartInstance).toHaveBeenCalledWith('inst-1');
    // The continuity prompt is sent through the manager-level sendInput as
    // part of restart-with-summary.
    expect(managerSendInput).toHaveBeenCalledWith(
      'inst-1',
      expect.stringContaining('[Context Compaction Continuity Package]'),
    );
    // Real compaction → boundary marker should be emitted.
    expect(emitOutputMessage).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({
        type: 'system',
        content: '— Context compacted —',
      }),
    );
  });

  it('wires selfManagesAutoCompaction so the coordinator skips background auto-trigger for Claude-style adapters', () => {
    // Build a fake instanceManager that mirrors the Claude-style capability
    // surface: no callable native hook, but `selfManagedAutoCompaction: true`.
    const instanceManager = {
      getAdapterRuntimeCapabilities: vi.fn(() => ({
        supportsNativeCompaction: false,
        selfManagedAutoCompaction: true,
      })),
      getAdapter: vi.fn(() => ({})),
      getInstance: vi.fn(() => undefined),
      sendInput: vi.fn(),
      restartInstance: vi.fn(),
      emitOutputMessage: vi.fn(),
    } as unknown as InstanceManager;

    setupCompactionCoordinator(instanceManager, makeWindowManager());

    const coordinator = CompactionCoordinator.getInstance();
    expect(coordinator.isSelfManagedAutoCompaction('inst-1')).toBe(true);
  });
});
