import { EventEmitter } from 'node:events';
import { TestBed } from '@angular/core/testing';
import { NgZone } from '@angular/core';
import { Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IpcRenderer } from 'electron';
import { createInstanceDomain } from '../../preload/domains/instance.preload';
import { IPC_CHANNELS } from '@contracts/channels';
import { createInstance } from '../../shared/types/instance.types';
import { setupInstanceTranscriptReplayForwarding } from '../../main/app/instance-transcript-replay-forwarding';
import { InstanceIpcService } from '../../renderer/app/core/services/ipc/instance-ipc.service';
import { IpcFacadeService } from '../../renderer/app/core/services/ipc';
import { IpcEventBusService } from '../../renderer/app/core/services/ipc/ipc-event-bus.service';
import { InstanceEventsService } from '../../renderer/app/core/services/instance-events.service';
import { StatsIpcService } from '../../renderer/app/core/services/ipc/stats-ipc.service';
import { ToastService } from '../../renderer/app/core/services/toast.service';
import { ProviderStateService } from '../../renderer/app/core/services/provider-state.service';
import { ImageAttachmentService } from '../../renderer/app/features/instance-detail/image-attachment.service';
import { AutomationStore } from '../../renderer/app/core/state/automation.store';
import { InstanceStore } from '../../renderer/app/core/state/instance/instance.store';
import { InstanceStateService } from '../../renderer/app/core/state/instance/instance-state.service';
import { InstanceListStore } from '../../renderer/app/core/state/instance/instance-list.store';
import { InstanceSelectionStore } from '../../renderer/app/core/state/instance/instance-selection.store';
import { InstanceMessagingStore } from '../../renderer/app/core/state/instance/instance-messaging.store';
import { InstanceOutputStore } from '../../renderer/app/core/state/instance/instance-output.store';
import type { Instance } from '../../renderer/app/core/state/instance/instance.types';

const originalApi = window.electronAPI;
afterEach(() => { TestBed.resetTestingModule(); window.electronAPI = originalApi; });
describe('authoritative replay IPC integration', () => {
  it('resyncs unknown startup replay once and protects it from the older initial snapshot', async () => {
    const listeners = new Map<string, (event: unknown, data: unknown) => void>();
    const renderer = { on: (channel: string, handler: (event: unknown, data: unknown) => void) => listeners.set(channel, handler),
      removeListener: (channel: string) => listeners.delete(channel) } as unknown as IpcRenderer;
    window.electronAPI = createInstanceDomain(renderer, IPC_CHANNELS) as unknown as typeof window.electronAPI;
    const instance = Object.assign(createInstance({ workingDirectory: '/tmp/placeholder', provider: 'opencode' }), {
      id: 'startup-placeholder', adapterGeneration: 1, restartEpoch: 0,
    });
    const messages = [{ id: 'native', type: 'assistant' as const, timestamp: 2, content: 'repaired '.repeat(15000) }];
    let resolveInitial!: (value: unknown) => void;
    const initial = new Promise(resolve => { resolveInitial = resolve; });
    const resync = vi.fn().mockReturnValueOnce(initial).mockResolvedValue({ success: true,
      data: { instances: [{ ...instance, outputBuffer: messages }] } });
    TestBed.configureTestingModule({ providers: [
      { provide: IpcFacadeService, useValue: { stateResync: resync } },
      { provide: InstanceEventsService, useValue: { outputEvents$: new Subject() } },
      { provide: NgZone, useValue: { run: (callback: () => void) => callback() } },
      { provide: StatsIpcService, useValue: {} }, { provide: ToastService, useValue: { show: vi.fn() } },
      { provide: ProviderStateService, useValue: {} }, { provide: AutomationStore, useValue: {} },
      { provide: InstanceSelectionStore, useValue: {} },
      { provide: InstanceMessagingStore, useValue: { processMessageQueue: vi.fn(), clearQueueWithNotification: vi.fn() } },
      { provide: ImageAttachmentService, useValue: { processMessage: vi.fn() } },
    ] });
    TestBed.inject(InstanceStore);
    const state = TestBed.inject(InstanceStateService);
    const manager = Object.assign(new EventEmitter(), { getInstance: () => instance });
    const cleanup = setupInstanceTranscriptReplayForwarding({ instanceManager: manager,
      windowManager: { sendToRenderer: (channel, payload) => listeners.get(channel)?.({}, payload) },
      continuityQueue: { enqueue: () => ({ accepted: true }) } });
    try {
      manager.emit('history-replayed', { instanceId: instance.id, adapterGeneration: 1, restartEpoch: 0, messages });
      await vi.waitFor(() => expect(resync).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(state.getInstance(instance.id)?.outputBuffer).toEqual(messages));
      resolveInitial({ success: true, data: { instances: [] } });
      await initial;
      await Promise.resolve();
      await Promise.resolve();
      expect(state.getInstance(instance.id)?.outputBuffer).toEqual(messages);
    } finally { resolveInitial({ success: true, data: { instances: [] } }); cleanup(); }
  });
  it('reaches renderer replacement through actual main forwarding, preload, IPC service and event bus without tool hooks', () => {
    const listeners = new Map<string, (event: unknown, data: unknown) => void>();
    const renderer = { on: (channel: string, handler: (event: unknown, data: unknown) => void) => listeners.set(channel, handler),
      removeListener: (channel: string) => listeners.delete(channel) } as unknown as IpcRenderer;
    window.electronAPI = createInstanceDomain(renderer, IPC_CHANNELS) as unknown as typeof window.electronAPI;
    const stats = { statsRecordToolUsage: vi.fn(), statsRecordSessionEnd: vi.fn() };
    const image = { processMessage: vi.fn() };
    TestBed.configureTestingModule({ providers: [InstanceIpcService, IpcEventBusService, InstanceOutputStore,
      { provide: InstanceEventsService, useValue: { outputEvents$: new Subject() } },
      { provide: NgZone, useValue: { run: (callback: () => void) => callback() } },
      { provide: StatsIpcService, useValue: stats }, { provide: ToastService, useValue: {} },
      { provide: ProviderStateService, useValue: {} }, { provide: AutomationStore, useValue: {} },
      { provide: InstanceListStore, useValue: { loadInitialInstances: vi.fn() } },
      { provide: InstanceSelectionStore, useValue: {} },
      { provide: InstanceMessagingStore, useValue: { processMessageQueue: vi.fn(), clearQueueWithNotification: vi.fn() } },
      { provide: ImageAttachmentService, useValue: image },
    ] });
    TestBed.inject(InstanceStore);
    const state = TestBed.inject(InstanceStateService);
    const instance = Object.assign(createInstance({ workingDirectory: '/tmp/placeholder', provider: 'opencode' }), {
      id: 'instance-placeholder', adapterGeneration: 1, restartEpoch: 0,
    });
    state.addInstance({ ...instance, outputBuffer: [{ id: 'stale', type: 'assistant', timestamp: 1, content: 'old' }] } as unknown as Instance);
    const manager = Object.assign(new EventEmitter(), { getInstance: () => instance });
    const cleanup = setupInstanceTranscriptReplayForwarding({ instanceManager: manager,
      windowManager: { sendToRenderer: (channel, payload) => listeners.get(channel)?.({}, payload) },
      continuityQueue: { enqueue: () => ({ accepted: true }) } });
    try {
      const messages = [{ id: 'native-tool', type: 'tool_use', timestamp: 2, content: 'Recovered tool', metadata: { name: 'shell' } },
        { id: 'native-user', type: 'user', timestamp: 3, content: 'Recovered ask',
          attachments: [{ name: 'placeholder.txt', type: 'text/plain', size: 70000, data: 'a'.repeat(70000) }] }];
      manager.emit('history-replayed', { instanceId: instance.id, adapterGeneration: 1, restartEpoch: 0, messages });
      expect(state.getInstance(instance.id)?.outputBuffer).toEqual(messages);
      expect(stats.statsRecordToolUsage).not.toHaveBeenCalled();
      expect(image.processMessage).not.toHaveBeenCalled();
      TestBed.resetTestingModule();
      expect(listeners.has(IPC_CHANNELS.INSTANCE_TRANSCRIPT_CHUNK)).toBe(false);
    } finally { cleanup(); }
  });
});
