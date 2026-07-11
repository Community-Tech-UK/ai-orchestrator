import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { AutoUpdateService, type UpdaterLike } from '../auto-update-service';

class FakeUpdater extends EventEmitter implements UpdaterLike {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  checkForUpdates = vi.fn(async () => ({}));
  downloadUpdate = vi.fn(async () => ({}));
  quitAndInstall = vi.fn();
}

function make(now: () => Date = () => new Date('2026-07-11T12:00:00.000Z')): {
  service: AutoUpdateService;
  updater: FakeUpdater;
} {
  const updater = new FakeUpdater();
  const service = new AutoUpdateService({ autoUpdater: updater, currentVersion: '0.1.0', now });
  return { service, updater };
}

describe('AutoUpdateService', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it('is idle and disabled before initialization', () => {
    const { service } = make();
    expect(service.getStatus()).toMatchObject({ state: 'idle', enabled: false, currentVersion: '0.1.0' });
  });

  it('stays disabled and never wires the updater when not enabled (dev)', () => {
    const { service, updater } = make();
    const onSpy = vi.spyOn(updater, 'on');
    service.initialize({ enabled: false });
    expect(service.getStatus().enabled).toBe(false);
    expect(onSpy).not.toHaveBeenCalled();
  });

  it('sets autoDownload from options when enabled', () => {
    const { service, updater } = make();
    service.initialize({ enabled: true, autoDownload: false });
    expect(updater.autoDownload).toBe(false);
  });

  it('delegates automatic download and normal-quit installation to electron-updater', () => {
    const { service, updater } = make();
    service.initialize({ enabled: true, autoDownload: true });

    expect(updater.autoDownload).toBe(true);
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it('checks after the startup delay and then on the polling interval', async () => {
    vi.useFakeTimers();
    const { service, updater } = make();
    service.initialize({
      enabled: true,
      autoDownload: true,
      startupDelayMs: 15_000,
      pollIntervalMs: 4 * 60 * 60 * 1_000,
    });

    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);

    service.dispose();
    await vi.advanceTimersByTimeAsync(4 * 60 * 60 * 1_000);
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });

  it('does not overlap update checks', async () => {
    const { service, updater } = make();
    let resolveCheck: (() => void) | null = null;
    updater.checkForUpdates.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveCheck = resolve; }),
    );
    service.initialize({ enabled: true });

    const first = service.checkForUpdates();
    const second = service.checkForUpdates();
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();

    resolveCheck?.();
    await Promise.all([first, second]);
  });

  it('does not check again while an update is available, downloading, or downloaded', async () => {
    const { service, updater } = make();
    service.initialize({ enabled: true });

    updater.emit('update-available', { version: '0.2.0' });
    await service.checkForUpdates();
    updater.emit('download-progress', { percent: 25 });
    await service.checkForUpdates();
    updater.emit('update-downloaded', { version: '0.2.0' });
    await service.checkForUpdates();

    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('maps the updater event stream to status transitions and emits them', () => {
    const { service, updater } = make();
    const seen: string[] = [];
    service.on('status', (s) => seen.push(s.state));
    service.initialize({ enabled: true });

    updater.emit('checking-for-update');
    expect(service.getStatus().state).toBe('checking');

    updater.emit('update-available', { version: '0.2.0' });
    expect(service.getStatus()).toMatchObject({ state: 'available', availableVersion: '0.2.0' });

    updater.emit('download-progress', { percent: 42.6 });
    expect(service.getStatus()).toMatchObject({ state: 'downloading', percent: 43 });

    updater.emit('update-downloaded', { version: '0.2.0' });
    expect(service.getStatus()).toMatchObject({ state: 'downloaded', percent: 100 });

    expect(seen).toContain('checking');
    expect(seen).toContain('downloaded');
  });

  it('records update-not-available and error states', () => {
    const { service, updater } = make();
    service.initialize({ enabled: true });
    updater.emit('update-not-available');
    expect(service.getStatus().state).toBe('not-available');
    updater.emit('error', new Error('feed unreachable'));
    expect(service.getStatus()).toMatchObject({ state: 'error', error: 'feed unreachable' });
  });

  it('classifies updater errors after update discovery as download failures', () => {
    const { service, updater } = make();
    service.initialize({ enabled: true });

    updater.emit('update-available', { version: '0.2.0' });
    updater.emit('error', new Error('automatic download failed'));

    expect(service.getStatus()).toMatchObject({
      state: 'error',
      error: 'automatic download failed',
      errorContext: 'download',
    });
  });

  it('checkForUpdates is a no-op while disabled', async () => {
    const { service, updater } = make();
    const status = await service.checkForUpdates();
    expect(status.state).toBe('idle');
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('checkForUpdates calls through and captures thrown errors', async () => {
    const { service, updater } = make();
    service.initialize({ enabled: true });
    await service.checkForUpdates();
    expect(updater.checkForUpdates).toHaveBeenCalledOnce();

    updater.checkForUpdates.mockRejectedValueOnce(new Error('network down'));
    const status = await service.checkForUpdates();
    expect(status).toMatchObject({
      state: 'error',
      error: 'network down',
      errorContext: 'check',
      lastCheckedAt: '2026-07-11T12:00:00.000Z',
    });
  });

  it('records download failures as retryable download errors', async () => {
    const { service, updater } = make();
    service.initialize({ enabled: true });
    updater.downloadUpdate.mockRejectedValueOnce(new Error('download interrupted'));

    const status = await service.downloadUpdate();

    expect(status).toMatchObject({
      state: 'error',
      error: 'download interrupted',
      errorContext: 'download',
    });
  });

  it('removes only its updater listeners when disposed', () => {
    const { service, updater } = make();
    const externalListener = vi.fn();
    updater.on('update-available', externalListener);
    service.initialize({ enabled: true });

    service.dispose();
    updater.emit('update-available', { version: '0.2.0' });

    expect(externalListener).toHaveBeenCalledOnce();
    expect(service.listenerCount('status')).toBe(0);
    expect(service.getStatus().state).toBe('idle');
  });

  it('quitAndInstall only fires when an update is downloaded', () => {
    const { service, updater } = make();
    service.initialize({ enabled: true });
    expect(service.quitAndInstall()).toBe(false);
    expect(updater.quitAndInstall).not.toHaveBeenCalled();

    updater.emit('update-downloaded', { version: '0.2.0' });
    expect(service.quitAndInstall()).toBe(true);
    expect(updater.quitAndInstall).toHaveBeenCalledOnce();
  });
});
