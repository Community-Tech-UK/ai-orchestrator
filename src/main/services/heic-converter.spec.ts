import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { convertHeicToJpeg } from './heic-converter';

/** A valid 1x1 PNG, used to build a real HEIC fixture with `sips`. */
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

function heicTempDirs(): string[] {
  return fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('aio-heic-'));
}

describe('convertHeicToJpeg', () => {
  it('refuses on platforms without sips, with a message the user can act on', async () => {
    await expect(convertHeicToJpeg(new Uint8Array([1, 2, 3]), 'win32')).rejects.toThrow(
      /only be converted on a Mac.*JPEG or PNG/,
    );
  });

  describe.runIf(process.platform === 'darwin')('on macOS', () => {
    let fixtureDir: string;

    beforeEach(() => {
      fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heic-converter-spec-'));
    });

    afterEach(() => {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
    });

    it('converts a real HEIC photo to JPEG and leaves no temp files behind', async () => {
      const pngPath = path.join(fixtureDir, 'pixel.png');
      const heicPath = path.join(fixtureDir, 'pixel.heic');
      fs.writeFileSync(pngPath, ONE_PIXEL_PNG);
      execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', pngPath, '--out', heicPath]);
      const before = heicTempDirs();

      const jpeg = await convertHeicToJpeg(fs.readFileSync(heicPath));

      expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      expect(heicTempDirs()).toEqual(before);
    });

    it('reports bytes that are not an image as a conversion failure', async () => {
      const before = heicTempDirs();

      await expect(convertHeicToJpeg(new TextEncoder().encode('not an image'))).rejects.toThrow(
        /macOS could not convert the HEIC photo to JPEG/,
      );
      expect(heicTempDirs()).toEqual(before);
    });
  });
});
