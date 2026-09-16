import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcFacadeService } from '../../services/ipc';
import { CrossSessionMessagingStore } from './cross-session-messaging.store';

describe('CrossSessionMessagingStore', () => {
  let store: CrossSessionMessagingStore;

  const instanceIpcMock = {
    listMessageableSessions: vi.fn(),
    sendCrossSessionMessage: vi.fn(),
  };

  beforeEach(() => {
    instanceIpcMock.listMessageableSessions.mockReset();
    instanceIpcMock.sendCrossSessionMessage.mockReset();
    TestBed.resetTestingModule();

    TestBed.configureTestingModule({
      providers: [
        CrossSessionMessagingStore,
        { provide: IpcFacadeService, useValue: { instance: instanceIpcMock } },
      ],
    });

    store = TestBed.inject(CrossSessionMessagingStore);
  });

  describe('refresh', () => {
    it('populates messageableSessions on success', async () => {
      instanceIpcMock.listMessageableSessions.mockResolvedValue({
        success: true,
        data: [{ instanceId: 'tgt', displayName: 'Target', reachable: true, reason: 'reachable' }],
      });

      await store.refresh('src');

      expect(instanceIpcMock.listMessageableSessions).toHaveBeenCalledWith('src');
      expect(store.messageableSessions()).toEqual([
        { instanceId: 'tgt', displayName: 'Target', reachable: true, reason: 'reachable' },
      ]);
      expect(store.lastError()).toBeNull();
    });

    it('records an error and leaves the list unchanged on failure', async () => {
      instanceIpcMock.listMessageableSessions.mockResolvedValue({
        success: false,
        error: { message: 'boom' },
      });

      await store.refresh('src');

      expect(store.messageableSessions()).toEqual([]);
      expect(store.lastError()).toBe('boom');
    });

    it('toggles loading around the IPC call', async () => {
      let resolveCall!: (value: unknown) => void;
      instanceIpcMock.listMessageableSessions.mockReturnValue(
        new Promise((resolve) => { resolveCall = resolve; }),
      );

      const pending = store.refresh('src');
      expect(store.loading()).toBe(true);

      resolveCall({ success: true, data: [] });
      await pending;

      expect(store.loading()).toBe(false);
    });
  });

  describe('send', () => {
    it('returns the discriminated result on success', async () => {
      instanceIpcMock.sendCrossSessionMessage.mockResolvedValue({
        success: true,
        data: { outcome: 'delivered', targetInstanceId: 'tgt', targetDisplayName: 'Target', hopCount: 0 },
      });

      const result = await store.send('src', 'tgt', 'hello');

      expect(instanceIpcMock.sendCrossSessionMessage).toHaveBeenCalledWith('src', 'tgt', 'hello');
      expect(result).toEqual({ outcome: 'delivered', targetInstanceId: 'tgt', targetDisplayName: 'Target', hopCount: 0 });
    });

    it('maps an IPC-level failure to a synthetic error outcome, never throwing', async () => {
      instanceIpcMock.sendCrossSessionMessage.mockResolvedValue({
        success: false,
        error: { message: 'not in electron' },
      });

      const result = await store.send('src', 'tgt', 'hello');

      expect(result).toEqual({ outcome: 'error', message: 'not in electron' });
    });
  });
});
