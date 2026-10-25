import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { safeExtractZip } from './safe-extract-zip';

vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});

describe('safeExtractZip archive lifetime', () => {
  let root: string;

  beforeEach(async () => {
    vi.mocked(fs.open).mockClear();
    root = await fs.mkdtemp(path.join(tmpdir(), 'safe-extract-lifetime-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it.each(['valid', 'invalid header', 'invalid directory'] as const)(
    'closes the archive before returning for %s data', async (kind) => {
      const bytes = Buffer.from(zipSync({ 'file.txt': Buffer.from('fixture') }));
      if (kind === 'invalid header') bytes.fill(0);
      if (kind === 'invalid directory') {
        const header = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        expect(header).toBeGreaterThanOrEqual(0);
        bytes.writeUInt32LE(0, header);
      }
      const archivePath = path.join(root, 'fixture.zip');
      await fs.writeFile(archivePath, bytes);
      const open = vi.mocked(fs.open);

      const extracting = safeExtractZip(archivePath, path.join(root, 'out'));
      if (kind === 'valid') await extracting;
      else await expect(extracting).rejects.toThrow();

      // A failed stat proves the actual descriptor is closed, including when
      // the parser accepts the archive and then fails while iterating entries.
      const file = await open.mock.results[0].value;
      await expect(file.stat()).rejects.toMatchObject({ code: 'EBADF' });
    },
  );
});
