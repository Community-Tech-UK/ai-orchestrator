import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcFacadeService } from '../../services/ipc';
import { InstanceStateService } from './instance-state.service';
import { InstanceStatusReconcilerService } from './instance-status-reconciler.service';
import type { Instance, InstanceStatus } from './instance.types';

function createInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    displayName: 'Instance 1',
    createdAt: Date.now(),
    historyThreadId: 'thread-1',
    parentId: null,
    childrenIds: [],
    agentId: 'build',
    agentMode: 'build',
    provider: 'codex',
    status: 'busy',
    contextUsage: {
      used: 0,
      total: 200000,
      percentage: 0,
    },
    lastActivity: Date.now(),
    providerSessionId: 'provider-session-1',
    sessionId: 'session-1',
    restartEpoch: 0,
    workingDirectory: '/tmp/project',
    yoloMode: false,
    launchMode: 'interactive',
    currentModel: undefined,
    outputBuffer: [],
    ...overrides,
  };
}

function backendEntry(id: string, status: InstanceStatus): Record<string, unknown> {
  return { id, status };
}

describe('InstanceStatusReconcilerService', () => {
  let service: InstanceStatusReconcilerService;
  let stateService: InstanceStateService;

  const ipcMock = {
    listInstances: vi.fn(),
  };

  beforeEach(() => {
    ipcMock.listInstances.mockReset();
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        InstanceStatusReconcilerService,
        InstanceStateService,
        { provide: IpcFacadeService, useValue: ipcMock },
      ],
    });
    service = TestBed.inject(InstanceStatusReconcilerService);
    stateService = TestBed.inject(InstanceStateService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('skips the IPC round-trip entirely when no instance looks stale', async () => {
    stateService.addInstance(createInstance({ status: 'idle' }));

    await service.reconcileOnce();

    expect(ipcMock.listInstances).not.toHaveBeenCalled();
  });

  it('adopts the backend status only after two consecutive mismatched polls', async () => {
    stateService.addInstance(createInstance({ status: 'busy' }));
    ipcMock.listInstances.mockResolvedValue({
      success: true,
      data: [backendEntry('inst-1', 'idle')],
    });

    await service.reconcileOnce();
    expect(stateService.getInstance('inst-1')?.status).toBe('busy');

    await service.reconcileOnce();
    expect(stateService.getInstance('inst-1')?.status).toBe('idle');
  });

  it('corrects a stale initializing status from a missed startup event', async () => {
    stateService.addInstance(createInstance({ status: 'initializing' }));
    ipcMock.listInstances.mockResolvedValue({
      success: true,
      data: [backendEntry('inst-1', 'idle')],
    });

    await service.reconcileOnce();
    await service.reconcileOnce();

    expect(stateService.getInstance('inst-1')?.status).toBe('idle');
  });

  it('leaves the renderer status alone while the backend reports an active turn', async () => {
    stateService.addInstance(createInstance({ status: 'busy' }));
    ipcMock.listInstances.mockResolvedValue({
      success: true,
      data: [backendEntry('inst-1', 'busy')],
    });

    await service.reconcileOnce();
    await service.reconcileOnce();

    expect(stateService.getInstance('inst-1')?.status).toBe('busy');
  });

  it('requires the mismatch streak to be consecutive', async () => {
    stateService.addInstance(createInstance({ status: 'busy' }));
    ipcMock.listInstances
      .mockResolvedValueOnce({ success: true, data: [backendEntry('inst-1', 'idle')] })
      .mockResolvedValueOnce({ success: true, data: [backendEntry('inst-1', 'busy')] })
      .mockResolvedValueOnce({ success: true, data: [backendEntry('inst-1', 'idle')] });

    await service.reconcileOnce();
    await service.reconcileOnce();
    // The idle mismatch did not recur consecutively, so this third poll is
    // streak 1 again — nothing may be applied yet.
    await service.reconcileOnce();

    expect(stateService.getInstance('inst-1')?.status).toBe('busy');
  });

  it('does not reconcile an instance with a recently dispatched send', async () => {
    stateService.addInstance(createInstance({ status: 'busy' }));
    service.noteSendStarted('inst-1');
    ipcMock.listInstances.mockResolvedValue({
      success: true,
      data: [backendEntry('inst-1', 'idle')],
    });

    await service.reconcileOnce();
    await service.reconcileOnce();
    expect(stateService.getInstance('inst-1')?.status).toBe('busy');
    expect(ipcMock.listInstances).not.toHaveBeenCalled();

    service.noteSendSettled('inst-1');
    await service.reconcileOnce();
    await service.reconcileOnce();
    expect(stateService.getInstance('inst-1')?.status).toBe('idle');
  });

  it('does not stomp an instance whose status changed while the poll was in flight', async () => {
    stateService.addInstance(createInstance({ status: 'busy' }));
    ipcMock.listInstances
      .mockResolvedValueOnce({ success: true, data: [backendEntry('inst-1', 'idle')] })
      // Second poll: a real status event lands during the IPC round-trip.
      .mockImplementationOnce(async () => {
        stateService.updateInstance('inst-1', { status: 'thinking_deeply' });
        return { success: true, data: [backendEntry('inst-1', 'idle')] };
      });

    await service.reconcileOnce();
    await service.reconcileOnce();

    expect(stateService.getInstance('inst-1')?.status).toBe('thinking_deeply');
  });

  it('ignores instances the backend no longer knows about', async () => {
    stateService.addInstance(createInstance({ status: 'busy' }));
    ipcMock.listInstances.mockResolvedValue({ success: true, data: [] });

    await service.reconcileOnce();
    await service.reconcileOnce();

    expect(stateService.getInstance('inst-1')?.status).toBe('busy');
  });
});
