import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({
  initializeOptions: null as null | {
    listRemoteNodes?: () => Promise<unknown>;
    spawnRemoteInstance?: (args: {
      node?: string;
      prompt: string;
      requiresAndroid?: boolean;
      androidDeviceKind?: 'emulator' | 'physical' | 'any';
    }) => Promise<unknown>;
    updateNodeConfig?: (args: {
      nodeId: string;
      extensionRelay?: { enabled: boolean };
    }) => Promise<unknown>;
    resolveContextEvidence?: (instanceId: string) => unknown;
    calendarTools?: {
      authManager?: unknown;
      graphClient?: unknown;
      writableAccountEmails?: readonly string[];
    };
    authorizeCalendarMutation?: (args: {
      instanceId: string;
      method: string;
      payload: Record<string, unknown>;
    }) => Promise<boolean>;
  },
  settings: {
    graphClientId: 'graph-client-id',
    graphAuthority: 'https://login.microsoftonline.com/common',
    graphScopesJson: '["Calendars.ReadWrite","User.Read"]',
    graphAgentWritableAccountsJson: '["james@communitytech.co.uk"]',
  } as Record<string, unknown>,
  permissionRequest: vi.fn(),
  graphAuthOptions: null as unknown,
  graphClientOptions: null as unknown,
  graphTokenStoreArgs: null as unknown,
  registry: {
    getAllNodes: vi.fn(),
    getNode: vi.fn(),
    selectNode: vi.fn(),
  },
  roster: {
    list: vi.fn(),
  },
  connectionServer: {
    getConnectedNodeIds: vi.fn(),
    isNodeConnected: vi.fn(),
  },
  sendServiceRpc: vi.fn(),
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    get: vi.fn((key: string) => captured.settings[key] ?? 3),
    getAll: vi.fn(() => ({
      maxSpawnDepth: 3,
      maxTotalInstances: 20,
      ...captured.settings,
    })),
  }),
}));

vi.mock('../mcp/orchestrator-tools-rpc-server', () => ({
  initializeOrchestratorToolsRpcServer: vi.fn(async (options) => {
    captured.initializeOptions = options;
    return {};
  }),
}));

vi.mock('../operator/operator-database', () => ({
  defaultOperatorDbPath: () => '/tmp/operator.db',
  getOperatorDatabase: () => ({ db: { id: 'operator-db' } }),
}));

vi.mock('../mcp/secret-storage', () => ({
  getMcpSecretStorage: () => ({ id: 'secret-storage' }),
}));

vi.mock('../graph/graph-token-store', () => ({
  GraphTokenStore: class {
    constructor(...args: unknown[]) {
      captured.graphTokenStoreArgs = args;
    }
  },
}));

vi.mock('../graph/graph-auth', () => ({
  GraphAuthManager: class {
    constructor(options: unknown) {
      captured.graphAuthOptions = options;
    }

    connectAccount = vi.fn();
    listAccounts = vi.fn();
    getAccessToken = vi.fn();
  },
}));

vi.mock('../graph/graph-client', () => ({
  GraphClient: class {
    constructor(options: unknown) {
      captured.graphClientOptions = options;
    }
  },
}));

vi.mock('../orchestration/permission-registry', () => ({
  getPermissionRegistry: () => ({ requestPermission: captured.permissionRequest }),
}));

vi.mock('../remote-node', () => ({
  getWorkerNodeConnectionServer: () => captured.connectionServer,
  getRemoteNodeRosterService: () => captured.roster,
  getWorkerNodeRegistry: () => captured.registry,
  isAndroidAutomationReady: (caps: { hasAndroidMcp?: boolean }) => Boolean(caps.hasAndroidMcp),
}));

vi.mock('../remote-node/service-rpc-client', () => ({
  sendServiceRpc: captured.sendServiceRpc,
}));

vi.mock('../automations', () => ({
  getAutomationRunner: vi.fn(),
  getAutomationScheduler: vi.fn(),
  getAutomationStore: vi.fn(),
}));

vi.mock('../automations/automation-create-service', () => ({
  createAutomationWithScheduling: vi.fn(),
  handlePastOneTimeAutomation: vi.fn(),
}));

vi.mock('../automations/automation-events', () => ({
  getAutomationEvents: vi.fn(),
}));

vi.mock('../automations/automation-tool-impl', () => ({
  createAutomationToolImplementations: vi.fn(() => ({
    createAutomation: vi.fn(),
    deleteAutomation: vi.fn(),
    listAutomations: vi.fn(),
    postponeAutomation: vi.fn(),
    updateAutomation: vi.fn(),
  })),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

vi.mock('../context-evidence/context-evidence-coordinator', () => ({
  getContextEvidenceCoordinator: () => ({ id: 'coordinator' }),
}));

import { createOrchestratorToolsStep } from './orchestrator-tools-step';
import { COORDINATOR_TO_NODE } from '../remote-node/worker-node-rpc';

describe('createOrchestratorToolsStep settings node-config integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    captured.initializeOptions = null;
    captured.graphAuthOptions = null;
    captured.graphClientOptions = null;
    captured.graphTokenStoreArgs = null;
    captured.settings = {
      graphClientId: 'graph-client-id',
      graphAuthority: 'https://login.microsoftonline.com/common',
      graphScopesJson: '["Calendars.ReadWrite","User.Read"]',
      graphAgentWritableAccountsJson: '["james@communitytech.co.uk"]',
    };
    captured.permissionRequest.mockResolvedValue({
      requestId: 'permission-1',
      granted: true,
      decidedBy: 'user',
      decidedAt: Date.now(),
    });
    captured.roster.list.mockImplementation(() => captured.registry.getAllNodes());
  });

  it('injects Graph calendar dependencies and requires an explicit user decision per mutation', async () => {
    await startStep();

    expect(captured.graphTokenStoreArgs).toEqual([
      { id: 'operator-db' },
      { id: 'secret-storage' },
    ]);
    expect(captured.graphAuthOptions).toMatchObject({
      clientId: 'graph-client-id',
      authority: 'https://login.microsoftonline.com/common',
      scopes: ['Calendars.ReadWrite', 'User.Read'],
      deviceCodeCallback: expect.any(Function),
    });
    expect(captured.graphClientOptions).toMatchObject({
      tokenProvider: captured.initializeOptions?.calendarTools?.authManager,
    });
    expect(captured.initializeOptions?.calendarTools?.writableAccountEmails).toEqual([
      'james@communitytech.co.uk',
    ]);

    const request = {
      instanceId: 'instance-1',
      method: 'orchestrator_tools.graph_calendar_create_event',
      payload: {
        account: 'james@communitytech.co.uk',
        subject: 'TEST - IGNORE',
        attendees: [{ emailAddress: { address: 'invitee@example.com' } }],
        body: { contentType: 'text', content: 'private content' },
      },
    };
    await expect(
      captured.initializeOptions?.authorizeCalendarMutation?.(request),
    ).resolves.toBe(true);
    expect(captured.permissionRequest).toHaveBeenCalledTimes(1);
    const permission = captured.permissionRequest.mock.calls[0]?.[0];
    expect(permission.description).toContain('may send attendee invitations');
    expect(permission.description).not.toContain('private content');

    captured.permissionRequest.mockResolvedValueOnce({
      requestId: 'permission-2',
      granted: true,
      decidedBy: 'auto_approve',
      decidedAt: Date.now(),
    });
    await expect(
      captured.initializeOptions?.authorizeCalendarMutation?.(request),
    ).resolves.toBe(false);
  });

  it('fails closed when the writable-account setting is malformed', async () => {
    captured.settings['graphAgentWritableAccountsJson'] = 'not-json';

    await startStep();

    expect(captured.initializeOptions?.calendarTools?.writableAccountEmails).toEqual([]);
  });

  it('rejects update_node_config for a disconnected node before sending service RPC', async () => {
    const node = { id: 'node-1', name: 'windows-pc' };
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.registry.getNode.mockReturnValue(node);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue([]);
    captured.connectionServer.isNodeConnected.mockReturnValue(false);
    await startStep();

    await expect(
      captured.initializeOptions?.updateNodeConfig?.({
        nodeId: 'windows-pc',
        extensionRelay: { enabled: true },
      }),
    ).rejects.toThrow(/no worker nodes are currently connected/i);
    expect(captured.sendServiceRpc).not.toHaveBeenCalled();
  });

  it('sends update_node_config through config.update for a connected node', async () => {
    const node = { id: 'node-1', name: 'windows-pc' };
    captured.registry.getAllNodes.mockReturnValue([node]);
    captured.registry.getNode.mockReturnValue(node);
    captured.connectionServer.getConnectedNodeIds.mockReturnValue(['node-1']);
    captured.connectionServer.isNodeConnected.mockReturnValue(true);
    captured.sendServiceRpc.mockResolvedValue({ ok: true });
    await startStep();

    const result = await captured.initializeOptions?.updateNodeConfig?.({
      nodeId: 'windows-pc',
      extensionRelay: { enabled: true },
    });

    expect(captured.sendServiceRpc).toHaveBeenCalledWith(
      'node-1',
      COORDINATOR_TO_NODE.CONFIG_UPDATE,
      { extensionRelay: { enabled: true } },
      30_000,
    );
    expect(result).toMatchObject({
      nodeId: 'node-1',
      nodeName: 'windows-pc',
      updatedBlocks: ['extensionRelay'],
      result: { ok: true },
    });
  });

  it('surfaces Android capabilities from list_remote_nodes', async () => {
    const node = makeNode({ hasAndroidMcp: true });
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep();

    const result = await captured.initializeOptions?.listRemoteNodes?.();

    expect(result).toMatchObject({
      connectedCount: 1,
      totalCount: 1,
      nodes: [
        expect.objectContaining({
          id: 'node-1',
          name: 'windows-pc',
          hasAndroidMcp: true,
          androidAutomation: expect.objectContaining({
            enabled: true,
            avds: ['Pixel_8'],
          }),
        }),
      ],
    });
  });

  it('surfaces worker and extension rollout evidence from list_remote_nodes', async () => {
    const node = makeNode({
      hasBrowserMcp: true,
      workerAgent: {
        version: '0.1.0',
        startedAt: 1_700_000_000_000,
      },
      extensionRelay: {
        enabled: true,
        running: true,
        extensionVersion: '0.2.1',
        extensionReloadedAt: 1_700_000_010_000,
        lastExtensionContactAt: 1_700_000_020_000,
      },
    });
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep();

    const result = await captured.initializeOptions?.listRemoteNodes?.();

    expect(result).toMatchObject({
      nodes: [
        expect.objectContaining({
          id: 'node-1',
          hasBrowserMcp: true,
          workerAgent: {
            version: '0.1.0',
            startedAt: 1_700_000_000_000,
          },
          hasExtensionRelay: true,
          extensionRelay: expect.objectContaining({
            enabled: true,
            running: true,
            extensionVersion: '0.2.1',
            extensionReloadedAt: 1_700_000_010_000,
            lastExtensionContactAt: 1_700_000_020_000,
          }),
        }),
      ],
    });
  });

  it('does not infer platform from fallback capabilities in list_remote_nodes', async () => {
    captured.roster.list.mockReturnValue([
      {
        id: 'node-unknown',
        name: 'paired-worker',
        status: 'disconnected',
        connected: false,
        address: '',
        supportedClis: [],
        hasBrowserRuntime: false,
        hasBrowserMcp: false,
        hasAndroidMcp: false,
        hasDocker: false,
        activeInstances: 0,
        maxConcurrentInstances: 0,
        workingDirectories: [],
        capabilities: {
          platform: 'linux',
          arch: '',
          supportedClis: [],
          hasBrowserRuntime: false,
          hasBrowserMcp: false,
          hasAndroidMcp: false,
          hasDocker: false,
          maxConcurrentInstances: 0,
          workingDirectories: [],
        },
      },
    ]);
    await startStep();

    const result = await captured.initializeOptions?.listRemoteNodes?.();

    expect(result).toMatchObject({
      nodes: [
        expect.objectContaining({
          id: 'node-unknown',
          platform: 'unknown',
        }),
      ],
    });
  });

  it('passes Android placement through run_on_node spawns', async () => {
    const node = makeNode({ hasAndroidMcp: true });
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1',
      status: 'initializing',
      ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc',
      prompt: 'run the Android smoke test',
      requiresAndroid: true,
      androidDeviceKind: 'emulator',
    });

    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({
      forceNodeId: 'node-1',
      nodePlacement: {
        requiresAndroid: true,
        androidDeviceKind: 'emulator',
      },
    }));
  });

  it('injects only canonical enabled instance evidence ownership into MCP', async () => {
    await startStep({
      getInstance: vi.fn((id: string) => id === 'enabled'
        ? {
            contextEvidence: { mode: 'shadow', conversationId: 'ledger-1' },
            contextUsage: { used: 50_000, total: 200_000, percentage: 25 },
          }
        : id === 'off'
          ? { contextEvidence: { mode: 'off', conversationId: 'ledger-2' } }
          : undefined),
    });

    expect(captured.initializeOptions?.resolveContextEvidence?.('enabled')).toEqual({
      coordinator: { id: 'coordinator' },
      conversationId: 'ledger-1',
      mode: 'shadow',
      providerWindowTokens: 200_000,
    });
    expect(captured.initializeOptions?.resolveContextEvidence?.('off')).toBeNull();
    expect(captured.initializeOptions?.resolveContextEvidence?.('missing')).toBeNull();
  });

  it('infers Android placement from an Android run_on_node prompt', async () => {
    const node = makeNode({ hasAndroidMcp: true });
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1',
      status: 'initializing',
      ...config,
    }));
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await captured.initializeOptions!.spawnRemoteInstance!({
      node: 'windows-pc',
      prompt: 'install the APK and test it on the emulator',
    });

    expect(createInstance).toHaveBeenCalledWith(expect.objectContaining({
      nodePlacement: {
        requiresAndroid: true,
        androidDeviceKind: 'any',
      },
    }));
  });

  it('rejects Android run_on_node spawns on nodes without Android readiness', async () => {
    const node = makeNode({ hasAndroidMcp: false });
    const createInstance = vi.fn();
    captured.registry.getAllNodes.mockReturnValue([node]);
    await startStep({ createInstance });

    await expect(
      captured.initializeOptions!.spawnRemoteInstance!({
        node: 'windows-pc',
        prompt: 'run the Android smoke test',
        requiresAndroid: true,
      }),
    ).rejects.toThrow(/not Android-automation ready/i);
    expect(createInstance).not.toHaveBeenCalled();
  });
});

function makeNode(overrides: {
  hasAndroidMcp?: boolean;
  hasBrowserMcp?: boolean;
  workerAgent?: { version: string; startedAt: number };
  extensionRelay?: {
    enabled: boolean;
    running: boolean;
    extensionVersion?: string;
    extensionReloadedAt?: number;
    lastExtensionContactAt?: number;
  };
} = {}) {
  const hasAndroidMcp = overrides.hasAndroidMcp ?? false;
  const hasBrowserMcp = overrides.hasBrowserMcp ?? false;
  return {
    id: 'node-1',
    name: 'windows-pc',
    status: 'connected',
    activeInstances: 0,
    capabilities: {
      platform: 'win32',
      arch: 'x64',
      supportedClis: ['claude'],
      hasBrowserRuntime: true,
      hasBrowserMcp,
      ...(overrides.workerAgent ? { workerAgent: overrides.workerAgent } : {}),
      ...(overrides.extensionRelay
        ? {
            hasExtensionRelay: overrides.extensionRelay.enabled && overrides.extensionRelay.running,
            extensionRelay: overrides.extensionRelay,
          }
        : {}),
      hasAndroidMcp,
      ...(hasAndroidMcp
        ? {
            androidAutomation: {
              enabled: true,
              sdkPath: 'C:\\Android\\Sdk',
              adbVersion: 'Android Debug Bridge version 1.0.41',
              avds: ['Pixel_8'],
              connectedDevices: [],
              emulatorRunning: false,
              hasMaestro: false,
            },
          }
        : {}),
      hasDocker: false,
      maxConcurrentInstances: 4,
      workingDirectories: ['C:\\work'],
    },
  };
}

async function startStep(instanceManagerOverrides: Record<string, unknown> = {}): Promise<void> {
  const instanceManager = {
    getAllInstances: vi.fn(() => []),
    getInstance: vi.fn(() => undefined),
    createInstance: vi.fn(async () => ({
      id: 'inst-default',
      status: 'initializing',
    })),
    ...instanceManagerOverrides,
  };
  const windowManager = { sendToRenderer: vi.fn() };
  await createOrchestratorToolsStep(instanceManager as never, windowManager as never).fn();
}
