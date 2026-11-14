/**
 * Size-capped append for the diagnostic NDJSON logs under `<userData>/logs`.
 *
 * The size is read from disk before each append rather than tracked in memory,
 * so the cap holds across restarts and a file that grew past it under older
 * code is rotated on the next write. Rotation keeps ROTATED_LOG_COPIES older
 * files beside the live one (`name.1` newest, `name.N` oldest) and drops the
 * rest, so each log settles at no more than (ROTATED_LOG_COPIES + 1) ×
 * MAX_LOG_FILE_BYTES. A file that was already oversized becomes `name.1` and
 * is dropped after ROTATED_LOG_COPIES further rotations.
 *
 * Callers must serialize their own appends to a given file (each writer here
 * already chains writes through a promise queue).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Largest a diagnostic log may grow before it is rotated. */
export const MAX_LOG_FILE_BYTES = 30 * 1024 * 1024;
/** Older copies kept beside the live file. */
export const ROTATED_LOG_COPIES = 2;

/**
 * Append `text` to `filePath`, rotating first when the append would take the
 * file past `maxBytes`. Returns true when this call rotated the file. Errors
 * propagate; diagnostic writers decide whether to swallow them.
 */
export async function appendToRotatingLog(
  filePath: string,
  text: string,
  maxBytes = MAX_LOG_FILE_BYTES,
): Promise<boolean> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const size = await fs.stat(filePath).then((stat) => stat.size, ignoreMissing(0));
  const rotate = size > 0 && size + Buffer.byteLength(text, 'utf8') > maxBytes;
  if (rotate) {
    // Shift oldest first; rename replaces the destination, dropping the copy
    // that falls off the end.
    for (let copy = ROTATED_LOG_COPIES; copy >= 1; copy -= 1) {
      const from = copy === 1 ? filePath : `${filePath}.${copy - 1}`;
      await fs.rename(from, `${filePath}.${copy}`).catch(ignoreMissing(undefined));
    }
  }
  await fs.appendFile(filePath, text, 'utf8');
  return rotate;
}

function ignoreMissing<T>(fallback: T): (error: unknown) => T {
  return (error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
    throw error;
  };
}
