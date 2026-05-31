import { describe, it, expect, vi, beforeEach } from 'vitest';
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

function make(): { service: AutoUpdateService; updater: FakeUpdater } {
  const updater = new FakeUpdater();
  const service = new AutoUpdateService({ autoUpdater: updater, currentVersion: '0.1.0' });
  return { service, updater };
}

describe('AutoUpdateService', () => {
  beforeEach(() => vi.clearAllMocks());

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
    expect(status).toMatchObject({ state: 'error', error: 'network down' });
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
