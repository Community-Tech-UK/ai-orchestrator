import { describe, expect, it } from 'vitest';
import { blobToClipboardCompatibleDataUrl } from './clipboard-image.util';

const ONE_PIXEL_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9ZptKbsAAAAASUVORK5CYII=';

describe('blobToClipboardCompatibleDataUrl', () => {
  it('returns the original data URL for PNG blobs', async () => {
    const png = await fetch(ONE_PIXEL_PNG).then((response) => response.blob());

    await expect(blobToClipboardCompatibleDataUrl(png)).resolves.toMatch(/^data:image\/png/);
  });

  it('returns null or a converted data URL for undecodable non-PNG blobs', async () => {
    const out = await blobToClipboardCompatibleDataUrl(
      new Blob([new Uint8Array([0])], { type: 'image/webp' }),
    );

    expect(out === null || /^data:image\/png/.test(out)).toBe(true);
  });
});
