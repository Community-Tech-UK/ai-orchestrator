import { describe, it, expect, vi } from 'vitest';
import { relayAttachmentsToChannel, attachmentKey } from '../channel-attachment-relay';
import type { FileAttachment } from '../../../shared/types/instance.types';
import type { BaseChannelAdapter } from '../channel-adapter';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

function dataUrl(text: string): string {
  return `data:text/plain;base64,${Buffer.from(text).toString('base64')}`;
}

function makeAttachment(overrides: Partial<FileAttachment> = {}): FileAttachment {
  return { name: 'file.txt', type: 'text/plain', size: 2, data: dataUrl('hi'), ...overrides };
}

function makeAdapter() {
  return {
    sendFile: vi.fn(async () => ({ messageId: 'm', chatId: 'c', timestamp: 1 })),
  } as unknown as BaseChannelAdapter & { sendFile: ReturnType<typeof vi.fn> };
}

describe('relayAttachmentsToChannel', () => {
  it('writes a temp file and sends a valid data-URL attachment', async () => {
    const adapter = makeAdapter();
    const sent = await relayAttachmentsToChannel(adapter, 'c1', [makeAttachment()], new Set());
    expect(sent).toBe(1);
    expect(adapter.sendFile).toHaveBeenCalledOnce();
    expect(adapter.sendFile.mock.calls[0][0]).toBe('c1');
    // The temp path should carry the sanitized basename.
    expect(String(adapter.sendFile.mock.calls[0][1])).toContain('file.txt');
  });

  it('skips an attachment whose key is already in sentKeys', async () => {
    const adapter = makeAdapter();
    const attachment = makeAttachment();
    const sentKeys = new Set<string>([attachmentKey(attachment)]);
    const sent = await relayAttachmentsToChannel(adapter, 'c1', [attachment], sentKeys);
    expect(sent).toBe(0);
    expect(adapter.sendFile).not.toHaveBeenCalled();
  });

  it('records the key so a repeat in the same batch is deduped', async () => {
    const adapter = makeAdapter();
    const attachment = makeAttachment();
    const sent = await relayAttachmentsToChannel(adapter, 'c1', [attachment, attachment], new Set());
    expect(sent).toBe(1);
    expect(adapter.sendFile).toHaveBeenCalledOnce();
  });

  it('skips attachments that are not inline data URLs', async () => {
    const adapter = makeAdapter();
    const sent = await relayAttachmentsToChannel(
      adapter,
      'c1',
      [makeAttachment({ data: 'https://example.com/img.png' })],
      new Set(),
    );
    expect(sent).toBe(0);
    expect(adapter.sendFile).not.toHaveBeenCalled();
  });

  it('skips oversized attachments', async () => {
    const adapter = makeAdapter();
    const big = 'A'.repeat(11 * 1024 * 1024); // > 10 MB decoded
    const sent = await relayAttachmentsToChannel(
      adapter,
      'c1',
      [makeAttachment({ data: dataUrl(big) })],
      new Set(),
    );
    expect(sent).toBe(0);
    expect(adapter.sendFile).not.toHaveBeenCalled();
  });

  it('is best-effort: a failing send does not reject', async () => {
    const adapter = makeAdapter();
    adapter.sendFile.mockRejectedValueOnce(new Error('discord down'));
    const sent = await relayAttachmentsToChannel(adapter, 'c1', [makeAttachment()], new Set());
    expect(sent).toBe(0);
  });
});
