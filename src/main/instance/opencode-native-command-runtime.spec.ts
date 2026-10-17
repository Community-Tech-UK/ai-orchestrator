import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import type { IpcResponse } from '../../shared/types/ipc.types';
import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import { InstanceManager } from './instance-manager';
import { InstanceCommunicationManager } from './instance-communication';
import { registerCommandHandlers } from '../ipc/handlers/command-handlers';
import { createInitializedAgentHarness, TestAcpCliAdapter } from '../cli/adapters/acp-cli-adapter.test-helpers';

type Handler = (_event: unknown, payload: unknown) => Promise<IpcResponse>;
const mocks = vi.hoisted(() => ({ handlers: new Map<string, Handler>(), compact: vi.fn(), commands: vi.fn(), record: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler) }, app: { getPath: () => '/tmp/aio-disposable-native-command' } }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({ triggerHooks: vi.fn(), triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }) }) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }), get: () => undefined }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({ storeMessages: vi.fn() }) }));
vi.mock('../commands/command-manager', () => ({ getCommandManager: () => ({ executeCommandString: mocks.commands, executeCommand: vi.fn(), getAllCommandsSnapshot: async () => ({ commands: [], diagnostics: [] }) }) }));
vi.mock('../context/context-engine', () => ({ getContextEngine: () => ({ compactInstance: mocks.compact }) }));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../usage/usage-tracker', () => ({ getUsageTracker: () => ({ record: vi.fn() }) }));
vi.mock('../prompt-history/prompt-history-service', () => ({ getPromptHistoryService: () => ({ record: mocks.record }) }));
vi.mock('../session/session-admission-service', () => ({ getSessionAdmissionService: () => ({ recordUserSend: () => null }) }));
vi.mock('../memory/token-stats', () => ({ getTokenStatsService: () => ({ record: vi.fn(), classifyToolType: () => 'other' }) }));

describe('native OpenCode command from IPC through the actual manager to ACP', () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.handlers.clear(); });

  it.each([false, true])('sends bare native compact without re-resolving Harness and rejects a withdrawn catalog (%s)', async (withdrawn) => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp', systemPrompt: 'Fixture system instructions', rtkEnabled: true,
      beforeProviderPrompt: async () => { if (withdrawn) proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: 'available_commands_update', availableCommands: [] } }); },
    });
    adapter.configureOpenCodeV2(true);
    await adapter.spawn();
    proc.notify('session/update', { sessionId: 'sess-acp-1', update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'compact' }] } });
    const instance = { id: 'native-runtime', provider: 'opencode', workingDirectory: '/tmp', sessionId: 'sess-acp-1', providerSessionId: 'sess-acp-1', restartEpoch: 0, adapterGeneration: 0, parentId: null, outputBuffer: [], status: 'idle', requestCount: 0, lastActivity: 0 } as unknown as Instance;
    const communication = new InstanceCommunicationManager({ getInstance: () => instance, getAdapter: () => adapter, setAdapter: () => undefined, deleteAdapter: () => false, queueUpdate: () => undefined, processOrchestrationOutput: () => undefined, onInterruptedExit: async () => undefined, ingestToRLM: () => undefined, ingestToUnifiedMemory: () => undefined });
    communication.queueContinuityPreamble(instance.id, 'Fixture hidden continuity');
    const manager = Object.create(InstanceManager.prototype) as InstanceManager;
    Object.assign(manager, { state: { getInstance: () => instance, getAdapter: () => adapter, isInstancePending: () => false }, communication,
      orchestrationMgr: { getOrchestrationHandler: () => ({ getPendingUserActionsForInstance: () => [] }) }, hasReceivedFirstMessage: new Set<string>(),
      context: { getInputContext: async () => ({}) }, publishOutput: vi.fn() });
    mocks.commands.mockResolvedValue({ command: { id: 'builtin-compact', name: 'compact' }, execution: { type: 'compact' }, resolvedPrompt: '' });
    proc.onRequest('session/prompt', (request) => proc.respond(request.id, { stopReason: 'end_turn' }));
    registerCommandHandlers(manager);
    try {
      const result = await mocks.handlers.get(IPC_CHANNELS.COMMAND_EXECUTE)!({}, { instanceId: instance.id, commandId: 'acp:opencode:compact' });
      expect(result).toMatchObject({ success: !withdrawn });
      const prompts = proc.receivedMessages.filter((message) => 'method' in message && message.method === 'session/prompt');
      expect(prompts).toEqual(withdrawn ? [] : [expect.objectContaining({ params: { sessionId: 'sess-acp-1', prompt: [{ type: 'text', text: '/compact' }] } })]);
      expect(mocks.commands).not.toHaveBeenCalled();
      expect(mocks.compact).not.toHaveBeenCalled();
    } finally { proc.exit(); communication.cleanupCircuitBreaker(instance.id); }
  });
});
