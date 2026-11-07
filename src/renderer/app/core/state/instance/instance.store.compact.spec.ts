import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { InstanceIpcService, IpcEventBusService } from '../../services/ipc';
import { StatsIpcService } from '../../services/ipc/stats-ipc.service';
import { ToastService } from '../../services/toast.service';
import { ProviderStateService } from '../../services/provider-state.service';
import { AutomationStore } from '../automation.store';
import { InstanceStore } from './instance.store';
import { InstanceListStore } from './instance-list.store';
import { InstanceSelectionStore } from './instance-selection.store';
import { InstanceOutputStore } from './instance-output.store';
import { InstanceMessagingStore } from './instance-messaging.store';

describe('InstanceStore.compactInstance', () => {
  it('uses the compactor verdict as well as the IPC transport verdict', async () => {
    const streams = ['batchUpdate$', 'compactStatus$', 'fastToggled$', 'inputRequired$', 'inputRequiredResolved$', 'inputContextDelivered$',
      'instanceCreated$', 'instanceOutput$', 'instanceTranscriptChunk$', 'instanceRemoved$', 'instanceStateUpdate$', 'orchestrationActivity$', 'yoloToggled$'];
    const bus = Object.fromEntries(streams.map(name => [name, new Subject<unknown>()]));
    const compactInstance = vi.fn();
    TestBed.configureTestingModule({ providers: [
      { provide: IpcEventBusService, useValue: bus },
      { provide: InstanceIpcService, useValue: { compactInstance } },
      { provide: StatsIpcService, useValue: {} },
      { provide: ToastService, useValue: {} },
      { provide: ProviderStateService, useValue: {} },
      { provide: AutomationStore, useValue: {} },
      { provide: InstanceListStore, useValue: { loadInitialInstances: vi.fn() } },
      { provide: InstanceSelectionStore, useValue: {} },
      { provide: InstanceOutputStore, useValue: {} },
      { provide: InstanceMessagingStore, useValue: {} },
    ] });
    const store = TestBed.inject(InstanceStore);
    compactInstance.mockResolvedValueOnce({ success: true, data: { success: true } })
      .mockResolvedValueOnce({ success: true, data: { success: false } })
      .mockResolvedValueOnce({ success: false, error: { message: 'unavailable' } });
    expect(await store.compactInstance('one')).toBe(true);
    expect(await store.compactInstance('one')).toBe(false);
    expect(await store.compactInstance('one')).toBe(false);
  });
});
