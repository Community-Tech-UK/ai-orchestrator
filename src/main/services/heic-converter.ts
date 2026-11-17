/**
 * HEIC/HEIF → JPEG conversion for chat attachments.
 *
 * Chromium cannot decode HEIC (the default iPhone photo format), and neither
 * can Electron's `nativeImage`, so the renderer's attachment pipeline fails on
 * these files with "Failed to load image". macOS ships `sips`, which decodes
 * HEIC natively, so the renderer hands the bytes here and gets a JPEG back.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

const execFileAsync = promisify(execFile);

const SIPS_PATH = '/usr/bin/sips';
const SIPS_TIMEOUT_MS = 60_000;
const JPEG_QUALITY = '90';

export async function convertHeicToJpeg(
  heicBytes: Uint8Array,
  platform: NodeJS.Platform = process.platform,
): Promise<Buffer> {
  if (platform !== 'darwin') {
    throw new Error(
      'HEIC photos can only be converted on a Mac. Save the photo as JPEG or PNG and attach that instead.',
    );
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'aio-heic-'));
  try {
    const inputPath = path.join(workDir, 'input.heic');
    const outputPath = path.join(workDir, 'output.jpg');
    await fs.writeFile(inputPath, heicBytes);
    try {
      await execFileAsync(
        SIPS_PATH,
        ['-s', 'format', 'jpeg', '-s', 'formatOptions', JPEG_QUALITY, inputPath, '--out', outputPath],
        { timeout: SIPS_TIMEOUT_MS },
      );
    } catch (error) {
      const output = (error as { stderr?: string }).stderr?.trim() || (error as Error).message;
      const detail = output.split('\n')[0];
      throw new Error(`macOS could not convert the HEIC photo to JPEG (${detail})`, { cause: error });
    }
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}
