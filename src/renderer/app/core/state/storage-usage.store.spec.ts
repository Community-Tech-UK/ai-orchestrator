import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { StorageUsageStore } from './storage-usage.store';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';
const usage = { rows: [], measuredAt: 1, reclaimableBytes: 0, progress: null };
describe('storage card store', () => {
  const api = { storageGetUsage: vi.fn(async () => ({ success: true, data: usage })), storagePreviewCleanup: vi.fn(async () => ({ success: true, data: { previewId: 'fixture', target: 'activity-logs' } })), storageRunCleanup: vi.fn() };
  beforeEach(() => { vi.clearAllMocks(); TestBed.configureTestingModule({ providers: [{ provide: ElectronIpcService, useValue: { getApi: () => api } }] }); });
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });
  it('Cancel sends no cleanup and run carries only the server preview ticket', async () => {
    api.storageRunCleanup.mockResolvedValue({ success: true });
    const store = TestBed.inject(StorageUsageStore);
    await store.review('activity-logs'); store.cancel(); await store.run();
    expect(api.storageRunCleanup).not.toHaveBeenCalled();
    await store.review('activity-logs'); await store.run();
    expect(api.storageRunCleanup).toHaveBeenCalledExactlyOnceWith('activity-logs', 'fixture');
  });
  it('resumes polling when a card reopens during a server cleanup', async () => {
    vi.useFakeTimers();
    api.storageGetUsage.mockResolvedValueOnce({ success: true, data: { ...usage, progress: { target: 'event-record', running: true, removed: 1, estimatedTotal: 2 } } } as never);
    const store = TestBed.inject(StorageUsageStore);
    await store.refresh();
    expect(store.busy()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.storageGetUsage).toHaveBeenCalledTimes(2);
  });
  it('polls every two seconds while running, then stops and forces fresh numbers', async () => {
    vi.useFakeTimers();
    let resolve!: (response: unknown) => void;
    api.storageRunCleanup.mockImplementation(() => new Promise(done => { resolve = done; }));
    const store = TestBed.inject(StorageUsageStore);
    await store.review('activity-logs');
    const runningCleanup = store.run();
    await vi.advanceTimersByTimeAsync(4000);
    expect(api.storageGetUsage).toHaveBeenCalledTimes(2);
    resolve({ success: true }); await runningCleanup;
    expect(api.storageGetUsage).toHaveBeenLastCalledWith(true);
    const count = api.storageGetUsage.mock.calls.length;
    await vi.advanceTimersByTimeAsync(4000);
    expect(api.storageGetUsage).toHaveBeenCalledTimes(count);
  });
});
