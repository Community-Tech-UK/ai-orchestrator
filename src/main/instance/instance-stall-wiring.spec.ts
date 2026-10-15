import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../cli/adapters/adapter-factory';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }) }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({}) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({}) }));
vi.mock('./stall-notices', () => ({ buildSpawnStallNotice: vi.fn() }));
import { buildSpawnStallNotice } from './stall-notices';
import { InstanceCommunicationManager } from './instance-communication';

const notice: OutputMessage = {
  id: 'spawn-stall-123', timestamp: 123, type: 'system', content: 'Observed process is paused.',
  metadata: { spawnStall: true, timeoutMs: 30_000, processFacts: { pid: 100, state: 'stopped' } },
};

function setup() {
  const original = Object.assign(new EventEmitter(), { getPid: () => 100 }) as unknown as CliAdapter;
  let adapter = original;
  let instance: Instance | undefined = {
    id: 'stall', displayName: 'Stall', createdAt: 1, historyThreadId: 'history-1',
    parentId: null, childrenIds: [], supervisorNodeId: '', depth: 0,
    terminationPolicy: 'terminate-children', launchMode: 'orchestrated', executionLocation: { type: 'local' },
    contextInheritance: {} as Instance['contextInheritance'], agentId: 'build', agentMode: 'build',
    planMode: { enabled: false, state: 'off' }, status: 'busy', contextUsage: { used: 0, total: 1000, percentage: 0 },
    lastActivity: 1, processId: 100, sessionId: 'session-1', providerSessionId: 'provider-session-1',
    workingDirectory: '/tmp', yoloMode: false, provider: 'claude', outputBuffer: [], outputBufferMaxSize: 100,
    communicationTokens: new Map(), subscribedTo: [], totalTokensUsed: 0, requestCount: 0,
    errorCount: 0, restartCount: 0, restartEpoch: 0,
  };
  const onOutput = vi.fn();
  const manager = new InstanceCommunicationManager({
    getInstance: () => instance, getAdapter: () => adapter, setAdapter: vi.fn(), deleteAdapter: () => false,
    queueUpdate: vi.fn(), processOrchestrationOutput: vi.fn(), onInterruptedExit: async () => undefined,
    ingestToRLM: vi.fn(), ingestToUnifiedMemory: vi.fn(), onOutput,
  });
  const sink = vi.fn();
  manager.on('output', sink);
  manager.setupAdapterEvents('stall', original);
  return { original, instance, sink, onOutput, remove: () => { instance = undefined; }, replace: () => { adapter = new EventEmitter() as CliAdapter; } };
}

afterEach(() => vi.restoreAllMocks());
describe('spawn stall process notice wiring', () => {
  it('publishes the shared notice with facts without resetting the silence clock', async () => {
    vi.mocked(buildSpawnStallNotice).mockResolvedValue(notice);
    const test = setup();
    test.original.emit('spawn:stall', { timeoutMs: 30_000 });
    await new Promise<void>((r) => setImmediate(r));
    expect(test.sink).toHaveBeenCalledWith({ instanceId: 'stall', message: notice });
    expect(test.instance?.outputBuffer).toContainEqual(notice);
    expect(test.onOutput).not.toHaveBeenCalled();
  });

  it.each(['remove', 'replace'] as const)('drops a delayed notice after %s', async (action) => {
    let resolve!: (value: OutputMessage) => void;
    vi.mocked(buildSpawnStallNotice).mockReturnValue(new Promise((r) => { resolve = r; }));
    const test = setup();
    test.original.emit('spawn:stall', { timeoutMs: 30_000 });
    expect(buildSpawnStallNotice).toHaveBeenCalledWith({ timeoutMs: 30_000, pid: 100 });
    test[action]();
    resolve(notice);
    await new Promise<void>((r) => setImmediate(r));
    expect(test.sink).not.toHaveBeenCalled();
    expect(test.instance?.outputBuffer).toEqual([]);
  });

  it('drops a delayed warning after new session activity', async () => {
    let resolve!: (value: OutputMessage) => void;
    vi.mocked(buildSpawnStallNotice).mockReturnValue(new Promise((r) => { resolve = r; }));
    const test = setup();
    test.original.emit('spawn:stall', { timeoutMs: 30_000 });
    test.instance!.lastActivity = 2;
    resolve(notice);
    await new Promise<void>((r) => setImmediate(r));
    expect(test.sink).not.toHaveBeenCalled();
  });
});
