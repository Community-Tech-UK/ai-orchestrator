import { EventEmitter } from 'events';
import { execFile, type ChildProcess, type ExecFileException } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const execFile = vi.fn();
  return { ...actual, execFile, default: { ...actual, execFile } };
});
vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

const mockRegistry = new EventEmitter();
vi.mock('../worker-node-registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../worker-node-registry')>();
  return { ...actual, getWorkerNodeRegistry: () => mockRegistry };
});

let mockAdapter: EventEmitter & { spawn: () => Promise<number> };
const mockCreateCliAdapter = vi.fn((..._args: unknown[]) => mockAdapter);
vi.mock('../../cli/adapters/adapter-factory', () => ({
  createCliAdapter: (...args: unknown[]) => mockCreateCliAdapter(...args),
}));

const bindingState: { current: Record<string, unknown>; profiles: unknown[] } = {
  current: { state: 'authenticated' },
  profiles: [],
};
vi.mock('../../providers/account-pool/provider-account-binding-service', () => ({
  ProviderAccountBindingService: class {
    async checkBinding(profile: unknown, nodeId: string) {
      bindingState.profiles.push({ profile, nodeId });
      return bindingState.current;
    }
  },
}));

import { InstanceSpawnParamsSchema, NodeHeartbeatParamsSchema } from '../rpc-schemas';
import { WorkerNodeRegistry } from '../worker-node-registry';
import { RemoteCliAdapter } from '../../cli/adapters/remote-cli-adapter';
import type { WorkerNodeConnectionServer } from '../worker-node-connection';
import type { WorkerNodeCapabilities, WorkerNodeInfo } from '../../../shared/types/worker-node.types';
import { LocalInstanceManager } from '../../../worker-agent/local-instance-manager';
import {
  _resetWorkerOpenCodeAccountCacheForTesting,
  listWorkerAccountProfileIds,
  listWorkerOpenCodeAccountProfileIds,
  materializeWorkerAccountRoute,
} from '../../../worker-agent/worker-account-route';

/**
 * Decision D10: a Claude/Codex sign-in is node-local. The controller sends only
 * a profile ID and the identity it expects; the worker verifies its own
 * binding and derives its own home. Credentials and paths never travel.
 */

const base = { instanceId: 'session-1', cliType: 'claude', workingDirectory: '/work/repo' };

const mockExecFile = vi.mocked(execFile);
const WORKER_AUTH_LIST = '┌  Credentials\n●  aio-mimo-max-b-1a2b api\n●  Xiaomi Token Plan (Europe) api\n└  2 credentials\n';

function workerAuthListReply(error: ExecFileException | null, stdout: string): void {
  mockExecFile.mockImplementation((file, args, options, callback) => {
    expect(file).toBe('opencode');
    expect(args).toEqual(['auth', 'list']);
    expect(options).toMatchObject({ timeout: 8_000, maxBuffer: 256 * 1024 });
    if (!callback) throw new Error('Missing auth-list callback');
    queueMicrotask(() => callback(error, stdout, 'stderr-placeholder'));
    return {} as ChildProcess;
  });
}

describe('default worker OpenCode account advertisement', () => {
  beforeEach(() => {
    mockExecFile.mockReset();
    _resetWorkerOpenCodeAccountCacheForTesting();
  });

  afterEach(() => {
    _resetWorkerOpenCodeAccountCacheForTesting();
  });

  it.each([
    ['nonzero exit', { code: 7 }],
    ['timeout', { killed: true, signal: 'SIGTERM' }],
    ['signal termination', { signal: 'SIGKILL' }],
    ['buffer overflow', { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }],
    ['spawn failure', { code: 'ENOENT' }],
  ] as const)('advertises no accounts after %s with valid-looking output', async (_name, properties) => {
    workerAuthListReply(Object.assign(new Error('error-placeholder'), properties), WORKER_AUTH_LIST);
    expect(await listWorkerOpenCodeAccountProfileIds()).toEqual([]);
    expect(mockExecFile).toHaveBeenCalledOnce();
    expect(mockExecFile).toHaveBeenCalledWith('opencode', ['auth', 'list'],
      expect.objectContaining({ timeout: 8_000, maxBuffer: 256 * 1024 }), expect.any(Function));
  });

  it('advertises no accounts when starting the subprocess throws', async () => {
    mockExecFile.mockImplementation(() => { throw Object.assign(new Error('error-placeholder'), { code: 'ENOENT' }); });
    expect(await listWorkerOpenCodeAccountProfileIds()).toEqual([]);
  });

  it.each([
    { name: 'custom and legacy display names', output: WORKER_AUTH_LIST, ids: ['legacy', 'max-b-1a2b'] },
    { name: 'legacy provider ID', output: WORKER_AUTH_LIST.replace('Xiaomi Token Plan (Europe)', 'xiaomi-token-plan-ams'), ids: ['legacy', 'max-b-1a2b'] },
    { name: 'zero credentials', output: '┌  Credentials\n└  0 credentials\n', ids: [] },
    { name: 'empty output', output: '', ids: [] },
    { name: 'malformed output', output: 'unexpected output', ids: [] },
  ])('retains successful-command advertisement for $name', async ({ output, ids }) => {
    workerAuthListReply(null, output);
    expect(await listWorkerOpenCodeAccountProfileIds()).toEqual(ids);
    expect(mockExecFile).toHaveBeenCalledOnce();
  });

  it('caches an empty failed read until expiry and then reads the current sign-in', async () => {
    workerAuthListReply(Object.assign(new Error('error-placeholder'), { code: 7 }), WORKER_AUTH_LIST);
    expect(await listWorkerOpenCodeAccountProfileIds(undefined, () => 1000)).toEqual([]);
    workerAuthListReply(null, WORKER_AUTH_LIST);
    expect(await listWorkerOpenCodeAccountProfileIds(undefined, () => 1001)).toEqual([]);
    expect(await listWorkerOpenCodeAccountProfileIds(undefined, () => 62_000)).toEqual(['legacy', 'max-b-1a2b']);
    expect(mockExecFile).toHaveBeenCalledTimes(2);
  });
});

describe('instance.spawn account route metadata', () => {
  it('accepts provider, profile ID, expected identity and routing source', () => {
    const result = InstanceSpawnParamsSchema.safeParse({
      ...base,
      accountRoute: { provider: 'claude', profileId: 'max-b-1a2b', expectedIdentity: 'b@example.com', source: 'failover' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts MiMo routes with their Token Plan region and rejects unknown regions', () => {
    const ok = InstanceSpawnParamsSchema.safeParse({
      ...base,
      cliType: 'opencode',
      accountRoute: { provider: 'opencode', profileId: 'max-b-1a2b', region: 'ams', source: 'failover' },
    });
    expect(ok.success).toBe(true);
    expect(InstanceSpawnParamsSchema.safeParse({
      ...base,
      accountRoute: { provider: 'opencode', profileId: 'max-b-1a2b', region: 'moon' },
    }).success).toBe(false);
  });

  it('rejects unsafe profile IDs and unknown providers', () => {
    for (const accountRoute of [
      { provider: 'claude', profileId: '../escape' },
      { provider: 'claude', profileId: 'Upper' },
      { provider: 'gemini', profileId: 'max-b' },
    ]) {
      expect(InstanceSpawnParamsSchema.safeParse({ ...base, accountRoute }).success, JSON.stringify(accountRoute)).toBe(false);
    }
  });

  it('strips anything path- or token-shaped smuggled through the route', () => {
    const parsed = InstanceSpawnParamsSchema.parse({
      ...base,
      accountRoute: { provider: 'codex', profileId: 'pro-b', codexHome: '/home/attacker/.codex', token: 'placeholder' },
    });
    expect(Object.keys(parsed.accountRoute ?? {}).sort()).toEqual(['profileId', 'provider']);
  });
});

describe('RemoteCliAdapter account route', () => {
  it('sends only safe route metadata to the worker', async () => {
    const sendRpc = vi.fn(async () => ({ instanceId: 'session-1' }));
    const connection = { sendRpc } as unknown as WorkerNodeConnectionServer;
    const adapter = new RemoteCliAdapter(connection, 'node-1', 'claude', {
      sessionId: 'session-1',
      workingDirectory: '/work/repo',
      accountRoute: { provider: 'claude', profileId: 'max-b-1a2b', source: 'failover', executionNodeId: 'node-1', expectedIdentity: 'b@example.com', profileLabel: 'Max B' },
    });
    await adapter.spawn();
    const params = (sendRpc.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(params['accountRoute']).toEqual({ provider: 'claude', profileId: 'max-b-1a2b', expectedIdentity: 'b@example.com', source: 'failover' });
  });

  it('omits the route for an unrouted spawn', async () => {
    const sendRpc = vi.fn(async () => ({ instanceId: 'session-1' }));
    const adapter = new RemoteCliAdapter({ sendRpc } as unknown as WorkerNodeConnectionServer, 'node-1', 'claude', {
      sessionId: 'session-1',
      workingDirectory: '/work/repo',
    });
    await adapter.spawn();
    expect((sendRpc.mock.calls[0] as unknown[])[2]).not.toHaveProperty('accountRoute');
  });

  it('sends the MiMo Token Plan region — never a home or key', async () => {
    const sendRpc = vi.fn(async () => ({ instanceId: 'session-1' }));
    const adapter = new RemoteCliAdapter({ sendRpc } as unknown as WorkerNodeConnectionServer, 'node-1', 'opencode', {
      sessionId: 'session-1',
      workingDirectory: '/work/repo',
      accountRoute: { provider: 'opencode', profileId: 'max-b-1a2b', source: 'failover', executionNodeId: 'node-1', region: 'sgp', profileLabel: 'MiMo B' },
    });
    await adapter.spawn();
    const params = (sendRpc.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect(params['accountRoute']).toEqual({ provider: 'opencode', profileId: 'max-b-1a2b', expectedIdentity: null, source: 'failover', region: 'sgp' });
  });
});

describe('worker-side account binding', () => {
  let manager: LocalInstanceManager;

  beforeEach(() => {
    bindingState.current = { state: 'authenticated' };
    bindingState.profiles = [];
    mockAdapter = Object.assign(new EventEmitter(), { spawn: vi.fn(async () => 1), terminate: vi.fn(async () => undefined) });
    mockCreateCliAdapter.mockClear();
    manager = new LocalInstanceManager(['/tmp/allowed']);
  });

  const spawn = (cliType: string, accountRoute?: Record<string, unknown>, instanceId = 'pool-1') =>
    manager.spawn({
      instanceId,
      cliType,
      workingDirectory: '/tmp/allowed/project',
      ...(accountRoute ? { accountRoute } : {}),
    } as never);

  it('spawns under a route re-materialised for this node after verifying its own sign-in', async () => {
    await spawn('codex', { provider: 'codex', profileId: 'pro-b', expectedIdentity: 'b@example.com', source: 'explicit' });
    expect(bindingState.profiles).toEqual([
      expect.objectContaining({ nodeId: 'worker', profile: expect.objectContaining({ id: 'pro-b', provider: 'codex', expectedIdentity: 'b@example.com', isLegacy: false }) }),
    ]);
    const options = mockCreateCliAdapter.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options['accountRoute']).toEqual({ provider: 'codex', profileId: 'pro-b', source: 'persisted', executionNodeId: 'worker', expectedIdentity: 'b@example.com' });
  });

  it('refuses when the profile is not signed in here, or as someone else', async () => {
    bindingState.current = { state: 'unauthenticated' };
    await expect(spawn('claude', { provider: 'claude', profileId: 'max-b' })).rejects.toThrow(/not signed in on this node/);
    bindingState.current = { state: 'identity-mismatch' };
    await expect(spawn('claude', { provider: 'claude', profileId: 'max-b' })).rejects.toThrow(/different account on this node/);
    bindingState.current = { state: 'unavailable', errorCode: 'check-failed' };
    await expect(spawn('claude', { provider: 'claude', profileId: 'max-b' })).rejects.toThrow(/could not be read on this node \(check-failed\)/);
    expect(mockCreateCliAdapter).not.toHaveBeenCalled();
  });

  it('refuses a route for another provider or with an unsafe ID (the dispatcher does not re-parse)', async () => {
    await expect(spawn('claude', { provider: 'codex', profileId: 'pro-b' })).rejects.toThrow(/codex account route was sent with a claude spawn/);
    await expect(materializeWorkerAccountRoute('claude', { provider: 'claude', profileId: '../x' })).rejects.toThrow(/invalid profile ID/);
    expect(bindingState.profiles).toEqual([]);
  });

  it('spawns an unrouted Claude session exactly as before', async () => {
    await spawn('claude');
    expect(bindingState.profiles).toEqual([]);
    expect(mockCreateCliAdapter.mock.calls[0]?.[1]).not.toHaveProperty('accountRoute');
  });

  it('re-materialises a MiMo route with its region and refuses one without', async () => {
    await spawn('opencode', { provider: 'opencode', profileId: 'max-b-1a2b', region: 'ams', source: 'failover' });
    expect(bindingState.profiles).toEqual([
      expect.objectContaining({
        nodeId: 'worker',
        profile: expect.objectContaining({ id: 'max-b-1a2b', provider: 'opencode', region: 'ams', isLegacy: false }),
      }),
    ]);
    const options = mockCreateCliAdapter.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(options['accountRoute']).toEqual({
      provider: 'opencode',
      profileId: 'max-b-1a2b',
      source: 'persisted',
      executionNodeId: 'worker',
      region: 'ams',
    });
    // Without a region the worker cannot derive the provider name or its model
    // metadata, so the spawn is refused before any binding check.
    await expect(spawn('opencode', { provider: 'opencode', profileId: 'max-c-2b3c' }, 'pool-2'))
      .rejects.toThrow(/no Token Plan region/);
    expect(bindingState.profiles).toHaveLength(1);
  });
});

describe('account profile advertisement and placement', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'worker-account-profiles-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('lists profile homes by ID only, skipping files and unsafe names', () => {
    mkdirSync(join(root, 'claude', 'max-b'), { recursive: true });
    mkdirSync(join(root, 'claude', 'Not Safe'), { recursive: true });
    writeFileSync(join(root, 'claude', 'max-c'), '');
    expect(listWorkerAccountProfileIds((provider) => join(root, provider))).toEqual({ claude: ['max-b'] });
  });

  it('heartbeats carry the advertisement', () => {
    const parsed = NodeHeartbeatParamsSchema.parse({
      nodeId: 'node-1',
      activeInstances: 0,
      capabilities: capabilities({ accountProfileIds: { claude: ['max-b'] } }),
    });
    expect(parsed.capabilities.accountProfileIds).toEqual({ claude: ['max-b'] });
  });

  it('keeps the MiMo advertisement through the heartbeat wire round-trip', () => {
    // Regression (completion-gate finding 1): the schema used to declare only
    // claude/codex keys, so the worker's `opencode` advertisement was silently
    // stripped at the coordinator's parse and per-machine status could never
    // show a MiMo sign-in.
    const parsed = NodeHeartbeatParamsSchema.parse({
      nodeId: 'node-1',
      activeInstances: 0,
      capabilities: capabilities({ accountProfileIds: { opencode: ['max-b-1a2b'] } }),
    });
    expect(parsed.capabilities.accountProfileIds).toEqual({ opencode: ['max-b-1a2b'] });
  });

  it('drops a malformed advertisement without rejecting the heartbeat', () => {
    for (const accountProfileIds of [{ claude: ['../escape'] }, { opencode: ['../escape'] }]) {
      const parsed = NodeHeartbeatParamsSchema.parse({
        nodeId: 'node-1',
        activeInstances: 2,
        capabilities: capabilities({ accountProfileIds }),
      });
      expect(parsed.activeInstances).toBe(2);
      expect(parsed.capabilities.accountProfileIds).toBeUndefined();
    }
  });

  it('prefers a node that has the chosen profile without excluding the others', () => {
    WorkerNodeRegistry._resetForTesting();
    const registry = WorkerNodeRegistry.getInstance();
    registry.registerNode(node('a', capabilities()));
    registry.registerNode(node('b', capabilities({ accountProfileIds: { codex: ['pro-b'] } })));
    expect(registry.selectNode({ prefersAccountProfile: { provider: 'codex', profileId: 'pro-b' } })?.id).toBe('b');
    expect(registry.selectNode({ prefersAccountProfile: { provider: 'claude', profileId: 'pro-b' } })).not.toBeNull();
  });

  it('advertises MiMo accounts from the OpenCode key store names (names only)', async () => {
    const authList = [
      '┌  Credentials ~/.local/share/opencode/auth.json',
      '│',
      '●  aio-mimo-max-b-1a2b api',
      '│',
      '●  aio-mimo-max-c-2b3c api',
      '│',
      '●  Xiaomi Token Plan (Europe) api',
      '│',
      '●  xiaomi-token-plan-ams api',
      '│',
      '└  4 credentials',
    ].join('\n');
    _resetWorkerOpenCodeAccountCacheForTesting();
    const ids = await listWorkerOpenCodeAccountProfileIds(async () => authList);
    // `aio-mimo-*` names are the derived accounts; the built-in region
    // credential is the legacy account under BOTH printed forms (display label
    // and provider id) and is advertised exactly once. Nothing path-shaped leaks.
    expect(ids).toEqual(['legacy', 'max-b-1a2b', 'max-c-2b3c']);
    // Cached: a second call within the window does not re-read the key store.
    const read = vi.fn(async () => authList);
    await listWorkerOpenCodeAccountProfileIds(read);
    expect(read).not.toHaveBeenCalled();
    _resetWorkerOpenCodeAccountCacheForTesting();
    expect(await listWorkerOpenCodeAccountProfileIds(async () => null)).toEqual([]);
  });
});

function capabilities(overrides: Partial<WorkerNodeCapabilities> = {}): WorkerNodeCapabilities {
  return {
    platform: 'linux', arch: 'x64', cpuCores: 4, totalMemoryMB: 8192, availableMemoryMB: 4096,
    supportedClis: ['claude', 'codex'], hasBrowserRuntime: false, hasBrowserMcp: false, hasAndroidMcp: false,
    hasDocker: false, maxConcurrentInstances: 4, workingDirectories: ['/workspace'], browsableRoots: ['/workspace'],
    discoveredProjects: [], ...overrides,
  };
}

function node(id: string, caps: WorkerNodeCapabilities): WorkerNodeInfo {
  return { id, name: `node-${id}`, address: '192.0.2.1', capabilities: caps, status: 'connected', activeInstances: 0, latencyMs: 20 };
}
