import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }) }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({ triggerLifecycleHooks: async () => undefined }) }));

import { InstanceCommunicationManager } from './instance-communication';
import { StuckProcessDetector } from './stuck-process-detector';

const detectors: StuckProcessDetector[] = [];

function setup() {
  const adapter = Object.assign(new EventEmitter(), {
    getSessionId: () => 'native-fixture', getName: () => 'opencode-acp',
  }) as unknown as CliAdapter;
  const instance = {
    id: 'late-tools', sessionId: 'native-fixture', providerSessionId: 'native-fixture',
    restartEpoch: 0, provider: 'opencode', status: 'busy', parentId: null,
    agentId: 'build', workingDirectory: '/fixture', outputBuffer: [],
  } as unknown as Instance;
  const detector = new StuckProcessDetector({ isProcessAlive: () => true, getTimeoutMultiplier: () => 1 });
  detectors.push(detector);
  detector.startTracking(instance.id);
  detector.updateState(instance.id, 'generating');
  const stuck = vi.fn();
  detector.on('process:stuck', stuck);
  const manager = new InstanceCommunicationManager({
    getInstance: () => instance, getAdapter: () => adapter, setAdapter: vi.fn(), deleteAdapter: () => false,
    queueUpdate: vi.fn(), processOrchestrationOutput: vi.fn(), onInterruptedExit: async () => undefined,
    ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn(),
    onOutput: (id, content) => detector.recordOutput(id, content),
    onToolStateChange: (id, state) => detector.updateState(id, state),
  });
  manager.setupAdapterEvents(instance.id, adapter);
  return { adapter, instance, stuck };
}

function toolOutput(type: 'tool_use' | 'tool_result'): OutputMessage {
  return {
    id: 'late-tool-message', timestamp: Date.now(), type, content: 'Command aborted',
    metadata: { transport: 'acp', toolCallId: 'cancelled-tool', title: 'bash', kind: 'execute', status: 'cancelled' },
  };
}

afterEach(() => {
  for (const detector of detectors.splice(0)) detector.shutdown();
  vi.useRealTimers();
});

describe('tool output after an interrupted turn settles', () => {
  it.each(['tool_use', 'tool_result'] as const)('keeps late %s in the transcript without restarting an idle session', async (type) => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { adapter, instance, stuck } = setup();
    instance.status = 'interrupting';
    adapter.emit('status', 'idle');
    const output = toolOutput(type);
    adapter.emit('output', output);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(instance.status).toBe('idle');
    expect(instance.outputBuffer).toContainEqual(expect.objectContaining({ id: output.id, content: output.content }));
    // Covers both the eight-minute generating limit and the longer tool limit.
    await vi.advanceTimersByTimeAsync(41 * 60_000);
    expect(stuck).not.toHaveBeenCalled();
  });

  it('still detects a live turn that stops responding after a tool result', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { adapter, stuck } = setup();
    adapter.emit('output', toolOutput('tool_use'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(stuck).not.toHaveBeenCalled();

    adapter.emit('output', toolOutput('tool_result'));
    await new Promise<void>((resolve) => setImmediate(resolve));

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(stuck).toHaveBeenCalledOnce();
  });
});
