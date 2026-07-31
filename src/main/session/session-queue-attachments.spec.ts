import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ContentRef } from './content-store';

const storeDurable = vi.fn();
const resolve = vi.fn();

vi.mock('./content-store', () => ({
  getContentStore: () => ({ storeDurable, resolve }),
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { stageQueuedAttachments, resolveQueuedAttachments } from './session-queue-attachments';

describe('session-queue-attachments', () => {
  beforeEach(() => {
    storeDurable.mockReset();
    resolve.mockReset();
  });

  describe('stageQueuedAttachments', () => {
    it('returns an empty array for undefined/empty input without touching the content store', async () => {
      expect(await stageQueuedAttachments(undefined)).toEqual([]);
      expect(await stageQueuedAttachments([])).toEqual([]);
      expect(storeDurable).not.toHaveBeenCalled();
    });

    it('stages each attachment durably and returns name/type/size + contentRef', async () => {
      const ref: ContentRef = { inline: false, hash: 'abc', size: 123 };
      storeDurable.mockResolvedValue(ref);

      const staged = await stageQueuedAttachments([
        { name: 'a.png', type: 'image/png', size: 10, data: 'data:image/png;base64,AAAA' },
      ]);

      expect(storeDurable).toHaveBeenCalledWith('data:image/png;base64,AAAA');
      expect(staged).toEqual([{ name: 'a.png', type: 'image/png', size: 10, contentRef: ref }]);
    });

    it('skips (does not throw for) an attachment with no data', async () => {
      const staged = await stageQueuedAttachments([{ name: 'empty.txt', type: 'text/plain', size: 0, data: '' }]);
      expect(staged).toEqual([]);
      expect(storeDurable).not.toHaveBeenCalled();
    });
  });

  describe('resolveQueuedAttachments', () => {
    it('returns an empty, non-dropped result for undefined/empty refs', async () => {
      expect(await resolveQueuedAttachments(undefined)).toEqual({ attachments: [], dropped: false });
      expect(await resolveQueuedAttachments([])).toEqual({ attachments: [], dropped: false });
    });

    it('resolves each ref back into a full FileAttachment with dropped:false', async () => {
      resolve.mockResolvedValue('data:image/png;base64,AAAA');
      const result = await resolveQueuedAttachments([
        { name: 'a.png', type: 'image/png', size: 10, contentRef: { inline: true, content: 'x' } },
      ]);
      expect(result).toEqual({
        attachments: [{ name: 'a.png', type: 'image/png', size: 10, data: 'data:image/png;base64,AAAA' }],
        dropped: false,
      });
    });

    it('(Finding 3) sets dropped:true when a ref fails to resolve, while still keeping attachments that DID resolve — never silent', async () => {
      resolve
        .mockRejectedValueOnce(new Error('missing'))
        .mockResolvedValueOnce('data:text/plain;base64,QQ==');

      const result = await resolveQueuedAttachments([
        { name: 'missing.png', type: 'image/png', size: 10, contentRef: { inline: false, hash: 'h1', size: 10 } },
        { name: 'ok.txt', type: 'text/plain', size: 1, contentRef: { inline: true, content: 'A' } },
      ]);

      expect(result.dropped).toBe(true);
      expect(result.attachments).toEqual([{ name: 'ok.txt', type: 'text/plain', size: 1, data: 'data:text/plain;base64,QQ==' }]);
    });
  });
});
