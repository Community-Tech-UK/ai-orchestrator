import { EventEmitter } from 'node:events';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import { createInstance } from '../../shared/types/instance.types';
import { createInstanceDomain } from '../../preload/domains/instance.preload';
import { createOrchestrationDomain } from '../../preload/domains/orchestration.preload';
import { nativeOpenCodeCommands } from '../../main/commands/provider-native-commands';
import { InstanceCommunicationManager } from '../../main/instance/instance-communication';
import { InstanceManager } from '../../main/instance/instance-manager';
import { setupInstanceEventForwarding } from '../../main/app/instance-event-forwarding';
import { createInitializedAgentHarness, TestAcpCliAdapter } from '../../main/cli/adapters/acp-cli-adapter.test-helpers';
import { CommandStore } from '../../renderer/app/core/state/command.store';
import { InstanceStore } from '../../renderer/app/core/state/instance.store';
import { SkillStore } from '../../renderer/app/core/state/skill.store';
import { InstanceEventsService } from '../../renderer/app/core/services/instance-events.service';

// App services are isolated at the boundary: no app/store/provider/runtime constructor runs.
vi.mock('../../main/commands/command-manager', () => ({ getCommandManager: () => ({}) }));
vi.mock('electron-store', () => ({ default: class { store = {}; get() { return undefined; } set() { return undefined; } } }));
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/catalog-fixture', isPackaged: false } }));
vi.mock('../../main/logging/logger', () => ({ getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }) }));
vi.mock('../../main/hooks/hook-manager', () => ({ getHookManager: () => ({ triggerHooks: vi.fn(), triggerLifecycleHooks: vi.fn().mockResolvedValue({ blocked: false }) }) }));
vi.mock('../../main/core/config/settings-manager', () => ({ getSettingsManager: () => ({ getAll: () => ({ outputBufferSize: 100, enableDiskStorage: false }), get: () => undefined }) }));
vi.mock('../../main/memory/output-storage', () => ({ getOutputStorageManager: () => ({ storeMessages: vi.fn() }) }));
vi.mock('../../main/session/session-continuity', () => ({ getSessionContinuityManager: () => ({}), getSessionContinuityManagerIfInitialized: () => undefined }));
vi.mock('../../main/context/context-engine', () => ({ getContextEngine: () => ({}) }));
vi.mock('../../main/orchestration/cross-model-review-service', () => ({ getCrossModelReviewService: () => ({ on: () => undefined }) }));
vi.mock('../../main/orchestration/debate-coordinator', () => ({ getDebateCoordinator: () => ({}) }));
vi.mock('../../main/orchestration/doom-loop-detector', () => ({ getDoomLoopDetector: () => ({ on: () => undefined }) }));
vi.mock('../../main/orchestration/orchestration-activity-bridge', () => ({ getOrchestrationActivityBridge: () => ({ initialize: () => undefined }) }));
vi.mock('../../main/orchestration/multi-verify-coordinator', () => ({ getMultiVerifyCoordinator: () => ({}) }));
vi.mock('../../main/memory/memory-monitor', () => ({ getMemoryMonitor: () => ({ on: () => undefined }) }));
vi.mock('../../main/remote/observer-server', () => ({ getRemoteObserverServer: () => ({ publishInstanceState: () => undefined }) }));
vi.mock('../../main/repo-jobs', () => ({ getRepoJobService: () => ({ on: () => undefined }) }));
vi.mock('../../main/state', () => ({ getAppStore: () => undefined, setGlobalState: () => undefined }));
vi.mock('../../main/observability/provider-runtime-trace-sink', () => ({ getProviderRuntimeTraceSink: () => ({ enqueue: () => undefined }) }));
vi.mock('../../main/observability/otel-spans', () => ({ recordProviderRuntimeEventSpan: () => undefined }));
vi.mock('../../main/observability/otel-setup', () => ({ getOrchestratorTracer: () => ({ startSpan: () => ({ end: () => undefined }) }) }));
vi.mock('../../main/observability', () => ({}));
vi.mock('../../main/instance/instance-lifecycle', () => ({ InstanceLifecycleManager: class {} }));
vi.mock('../../main/instance/instance-orchestration', () => ({ InstanceOrchestrationManager: class {} }));
vi.mock('../../main/instance/instance-persistence', () => ({ InstancePersistenceManager: class {} }));
vi.mock('../../main/providers/provider-runtime-service', () => ({ getProviderRuntimeService: () => ({}) }));

const originalApi = window.electronAPI;
afterEach(() => { TestBed.resetTestingModule(); window.electronAPI = originalApi; });

describe('native catalog end-to-end source wiring', () => {
  it('updates the Angular menu through actual adapter, communication, manager, app forwarding, preload and event bus', async () => {
    const proc = createInitializedAgentHarness();
    const adapter = new TestAcpCliAdapter(proc, { workingDirectory: '/tmp' }); adapter.configureOpenCodeV2(true);
    const instance = Object.assign(createInstance({ workingDirectory: '/tmp', provider: 'opencode' }), { id: 'catalog-integration', status: 'idle' as const });
    const communication = new InstanceCommunicationManager({ getInstance: () => instance, getAdapter: () => adapter,
      setAdapter: () => undefined, deleteAdapter: () => false, queueUpdate: () => undefined,
      processOrchestrationOutput: () => undefined, onInterruptedExit: async () => undefined, ingestToRLM: () => undefined, ingestToUnifiedMemory: () => undefined });
    communication.setupAdapterEvents(instance.id, adapter);
    const state = Object.assign(new EventEmitter(), { getInstance: () => instance, getAdapter: () => adapter });
    const manager = Object.assign(Object.create(InstanceManager.prototype), {
      state, communication, lifecycle: new EventEmitter(), orchestrationMgr: { getOrchestrationHandler: () => new EventEmitter() },
    }) as InstanceManager;
    (manager as unknown as { setupEventForwarding(): void }).setupEventForwarding();
    const listeners = new Map<string, Set<(event: unknown, payload: unknown) => void>>();
    let listCalls = 0;
    const renderer = { invoke: async (channel: string, payload: { instanceId: string }) => {
      expect(channel).toBe(IPC_CHANNELS.COMMAND_LIST); expect(payload.instanceId).toBe(instance.id); listCalls++;
      return { success: true, data: { commands: nativeOpenCodeCommands(instance.provider, manager.getAdapter(instance.id)), diagnostics: [], scanDirs: [] } };
    }, on: (channel: string, handler: (event: unknown, payload: unknown) => void) => {
      const handlers = listeners.get(channel) ?? new Set(); handlers.add(handler); listeners.set(channel, handlers);
    }, removeListener: (channel: string, handler: (event: unknown, payload: unknown) => void) => listeners.get(channel)?.delete(handler) } as unknown as IpcRenderer;
    window.electronAPI = { ...createInstanceDomain(renderer, IPC_CHANNELS), ...createOrchestrationDomain(renderer, IPC_CHANNELS) } as unknown as typeof window.electronAPI;
    const sent: string[] = [];
    setupInstanceEventForwarding({ instanceManager: manager,
      windowManager: { sendToRenderer: (channel: string, payload: unknown) => { sent.push(channel); for (const handler of listeners.get(channel) ?? []) handler({}, payload); } } as never,
      isStatelessExecProvider: () => false, getNodeLatencyForInstance: () => undefined });
    const selected = signal({ ...instance });
    TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection(), CommandStore,
      { provide: InstanceEventsService, useValue: { outputEvents$: new Subject() } },
      { provide: InstanceStore, useValue: { selectedInstance: selected } },
      { provide: SkillStore, useValue: { skillCommands: () => [], discoverSkills: async () => undefined } },
    ] });
    try {
      await adapter.spawn();
      const notify = (commands: { name: string; description?: string }[]) => proc.notify('session/update', { sessionId: adapter.getSessionId(), update: { sessionUpdate: 'available_commands_update', availableCommands: commands } });
      notify([{ name: 'compact', description: 'Compact' }]);
      const store = TestBed.inject(CommandStore); TestBed.tick();
      await vi.waitFor(() => expect(store.rawCommands().map(command => command.name)).toEqual(['compact']));
      notify([{ name: 'new-action', description: 'First' }]);
      await vi.waitFor(() => expect(store.rawCommands().map(command => command.name)).toEqual(['new-action']));
      notify([{ name: 'new-action', description: 'Changed' }]);
      await vi.waitFor(() => expect(store.rawCommands()[0]?.description).toBe('Changed'));
      notify([]); await vi.waitFor(() => expect(store.rawCommands()).toEqual([]));
      expect(sent.filter(channel => channel === IPC_CHANNELS.INSTANCE_STATE_UPDATE)).toHaveLength(4);
      expect(listCalls).toBe(4);
      TestBed.resetTestingModule();
      expect(listeners.get(IPC_CHANNELS.INSTANCE_STATE_UPDATE)?.size ?? 0).toBe(0);
    } finally { adapter.removeAllListeners(); proc.exit(); communication.cleanupCircuitBreaker(instance.id); manager.removeAllListeners(); }
  });
});
