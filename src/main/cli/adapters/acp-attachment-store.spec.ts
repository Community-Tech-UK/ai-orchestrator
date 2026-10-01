import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import {
  ACP_ATTACHMENT_STORE_TTL_MS,
  cleanupExpiredAcpAttachments,
  persistAcpImageAttachment,
  setAcpAttachmentStoreDirForTesting,
  withPersistedAcpImageAttachments,
} from './acp-attachment-store';

const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');
const PNG_DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

describe('acp attachment store', () => {
  afterEach(() => {
    setAcpAttachmentStoreDirForTesting(null);
  });

  function useTempStore(): string {
    const dir = mkdtempSync(join(tmpdir(), 'aio-acp-attachments-'));
    setAcpAttachmentStoreDirForTesting(dir);
    return dir;
  }

  it('writes the decoded image under its session with owner-only mode', async () => {
    const store = useTempStore();

    const stored = await persistAcpImageAttachment('sess-1', {
      type: 'image',
      content: PNG_DATA_URL,
      mimeType: 'image/png',
      name: 'pasted-image-4.png',
    });

    expect(stored).not.toBeNull();
    expect(stored!.startsWith(join(store, 'sess-1'))).toBe(true);
    expect(stored!.endsWith('-pasted-image-4.png')).toBe(true);
    expect(readFileSync(stored!)).toEqual(PNG_BYTES);
    if (process.platform !== 'win32') {
      expect(statSync(stored!).mode & 0o777).toBe(0o600);
      expect(statSync(join(store, 'sess-1')).mode & 0o777).toBe(0o700);
    }
    expect(readdirSync(join(store, 'sess-1'))).toHaveLength(1);
  });

  it('stores a re-sent image once and refreshes its age', async () => {
    const store = useTempStore();
    const attachment = { type: 'image' as const, content: PNG_DATA_URL, mimeType: 'image/png', name: 'a.png' };

    const first = await persistAcpImageAttachment('sess-1', attachment);
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(first!, old, old);
    const second = await persistAcpImageAttachment('sess-1', attachment);

    expect(second).toBe(first);
    expect(readdirSync(join(store, 'sess-1'))).toHaveLength(1);
    expect(Date.now() - statSync(second!).mtimeMs).toBeLessThan(60_000);
  });

  it('names the file for the real image type and never escapes the store', async () => {
    const store = useTempStore();

    const stored = await persistAcpImageAttachment('../../evil', {
      type: 'image',
      content: PNG_BYTES.toString('base64'),
      mimeType: 'image/webp',
      name: '../../etc/shot.png',
    });

    expect(stored!.startsWith(store)).toBe(true);
    expect(stored!.endsWith('-shot.webp')).toBe(true);
    expect(readdirSync(store)).toHaveLength(1);
  });

  it('ignores non-image and empty attachments', async () => {
    useTempStore();

    await expect(persistAcpImageAttachment('sess-1', {
      type: 'file', content: 'data:application/pdf;base64,JVBERi0x', mimeType: 'application/pdf', name: 'r.pdf',
    })).resolves.toBeNull();
    await expect(persistAcpImageAttachment('sess-1', {
      type: 'image', content: '', mimeType: 'image/png', name: 'empty.png',
    })).resolves.toBeNull();
  });

  it('returns null instead of throwing when the store cannot be written', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'aio-acp-attachments-blocked-'));
    const blocker = join(parent, 'not-a-directory');
    writeFileSync(blocker, 'x');
    setAcpAttachmentStoreDirForTesting(blocker);

    await expect(persistAcpImageAttachment('sess-1', {
      type: 'image', content: PNG_DATA_URL, mimeType: 'image/png', name: 'a.png',
    })).resolves.toBeNull();
  });

  it('adds a path to inline images only, keeping everything else untouched', async () => {
    useTempStore();
    const pdf = { type: 'file' as const, content: 'data:application/pdf;base64,JVBERi0x', mimeType: 'application/pdf', name: 'r.pdf' };
    const existing = { type: 'image' as const, path: '/already/on/disk.png', mimeType: 'image/png', name: 'disk.png' };

    const result = await withPersistedAcpImageAttachments('sess-1', [
      { type: 'image', content: PNG_DATA_URL, mimeType: 'image/png', name: 'a.png' },
      pdf,
      existing,
    ]);

    expect(result![0]!.path).toMatch(/-a\.png$/);
    expect(existsSync(result![0]!.path!)).toBe(true);
    expect(result![1]).toBe(pdf);
    expect(result![2]).toBe(existing);
  });

  it('expires attachments past the TTL and removes emptied session folders', async () => {
    const store = useTempStore();
    const expiredDir = join(store, 'sess-old');
    const liveDir = join(store, 'sess-live');
    const emptyDir = join(store, 'sess-just-created');
    mkdirSync(expiredDir);
    mkdirSync(liveDir);
    mkdirSync(emptyDir);
    writeFileSync(join(expiredDir, 'old.png'), 'x');
    writeFileSync(join(liveDir, 'old.png'), 'x');
    writeFileSync(join(liveDir, 'new.png'), 'x');
    const expired = new Date(Date.now() - ACP_ATTACHMENT_STORE_TTL_MS - 60_000);
    utimesSync(join(expiredDir, 'old.png'), expired, expired);
    utimesSync(join(liveDir, 'old.png'), expired, expired);

    await expect(cleanupExpiredAcpAttachments()).resolves.toBe(2);

    expect(existsSync(expiredDir)).toBe(false);
    expect(readdirSync(liveDir)).toEqual(['new.png']);
    expect(existsSync(emptyDir)).toBe(true);
  });
});
