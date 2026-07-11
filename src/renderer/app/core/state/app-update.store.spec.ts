import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../../../../shared/types/update.types';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';
import { AppUpdateStore } from './app-update.store';

const IDLE: UpdateStatus = { state: 'idle', enabled: true, currentVersion: '0.1.0' };

describe('AppUpdateStore', () => {
  let statusListener: ((status: unknown) => void) | null;
  const cleanup = vi.fn();
  const api = {
    updateGetStatus: vi.fn(),
    updateCheck: vi.fn(),
    updateDownload: vi.fn(),
    updateInstall: vi.fn(),
    onUpdateStatusChanged: vi.fn((listener: (status: unknown) => void) => {
      statusListener = listener;
      return cleanup;
    }),
  };

  beforeEach(() => {
    statusListener = null;
    vi.clearAllMocks();
    api.updateGetStatus.mockResolvedValue({ success: true, data: IDLE });
    api.updateCheck.mockResolvedValue({ success: true, data: { ...IDLE, state: 'checking' } });
    api.updateDownload.mockResolvedValue({ success: true, data: { ...IDLE, state: 'downloading' } });
    api.updateInstall.mockResolvedValue({ success: true, data: { installing: true } });
    TestBed.configureTestingModule({
      providers: [
        AppUpdateStore,
        { provide: ElectronIpcService, useValue: { getApi: () => api } },
      ],
    });
  });

  it('loads initial status once and applies pushed status', async () => {
    const store = TestBed.inject(AppUpdateStore);
    await store.init();
    await store.init();

    expect(api.updateGetStatus).toHaveBeenCalledOnce();
    expect(api.onUpdateStatusChanged).toHaveBeenCalledOnce();

    statusListener?.({ ...IDLE, state: 'downloaded', availableVersion: '0.2.0', percent: 100 });
    expect(store.status()).toMatchObject({ state: 'downloaded', availableVersion: '0.2.0' });
    expect(store.visible()).toBe(true);
  });

  it('dismisses a downloaded version only for the current renderer session', async () => {
    const store = TestBed.inject(AppUpdateStore);
    await store.init();
    statusListener?.({ ...IDLE, state: 'downloaded', availableVersion: '0.2.0' });

    store.dismissForSession();
    expect(store.visible()).toBe(false);

    statusListener?.({ ...IDLE, state: 'downloaded', availableVersion: '0.2.1' });
    expect(store.visible()).toBe(true);
  });

  it('dismisses a downloaded update when the updater omits availableVersion', async () => {
    const store = TestBed.inject(AppUpdateStore);
    await store.init();
    statusListener?.({ ...IDLE, state: 'downloaded', percent: 100 });

    expect(store.visible()).toBe(true);
    store.dismissForSession();

    expect(store.visible()).toBe(false);
  });

  it('routes check, retry, and restart actions through the preload API', async () => {
    const store = TestBed.inject(AppUpdateStore);
    await store.init();

    await store.check();
    await store.retryDownload();
    await store.restartAndInstall();

    expect(api.updateCheck).toHaveBeenCalledOnce();
    expect(api.updateDownload).toHaveBeenCalledOnce();
    expect(api.updateInstall).toHaveBeenCalledOnce();
  });

  it('surfaces IPC failures and disposes its subscription', async () => {
    api.updateCheck.mockResolvedValueOnce({ success: false, error: { message: 'Feed unavailable' } });
    const store = TestBed.inject(AppUpdateStore);
    await store.init();

    await store.check();
    expect(store.error()).toBe('Feed unavailable');

    store.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
  });
});
