import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteBrowserExtensionBridge } from './remote-extension-bridge';
import { BrowserExtensionContactState } from './browser-extension-contact-state';
import { makeRelayNode } from './browser-gateway-service.test-helpers';
import { RpcEventRouter } from '../remote-node/rpc-event-router';
import type { WorkerNodeConnectionServer } from '../remote-node/worker-node-connection';
import { WorkerNodeRegistry } from '../remote-node/worker-node-registry';
import { NODE_TO_COORDINATOR } from '../remote-node/worker-node-rpc';

const mocks = vi.hoisted(() => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  authenticate: vi.fn(() => true),
}));
vi.mock('../logging/logger', () => ({ getLogger: () => mocks.logger }));
vi.mock('../auth/remote-auth', () => ({ getRemoteAuthService: () => ({ validateSessionToken: mocks.authenticate }) }));

const commandId = '00000000-0000-4000-8000-000000000001';
const runtime = { extensionVersion: '0.2.18', extensionStartedAt: 1_000 };

describe('browser reply evidence before rejection', () => {
  let router: RpcEventRouter | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockReturnValue(true);
    WorkerNodeRegistry._resetForTesting();
  });

  afterEach(() => router?.stop());

  function fixture() {
    const commandStore = {
      pollCommand: vi.fn(async () => null), validateCommandHandoff: vi.fn(() => true),
      confirmCommandHandoff: vi.fn(() => true), requeueUndeliveredCommand: vi.fn(() => false),
      resolveCommand: vi.fn(), markReceived: vi.fn(), rejectQueue: vi.fn(),
    };
    const bridge = new RemoteBrowserExtensionBridge({
      service: { attachExistingTab: vi.fn(async () => ({ decision: 'allowed' as const, outcome: 'succeeded' as const, auditId: 'placeholder' })) },
      commandStore, tabStore: { suspendNode: () => 0, restoreNode: () => 0 },
      registry: { getNode: () => makeRelayNode() },
      contactState: new BrowserExtensionContactState({ now: () => 1_000 }),
      reliabilityEvents: { record: vi.fn() }, logger: mocks.logger, now: () => 1_000,
      maxRequestsPerWindow: 1,
    });
    const connection = Object.assign(new EventEmitter(), {
      sendResponse: vi.fn(() => true), sendNotification: vi.fn(() => true), sendRpc: vi.fn(async () => ({})),
    });
    router = new RpcEventRouter(connection as unknown as WorkerNodeConnectionServer, WorkerNodeRegistry.getInstance(), bridge);
    router.start();
    const emit = (method: string, params: Record<string, unknown>) => connection.emit('rpc:request', 'node-1', {
      jsonrpc: '2.0', id: 'rpc-placeholder', method, params,
    });
    return { bridge, commandStore, connection, emit };
  }

  it('records a receipt rejected by exact-runtime validation without accepting it', () => {
    const { bridge, commandStore } = fixture();
    bridge.commandReceived('node-1', { commandId, extensionVersion: '0.1.0', extensionStartedAt: 1_000 });
    expect(commandStore.markReceived).not.toHaveBeenCalled();
    expect(mocks.logger.info).toHaveBeenCalledWith('Browser command receipt rejected', {
      nodeId: 'node-1', commandId, accepted: false, reason: 'runtime_incompatible',
    });
  });

  it('records both arrivals even when a repeated receipt is rate limited before the store', () => {
    const { emit, commandStore } = fixture();
    emit(NODE_TO_COORDINATOR.BROWSER_EXT_COMMAND_RECEIVED, { ...runtime, commandId });
    emit(NODE_TO_COORDINATOR.BROWSER_EXT_COMMAND_RECEIVED, { ...runtime, commandId });
    expect(commandStore.markReceived).toHaveBeenCalledTimes(1);
    const arrivals = mocks.logger.info.mock.calls.filter(([event]) => event === 'Browser command reply arrived');
    expect(arrivals).toHaveLength(2);
    expect(arrivals[1][1]).toEqual({ nodeId: 'node-1', commandId, reply: 'receipt' });
  });

  it.each([
    [NODE_TO_COORDINATOR.BROWSER_EXT_COMMAND_RECEIVED, 'receipt'],
    [NODE_TO_COORDINATOR.BROWSER_EXT_COMMAND_RESULT, 'result'],
  ])('records %s before schema and authentication rejection without logging peer content', (method, reply) => {
    const { emit, commandStore } = fixture();
    emit(method, { commandId, extensionStartedAt: 'invalid_timestamp', error: 'private page error' });
    mocks.authenticate.mockReturnValue(false);
    emit(method, { ...runtime, commandId, ok: true, result: 'private page result' });
    expect(commandStore.markReceived).not.toHaveBeenCalled();
    expect(commandStore.resolveCommand).not.toHaveBeenCalled();
    const arrivals = mocks.logger.info.mock.calls.filter(([event]) => event === 'Browser command reply arrived');
    expect(arrivals.map(([, detail]) => detail)).toEqual([
      { nodeId: 'node-1', commandId, reply }, { nodeId: 'node-1', commandId, reply },
    ]);
    expect(JSON.stringify(arrivals)).not.toMatch(/private page|invalid_timestamp/);
  });

  it('does not log arbitrary peer IDs on either rejected path', () => {
    const { emit, bridge } = fixture();
    emit(NODE_TO_COORDINATOR.BROWSER_EXT_COMMAND_RECEIVED, { commandId: 'non_identifier_page_content', extensionStartedAt: 'invalid_timestamp' });
    bridge.commandReceived('node-1', { commandId: 'non_identifier_page_content', extensionVersion: '0.1.0' });
    expect(JSON.stringify(mocks.logger.info.mock.calls)).not.toContain('non_identifier_page_content');
  });
});
