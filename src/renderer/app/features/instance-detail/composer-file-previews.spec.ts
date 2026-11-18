import { computed } from '@angular/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposerFilePreviews } from './composer-file-previews';

describe('ComposerFilePreviews', () => {
  let nextUrl = 0;
  let revoked: string[];

  beforeEach(() => {
    nextUrl = 0;
    revoked = [];
    // jsdom has no object URLs; Chromium does.
    vi.stubGlobal('URL', Object.assign(class extends URL {}, {
      createObjectURL: vi.fn((blob: Blob) => `blob:${(blob as File).name}#${nextUrl++}`),
      revokeObjectURL: vi.fn((url: string) => { revoked.push(url); }),
    }));
  });

  afterEach(() => vi.unstubAllGlobals());

  const photo = () => new File([new Uint8Array([1])], 'IMG_1531.HEIC', { type: 'image/heic' });
  const jpegOf = (file: File) => new File([new Uint8Array([0xff])], file.name.replace(/\.[^.]+$/, '.jpg'), { type: 'image/jpeg' });

  it('gives ordinary files a thumbnail straight away', () => {
    const convertHeic = vi.fn();
    const previews = new ComposerFilePreviews(convertHeic);
    const shot = new File(['x'], 'shot.png', { type: 'image/png' });

    expect(previews.thumbnailFor(shot)).toBe('blob:shot.png#0');
    expect(previews.thumbnailFor(shot)).toBe('blob:shot.png#0');
    expect(convertHeic).not.toHaveBeenCalled();
  });

  it('shows a HEIC photo once its JPEG is ready, re-running whatever reads it', async () => {
    let finish!: (jpeg: File) => void;
    const convertHeic = vi.fn(() => new Promise<File>((resolve) => { finish = resolve; }));
    const previews = new ComposerFilePreviews(convertHeic);
    const heic = photo();
    const url = computed(() => previews.thumbnailFor(heic));

    expect(url()).toBeNull();
    expect(url()).toBeNull();
    expect(convertHeic).toHaveBeenCalledOnce();

    finish(jpegOf(heic));
    await vi.waitFor(() => expect(url()).toBe('blob:IMG_1531.jpg#0'));
  });

  it('leaves a photo that cannot be converted as a plain file without retrying on every render', async () => {
    const convertHeic = vi.fn(async () => { throw new Error('could not be converted'); });
    const previews = new ComposerFilePreviews(convertHeic);
    const heic = photo();
    const url = computed(() => previews.thumbnailFor(heic));

    expect(url()).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(url()).toBeNull();
    expect(convertHeic).toHaveBeenCalledOnce();
  });

  it('tries a failed photo again once it is removed and attached again', async () => {
    const convertHeic = vi.fn()
      .mockRejectedValueOnce(new Error('could not be converted'))
      .mockImplementationOnce(async (file: File) => jpegOf(file));
    const previews = new ComposerFilePreviews(convertHeic);
    const heic = photo();

    previews.thumbnailFor(heic);
    await new Promise((resolve) => setTimeout(resolve, 0));
    previews.retainOnly([]);
    previews.thumbnailFor(heic);

    await vi.waitFor(() => expect(previews.thumbnailFor(heic)).toBe('blob:IMG_1531.jpg#0'));
    expect(convertHeic).toHaveBeenCalledTimes(2);
  });

  it('tries again when a photo removed mid-conversion, whose conversion then failed, is attached again', async () => {
    let fail!: (error: Error) => void;
    const convertHeic = vi.fn()
      .mockReturnValueOnce(new Promise<File>((_resolve, reject) => { fail = reject; }))
      .mockImplementationOnce(async (file: File) => jpegOf(file));
    const previews = new ComposerFilePreviews(convertHeic);
    const heic = photo();

    previews.thumbnailFor(heic);
    previews.retainOnly([]);
    fail(new Error('could not be converted'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    previews.thumbnailFor(heic);

    await vi.waitFor(() => expect(previews.thumbnailFor(heic)).toBe('blob:IMG_1531.jpg#0'));
    expect(convertHeic).toHaveBeenCalledTimes(2);
  });

  it('gives files that are not images no thumbnail', () => {
    const previews = new ComposerFilePreviews(vi.fn());

    expect(previews.thumbnailFor(new File(['notes'], 'notes.txt', { type: 'text/plain' }))).toBeNull();
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('recognises a HEIC photo that arrived with no file type by its name', async () => {
    const convertHeic = vi.fn(async (file: File) => jpegOf(file));
    const previews = new ComposerFilePreviews(convertHeic);
    const untyped = new File([new Uint8Array([1])], 'IMG_1531.HEIC', { type: '' });

    expect(previews.thumbnailFor(untyped)).toBeNull();
    await vi.waitFor(() => expect(previews.thumbnailFor(untyped)).toBe('blob:IMG_1531.jpg#0'));
  });

  it('creates no thumbnail for a photo removed while it was converting', async () => {
    let finish!: (jpeg: File) => void;
    const previews = new ComposerFilePreviews(() => new Promise<File>((resolve) => { finish = resolve; }));
    const heic = photo();

    previews.thumbnailFor(heic);
    previews.retainOnly([]);
    finish(jpegOf(heic));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });

  it('makes one thumbnail for a photo removed and staged again while it converts', async () => {
    let finish!: (jpeg: File) => void;
    const conversion = new Promise<File>((resolve) => { finish = resolve; });
    // The file service hands every caller the same conversion of a photo.
    const previews = new ComposerFilePreviews(() => conversion);
    const heic = photo();

    previews.thumbnailFor(heic);
    previews.retainOnly([]);
    previews.thumbnailFor(heic);
    finish(jpegOf(heic));
    await vi.waitFor(() => expect(previews.thumbnailFor(heic)).toBe('blob:IMG_1531.jpg#0'));

    expect(URL.createObjectURL).toHaveBeenCalledOnce();
  });

  it('revokes thumbnails for files no longer staged, and all of them on dispose', () => {
    const previews = new ComposerFilePreviews(vi.fn());
    const kept = new File(['a'], 'kept.png', { type: 'image/png' });
    const dropped = new File(['b'], 'dropped.png', { type: 'image/png' });
    previews.thumbnailFor(kept);
    previews.thumbnailFor(dropped);

    previews.retainOnly([kept]);
    expect(revoked).toEqual(['blob:dropped.png#1']);

    previews.dispose();
    expect(revoked).toEqual(['blob:dropped.png#1', 'blob:kept.png#0']);
  });
});
