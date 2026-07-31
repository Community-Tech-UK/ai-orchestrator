/**
 * Tests for the durable renderer send-queue IPC handlers (WS-A1 Phase B).
 *
 * Strategy: mock `electron` to capture ipcMain.handle registrations (same
 * approach as session-handlers.spec.ts), then invoke the captured handlers
 * directly to verify Zod validation and service wiring without launching an
 * Electron process.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../../../shared/types/ipc.types';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<unknown>;
const handlers = new Map<string, IpcHandler>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
}));

const mockEnqueue = vi.fn();
const mockUpdate = vi.fn();
const mockCancel = vi.fn();
const mockReorder = vi.fn();
const mockList = vi.fn();
const mockPromote = vi.fn();

vi.mock('../../../session/session-queue-service', () => ({
  getSessionQueueService: () => ({
    enqueueUserMessage: mockEnqueue,
    updateQueuedMessage: mockUpdate,
    cancelQueuedMessage: mockCancel,
    reorderQueue: mockReorder,
    listQueue: mockList,
    promoteQueuedMessage: mockPromote,
  }),
}));

import { registerSessionQueueHandlers } from '../session-queue-handlers';
import { IPC_CHANNELS } from '../../../../shared/types/ipc.types';

async function invoke(channel: string, payload?: unknown): Promise<IpcResponse<Record<string, unknown>>> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for channel: ${channel}`);
  return handler({}, payload) as Promise<IpcResponse<Record<string, unknown>>>;
}

describe('session-queue-handlers', () => {
  beforeEach(() => {
    handlers.clear();
    vi.clearAllMocks();
    registerSessionQueueHandlers({});
  });

  describe('SESSION_QUEUE_ENQUEUE', () => {
    it('validates and forwards to the service, returning the admissionId', async () => {
      mockEnqueue.mockResolvedValue({ admissionId: 'adm-1', queuePosition: 0 });
      const result = await invoke(IPC_CHANNELS.SESSION_QUEUE_ENQUEUE, { instanceId: 'i1', message: 'hello' });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ admissionId: 'adm-1', queuePosition: 0 });
      expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ instanceId: 'i1', message: 'hello' }));
    });

    it('rejects a payload with neither message nor attachments', async () => {
      const result = await invoke(IPC_CHANNELS.SESSION_QUEUE_ENQUEUE, { instanceId: 'i1', message: '' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('VALIDATION_FAILED');
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('rejects a missing instanceId', async () => {
      const result = await invoke(IPC_CHANNELS.SESSION_QUEUE_ENQUEUE, { message: 'hi' });
      expect(result.success).toBe(false);
      expect(mockEnqueue).not.toHaveBeenCalled();
    });

    it('returns a structured error when the service throws', async () => {
      mockEnqueue.mockRejectedValue(new Error('disk full'));
      const result = await invoke(IPC_CHANNELS.SESSION_QUEUE_ENQUEUE, { instanceId: 'i1', message: 'hi' });
      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('SESSION_QUEUE_ENQUEUE_FAILED');
      expect(result.error?.message).toContain('disk full');
    });
  });

  describe('SESSION_QUEUE_UPDATE', () => {
    it('validates and forwards the patch', async () => {
      mockUpdate.mockResolvedValue({ admissionId: 'adm-1', message: 'edited' });
      const result = await invoke(IPC_CHANNELS.SESSION_QUEUE_UPDATE, { admissionId: 'adm-1', message: 'edited' });
      expect(result.success).toBe(true);
      expect(mockUpdate).toHaveBeenCalledWith('adm-1', expect.objectContaining({ message: 'edited' }));
    });

    it('rejects a missing admissionId', async () => {
      const result = await invoke(IPC_CHANNELS.SESSION_QUEUE_UPDATE, { message: 'edited' });
      expect(result.success).toBe(false);
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe('SESSION_QUEUE_CANCEL', () => {
    it('forwards admissionId and returns cancelled:true/false', async () => {
      mockCancel.mockReturnValue(true);
      const result = await invoke(IPC_CHANNELS.SESSION_QUEUE_CANCEL, { admissionId: 'adm-1' });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ cancelled: true });
      expect(mockCancel).toHaveBeenCalledWith('adm-1');
    });
  });

  describe('SESSION_QUEUE_REORDER', () => {
    it('forwards instanceId and orderedIds', async () => {
      const result = await invoke(IPC_CHANNELS.SESSION_QUEUE_REORDER, { instanceId: 'i1', orderedIds: ['a', 'b'] });
      expect(result.success).toBe(true);
      expect(mockReorder).toHaveBeenCalledWith('i1', ['a', 'b']);
    });
  });

  describe('SESSION_QUEUE_LIST', () => {
    it('lists a single instance when instanceId is provided', async () => {
      mockList.mockResolvedValue({ i1: [] });
      const result = await invoke(IPC_CHANNELS.SESSION_QUEUE_LIST, { instanceId: 'i1' });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ queues: { i1: [] } });
      expect(mockList).toHaveBeenCalledWith('i1');
    });

    it('lists all instances when no payload is provided', async () => {
      mockList.mockResolvedValue({ i1: [], i2: [] });
      const result = await invoke(IPC_CHANNELS.SESSION_QUEUE_LIST, undefined);
      expect(result.success).toBe(true);
      expect(mockList).toHaveBeenCalledWith(undefined);
    });
  });

  describe('SESSION_QUEUE_PROMOTE', () => {
    it('forwards admissionId and returns the promoted row', async () => {
      mockPromote.mockResolvedValue({ admissionId: 'adm-1', state: 'promoting' });
      const result = await invoke(IPC_CHANNELS.SESSION_QUEUE_PROMOTE, { admissionId: 'adm-1' });
      expect(result.success).toBe(true);
      expect(result.data).toEqual({ admissionId: 'adm-1', state: 'promoting' });
    });

    it('returns null data (not an error) when the promote is a no-op (already promoted)', async () => {
      mockPromote.mockResolvedValue(null);
      const result = await invoke(IPC_CHANNELS.SESSION_QUEUE_PROMOTE, { admissionId: 'adm-1' });
      expect(result.success).toBe(true);
      expect(result.data).toBeNull();
    });
  });

  it('routes ensureTrustedSender rejections before the handler runs', async () => {
    handlers.clear();
    const ensureTrustedSender = vi.fn().mockReturnValue({ success: false, error: { code: 'UNTRUSTED', message: 'nope', timestamp: 0 } });
    registerSessionQueueHandlers({ ensureTrustedSender });

    const result = await invoke(IPC_CHANNELS.SESSION_QUEUE_ENQUEUE, { instanceId: 'i1', message: 'hi' });
    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('UNTRUSTED');
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});
