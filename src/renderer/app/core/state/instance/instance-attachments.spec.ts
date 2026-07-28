import { describe, expect, it } from 'vitest';
import { validateAttachmentCount, validateFiles, type InstanceAttachment } from './instance-attachments';
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
