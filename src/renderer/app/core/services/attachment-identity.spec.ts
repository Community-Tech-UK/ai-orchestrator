import { describe, expect, it, vi } from 'vitest';
import { fingerprintFile, identityOf, notifySkippedAttachments, splitNewAttachments } from './attachment-identity';

function file(contents: string, name: string, type = 'image/png', lastModified = 1): File {
  const result = new File([contents], name, { type, lastModified });
  // jsdom's File omits Blob.arrayBuffer; Chromium's File provides it.
  Object.defineProperty(result, 'arrayBuffer', { value: async () => new TextEncoder().encode(contents).buffer });
  return result;
}

describe('attachment identity', () => {
  it('deduplicates equal bytes under different paste names', async () => {
    const first = file('same image', 'pasted-image-2.png');
    const second = file('same image', 'pasted-image-7.png');
    await Promise.all([fingerprintFile(first), fingerprintFile(second)]);
    expect(splitNewAttachments([first], [second])).toEqual({ added: [], skipped: 1 });
  });

  it('keeps different bytes even when metadata matches', async () => {
    const first = file('left', 'same.png');
    const second = file('right', 'same.png');
    await Promise.all([fingerprintFile(first), fingerprintFile(second)]);
    expect(splitNewAttachments([first], [second])).toEqual({ added: [second], skipped: 0 });
  });

  it('deduplicates within an incoming batch', async () => {
    const first = file('same', 'one.png');
    const second = file('same', 'two.png');
    await Promise.all([fingerprintFile(first), fingerprintFile(second)]);
    expect(splitNewAttachments([], [first, second])).toEqual({ added: [first], skipped: 1 });
  });

  it('keeps distinct large files when their byte identity was not checked', async () => {
    const first = new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'large.bin', { lastModified: 1 });
    const second = new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'large.bin', { lastModified: 2 });
    expect(await fingerprintFile(first)).toBeNull();
    expect(identityOf(first)).not.toBe(identityOf(second));
    expect(splitNewAttachments([first], [second, first])).toEqual({ added: [second], skipped: 1 });
  });

  it('keeps different files when reading their contents fails', async () => {
    const first = new File(['left'], 'same.txt', { type: 'text/plain' });
    const second = new File(['rght'], 'same.txt', { type: 'text/plain' });
    for (const file of [first, second]) {
      Object.defineProperty(file, 'arrayBuffer', { value: async () => { throw new Error('Read failed'); } });
      expect(await fingerprintFile(file)).toBeNull();
    }
    expect(splitNewAttachments([first], [second, first])).toEqual({ added: [second], skipped: 1 });
  });

  it('announces a skipped batch once', () => {
    const toast = { show: vi.fn() };
    notifySkippedAttachments(toast, 2);
    expect(toast.show).toHaveBeenCalledExactlyOnceWith('Already attached.');
  });
});
