import { createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { fromFdPromise } from 'yauzl';
import { assertSafeZipEntry } from './safe-zip-entry';

/** Extract into the resolver's newly created, private staging directory. */
export async function safeExtractZip(zipPath: string, destDir: string): Promise<void> {
  // Own the descriptor so parser errors cannot race asynchronous auto-close
  // against staging cleanup, and a close failure is surfaced to the caller.
  const file = await fs.open(zipPath, 'r');
  try {
    const archive = await fromFdPromise(file.fd, { autoClose: false, lazyEntries: true });
    for await (const entry of archive.eachEntry()) {
      assertSafeZipEntry(entry, destDir);
      if (entry.fileName.startsWith('__MACOSX/')) {
        continue;
      }

      const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
      const isDirectory = (mode & 0o170000) === 0o040000
        || entry.fileName.endsWith('/')
        || ((entry.versionMadeBy >>> 8) === 0 && entry.externalFileAttributes === 0x10);
      const permissions = mode === 0 ? (isDirectory ? 0o755 : 0o644) : mode & 0o777;
      const destination = path.join(destDir, entry.fileName);

      if (isDirectory) {
        await fs.mkdir(destination, { recursive: true, mode: permissions });
        continue;
      }

      await fs.mkdir(path.dirname(destination), { recursive: true });
      const source = await archive.openReadStreamPromise(entry);
      await pipeline(source, createWriteStream(destination, { mode: permissions }));
    }
  } finally {
    await file.close();
  }
}
