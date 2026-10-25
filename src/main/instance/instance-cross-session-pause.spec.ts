import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import { InstanceManager } from './instance-manager';
import { InstanceCommunicationManager } from './instance-communication';
import { GlobalPauseService } from '../global-pause/global-pause-service';
const mocks = vi.hoisted(() => ({ handlers: new Map<string, unknown>(), compact: vi.fn(), commands: vi.fn(), record: vi.fn(), preSampling: vi.fn().mockResolvedValue({ blocked: false }) }));
vi.mock('electron', () => ({ ipcMain: { handle: (channel: string, handler: unknown) => mocks.handlers.set(channel, handler) }, app: { getPath: () => '/tmp/aio-disposable-native-command' } }));
vi.mock('../logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../hooks/hook-manager', () => ({ getHookManager: () => ({ triggerHooks: vi.fn(), triggerLifecycleHooks: mocks.preSampling }) }));
vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }), get: () => undefined }) }));
vi.mock('../memory/output-storage', () => ({ getOutputStorageManager: () => ({ storeMessages: vi.fn() }) }));
vi.mock('../commands/command-manager', () => ({ getCommandManager: () => ({ executeCommandString: mocks.commands, executeCommand: vi.fn(), getAllCommandsSnapshot: async () => ({ commands: [], diagnostics: [] }) }) }));
vi.mock('../context/context-engine', () => ({ getContextEngine: () => ({ compactInstance: mocks.compact }) }));
vi.mock('../plugins/hook-emitter', () => ({ emitPluginHook: vi.fn() }));
vi.mock('../usage/usage-tracker', () => ({ getUsageTracker: () => ({ record: vi.fn() }) }));
vi.mock('../prompt-history/prompt-history-service', () => ({ getPromptHistoryService: () => ({ record: mocks.record }) }));
vi.mock('../session/session-admission-service', () => ({ getSessionAdmissionService: () => ({ recordUserSend: () => null }) }));
vi.mock('../memory/token-stats', () => ({ getTokenStatsService: () => ({ record: vi.fn(), classifyToolType: () => 'other' }) }));



afterEach(() => { vi.restoreAllMocks(); mocks.commands.mockReset(); mocks.preSampling.mockReset(); mocks.preSampling.mockResolvedValue({ blocked: false }); });
function fixture() {
  let held = false;
  const pause = Object.assign(new EventEmitter(), { holdsAutomaticInput: () => held,
    manualInput: vi.fn(() => { held = false; pause.emit('state-changed'); }) });
  vi.spyOn(GlobalPauseService, 'peek').mockReturnValue(pause as unknown as GlobalPauseService);
  const adapter = Object.assign(new EventEmitter(), { sendInput: vi.fn(async () => undefined), getName: vi.fn(() => 'claude-cli'), getSessionId: () => 'saved' });
  const instance = { id: 'target', provider: 'claude', workingDirectory: '/tmp', sessionId: 'saved', providerSessionId: 'saved', restartEpoch: 0, adapterGeneration: 0, parentId: null, outputBuffer: [{type:'assistant',content:'Earlier work',timestamp:1}], status: 'idle', planMode: {enabled:false,state:'off'}, childrenIds: [], outputBufferMaxSize:100, communicationTokens:new Map(), totalTokensUsed:0, errorCount:0, restartCount:0, requestCount: 0, lastActivity: 0, contextUsage: {used:0,total:10000,percentage:0} } as unknown as Instance;
  const compactContext = vi.fn(async () => undefined);
  const communication = new InstanceCommunicationManager({ getInstance: () => instance, getAdapter: () => adapter as never, setAdapter: () => undefined, deleteAdapter: () => false, queueUpdate: () => undefined, processOrchestrationOutput: () => undefined, onInterruptedExit: async () => undefined, ingestToRLM: () => undefined, ingestToUnifiedMemory: () => undefined, compactContext });
  const manager = Object.create(InstanceManager.prototype) as InstanceManager;
  Object.assign(manager, { state: { getInstance: () => instance, getAdapter: () => adapter, isInstancePending: () => false }, communication,
    orchestrationMgr: { getOrchestrationHandler: () => ({ getPendingUserActionsForInstance: () => [] }), getLaterTurnReminderIfRelevant: () => null }, hasReceivedFirstMessage: new Set(['target']),
    context: { getInputContext: async () => ({}), formatUnifiedMemoryContextBlock: () => '', formatRlmContextBlock: () => '' }, publishOutput: vi.fn(), maybeHandleSwitchModeReply: async () => false });

  return { adapter, instance, manager, compactContext, pause, hold: () => { held = true; }, release: () => { held = false; pause.emit('state-changed'); }, held: () => held };
}
describe('cross-session automatic delivery through manager and communication', () => {
  it.each(['command-preflight', 'sampling-preflight', 'attachment-retry', 'overflow-retry'] as const)('keeps restart ownership across %s and resumes once', async boundary => {
    const h = fixture();
    if (boundary === 'command-preflight') mocks.commands.mockImplementation(async () => { h.hold(); return null; });
    if (boundary === 'sampling-preflight') mocks.preSampling.mockImplementation(async (event: string) => { if (event === 'PreSampling') h.hold(); return { blocked: false }; });
    if (boundary === 'attachment-retry') h.adapter.sendInput.mockImplementationOnce(async () => { h.hold(); throw new Error('Fixture provider does not support attachments in orchestrator mode'); });
    if (boundary === 'overflow-retry') {
      h.adapter.getName.mockReturnValue('fixture-provider');
      h.adapter.sendInput.mockRejectedValueOnce(new Error('context window exceeded'));
      h.compactContext.mockImplementation(async () => { h.hold(); });
    }
    let finished = false;
    const firstAttempts = boundary.endsWith('-retry') ? 1 : 0;
    const sending = h.manager.sendInput('target', 'A helper sent a result', boundary === 'attachment-retry' ? [{name: 'fixture.txt', type: 'text/plain', size: 0, data: ''}] : undefined,
      { crossSessionSourceId: 'helper' }).then(() => { finished = true; });
    await vi.waitFor(() => expect(h.held()).toBe(true));
    await new Promise<void>(resolve => setImmediate(resolve));
    const observed = { held: h.held(), finished, manualPickups: h.pause.manualInput.mock.calls.length, providerSends: h.adapter.sendInput.mock.calls.length };
    h.release(); await sending;
    expect(observed).toEqual({ held: true, finished: false, manualPickups: 0, providerSends: firstAttempts });
    expect(h.adapter.sendInput).toHaveBeenCalledTimes(firstAttempts + 1);
    expect(h.pause.manualInput).not.toHaveBeenCalled();
    expect(h.instance.outputBuffer.find(message => message.type === 'user')?.metadata?.['crossSessionMessage']).toMatchObject({sourceInstanceId:'helper'});
  });
  it('still lets a typed message take ownership of a paused chat', async () => {
    const h = fixture(); h.hold();
    await h.manager.sendInput('target', 'James takes over');
    expect(h.held()).toBe(false);
    expect(h.pause.manualInput).toHaveBeenCalled();
    expect(h.adapter.sendInput).toHaveBeenCalledOnce();
  });
});
