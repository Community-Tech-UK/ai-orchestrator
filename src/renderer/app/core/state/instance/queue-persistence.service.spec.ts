import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileAttachment } from '../../../../../shared/types/instance.types';
import { InstanceIpcService } from '../../services/ipc/instance-ipc.service';
import { ToastService } from '../../services/toast.service';
import { SettingsStore } from '../settings.store';
import type { QueuedMessage } from './instance.types';
import { InstanceStateService } from './instance-state.service';
import { QueuePersistenceService } from './queue-persistence.service';

interface InitialPromptPayload {
  instanceId: string;
  message: string;
  attachments?: FileAttachment[];
  seededAlready: true;
}

describe('QueuePersistenceService', () => {
  let initialPromptHandler: ((payload: InitialPromptPayload) => void) | undefined;
  let queueSignal: ReturnType<typeof signal<Map<string, QueuedMessage[]>>>;
  let settingsValues: Record<string, boolean>;
  let toastMock: { show: ReturnType<typeof vi.fn> };
  let ipcMock: {
    onInstanceQueueInitialPrompt: ReturnType<typeof vi.fn>;
    instanceQueueLoadAll: ReturnType<typeof vi.fn>;
    instanceQueueSave: ReturnType<typeof vi.fn>;
    queueList: ReturnType<typeof vi.fn>;
    queueEnqueue: ReturnType<typeof vi.fn>;
    queueCancel: ReturnType<typeof vi.fn>;
    queuePromote: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    initialPromptHandler = undefined;
    queueSignal = signal(new Map<string, QueuedMessage[]>());
    settingsValues = {
      pauseFeatureEnabled: true,
      persistSessionContent: false,
    };
    ipcMock = {
      onInstanceQueueInitialPrompt: vi.fn((handler: (payload: InitialPromptPayload) => void) => {
        initialPromptHandler = handler;
        return vi.fn();
      }),
      instanceQueueLoadAll: vi.fn().mockResolvedValue({ success: true, data: { queues: {} } }),
      instanceQueueSave: vi.fn().mockResolvedValue({ success: true }),
      queueList: vi.fn().mockResolvedValue({ success: true, data: { queues: {} } }),
      queueEnqueue: vi.fn().mockResolvedValue({ success: true, data: { admissionId: 'adm-1', queuePosition: 0 } }),
      queueCancel: vi.fn().mockResolvedValue({ success: true, data: { cancelled: true } }),
      queuePromote: vi.fn().mockResolvedValue({ success: true, data: null }),
    };
    toastMock = { show: vi.fn() };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        QueuePersistenceService,
        {
          provide: InstanceStateService,
          useValue: {
            messageQueue: queueSignal,
          },
        },
        { provide: InstanceIpcService, useValue: ipcMock },
        { provide: ToastService, useValue: toastMock },
        {
          provide: SettingsStore,
          useValue: {
            isInitialized: vi.fn(() => true),
            get: vi.fn((key: string) => settingsValues[key] ?? false),
          },
        },
      ],
    });
  });

  function flushMicrotasks(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** Enqueues an entry into the live queue signal so isStillQueued()-gated retries can find it. */
  function seedQueue(instanceId: string, entry: QueuedMessage): void {
    queueSignal.update((current) => {
      const next = new Map(current);
      next.set(instanceId, [...(next.get(instanceId) ?? []), entry]);
      return next;
    });
  }

  it('subscribes to initial prompt broadcasts when session persistence is disabled', () => {
    const service = TestBed.inject(QueuePersistenceService);

    service.subscribeToInitialPrompts();
    initialPromptHandler?.({
      instanceId: 'inst-1',
      message: 'Seeded prompt',
      seededAlready: true,
    });

    expect(queueSignal().get('inst-1')).toEqual([
      {
        message: 'Seeded prompt',
        files: undefined,
        seededAlready: true,
        hadAttachmentsDropped: false,
      },
    ]);
  });

  it('does not subscribe to initial prompt broadcasts when the pause feature is disabled', () => {
    settingsValues['pauseFeatureEnabled'] = false;
    const service = TestBed.inject(QueuePersistenceService);

    service.subscribeToInitialPrompts();

    expect(initialPromptHandler).toBeUndefined();
  });

  describe('durable queue mutations (persistSessionContent enabled)', () => {
    beforeEach(() => {
      settingsValues['persistSessionContent'] = true;
    });

    it('notifyEnqueued durably persists a text-only entry and tracks its admissionId', async () => {
      const service = TestBed.inject(QueuePersistenceService);
      const entry: QueuedMessage = { message: 'hello' };

      service.notifyEnqueued('inst-1', entry, 'back');
      await flushMicrotasks();

      expect(ipcMock.queueEnqueue).toHaveBeenCalledWith('inst-1', expect.objectContaining({ message: 'hello' }));

      // A subsequent notifyEnqueued for the same (now-tracked) object is a no-op.
      service.notifyEnqueued('inst-1', entry, 'back');
      await flushMicrotasks();
      expect(ipcMock.queueEnqueue).toHaveBeenCalledTimes(1);
    });

    it('notifyEnqueued is a no-op when persistence is disabled', async () => {
      settingsValues['persistSessionContent'] = false;
      const service = TestBed.inject(QueuePersistenceService);
      service.notifyEnqueued('inst-1', { message: 'hi' }, 'back');
      await flushMicrotasks();
      expect(ipcMock.queueEnqueue).not.toHaveBeenCalled();
    });

    it('notifyCancelled cancels a tracked entry and is a no-op for an untracked one', async () => {
      const service = TestBed.inject(QueuePersistenceService);
      const entry: QueuedMessage = { message: 'to cancel' };
      service.notifyEnqueued('inst-1', entry, 'back');
      await flushMicrotasks();

      service.notifyCancelled('inst-1', entry);
      await flushMicrotasks();
      expect(ipcMock.queueCancel).toHaveBeenCalledWith('adm-1');

      // Untracked entry — never enqueued — must not call cancel.
      service.notifyCancelled('inst-1', { message: 'never enqueued' });
      await flushMicrotasks();
      expect(ipcMock.queueCancel).toHaveBeenCalledTimes(1);
    });

    it('notifyPromoting awaits the promote IPC call for a tracked entry and clears tracking', async () => {
      const service = TestBed.inject(QueuePersistenceService);
      const entry: QueuedMessage = { message: 'to promote' };
      service.notifyEnqueued('inst-1', entry, 'back');
      await flushMicrotasks();

      await service.notifyPromoting('inst-1', entry);
      expect(ipcMock.queuePromote).toHaveBeenCalledWith('adm-1');

      // Already untracked (cleared by the first promote) — second call is a no-op.
      await service.notifyPromoting('inst-1', entry);
      expect(ipcMock.queuePromote).toHaveBeenCalledTimes(1);
    });

    it('notifyPromoting swallows a rejected promote call and returns false (never throws)', async () => {
      ipcMock.queuePromote.mockRejectedValue(new Error('boom'));
      const service = TestBed.inject(QueuePersistenceService);
      const entry: QueuedMessage = { message: 'flaky' };
      await service.notifyEnqueued('inst-1', entry, 'back');

      await expect(service.notifyPromoting('inst-1', entry)).resolves.toBe(false);
      // A failed promote must NOT clear tracking — a retry needs the same admissionId.
      await service.notifyPromoting('inst-1', entry);
      expect(ipcMock.queuePromote).toHaveBeenCalledTimes(2);
    });

    it('notifyPromoting returns false when the IPC call resolves with success:false', async () => {
      ipcMock.queuePromote.mockResolvedValue({ success: false, error: { message: 'db locked' } });
      const service = TestBed.inject(QueuePersistenceService);
      const entry: QueuedMessage = { message: 'db-locked' };
      await service.notifyEnqueued('inst-1', entry, 'back');

      await expect(service.notifyPromoting('inst-1', entry)).resolves.toBe(false);
    });

    it('notifyPromoting returns true for an untracked entry (nothing to gate on)', async () => {
      const service = TestBed.inject(QueuePersistenceService);
      await expect(service.notifyPromoting('inst-1', { message: 'never queued' })).resolves.toBe(true);
      expect(ipcMock.queuePromote).not.toHaveBeenCalled();
    });

    it('rebindEntry moves the durable-row association to a new object and skips re-enqueueing it', async () => {
      const service = TestBed.inject(QueuePersistenceService);
      const original: QueuedMessage = { message: 'steer me' };
      service.notifyEnqueued('inst-1', original, 'back');
      await flushMicrotasks();

      const steerVersion: QueuedMessage = { ...original, kind: 'steer' };
      service.rebindEntry(original, steerVersion);

      service.notifyEnqueued('inst-1', steerVersion, 'steer');
      await flushMicrotasks();
      expect(ipcMock.queueEnqueue).toHaveBeenCalledTimes(1); // no second enqueue for the rebound object

      await service.notifyPromoting('inst-1', steerVersion);
      expect(ipcMock.queuePromote).toHaveBeenCalledWith('adm-1'); // promotes under the ORIGINAL admissionId
    });

    it('rebindEntry is a no-op when the source entry was never tracked', () => {
      const service = TestBed.inject(QueuePersistenceService);
      expect(() => service.rebindEntry({ message: 'never tracked' }, { message: 'new' })).not.toThrow();
    });
  });

  describe('durability failure is never silent (Finding 1)', () => {
    beforeEach(() => {
      settingsValues['persistSessionContent'] = true;
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('marks the entry notDurable immediately on enqueue, before the IPC call resolves', () => {
      ipcMock.queueEnqueue.mockImplementation(() => new Promise(() => undefined)); // never resolves in this test
      const service = TestBed.inject(QueuePersistenceService);
      const entry: QueuedMessage = { message: 'pending' };
      seedQueue('inst-1', entry);

      void service.notifyEnqueued('inst-1', entry, 'back');

      expect(entry.notDurable).toBe(true);
    });

    it('clears notDurable once the durable write is confirmed', async () => {
      const service = TestBed.inject(QueuePersistenceService);
      const entry: QueuedMessage = { message: 'ok' };
      seedQueue('inst-1', entry);

      await service.notifyEnqueued('inst-1', entry, 'back');

      expect(entry.notDurable).toBe(false);
    });

    it('a failed IPC enqueue keeps the entry notDurable, toasts exactly once, and retries with backoff until it succeeds', async () => {
      ipcMock.queueEnqueue
        .mockResolvedValueOnce({ success: false, error: { message: 'disk full' } })
        .mockResolvedValueOnce({ success: false, error: { message: 'disk full' } })
        .mockResolvedValueOnce({ success: true, data: { admissionId: 'adm-recovered', queuePosition: 0 } });

      const service = TestBed.inject(QueuePersistenceService);
      const entry: QueuedMessage = { message: 'retry me' };
      seedQueue('inst-1', entry);

      const initialAttempt = service.notifyEnqueued('inst-1', entry, 'back');
      await initialAttempt;

      expect(entry.notDurable).toBe(true);
      expect(toastMock.show).toHaveBeenCalledTimes(1);
      expect(toastMock.show).toHaveBeenCalledWith(expect.stringContaining('could not be saved'), 'error');
      expect(ipcMock.queueEnqueue).toHaveBeenCalledTimes(1);

      // First backoff retry (2s) — still failing.
      await vi.advanceTimersByTimeAsync(2000);
      expect(ipcMock.queueEnqueue).toHaveBeenCalledTimes(2);
      expect(entry.notDurable).toBe(true);
      expect(toastMock.show).toHaveBeenCalledTimes(1); // no repeat toast on subsequent retries

      // Second backoff retry (4s) — succeeds this time.
      await vi.advanceTimersByTimeAsync(4000);
      expect(ipcMock.queueEnqueue).toHaveBeenCalledTimes(3);
      expect(entry.notDurable).toBe(false);
    });

    it('stops retrying (but stays visibly notDurable) once the entry leaves the live queue', async () => {
      ipcMock.queueEnqueue.mockResolvedValue({ success: false, error: { message: 'disk full' } });
      const service = TestBed.inject(QueuePersistenceService);
      const entry: QueuedMessage = { message: 'about to be cancelled' };
      seedQueue('inst-1', entry);

      await service.notifyEnqueued('inst-1', entry, 'back');
      expect(ipcMock.queueEnqueue).toHaveBeenCalledTimes(1);

      // Simulate cancellation: the entry leaves the tracked signal.
      queueSignal.set(new Map());

      await vi.advanceTimersByTimeAsync(2000);
      expect(ipcMock.queueEnqueue).toHaveBeenCalledTimes(1); // no retry fired
      expect(entry.notDurable).toBe(true); // still visibly marked, just not retried further
    });

    it('gives up after MAX_ENQUEUE_ATTEMPTS but leaves the entry visibly notDurable', async () => {
      ipcMock.queueEnqueue.mockResolvedValue({ success: false, error: { message: 'disk full' } });
      const service = TestBed.inject(QueuePersistenceService);
      const entry: QueuedMessage = { message: 'never recovers' };
      seedQueue('inst-1', entry);

      await service.notifyEnqueued('inst-1', entry, 'back');
      // Drain every scheduled backoff retry (2s,4s,8s,16s,30s caps).
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(30_000);
      }

      expect(entry.notDurable).toBe(true);
      expect(toastMock.show).toHaveBeenCalledTimes(1);
      // Bounded: does not retry forever.
      const callsAfterExhaustion = ipcMock.queueEnqueue.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ipcMock.queueEnqueue.mock.calls.length).toBe(callsAfterExhaustion);
    });
  });

  describe('restoreFromDisk', () => {
    beforeEach(() => {
      settingsValues['persistSessionContent'] = true;
    });

    it('is a no-op when persistence is disabled', async () => {
      settingsValues['persistSessionContent'] = false;
      const service = TestBed.inject(QueuePersistenceService);
      await service.restoreFromDisk();
      expect(ipcMock.queueList).not.toHaveBeenCalled();
    });

    it('reconstructs a File from a durable row carrying a base64 attachment (attachment survives a crash restore)', async () => {
      ipcMock.queueList.mockResolvedValue({
        success: true,
        data: {
          queues: {
            'inst-1': [
              {
                admissionId: 'adm-restored',
                instanceId: 'inst-1',
                message: 'restored message',
                attachments: [{ name: 'note.txt', type: 'text/plain', size: 5, data: 'data:text/plain;base64,aGVsbG8=' }],
                contextBlock: null,
                queuePosition: 0,
                state: 'queued',
                sourceMetadata: { kind: 'queue' },
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          },
        },
      });

      const service = TestBed.inject(QueuePersistenceService);
      await service.restoreFromDisk();

      const restored = queueSignal().get('inst-1');
      expect(restored).toHaveLength(1);
      expect(restored?.[0].message).toBe('restored message');
      expect(restored?.[0].hadAttachmentsDropped).toBe(false);
      const files = restored?.[0].files;
      expect(files).toHaveLength(1);
      expect(files?.[0].name).toBe('note.txt');
      expect(files?.[0].type).toBe('text/plain');
      const text = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsText(files![0]);
      });
      expect(text).toBe('hello');

      // The restored entry is durably tracked — cancelling it hits the real row.
      service.notifyCancelled('inst-1', restored![0]);
      await flushMicrotasks();
      expect(ipcMock.queueCancel).toHaveBeenCalledWith('adm-restored');
    });

    it('marks a legacy-imported row (no attachments) as hadAttachmentsDropped when its sourceMetadata says so', async () => {
      ipcMock.queueList.mockResolvedValue({
        success: true,
        data: {
          queues: {
            'inst-1': [
              {
                admissionId: 'adm-legacy',
                instanceId: 'inst-1',
                message: 'legacy message',
                attachments: [],
                contextBlock: null,
                queuePosition: 0,
                state: 'queued',
                sourceMetadata: { hadAttachmentsDropped: true, kind: 'queue' },
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          },
        },
      });

      const service = TestBed.inject(QueuePersistenceService);
      await service.restoreFromDisk();

      const restored = queueSignal().get('inst-1');
      expect(restored?.[0]).toMatchObject({ message: 'legacy message', files: undefined, hadAttachmentsDropped: true });
    });

    it('marks hadAttachmentsDropped when the main side reports a resolve failure (Finding 3), even though other attachments resolved fine', async () => {
      ipcMock.queueList.mockResolvedValue({
        success: true,
        data: {
          queues: {
            'inst-1': [
              {
                admissionId: 'adm-partial',
                instanceId: 'inst-1',
                message: 'partial attachments',
                // One of two attachments failed to resolve on the main side —
                // the surviving one is still returned, but attachmentsDropped
                // must still surface the loss (never silent).
                attachments: [{ name: 'ok.txt', type: 'text/plain', size: 2, data: 'data:text/plain;base64,b2s=' }],
                attachmentsDropped: true,
                contextBlock: null,
                queuePosition: 0,
                state: 'queued',
                sourceMetadata: { kind: 'queue' },
                createdAt: 1,
                updatedAt: 1,
              },
            ],
          },
        },
      });

      const service = TestBed.inject(QueuePersistenceService);
      await service.restoreFromDisk();

      const restored = queueSignal().get('inst-1');
      expect(restored?.[0].hadAttachmentsDropped).toBe(true);
      // The one attachment that DID resolve is still reconstructed as a real File.
      expect(restored?.[0].files).toHaveLength(1);
    });

    it('migrates legacy ElectronStore entries into the durable store exactly once, then clears the legacy store', async () => {
      ipcMock.instanceQueueLoadAll
        .mockResolvedValueOnce({
          success: true,
          data: {
            queues: {
              'inst-1': [{ message: 'legacy queued', hadAttachmentsDropped: true, kind: 'queue' as const }],
            },
          },
        })
        .mockResolvedValueOnce({ success: true, data: { queues: {} } });

      const service = TestBed.inject(QueuePersistenceService);
      await service.restoreFromDisk();

      expect(ipcMock.queueEnqueue).toHaveBeenCalledWith(
        'inst-1',
        expect.objectContaining({
          message: 'legacy queued',
          sourceMetadata: expect.objectContaining({ hadAttachmentsDropped: true }),
        }),
      );
      expect(ipcMock.instanceQueueSave).toHaveBeenCalledWith('inst-1', []);

      // Second restore: the (mocked) legacy store is now empty — migration is skipped.
      ipcMock.queueEnqueue.mockClear();
      ipcMock.instanceQueueSave.mockClear();
      await service.restoreFromDisk();
      expect(ipcMock.queueEnqueue).not.toHaveBeenCalled();
      expect(ipcMock.instanceQueueSave).not.toHaveBeenCalled();
    });
  });

  it('clearPendingSaves is a harmless no-op (kept for PauseRendererController API compatibility)', () => {
    const service = TestBed.inject(QueuePersistenceService);
    expect(() => service.clearPendingSaves()).not.toThrow();
  });
});
