import { describe, it, expect, beforeEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';

let testDb: SqliteDriver;

vi.mock('../persistence/rlm-database', () => ({
  getRLMDatabase: () => ({ getRawDb: () => testDb }),
}));

vi.mock('./content-store', () => {
  const inlineStore = new Map<string, string>();
  return {
    getContentStore: () => ({
      storeDurable: async (content: string) => {
        const hash = `hash-${inlineStore.size}`;
        inlineStore.set(hash, content);
        return { inline: false, hash, size: content.length };
      },
      resolve: async (ref: { inline: boolean; hash?: string; content?: string }) => {
        if (ref.inline) return ref.content as string;
        const content = inlineStore.get(ref.hash as string);
        if (content === undefined) throw new Error('missing content');
        return content;
      },
    }),
  };
});

import { SessionAdmissionStore } from './session-admission-store';
import { SessionQueueService, _resetSessionQueueServiceForTesting, getSessionQueueService } from './session-queue-service';

describe('SessionQueueService', () => {
  beforeEach(() => {
    testDb = new Database(':memory:') as unknown as SqliteDriver;
    SessionAdmissionStore._resetForTesting();
    _resetSessionQueueServiceForTesting();
  });

  it('enqueueUserMessage is durable before ack: the row exists (queued) once the promise resolves', async () => {
    const { admissionId, queuePosition } = await getSessionQueueService().enqueueUserMessage({
      instanceId: 'i1',
      message: 'hello',
    });
    expect(queuePosition).toBe(0);

    const store = SessionAdmissionStore.getInstance(testDb);
    const row = store.get(admissionId);
    expect(row?.state).toBe('queued');
    expect(row?.message).toBe('hello');
  });

  it('enqueueUserMessage stages attachments durably and listQueue resolves them back', async () => {
    const service = getSessionQueueService();
    const { admissionId } = await service.enqueueUserMessage({
      instanceId: 'i1',
      message: 'with file',
      attachments: [{ name: 'a.png', type: 'image/png', size: 4, data: 'data:image/png;base64,AAAA' }],
    });

    const queues = await service.listQueue('i1');
    expect(queues['i1']).toHaveLength(1);
    expect(queues['i1'][0].admissionId).toBe(admissionId);
    expect(queues['i1'][0].attachments).toEqual([
      { name: 'a.png', type: 'image/png', size: 4, data: 'data:image/png;base64,AAAA' },
    ]);
  });

  it('(Finding 3) sets attachmentsDropped:true when a staged blob cannot be resolved, without dropping the row itself', async () => {
    const store = SessionAdmissionStore.getInstance(testDb);
    const record = store.createQueued({
      admissionId: 'adm-missing-blob',
      instanceId: 'i1',
      message: 'partial attachments',
      attachmentFiles: [
        { name: 'missing.png', type: 'image/png', size: 10, contentRef: { inline: false, hash: 'never-staged', size: 10 } },
        { name: 'ok.txt', type: 'text/plain', size: 1, contentRef: { inline: true, content: 'A' } },
      ],
    });
    expect(record.state).toBe('queued');

    const queues = await getSessionQueueService().listQueue('i1');
    const dto = queues['i1'][0];
    expect(dto.attachmentsDropped).toBe(true);
    expect(dto.attachments).toEqual([{ name: 'ok.txt', type: 'text/plain', size: 1, data: 'A' }]);
    // The row itself is untouched — only the attachment resolution surfaced the loss.
    expect(dto.message).toBe('partial attachments');
  });

  it('updateQueuedMessage edits text/attachments while queued and returns null once no longer queued', async () => {
    const service = getSessionQueueService();
    const { admissionId } = await service.enqueueUserMessage({ instanceId: 'i1', message: 'orig' });

    const updated = await service.updateQueuedMessage(admissionId, { message: 'edited' });
    expect(updated?.message).toBe('edited');

    await service.promoteQueuedMessage(admissionId);
    const rejected = await service.updateQueuedMessage(admissionId, { message: 'too-late' });
    expect(rejected).toBeNull();
  });

  it('cancelQueuedMessage returns true once and false on a repeat call (idempotent)', async () => {
    const service = getSessionQueueService();
    const { admissionId } = await service.enqueueUserMessage({ instanceId: 'i1', message: 'm' });

    expect(service.cancelQueuedMessage(admissionId)).toBe(true);
    expect(service.cancelQueuedMessage(admissionId)).toBe(false);
  });

  it('reorderQueue changes listQueue ordering', async () => {
    const service = getSessionQueueService();
    const a = await service.enqueueUserMessage({ instanceId: 'i1', message: 'a' });
    const b = await service.enqueueUserMessage({ instanceId: 'i1', message: 'b' });
    const c = await service.enqueueUserMessage({ instanceId: 'i1', message: 'c' });

    service.reorderQueue('i1', [c.admissionId, a.admissionId, b.admissionId]);

    const queues = await service.listQueue('i1');
    expect(queues['i1'].map((q) => q.admissionId)).toEqual([c.admissionId, a.admissionId, b.admissionId]);
  });

  it('listQueue with no instanceId groups rows by instance across all instances', async () => {
    const service = getSessionQueueService();
    await service.enqueueUserMessage({ instanceId: 'i1', message: 'm1' });
    await service.enqueueUserMessage({ instanceId: 'i2', message: 'm2' });

    const queues = await service.listQueue();
    expect(Object.keys(queues).sort()).toEqual(['i1', 'i2']);
  });

  it('promoteQueuedMessage is idempotent: only the first call transitions the row, the second returns null', async () => {
    const service = getSessionQueueService();
    const { admissionId } = await service.enqueueUserMessage({ instanceId: 'i1', message: 'm' });

    const first = await service.promoteQueuedMessage(admissionId);
    expect(first?.state).toBe('promoting');

    const second = await service.promoteQueuedMessage(admissionId);
    expect(second).toBeNull();
  });

  it('promoteQueuedMessage on an unknown admissionId returns null', async () => {
    const result = await getSessionQueueService().promoteQueuedMessage('missing');
    expect(result).toBeNull();
  });

  it('getInstance() returns the same singleton until _resetForTesting()', () => {
    const a = SessionQueueService.getInstance();
    const b = SessionQueueService.getInstance();
    expect(a).toBe(b);
    SessionQueueService._resetForTesting();
    expect(SessionQueueService.getInstance()).not.toBe(a);
  });
});
