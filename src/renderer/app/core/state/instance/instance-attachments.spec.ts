import { describe, expect, it, vi } from 'vitest';
import {
  fileToAttachments,
  isHeicFile,
  readStagedFiles,
  StagedFileError,
  validateAttachmentCount,
  validateFiles,
  type InstanceAttachment,
} from './instance-attachments';
import { FILE_LIMITS } from './instance.types';
import { InstanceCreateWithMessagePayloadSchema } from '@contracts/schemas/instance';

/**
 * A `File` that reports `size` without allocating it — the limits under test
 * run to tens of megabytes and only the reported size matters here.
 */
function sizedFile(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array(8)], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function attachment(name: string): InstanceAttachment {
  return { name, type: 'image/webp', size: 1000, data: 'data:image/webp;base64,AA' };
}

describe('validateFiles', () => {
  it('accepts a realistic batch of six screenshots', () => {
    const files = [0, 1, 2, 3, 4, 5].map((i) =>
      sizedFile(`pasted-image-${i}.png`, 'image/png', 1_400_000),
    );
    expect(validateFiles(files)).toEqual([]);
  });

  it('rejects more staged files than the main process will accept', () => {
    const files = Array.from({ length: FILE_LIMITS.MAX_ATTACHMENTS + 1 }, (_, i) =>
      sizedFile(`shot-${i}.png`, 'image/png', 200_000),
    );

    const errors = validateFiles(files);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(`at most ${FILE_LIMITS.MAX_ATTACHMENTS}`);
  });

  it('does not size-gate images, which are compressed or tiled downstream', () => {
    // A high-resolution screenshot is tiled by `fileToAttachments` without any
    // reference to `file.size`, so these encode fine. Adding a size gate here
    // would reject staged sets that work today; a genuinely unencodable image
    // throws instead, and the composition survives that.
    expect(validateFiles([sizedFile('big.png', 'image/png', 12 * 1024 * 1024)])).toEqual([]);
    expect(validateFiles([sizedFile('retina.png', 'image/png', 25 * 1024 * 1024)])).toEqual([]);
    expect(validateFiles([sizedFile('huge.png', 'image/png', 60 * 1024 * 1024)])).toEqual([]);
  });

  it('rejects an oversized non-image', () => {
    const errors = validateFiles([sizedFile('dump.bin', 'application/octet-stream', 40 * 1024 * 1024)]);

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Maximum size is 30MB');
  });
});

describe('validateAttachmentCount', () => {
  it('passes at the limit', () => {
    const attachments = Array.from({ length: FILE_LIMITS.MAX_ATTACHMENTS }, (_, i) =>
      attachment(`tile-${i}.webp`),
    );
    expect(validateAttachmentCount(attachments, FILE_LIMITS.MAX_ATTACHMENTS)).toBeNull();
  });

  it('explains tile expansion when few files become many attachments', () => {
    // Six tall screenshots tiling into twelve attachments is the shape that the
    // main process rejects silently.
    const attachments = Array.from({ length: 12 }, (_, i) => attachment(`tile-${i}.webp`));

    const error = validateAttachmentCount(attachments, 6);

    expect(error).toContain('12');
    expect(error).toContain('6 file(s) expanded');
    expect(error).toContain('tiles');
  });

  it('reports a plain overflow when nothing expanded', () => {
    const attachments = Array.from({ length: 11 }, (_, i) => attachment(`file-${i}.png`));

    const error = validateAttachmentCount(attachments, 11);

    expect(error).toContain('11');
    expect(error).not.toContain('expanded');
  });
});

describe('renderer/main attachment-limit parity', () => {
  it('pins the renderer cap to the schema the main process enforces', () => {
    const payload = (count: number) => ({
      workingDirectory: '/repo',
      message: 'hello',
      attachments: Array.from({ length: count }, (_, i) => ({
        name: `a-${i}.png`,
        type: 'image/png',
        size: 100,
        data: 'x',
      })),
    });

    expect(
      InstanceCreateWithMessagePayloadSchema.safeParse(payload(FILE_LIMITS.MAX_ATTACHMENTS)).success,
    ).toBe(true);
    expect(
      InstanceCreateWithMessagePayloadSchema.safeParse(payload(FILE_LIMITS.MAX_ATTACHMENTS + 1))
        .success,
    ).toBe(false);
  });
});

describe('HEIC photos', () => {
  it('recognises iPhone photos by MIME type or by extension', () => {
    expect(isHeicFile(new File([], 'IMG_1531.HEIC', { type: 'image/heic' }))).toBe(true);
    expect(isHeicFile(new File([], 'photo.heif', { type: 'image/heif' }))).toBe(true);
    // Loaded from a path or dropped with no type: only the extension says what it is.
    expect(isHeicFile(new File([], 'IMG_1531.HEIC', { type: '' }))).toBe(true);
    expect(isHeicFile(new File([], 'IMG_1531.heic', { type: 'application/octet-stream' }))).toBe(true);
    expect(isHeicFile(new File([], 'shot.png', { type: 'image/png' }))).toBe(false);
    expect(isHeicFile(new File([], 'heic-notes.txt', { type: 'text/plain' }))).toBe(false);
  });

  it('converts a HEIC photo before trying to load it as an image', async () => {
    const photo = new File([new Uint8Array([1])], 'IMG_1531.HEIC', { type: 'image/heic' });
    const convertHeic = vi.fn().mockRejectedValue(new Error('HEIC photos can only be converted on a Mac.'));

    await expect(fileToAttachments(photo, convertHeic)).rejects.toThrow('HEIC photos can only be converted on a Mac.');
    expect(convertHeic).toHaveBeenCalledWith(photo);
  });

  it('leaves other files alone', async () => {
    const notes = new File(['hello'], 'notes.txt', { type: 'text/plain' });
    const convertHeic = vi.fn();

    const [attachment] = await fileToAttachments(notes, convertHeic);

    expect(convertHeic).not.toHaveBeenCalled();
    expect(attachment).toMatchObject({ name: 'notes.txt', type: 'text/plain', size: 5 });
  });
});

describe('readStagedFiles', () => {
  it('reads each file in order, converting HEIC photos first', async () => {
    const photo = new File([new Uint8Array([1])], 'IMG_1531.HEIC', { type: 'image/heic' });
    const notes = new File(['hi'], 'notes.txt', { type: 'text/plain' });
    const jpeg = new File([new Uint8Array([0xff])], 'IMG_1531.jpg', { type: 'image/jpeg' });
    const convertHeic = vi.fn(async () => jpeg);

    const names = await readStagedFiles([photo, notes], convertHeic, async (file) => file.name);

    expect(names).toEqual(['IMG_1531.jpg', 'notes.txt']);
    expect(convertHeic).toHaveBeenCalledExactlyOnceWith(photo);
  });

  it('names the file that failed in plain words and keeps the reason as the cause', async () => {
    const diagnostic = new Error('SYNTHETIC_DIAGNOSTIC');
    const photo = new File([new Uint8Array([1])], 'IMG_1531.HEIC', { type: 'image/heic' });

    const failure = await readStagedFiles([photo], vi.fn(async () => { throw diagnostic; }), async (file) => file)
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(StagedFileError);
    expect((failure as StagedFileError).visibleMessage)
      .toBe('IMG_1531.HEIC could not be converted. Save it as JPEG or PNG and attach that instead.');
    expect((failure as StagedFileError).cause).toBe(diagnostic);
  });

  it('gives a file that is not a photo advice that fits it', async () => {
    const report = new File(['%PDF'], 'report.pdf', { type: 'application/pdf' });

    const failure = await readStagedFiles([report], vi.fn(), async () => { throw new Error('NotReadableError'); })
      .catch((error: unknown) => error);

    expect((failure as StagedFileError).visibleMessage)
      .toBe('report.pdf could not be read. Check the file still exists, then attach it again.');
  });
});
