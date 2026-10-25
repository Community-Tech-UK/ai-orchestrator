import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { WorkerNodeConnectionServer } from '../main/remote-node/worker-node-connection';
import type { WorkerInstanceNotifier } from './worker-instance-notifier';
const registryHolder = vi.hoisted(() => ({ value: undefined as unknown }));
const mocks = vi.hoisted(() => ({ adapter: undefined as unknown, createAdapter: vi.fn() }));
vi.mock('../main/cli/adapters/adapter-factory', () => ({ createCliAdapter: (...args: unknown[]) => { mocks.createAdapter(...args); return mocks.adapter; } }));
vi.mock('../main/logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../main/remote-node/worker-node-registry', () => ({ getWorkerNodeRegistry: () => registryHolder.value }));
import { RemoteCliAdapter } from '../main/cli/adapters/remote-cli-adapter';
import { AcpCliAdapter } from '../main/cli/adapters/acp-cli-adapter';
import { LocalInstanceManager } from './local-instance-manager';
import { WorkerRpcDispatcher } from './worker-rpc-dispatcher';
import { wireInstanceEvents } from './worker-event-wiring';
import { nativeOpenCodeCommands, resolveNativeOpenCodeCommand } from '../main/commands/provider-native-commands';
import { COORDINATOR_TO_NODE_PARAM_SCHEMAS } from '../main/remote-node/rpc-schemas';

describe('remote ACP question and native-command wire integration', () => {
  let registry: EventEmitter;
  let manager: LocalInstanceManager;
  let native: AcpCliAdapter;
  let remote: RemoteCliAdapter;
  let sendRpc: Mock;
  let protocol: { sessionId: string; handleMessageLine: (line: string) => void; sendResponse: (id: number, result: unknown) => Promise<void> };
  let responses: Mock;
  beforeEach(async () => {
    mocks.createAdapter.mockClear();
    registry = new EventEmitter(); registryHolder.value = registry;
    native = new AcpCliAdapter({ command: 'placeholder', args: [], workingDirectory: '/tmp/project' });
    native.configureOpenCodeV2(true);
    protocol = native as unknown as typeof protocol;
    protocol.sessionId = 'native-session';
    responses = vi.fn(async () => undefined);
    protocol.sendResponse = responses;
    vi.spyOn(native, 'spawn').mockImplementation(async () => {
      protocol.handleMessageLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: {
        sessionId: 'native-session', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact', description: 'Compact this session' }] },
      } }));
      return 1;
    });
    vi.spyOn(native, 'terminate').mockResolvedValue(undefined);
    vi.spyOn(native, 'sendInput').mockResolvedValue(undefined);
    mocks.adapter = native;
    manager = new LocalInstanceManager(['/tmp']);
    const events = registry as unknown as EventEmitter;
    wireInstanceEvents(manager, new EventEmitter(), {
      sendHeartbeatNotification: vi.fn(), sendOutputNotification: vi.fn(), sendCompleteNotification: vi.fn(), sendExit: vi.fn(),
      sendContextNotification: (instanceId: string, usage: unknown) => events.emit('remote:instance-context', { nodeId: 'worker', instanceId, usage }),
      sendStateChange: (instanceId: string, state: string, info?: unknown) => events.emit('remote:instance-state-change', { nodeId: 'worker', instanceId, state, info }),
      sendPermissionRequest: (instanceId: string, permission: unknown) => events.emit('remote:instance-permission-request', { nodeId: 'worker', instanceId, permission }),
    } as unknown as WorkerInstanceNotifier);
    let result: unknown; let failure: Error | undefined;
    const dispatcher = new WorkerRpcDispatcher({ config: {} as never, instanceManager: manager,
      getFilesystemHandler: () => ({}) as never, getSyncHandler: () => ({}) as never,
      getTerminalHandler: () => ({}) as never, applyConfigUpdate: vi.fn() as never,
      getCdpTunnel: () => ({}) as never, stopManagedBrowser: vi.fn(), localAiHealth: {} as never,
      sendResult: (_id, value) => { result = value; }, sendError: (_id, code, message) => { failure = Object.assign(new Error(message), { code }); },
    });
    sendRpc = vi.fn(async (_node, method: string, params: unknown) => {
      result = undefined; failure = undefined;
      const schema = COORDINATOR_TO_NODE_PARAM_SCHEMAS[method];
      if (!schema) throw new Error('Missing RPC schema');
      await dispatcher.handleRpcRequest({ jsonrpc: '2.0', id: 1, method, scope: 'instance', params: schema.parse(JSON.parse(JSON.stringify(params))) });
      if (failure) throw failure;
      return result;
    });
    remote = new RemoteCliAdapter({ sendRpc, isNodeConnected: () => true } as unknown as WorkerNodeConnectionServer, 'worker', 'opencode', { sessionId: 'remote-session', workingDirectory: '/tmp/project' });
    await remote.spawn();
  });
  afterEach(async () => { remote.forceCleanup(); await manager.terminateAll(); });
  function question(id = 71): void {
    protocol.handleMessageLine(JSON.stringify({ jsonrpc: '2.0', id, method: 'elicitation/create', params: {
      mode: 'form', message: 'Choose an approach', requestedSchema: { type: 'object', properties: { choice: { type: 'string', enum: ['first', 'second'] } }, required: ['choice'] },
    } }));
  }
  it('relays real ACP questions, keeps structured answers byte-for-byte and removes the resolved card', async () => {
    const input = vi.fn(); const resolved = vi.fn(); remote.on('input_required', input); remote.on('input_required_resolved', resolved);
    question();
    expect(input).toHaveBeenCalledWith(expect.objectContaining({ id: expect.stringMatching(/^remote_input:/), metadata: expect.objectContaining({ type: 'acp_elicitation', questions: expect.any(Array) }) }));
    const key = input.mock.calls[0][0].id as string;
    const response = '{ "choice": "second" }';
    await remote.sendRaw(response, key);
    expect(sendRpc).toHaveBeenLastCalledWith('worker', 'instance.sendRaw', { instanceId: 'remote-session', response, permissionKey: key });
    expect(responses).toHaveBeenCalledWith(71, { action: 'accept', content: { choice: 'second' } });
    expect(resolved).toHaveBeenCalledWith({ id: key, reason: 'decided' });
    await expect(remote.sendRaw(response, key)).rejects.toThrow(/pending/);
  });
  it('exposes startup and updated catalogs only for the selected remote session and clears on cleanup', async () => {
    expect(nativeOpenCodeCommands('opencode', remote).map(command => command.name)).toEqual(['compact']);
    expect(resolveNativeOpenCodeCommand('opencode', remote, 'acp:opencode:compact', [])?.resolvedPrompt).toBe('/compact');
    (registry as unknown as EventEmitter).emit('remote:instance-state-change', { nodeId: 'worker', instanceId: 'another-session', state: 'available_commands', info: [{ name: 'foreign' }] });
    expect(nativeOpenCodeCommands('opencode', remote).map(command => command.name)).toEqual(['compact']);
    native.emit('available_commands', [{ name: 'new-command' }]);
    expect(resolveNativeOpenCodeCommand('opencode', remote, 'acp:opencode:compact', [])).toBeUndefined();
    expect(nativeOpenCodeCommands('opencode', remote).map(command => command.name)).toEqual(['new-command']);
    remote.forceCleanup();
    expect(nativeOpenCodeCommands('opencode', remote)).toEqual([]);
  });
  it('rejects a native command withdrawn on the worker before the coordinator receives its catalog update', async () => {
    expect(remote.getAvailableCommands().map((command) => command.name)).toEqual(['compact']);
    Object.assign(native, { availableCommands: [] });
    await expect(remote.sendInput('/compact')).rejects.toThrow('no longer available');
    expect(native.sendInput).not.toHaveBeenCalled();
  });
  it('refuses wrong keys, wrong instances and withdrawn requests at the worker boundary', async () => {
    const input = vi.fn(); remote.on('input_required', input);
    question();
    const key = input.mock.calls[0][0].id as string;
    await expect(sendRpc('worker', 'instance.sendRaw', { instanceId: 'remote-session', response: '{}', permissionKey: 'wrong-key' })).rejects.toThrow(/pending/);
    await expect(sendRpc('worker', 'instance.sendRaw', { instanceId: 'another-session', response: '{}', permissionKey: key })).rejects.toThrow(/Instance not found/);
    native.emit('input_required_resolved', { id: 'acp_elicitation:71', reason: 'cancelled' });
    await expect(sendRpc('worker', 'instance.sendRaw', { instanceId: 'remote-session', response: '{}', permissionKey: key })).rejects.toThrow(/pending/);
    expect(responses).not.toHaveBeenCalled();
  });
  it('keeps native provider identity separate from routing and retains full usage fields', () => {
    expect(remote.getRemoteInstanceId()).toBe('remote-session');
    expect(remote.getSessionId()).toBe('native-session');
    const context = vi.fn(); remote.on('context', context);
    const usage = { used: 100, total: 1000, percentage: 10, cumulativeTokens: 5000, inputTokens: 90, outputTokens: 10, isEstimated: true, source: 'acp' };
    native.emit('context', usage);
    expect(context).toHaveBeenCalledWith(usage);
  });
  it('rejects an old UI key when a replacement emits the same native request ID', async () => {
    const input = vi.fn(); remote.on('input_required', input); question();
    const oldKey = input.mock.calls[0][0].id as string;
    const oldInteractionId = (sendRpc.mock.calls[0][2] as { interactionId: string }).interactionId;
    await remote.terminate();
    remote = new RemoteCliAdapter({ sendRpc, isNodeConnected: () => true } as unknown as WorkerNodeConnectionServer, 'worker', 'opencode', { sessionId: 'remote-session', workingDirectory: '/tmp/project' });
    remote.on('input_required', input); await remote.spawn();
    question();
    const newKey = input.mock.calls[1][0].id as string;
    expect(newKey).not.toBe(oldKey);
    await expect(sendRpc('worker', 'instance.sendRaw', { instanceId: 'remote-session', response: '{}', permissionKey: oldKey })).rejects.toThrow(/pending/);
    for (const [state, payload] of [['provider_session', { sessionId: 'stale-native' }], ['provider_turn', { active: true, activeToolCalls: true }], ['available_commands', [{ name: 'stale' }]]] as const) {
      registry.emit('remote:instance-state-change', { nodeId: 'worker', instanceId: 'remote-session', state, info: { interactionId: oldInteractionId, payload } });
    }
    expect(remote.getSessionId()).toBe('native-session'); expect(remote.hasActiveTurn()).toBe(false);
    expect(nativeOpenCodeCommands('opencode', remote).map(command => command.name)).toEqual(['compact']);
    await remote.sendRaw('{"choice":"first"}', newKey);
    expect(responses).toHaveBeenCalledOnce();
  });
  it('answers a question raised before worker startup has published its instance', async () => {
    await remote.terminate();
    const input = vi.fn();
    let finishStartup: () => void = () => undefined;
    const answered = new Promise<void>(resolve => { finishStartup = resolve; });
    responses.mockImplementation(async () => { finishStartup(); });
    vi.mocked(native.spawn).mockImplementationOnce(async () => { question(99); await answered; return 1; });
    remote = new RemoteCliAdapter({ sendRpc, isNodeConnected: () => true } as unknown as WorkerNodeConnectionServer, 'worker', 'opencode', { sessionId: 'remote-session', workingDirectory: '/tmp/project' });
    remote.on('input_required', input);
    const spawning = remote.spawn();
    await vi.waitFor(() => expect(input).toHaveBeenCalledOnce());
    expect(manager.getInstance('remote-session')).toBeUndefined();
    await remote.sendRaw('{"choice":"second"}', input.mock.calls[0][0].id);
    await spawning;
    expect(responses).toHaveBeenCalledWith(99, { action: 'accept', content: { choice: 'second' } });
  });
  it('keeps the native cursor when the worker hibernates and wakes its transport instance', async () => {
    await manager.hibernate('remote-session');
    await manager.wake('remote-session');
    expect(mocks.createAdapter).toHaveBeenLastCalledWith('opencode', expect.objectContaining({ sessionId: 'native-session', resume: true }));
  });
  it('rejects malformed or oversized raw responses before calling the native adapter', async () => {
    const input = vi.fn(); remote.on('input_required', input); question();
    await expect(sendRpc('worker', 'instance.sendRaw', { instanceId: 'remote-session', response: 'x'.repeat(1024 * 1024 + 1), permissionKey: input.mock.calls[0][0].id })).rejects.toThrow();
    await expect(sendRpc('worker', 'instance.sendRaw', { instanceId: 'remote-session', response: '{}', permissionKey: '' })).rejects.toThrow();
    expect(responses).not.toHaveBeenCalled();
  });
  it('answers a form without absorbing a separate pending permission request', async () => {
    const input = vi.fn(); remote.on('input_required', input); question();
    const questionKey = input.mock.calls[0][0].id as string;
    protocol.handleMessageLine(JSON.stringify({ jsonrpc: '2.0', id: 88, method: 'session/request_permission', params: {
      sessionId: 'native-session', toolCall: { toolCallId: 'fixture-tool', title: 'Read a fixture', kind: 'read' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } }));
    expect(input).toHaveBeenCalledTimes(2);
    await remote.sendRaw('{"choice":"second"}', questionKey);
    expect(responses).toHaveBeenCalledWith(71, { action: 'accept', content: { choice: 'second' } });
    expect(responses).not.toHaveBeenCalledWith(88, expect.anything());
  });
  it('runs the real renderer ACP permission-option response through the opaque key and native permission RPC', async () => {
    await import('@angular/compiler');
    const { signal } = await import('@angular/core');
    const { UserActionRequestComponent } = await import('../renderer/app/features/instance-detail/user-action-request.component');
    const input = vi.fn(); remote.on('input_required', input);
    protocol.handleMessageLine(JSON.stringify({ jsonrpc: '2.0', id: 88, method: 'session/request_permission', params: {
      sessionId: 'native-session', toolCall: { toolCallId: 'fixture-tool', title: 'Read a fixture', kind: 'read' },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    } }));
    const payload = input.mock.calls[0][0];
    const request = { id: payload.id, instanceId: 'ui-instance', requestType: 'input_required', permissionMetadata: payload.metadata };
    const respondToInputRequired = vi.fn(async (_instanceId: string, _requestId: string, response: string, key: string) => {
      await remote.sendRaw(response, key); return { success: true };
    });
    const component = UserActionRequestComponent.prototype as unknown as { respond: (this: unknown, request: unknown, approved: boolean, selectedOption: string) => Promise<void> };
    const view = { isResponding: signal(false), responseErrors: signal(new Map<string, string>()),
      respond: component.respond,
      isPermissionRequest: UserActionRequestComponent.prototype.isPermissionRequest,
      ipc: { respondToInputRequired }, inputRequiredTexts: new Map(), pendingInputRequiredById: new Map(),
      pendingRequests: signal([]), instanceStore: { decrementPendingApproval: vi.fn() } };
    expect(UserActionRequestComponent.prototype.isPermissionRequest.call(view as never, request as never)).toBe(false);
    await UserActionRequestComponent.prototype.onSelectOption.call(view as never, request as never, 'allow-once');
    expect(respondToInputRequired).toHaveBeenCalledWith('ui-instance', payload.id, 'allow-once', payload.id);
    expect(payload.metadata).toMatchObject({ type: 'acp_permission_request', action: 'acp_permission', path: '88', transport: 'acp' });
    expect(responses).toHaveBeenCalledWith(88, { outcome: { outcome: 'selected', optionId: 'allow-once' } });
  });
});
