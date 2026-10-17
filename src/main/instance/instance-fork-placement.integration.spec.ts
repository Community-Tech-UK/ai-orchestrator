import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceCreatePayloadSchema } from '@contracts/schemas/instance';
import { getDefaultAgent } from '../../shared/types/agent.types';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import type { WorkerNodeConnectionServer } from '../remote-node/worker-node-connection';
import type { UnifiedSpawnOptions } from '../cli/adapters/adapter-factory.types';
import { getMocks, makeHarness } from './__tests__/instance-lifecycle-source-diagnostics.fixture';
import { InstancePersistenceManager } from './instance-persistence';
import { createOpenCodeAdapter } from '../cli/adapters/opencode-adapter-factory';
import { RemoteCliAdapter } from '../cli/adapters/remote-cli-adapter';
import { normalizeOpenCodeNativeConfig } from '../cli/adapters/opencode-v2-config';
import { projectOpenCodeConfig } from '../cli/adapters/opencode-config-shapes';

const boundary = vi.hoisted(() => ({
  probe: vi.fn(), prepare: vi.fn(), getNode: vi.fn(), selectNode: vi.fn(),
  launch: { command: '/tmp/placeholder-opencode', major: 2 },
}));
const registry = Object.assign(new EventEmitter(), { getNode: boundary.getNode, selectNode: boundary.selectNode });
vi.mock('../remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => registry }));
vi.mock('../cli/adapters/opencode-effective-budget-config', () => ({ readOpenCodeEffectiveBudgetConfig: boundary.probe }));
vi.mock('../cli/adapters/opencode-cli-launch', () => ({ selectOpenCodeLaunch: async () => boundary.launch }));
vi.mock('../cli/adapters/opencode-child-progress-source', () => ({ createOpenCodeChildProgressSource: () => ({ source: {}, request: vi.fn(), prepareSpawn: boundary.prepare }) }));

const mocks = getMocks();
const nodeId = '00000000-0000-4000-8000-000000000000';
const adapters: ReturnType<typeof createOpenCodeAdapter>[] = [];
const remoteAdapters: RemoteCliAdapter[] = [];
const sendRpc = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.createAdapter.mockReset();
  boundary.launch.major = 2;
  boundary.selectNode.mockReturnValue(undefined);
  boundary.getNode.mockReturnValue({ id: nodeId, status: 'connected', capabilities: { openCodeMajor: 2 } });
  boundary.prepare.mockResolvedValue(() => undefined);
  boundary.probe.mockImplementation(async params => projectOpenCodeConfig(boundary.launch.major === 2
    ? normalizeOpenCodeNativeConfig([{ type: 'document', info: JSON.parse(params.env.OPENCODE_CONFIG_CONTENT) }])
    : JSON.parse(params.env.OPENCODE_CONFIG_CONTENT), params.model));
  mocks.resolveAgent.mockResolvedValue(getDefaultAgent());
  mocks.resolveCliType.mockResolvedValue('opencode');
  mocks.getKnownModelsForCli.mockResolvedValue([]);
  mocks.getProviderCapabilities.mockReturnValue({ supportsResume: false, supportsForkSession: false });
  mocks.settings.defaultModel = undefined;
  mocks.settings.defaultModelByProvider = {};
  const actual = await vi.importActual<typeof import('./lifecycle/execution-location-resolver')>('./lifecycle/execution-location-resolver');
  mocks.resolveExecutionLocation.mockImplementation(config => actual.resolveExecutionLocation(config, registry));
  sendRpc.mockImplementation(async (_node, _method, params) => ({ instanceId: params.instanceId }));
  mocks.createAdapter.mockImplementation(({ options, executionLocation }: { options: UnifiedSpawnOptions; executionLocation?: { type: string; nodeId?: string } }) => {
    if (executionLocation?.type === 'remote') {
      const adapter = new RemoteCliAdapter({ sendRpc } as unknown as WorkerNodeConnectionServer, executionLocation.nodeId!, 'opencode', options);
      remoteAdapters.push(adapter);
      return adapter;
    }
    const adapter = createOpenCodeAdapter(options);
    adapters.push(adapter);
    // Run the real factory preparation/version guard; no provider process or config reader is launched.
    vi.spyOn(adapter, 'spawn').mockImplementation(async () => {
      await (adapter as unknown as { acpConfig: { prepareSpawn(): Promise<unknown> } }).acpConfig.prepareSpawn();
      return 4242;
    });
    vi.spyOn(adapter, 'terminate').mockResolvedValue(undefined);
    return adapter;
  });
});
afterEach(() => {
  adapters.splice(0).forEach(adapter => adapter.removeAllListeners());
  remoteAdapters.splice(0).forEach(adapter => adapter.forceCleanup());
  registry.removeAllListeners();
});

async function source(harness: ReturnType<typeof makeHarness>, config: Partial<InstanceCreateConfig> = {}) {
  const parsed = InstanceCreatePayloadSchema.parse({ workingDirectory: '/tmp/placeholder-project', provider: 'opencode', ...config });
  const value = await harness.manager.createInstance({ workingDirectory: parsed.workingDirectory, provider: parsed.provider,
    nodePlacement: parsed.nodePlacement, forceNodeId: parsed.forceNodeId });
  await value.readyPromise;
  value.outputBuffer.push({ id: 'placeholder-user', type: 'user', timestamp: 1, content: 'Placeholder request' });
  expect(value.additionalDirectories).toBeUndefined();
  return value;
}

describe('fork placement through actual lifecycle, central policy and provider guards', () => {
  it.each([false, true])('retains a public major-only constraint before a selected v1 can probe or spawn (native=%s)', async native => {
    const harness = makeHarness();
    try {
      const original = await source(harness, { nodePlacement: { requiresCli: 'opencode', requiresOpenCodeMajor: 2 } });
      const snapshot = structuredClone(original.nodePlacement);
      const clone = vi.fn(async () => 'placeholder-immutable-clone');
      const persistence = new InstancePersistenceManager({ getInstance: id => harness.instances.get(id),
        createInstance: config => harness.manager.createInstance(config), supportsNativeFork: () => native, forkNativeSession: clone });
      boundary.launch.major = 1;
      boundary.probe.mockClear(); boundary.prepare.mockClear();
      const fork = await persistence.forkInstance({ instanceId: original.id, preserveRuntimeSettings: true });
      await fork.readyPromise?.catch(() => undefined);
      expect(fork.status).toBe('error');
      expect(fork.outputBuffer.some(message => message.type === 'error' && message.content.includes('requires OpenCode 2'))).toBe(true);
      expect(fork.nodePlacement).toEqual(snapshot);
      expect(fork.nodePlacement).not.toBe(original.nodePlacement);
      expect(original.nodePlacement).toEqual(snapshot);
      expect(boundary.probe).not.toHaveBeenCalled();
      expect(boundary.prepare).not.toHaveBeenCalled();
      const options = mocks.createAdapter.mock.lastCall![0].options as UnifiedSpawnOptions;
      expect(options.nodePlacement?.requiresOpenCodeMajor).toBe(2);
      expect(options.forkSession).not.toBe(true);
      if (native) expect(options).toMatchObject({ sessionId: 'placeholder-immutable-clone', resume: true });
      else expect(clone).not.toHaveBeenCalled();
      fork.nodePlacement!.requiresOpenCodeMajor = 1;
      expect(original.nodePlacement?.requiresOpenCodeMajor).toBe(2);
    } finally { harness.manager.destroy(); }
  });

  it('binds a native clone to major2 even when its source had no placement constraint', async () => {
    const harness = makeHarness();
    try {
      const original = await source(harness);
      const persistence = new InstancePersistenceManager({ getInstance: () => original,
        createInstance: config => harness.manager.createInstance(config), supportsNativeFork: () => true,
        forkNativeSession: async () => 'placeholder-unconstrained-clone' });
      boundary.launch.major = 1;
      boundary.probe.mockClear();
      const fork = await persistence.forkInstance({ instanceId: original.id });
      await fork.readyPromise?.catch(() => undefined);
      expect(fork.status).toBe('error');
      expect(fork.outputBuffer.some(message => message.type === 'error' && message.content.includes('requires OpenCode 2'))).toBe(true);
      expect(fork.nodePlacement).toMatchObject({ requiresOpenCodeMajor: 2 });
      expect(original.nodePlacement).toBeUndefined();
      expect(boundary.probe).not.toHaveBeenCalled();
    } finally { harness.manager.destroy(); }
  });

  it('independently enforces the native-clone marker at the central runtime boundary', async () => {
    const harness = makeHarness();
    try {
      boundary.launch.major = 1;
      const fork = await harness.manager.createInstance({ workingDirectory: '/tmp/placeholder-project', provider: 'opencode',
        metadata: { openCodeForkSessionId: 'placeholder-existing-clone' } });
      await fork.readyPromise?.catch(() => undefined);
      expect(fork.status).toBe('error');
      expect(boundary.probe).not.toHaveBeenCalled();
      expect(mocks.createAdapter.mock.lastCall![0].options).toMatchObject({ resume: true,
        sessionId: 'placeholder-existing-clone', nodePlacement: { requiresOpenCodeMajor: 2 } });
      expect(mocks.createAdapter.mock.lastCall![0].options.forkSession).not.toBe(true);
    } finally { harness.manager.destroy(); }
  });

  it.each([undefined, 1, 'offline'] as const)('retains its forced original worker and refuses unavailable/unsupported runtime (%s)', async major => {
    const harness = makeHarness();
    try {
      const original = await source(harness, { forceNodeId: nodeId, nodePlacement: { requiresCli: 'opencode', requiresOpenCodeMajor: 2 } });
      const clone = vi.fn();
      const configs: InstanceCreateConfig[] = [];
      const persistence = new InstancePersistenceManager({ getInstance: () => original, supportsNativeFork: () => false,
        forkNativeSession: clone, createInstance: config => { configs.push(config); return harness.manager.createInstance(config); } });
      boundary.getNode.mockReturnValue(major === 'offline' ? undefined : {
        id: nodeId, status: 'connected', capabilities: { openCodeMajor: major },
      } as WorkerNodeInfo | undefined);
      sendRpc.mockClear();
      const fork = await persistence.forkInstance({ instanceId: original.id });
      await fork.readyPromise?.catch(() => undefined);
      expect(fork.status).toBe('error');
      expect(fork.outputBuffer.some(message => message.type === 'error' && message.content.includes(major === 'offline' ? 'unavailable' : 'OpenCode 2.0.30'))).toBe(true);
      expect(configs[0]).toMatchObject({ forceNodeId: nodeId, nodePlacement: { requiresCli: 'opencode', requiresOpenCodeMajor: 2 } });
      expect(sendRpc).not.toHaveBeenCalled();
      expect(clone).not.toHaveBeenCalled();
    } finally { harness.manager.destroy(); }
  });

  it('rejects conflicting and malformed source requirements before creating a native clone', async () => {
    const harness = makeHarness();
    try {
      const original = await source(harness);
      const clone = vi.fn(async () => 'placeholder-unused-clone');
      const create = vi.fn((config: InstanceCreateConfig) => harness.manager.createInstance(config));
      const persistence = new InstancePersistenceManager({ getInstance: () => original,
        createInstance: create, supportsNativeFork: () => true, forkNativeSession: clone });
      original.nodePlacement = { requiresOpenCodeMajor: 1 };
      await expect(persistence.forkInstance({ instanceId: original.id })).rejects.toThrow(/conflict/i);
      Reflect.set(original, 'nodePlacement', { requiresOpenCodeMajor: 3 });
      await expect(persistence.forkInstance({ instanceId: original.id })).rejects.toThrow(/Invalid recovery node placement/);
      expect(clone).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
    } finally { harness.manager.destroy(); }
  });

  it('resumes an already cloned v2 identity once and deep clones all retained placement preferences', async () => {
    const harness = makeHarness();
    try {
      const original = await source(harness, { nodePlacement: { requiresCli: 'opencode', requiresOpenCodeMajor: 2, preferPlatform: 'linux' } });
      original.nodePlacement!.prefersAccountProfile = { provider: 'opencode', profileId: 'placeholder-profile' };
      const clone = vi.fn(async () => 'placeholder-clone-once');
      const persistence = new InstancePersistenceManager({ getInstance: () => original,
        createInstance: config => harness.manager.createInstance(config), supportsNativeFork: () => true, forkNativeSession: clone });
      const fork = await persistence.forkInstance({ instanceId: original.id });
      await fork.readyPromise;
      expect(fork.status).toBe('idle');
      expect(fork.nodePlacement).toEqual(original.nodePlacement);
      expect(fork.nodePlacement?.prefersAccountProfile).not.toBe(original.nodePlacement?.prefersAccountProfile);
      expect(clone).toHaveBeenCalledExactlyOnceWith(original.id);
      const options = mocks.createAdapter.mock.lastCall![0].options as UnifiedSpawnOptions;
      expect(options).toMatchObject({ sessionId: 'placeholder-clone-once', resume: true, transcriptKnown: false,
        nodePlacement: original.nodePlacement });
      expect(options.forkSession).not.toBe(true);
      fork.nodePlacement!.prefersAccountProfile!.profileId = 'different-placeholder';
      expect(original.nodePlacement?.prefersAccountProfile?.profileId).toBe('placeholder-profile');
    } finally { harness.manager.destroy(); }
  });

  it('retains snapshot replay and placement if native cloning returns no identity', async () => {
    const harness = makeHarness();
    try {
      const original = await source(harness, { nodePlacement: { requiresOpenCodeMajor: 2 } });
      const clone = vi.fn(async () => undefined);
      const persistence = new InstancePersistenceManager({ getInstance: () => original,
        createInstance: config => harness.manager.createInstance(config), supportsNativeFork: () => true, forkNativeSession: clone });
      const fork = await persistence.forkInstance({ instanceId: original.id });
      await fork.readyPromise;
      expect(fork.status).toBe('idle');
      expect(fork.nodePlacement).toEqual({ requiresOpenCodeMajor: 2 });
      expect(fork.metadata?.['openCodeForkSessionId']).toBeUndefined();
      expect(fork.outputBuffer).toEqual(original.outputBuffer);
      expect(mocks.createAdapter.mock.lastCall![0].options.resume).not.toBe(true);
    } finally { harness.manager.destroy(); }
  });

  it('keeps historical and explicit reset forks on snapshot replay with reset placement omitted', async () => {
    const harness = makeHarness();
    try {
      const original = await source(harness, { nodePlacement: { requiresOpenCodeMajor: 2 } });
      original.outputBuffer.push({ id: 'placeholder-answer', type: 'assistant', timestamp: 2, content: 'Placeholder answer' });
      const clone = vi.fn();
      const configs: InstanceCreateConfig[] = [];
      const persistence = new InstancePersistenceManager({ getInstance: () => original, supportsNativeFork: () => true,
        forkNativeSession: clone, createInstance: config => { configs.push(config); return harness.manager.createInstance(config); } });
      const historical = await persistence.forkInstance({ instanceId: original.id, atMessageIndex: 1 });
      await historical.readyPromise;
      expect(configs[0]).toMatchObject({ nodePlacement: { requiresOpenCodeMajor: 2 }, initialOutputBuffer: [expect.objectContaining({ id: 'placeholder-user' })] });
      const reset = await persistence.forkInstance({ instanceId: original.id, preserveRuntimeSettings: false });
      await reset.readyPromise;
      expect(configs[1].nodePlacement).toBeUndefined(); expect(configs[1].forceNodeId).toBeUndefined();
      expect(configs[1].metadata?.['openCodeForkSessionId']).toBeUndefined();
      expect(clone).not.toHaveBeenCalled();
    } finally { harness.manager.destroy(); }
  });
});
