import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { UnifiedSpawnOptions } from '../adapter-factory.types';
import type { WorkerNodeCapabilities } from '../../../../shared/types/worker-node.types';

const mocks = vi.hoisted(() => ({
  sendRpc: vi.fn(),
  warn: vi.fn(),
  capSetting: undefined as number | undefined,
  getConnection: vi.fn(),
  capabilities: undefined as Partial<WorkerNodeCapabilities> | undefined,
}));
vi.mock('../claude-output-caps', async importOriginal => {
  const actual = await importOriginal<typeof import('../claude-output-caps')>();
  return { ...actual, resolveClaudeBashOutputMaxChars: (explicit?: number) => actual.resolveClaudeBashOutputMaxChars(explicit, () => mocks.capSetting) };
});
vi.mock('../../../logging/logger', () => ({ getLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() }) }));
vi.mock('../../../remote-node/worker-node-connection', () => ({
  getWorkerNodeConnectionServer: mocks.getConnection,
}));
vi.mock('../../../remote-node/worker-node-registry', () => {
  const registry = Object.assign(new EventEmitter(), {
    getNode: (nodeId: string) => (nodeId === 'worker-node' && mocks.capabilities
      ? { id: nodeId, capabilities: mocks.capabilities }
      : undefined),
  });
  return { getWorkerNodeRegistry: () => registry };
});

import { createCliAdapter } from '../adapter-factory';
import { RemoteCliAdapter } from '../remote-cli-adapter';
import { resolveRemoteClaudeSpawnPolicy } from '../remote-claude-spawn-policy';
import { applyInstanceSpawnPolicy } from '../../../instance/lifecycle/instance-spawn-policy';

const remoteLocation = { type: 'remote' as const, nodeId: 'worker-node' };
const baseOptions: UnifiedSpawnOptions = {
  workingDirectory: '/repo',
  sessionId: 'remote-claude',
  accountRoute: {
    provider: 'claude',
    profileId: 'legacy',
    source: 'persisted',
    executionNodeId: 'worker-node',
  },
};
const policies: { name: string; policy: Partial<UnifiedSpawnOptions> }[] = [
  { name: 'read-only review', policy: { readOnlyReview: true } },
  { name: 'context ceiling', policy: { contextCeilingTokens: 100_000 } },
  { name: 'turn limit', policy: { maxTurns: 8 } },
  { name: 'budget cap', policy: { maxBudgetUsd: 1 } },
  { name: 'machine-session policy', policy: { machineSession: 'review' } },
  { name: 'run_on_node machine session', policy: { machineSession: 'node-run' } },
  {
    name: 'read-only yolo reviewer with limits',
    policy: { readOnlyReview: true, yoloMode: true, machineSession: 'review', maxTurns: 8, contextCeilingTokens: 100_000 },
  },
];

describe('adapter factory — remote Claude policy enforcement', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capSetting = undefined;
    mocks.capabilities = undefined;
    mocks.sendRpc.mockResolvedValue({ instanceId: 'remote-claude' });
    mocks.getConnection.mockReturnValue({ sendRpc: mocks.sendRpc, isNodeConnected: () => true });
  });

  describe('on a worker that does not advertise the Claude spawn policy', () => {
    it.each(policies)('refuses $name before constructing a remote connection', ({ policy }) => {
      mocks.capabilities = { platform: 'win32' };
      expect(() => createCliAdapter('claude', { ...baseOptions, ...policy }, remoteLocation))
        .toThrow('Remote Claude execution cannot enforce');
      expect(mocks.getConnection).not.toHaveBeenCalled();
    });

    it.each<Partial<WorkerNodeCapabilities> | undefined>([
      undefined,
      { claudeSpawnPolicy: '1' as unknown as 1 },
      { claudeSpawnPolicy: 3 as unknown as 1 },
    ])('fails closed for an unknown node or a malformed capability (%j)', (capabilities) => {
      mocks.capabilities = capabilities;
      expect(() => createCliAdapter('claude', { ...baseOptions, machineSession: 'node-run' }, remoteLocation))
        .toThrow('Remote Claude execution cannot enforce');
    });

    it.each<Partial<UnifiedSpawnOptions>>([
      {},
      { readOnlyReview: false, contextCeilingTokens: 0, maxTurns: 0, maxBudgetUsd: 0 },
    ])('preserves ordinary remote sessions with no active policy (%j)', (options) => {
      const adapter = createCliAdapter('claude', { ...baseOptions, ...options }, remoteLocation);

      expect(adapter).toBeInstanceOf(RemoteCliAdapter);
      expect(adapter.getName()).toBe('remote:claude');
      expect(mocks.getConnection).toHaveBeenCalledTimes(1);
    });
  });

  describe('on a worker that enforces the Claude spawn policy', () => {
    beforeEach(() => { mocks.capabilities = { platform: 'win32', claudeSpawnPolicy: 1 }; });

    it.each(policies)('accepts $name and carries it to the worker', async ({ policy }) => {
      const adapter = createCliAdapter('claude', { ...baseOptions, ...policy }, remoteLocation);
      expect(adapter).toBeInstanceOf(RemoteCliAdapter);

      await (adapter as RemoteCliAdapter).spawn();

      const expected = resolveRemoteClaudeSpawnPolicy({ ...baseOptions, ...policy });
      expect(expected).toBeDefined();
      expect(mocks.sendRpc).toHaveBeenCalledWith('worker-node', 'instance.spawn', expect.objectContaining({
        cliType: 'claude',
        claudeSpawnPolicy: expected,
      }));
    });

    it('sends no policy for an ordinary session', async () => {
      const adapter = createCliAdapter('claude', baseOptions, remoteLocation) as RemoteCliAdapter;
      await adapter.spawn();

      expect(mocks.sendRpc.mock.calls[0][2]).not.toHaveProperty('claudeSpawnPolicy');
    });

    it('refuses at spawn time if the node re-registered on a build without support', async () => {
      const adapter = createCliAdapter('claude', { ...baseOptions, machineSession: 'node-run' }, remoteLocation) as RemoteCliAdapter;
      mocks.capabilities = { platform: 'win32' };

      await expect(adapter.spawn()).rejects.toThrow('Remote Claude execution cannot enforce');
      expect(mocks.sendRpc).not.toHaveBeenCalled();
    });

    it('carries the run_on_node machine session stamped by the instance spawn policy', async () => {
      // orchestrator-tools-step.ts spawnRemoteInstance: metadata for a call made by an agent session.
      const options = applyInstanceSpawnPolicy('claude', {
        id: 'run-on-node-child',
        depth: 0,
        parentId: null,
        additionalDirectories: undefined,
        metadata: { spawnDepth: 1, hideFromProjectRail: true, spawnParentInstanceId: 'caller-session' },
      }, { ...baseOptions, yoloMode: true });
      expect(options.machineSession).toBe('node-run');

      const adapter = createCliAdapter('claude', options, remoteLocation) as RemoteCliAdapter;
      await adapter.spawn();

      expect(mocks.sendRpc).toHaveBeenCalledWith('worker-node', 'instance.spawn', expect.objectContaining({
        yoloMode: true,
        claudeSpawnPolicy: expect.objectContaining({ machineSession: 'node-run' }),
      }));
    });
  });

  it('keeps policy-bearing local Claude on the canonical adapter', () => {
    const adapter = createCliAdapter('claude', {
      ...baseOptions,
      readOnlyReview: true,
      yoloMode: true,
      machineSession: 'review',
      maxTurns: 8,
      contextCeilingTokens: 100_000,
    });

    expect(adapter.getName()).toBe('claude-cli');
    expect(adapter).not.toBeInstanceOf(RemoteCliAdapter);
    expect(mocks.getConnection).not.toHaveBeenCalled();
  });
});

describe('resolveRemoteClaudeSpawnPolicy', () => {
  it('resolves the settings-derived context ceiling the way a local Claude spawn does', () => {
    const readCeiling = vi.fn((machineSession: boolean) => (machineSession ? 300_000 : undefined));

    expect(resolveRemoteClaudeSpawnPolicy({ ...baseOptions, machineSession: 'node-run' }, readCeiling))
      .toEqual({ machineSession: 'node-run', contextCeilingTokens: 300_000 });
    expect(readCeiling).toHaveBeenLastCalledWith(true);
    expect(resolveRemoteClaudeSpawnPolicy(baseOptions, readCeiling)).toBeUndefined();
    expect(readCeiling).toHaveBeenLastCalledWith(false);
  });

  it('prefers an explicit context ceiling over the setting', () => {
    expect(resolveRemoteClaudeSpawnPolicy({ ...baseOptions, contextCeilingTokens: 150_000 }, () => 900_000))
      .toEqual({ contextCeilingTokens: 150_000 });
  });

  it('rejects a value the worker could not accept instead of sending it', () => {
    expect(() => resolveRemoteClaudeSpawnPolicy({ ...baseOptions, maxTurns: 2.5 }, () => undefined)).toThrow();
  });
});


describe('remote spawn policy v2', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.capSetting = undefined;
    mocks.capabilities = { platform: 'win32', claudeSpawnPolicy: 2, cliVersions: { claude: '2.1.296' } };
    mocks.sendRpc.mockResolvedValue({ instanceId: 'remote-claude' });
    mocks.getConnection.mockReturnValue({ sendRpc: mocks.sendRpc, isNodeConnected: () => true });
  });

  it('carries the session kind and new Claude options on a v2 worker', async () => {
    const options = { ...baseOptions, sessionKind: 'review' as const, fastMode: true, name: 'review',
      fallbackModel: 'sonnet', jsonSchema: '{}', bare: false, residentClaude: true,
      excludeDynamicSystemPromptSections: false, systemPromptMode: 'replace' as const, bashOutputMaxChars: 12000 };
    const adapter = createCliAdapter('claude', options, remoteLocation) as RemoteCliAdapter;
    await adapter.spawn();
    expect(mocks.sendRpc.mock.calls[0][2].claudeSpawnPolicy).toMatchObject({ sessionKind: 'review', fastMode: true,
      name: 'review', fallbackModel: 'sonnet', jsonSchema: '{}', bare: false, residentClaude: true,
      excludeDynamicSystemPromptSections: false, systemPromptMode: 'replace', bashOutputMaxChars: 12000 });
  });

  it('keeps v1 sessions working without sending the v2 session-kind field', async () => {
    mocks.capabilities = { claudeSpawnPolicy: 1 };
    const adapter = createCliAdapter('claude', { ...baseOptions, sessionKind: 'child', maxTurns: 8 }, remoteLocation) as RemoteCliAdapter;
    await adapter.spawn();
    expect(mocks.sendRpc.mock.calls[0][2].claudeSpawnPolicy).toEqual({ maxTurns: 8 });
  });

  it.each([false, true])('preserves fresh and resumed lifecycle spawns on v1 with fast mode %j', async fastMode => {
    mocks.capabilities = { claudeSpawnPolicy: 1 };
    for (const resume of [false, true]) {
      // instance-lifecycle builds this shape for every normal Claude session,
      // including explicit booleans, not just optional helper-session metadata.
      const options = { ...baseOptions, bare: false, fastMode, residentClaude: true,
        sessionKind: 'chat' as const, resume, machineSession: 'review' as const, maxTurns: 8 };
      const adapter = createCliAdapter('claude', options, remoteLocation) as RemoteCliAdapter;
      try {
        await adapter.spawn();
        expect(mocks.sendRpc.mock.calls.at(-1)?.[2]).toMatchObject({ resume,
          claudeSpawnPolicy: { machineSession: 'review', maxTurns: 8 } });
        expect(mocks.sendRpc.mock.calls.at(-1)?.[2].claudeSpawnPolicy)
          .toEqual({ machineSession: 'review', maxTurns: 8 });
      } finally { adapter.forceCleanup(); }
    }
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('original Claude options'),
      expect.objectContaining({ omittedOptions: ['fastMode', 'residentClaude', 'bare'] }));
  });

  it.each([undefined, '2.1.260', 'unknown'])('omits the requested cap when the worker CLI is %j', async version => {
    mocks.capabilities = { claudeSpawnPolicy: 2, cliVersions: version ? { claude: version } : {} };
    const adapter = createCliAdapter('claude', { ...baseOptions, maxTurns: 8, bashOutputMaxChars: 12000 }, remoteLocation) as RemoteCliAdapter;
    await adapter.spawn();
    expect(mocks.sendRpc.mock.calls[0][2].claudeSpawnPolicy).toEqual({ maxTurns: 8 });
    expect(mocks.warn).toHaveBeenCalledWith(expect.stringContaining('without the requested cap'), expect.objectContaining({ minimumVersion: '2.1.261' }));
  });

  it('never sends the coordinator RTK executable path', async () => {
    const adapter = createCliAdapter('claude', { ...baseOptions, rtk: { enabled: true, binaryPath: '/coordinator/rtk' } }, remoteLocation) as RemoteCliAdapter;
    await adapter.spawn();
    expect(mocks.sendRpc.mock.calls[0][2].rtk).toEqual({ enabled: true });
    expect(JSON.stringify(mocks.sendRpc.mock.calls[0][2])).not.toContain('/coordinator/rtk');
  });
});


it('carries Codex session classification on a new worker without a Claude policy', async () => {
  mocks.capabilities = { claudeSpawnPolicy: 2 };
  mocks.sendRpc.mockResolvedValue({ instanceId: 'remote-codex' });
  mocks.getConnection.mockReturnValue({ sendRpc: mocks.sendRpc, isNodeConnected: () => true });
  const adapter = createCliAdapter('codex', { ...baseOptions, sessionKind: 'plan-queue',
    accountRoute: { provider: 'codex', profileId: 'legacy', source: 'persisted', executionNodeId: 'worker-node' } }, remoteLocation) as RemoteCliAdapter;
  await adapter.spawn();
  expect(mocks.sendRpc.mock.calls.at(-1)?.[2]).toMatchObject({ sessionKind: 'plan-queue' });
  expect(mocks.sendRpc.mock.calls.at(-1)?.[2]).not.toHaveProperty('claudeSpawnPolicy');
});


it('applies the configured default to ordinary local and remote Claude sessions', async () => {
  mocks.capSetting = 12_000;
  mocks.capabilities = { claudeSpawnPolicy: 2, cliVersions: { claude: '2.1.296' } };
  const local = createCliAdapter('claude', baseOptions) as unknown as { spawnOptions: { bashOutputMaxChars?: number } };
  expect(local.spawnOptions.bashOutputMaxChars).toBe(12_000);
  mocks.sendRpc.mockResolvedValue({ instanceId: 'remote-claude' });
  mocks.getConnection.mockReturnValue({ sendRpc: mocks.sendRpc, isNodeConnected: () => true });
  const remote = createCliAdapter('claude', baseOptions, remoteLocation) as RemoteCliAdapter;
  try {
    await remote.spawn();
    expect(mocks.sendRpc.mock.calls.at(-1)?.[2].claudeSpawnPolicy).toEqual({ bashOutputMaxChars: 12_000 });
  } finally { remote.forceCleanup(); mocks.capSetting = undefined; }
});
