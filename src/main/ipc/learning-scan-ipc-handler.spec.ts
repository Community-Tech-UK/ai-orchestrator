import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '@contracts/channels';
import type { LearningScanService } from '../learning/learning-scan-service';

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), removeHandler: vi.fn() },
}));

import { registerLearningScanHandlers } from './learning-scan-ipc-handler';

const fakeEvent = {} as Parameters<Parameters<typeof ipcMain.handle>[1]>[0];

type RegisteredHandler = (...args: unknown[]) => unknown;

function handlerFor(channel: string): RegisteredHandler {
  const call = vi.mocked(ipcMain.handle).mock.calls.find(([registered]) => registered === channel);
  if (!call) throw new Error(`No handler registered for channel: ${channel}`);
  return call[1] as RegisteredHandler;
}

function makeFakeService(): Pick<LearningScanService, 'runScan' | 'getStatus'> {
  return {
    runScan: vi.fn(async () => ({
      scopeKey: '__global__',
      sessionsScanned: 3,
      sessionsSkipped: 0,
      proposalsCreated: 1,
      proposalsReinforced: 0,
      patternsFound: 1,
      startedAt: 1,
      completedAt: 2,
      error: null,
    })),
    getStatus: vi.fn(() => ({
      scopeKey: '__global__',
      lastScannedEndedAt: 1000,
      lastScannedEntryId: 'e1',
      lastScanStartedAt: 1,
      lastScanCompletedAt: 2,
      sessionsScannedLastRun: 3,
      sessionsScannedTotal: 3,
      proposalsCreatedLastRun: 1,
      proposalsReinforcedLastRun: 0,
      lastError: null,
      updatedAt: 2,
    })),
  };
}

describe('registerLearningScanHandlers', () => {
  let service: Pick<LearningScanService, 'runScan' | 'getStatus'>;

  beforeEach(() => {
    vi.mocked(ipcMain.handle).mockClear();
    service = makeFakeService();
    registerLearningScanHandlers({ service: service as LearningScanService });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('runs a scan with the default payload and returns the summary', async () => {
    const result = await handlerFor(IPC_CHANNELS.LEARNING_SCAN_RUN)(fakeEvent, undefined);
    expect(result).toMatchObject({ success: true, data: { sessionsScanned: 3, proposalsCreated: 1 } });
    expect(service.runScan).toHaveBeenCalledWith({});
  });

  it('passes a validated scoped payload through to the service', async () => {
    await handlerFor(IPC_CHANNELS.LEARNING_SCAN_RUN)(fakeEvent, { workspaceId: '/repo', sessionLimit: 10 });
    expect(service.runScan).toHaveBeenCalledWith({ workspaceId: '/repo', sessionLimit: 10 });
  });

  it('rejects an invalid run payload (sessionLimit out of range)', async () => {
    const result = await handlerFor(IPC_CHANNELS.LEARNING_SCAN_RUN)(fakeEvent, { sessionLimit: 0 });
    expect(result).toMatchObject({ success: false, error: { code: 'VALIDATION_FAILED' } });
  });

  it('gets scan status for a scope', async () => {
    const result = await handlerFor(IPC_CHANNELS.LEARNING_SCAN_GET_STATUS)(fakeEvent, { workspaceId: '/repo' });
    expect(result).toMatchObject({ success: true, data: { scopeKey: '__global__' } });
    expect(service.getStatus).toHaveBeenCalledWith('/repo');
  });

  it('gets scan status with no payload (global scope)', async () => {
    const result = await handlerFor(IPC_CHANNELS.LEARNING_SCAN_GET_STATUS)(fakeEvent, undefined);
    expect(result).toMatchObject({ success: true });
    expect(service.getStatus).toHaveBeenCalledWith(undefined);
  });

  it('honours ensureTrustedSender before touching the service', async () => {
    vi.mocked(ipcMain.handle).mockClear();
    const trustError = { success: false, error: { code: 'IPC_TRUST_FAILED', message: 'Untrusted sender', timestamp: 123 } };
    const ensureTrustedSender = vi.fn(() => trustError);
    registerLearningScanHandlers({ service: service as LearningScanService, ensureTrustedSender });

    const result = await handlerFor(IPC_CHANNELS.LEARNING_SCAN_RUN)(fakeEvent, undefined);
    expect(result).toEqual(trustError);
    expect(ensureTrustedSender).toHaveBeenCalledWith(fakeEvent, IPC_CHANNELS.LEARNING_SCAN_RUN);
    expect(service.runScan).not.toHaveBeenCalled();
  });
});
