import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingApprovalItem } from '../../../../shared/types/permission-registry.types';
import { PermissionRegistryIpcService } from '../services/ipc/permission-registry-ipc.service';
import { PermissionApprovalsStore } from './permission-approvals.store';

describe('PermissionApprovalsStore', () => {
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); vi.restoreAllMocks(); });
  it('shares one poll and clock, preserves requests after failure and cleans up timers', async () => {
    vi.useFakeTimers();
    const listPending = vi.fn().mockResolvedValue({ success: true, data: [{ id: 'r' }] });
    TestBed.configureTestingModule({ providers: [{ provide: PermissionRegistryIpcService, useValue: { listPending } }] });
    const store = TestBed.inject(PermissionApprovalsStore);
    store.startPolling(); store.startPolling();
    await Promise.resolve();
    expect(listPending).toHaveBeenCalledTimes(1);
    expect(store.pendingRequests()).toEqual([{ id: 'r' }]);
    listPending.mockRejectedValue(new Error('offline'));
    await vi.advanceTimersByTimeAsync(2500);
    expect(listPending).toHaveBeenCalledTimes(2);
    expect(store.pendingRequests()).toEqual([{ id: 'r' }]);
    TestBed.resetTestingModule();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports a failed refresh once until recovery while retaining pending approvals', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const approval: PendingApprovalItem = {
      id: 'request', instanceId: 'session', action: 'test-action', description: 'Approval request',
      createdAt: 1000, timeoutMs: 60000, expiresAt: 61000,
    };
    const listPending = vi.fn().mockResolvedValue({ success: true, data: [approval] });
    TestBed.configureTestingModule({ providers: [{ provide: PermissionRegistryIpcService, useValue: { listPending } }] });
    const store = TestBed.inject(PermissionApprovalsStore);
    await store.refresh();
    expect(warn).not.toHaveBeenCalled();

    listPending.mockResolvedValue({ success: false, error: { message: 'Internal response details' } });
    await store.refresh();
    expect(store.pendingRequests()).toEqual([approval]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenLastCalledWith('Unable to refresh approval requests. Keeping the last successful list.');

    listPending.mockRejectedValue(new Error('Internal transport details'));
    await store.refresh();
    expect(store.pendingRequests()).toEqual([approval]);
    expect(warn).toHaveBeenCalledTimes(1);

    listPending.mockResolvedValue({ success: true, data: [] });
    await store.refresh();
    expect(store.pendingRequests()).toEqual([]);
    listPending.mockRejectedValue(new Error('Internal transport details'));
    await store.refresh();
    expect(store.pendingRequests()).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith('Unable to refresh approval requests. Keeping the last successful list.');
  });
});
