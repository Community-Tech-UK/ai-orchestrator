import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Step 6 (A0-S): a `run_on_node` session is started by a machine on a worker,
 * so its metadata must carry `spendPurpose: 'remote-node'`. The Costs page
 * files the turns of that session under "Remote machines" only while the tag
 * is on the config handed to `createInstance`. The mock block mirrors
 * `orchestrator-tools-step.spec.ts`, trimmed to what this one path needs.
 */
const captured = vi.hoisted(() => ({
  spawnRemoteInstance: null as null | ((args: { node?: string; prompt: string }) => Promise<unknown>),
  node: {
    id: 'node-1',
    name: 'windows-pc',
    status: 'connected',
    activeInstances: 0,
    capabilities: {
      platform: 'win32',
      arch: 'x64',
      supportedClis: ['claude'],
      hasBrowserRuntime: false,
      hasBrowserMcp: false,
      hasAndroidMcp: false,
      workingDirectories: ['C:\\work'],
    },
  },
}));

vi.mock('../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    get: vi.fn(() => 3),
    getAll: vi.fn(() => ({ maxSpawnDepth: 3, maxTotalInstances: 20 })),
  }),
}));
vi.mock('../mcp/orchestrator-tools-rpc-server', () => ({
  initializeOrchestratorToolsRpcServer: vi.fn(async (options: {
    spawnRemoteInstance: typeof captured.spawnRemoteInstance;
  }) => {
    captured.spawnRemoteInstance = options.spawnRemoteInstance;
    return {};
  }),
}));
vi.mock('../operator/operator-database', () => ({
  defaultOperatorDbPath: () => '/tmp/operator.db',
  getOperatorDatabase: () => ({ db: { id: 'operator-db' } }),
}));
vi.mock('../mcp/secret-storage', () => ({ getMcpSecretStorage: () => ({ id: 'secret-storage' }) }));
vi.mock('../graph/graph-token-store', () => ({ GraphTokenStore: class {} }));
vi.mock('../graph/graph-auth', () => ({
  GraphAuthManager: class {
    connectAccount = vi.fn();
    listAccounts = vi.fn();
    getAccessToken = vi.fn();
  },
}));
vi.mock('../graph/graph-client', () => ({ GraphClient: class {} }));
vi.mock('../orchestration/permission-registry', () => ({
  getPermissionRegistry: () => ({ requestPermission: vi.fn() }),
}));
vi.mock('../remote-node', () => ({
  getWorkerNodeConnectionServer: () => ({}),
  getRemoteNodeRosterService: () => ({ list: () => [captured.node] }),
  getWorkerNodeRegistry: () => ({ getAllNodes: () => [captured.node], getNode: vi.fn(), selectNode: vi.fn() }),
  isAndroidAutomationReady: () => false,
}));
vi.mock('../remote-node/service-rpc-client', () => ({
  sendServiceRpc: vi.fn(async () => ({
    ok: true,
    platform: 'win32',
    identity: { username: 'fixture', homeDirectory: 'C:\\Users\\fixture' },
    provider: { provider: 'claude', available: true, authenticated: true },
  })),
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
vi.mock('../automations/automation-events', () => ({ getAutomationEvents: vi.fn() }));
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
vi.mock('../chats/chat-transcript-bridge', () => ({ flushChatTranscriptSource: vi.fn() }));
vi.mock('../local-ai-guard/local-ai-runtime', () => ({ getLocalAiGuardRuntime: () => ({}) }));
vi.mock('../rlm/auxiliary-llm-service', () => ({
  getAuxiliaryLlmService: () => ({ discoverCandidates: vi.fn() }),
}));

import type { AppSettings } from '@shared/types/settings.types';
import { resolveSpendPurpose } from '../core/system/spend-purpose';
import {
  _resetCrossSessionMessagingServiceForTesting,
  getCrossSessionMessagingService,
} from '../instance/cross-session-messaging';
import { createOrchestratorToolsStep } from './orchestrator-tools-step';

describe('run_on_node spend purpose (Step 6, A0-S)', () => {
  beforeEach(() => {
    captured.spawnRemoteInstance = null;
    _resetCrossSessionMessagingServiceForTesting();
    getCrossSessionMessagingService({
      getAllInstances: () => [],
      getInstance: () => undefined,
      sendInput: async () => undefined,
      getSettings: () => ({
        interSessionMessaging: {
          enabled: false,
          allowCrossProject: false,
          maxHops: 3,
          rateLimitPerMinute: 10,
        },
      } as unknown as AppSettings),
    });
  });

  it('tags the remote session so its turns file under remote-node', async () => {
    const createInstance = vi.fn(async (config: Record<string, unknown>) => ({
      id: 'inst-1',
      status: 'initializing',
      ...config,
    }));
    const instanceManager = {
      getAllInstances: vi.fn(() => []),
      getInstance: vi.fn(() => undefined),
      createInstance,
    };
    await createOrchestratorToolsStep(instanceManager as never, { sendToRenderer: vi.fn() } as never).fn();

    await captured.spawnRemoteInstance!({ node: 'windows-pc', prompt: 'run the checks' });

    expect(createInstance).toHaveBeenCalledTimes(1);
    const config = createInstance.mock.calls[0]![0] as { metadata?: Record<string, unknown> };
    expect(config.metadata).toMatchObject({ spendPurpose: 'remote-node' });
    expect(resolveSpendPurpose({ metadata: config.metadata }).purpose).toBe('remote-node');
  });
});
