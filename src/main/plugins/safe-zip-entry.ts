import * as path from 'path';
import type { Entry } from 'yauzl';

/** stat mode bits, as encoded in a zip entry's external file attributes. */
const IFMT = 0o170000;
const IFLNK = 0o120000;

export class UnsafeZipEntryError extends Error {
  constructor(
    readonly entryName: string,
    reason: string,
  ) {
    super(`Refusing to extract unsafe zip entry "${entryName}": ${reason}`);
    this.name = 'UnsafeZipEntryError';
  }
}

/**
 * Keeps plugin archive entries inside their private staging directory.
 * safeExtractZip calls this guard before creating a directory or writing a file.
 *
 * yauzl rejects absolute and `../` entry names, normalising `\` to `/` first
 * unless strictFileNames is set. The checks below deliberately retain those
 * guarantees at our extraction boundary. Symlinks are rejected outright:
 * creating a link and then extracting a nested or same-named file through it
 * caused GHSA-jmr9-qjv8-65gv and GHSA-7pqw-9j4j-h8q3 in the former extractor.
 *
 * Plugin archives are fetched from a renderer-supplied URL with no scheme or
 * host allowlist, so the archive is not trusted. Nothing shipped needs symlinks
 * inside a plugin package, so they are rejected outright rather than resolved.
 */
export function assertSafeZipEntry(entry: Entry, destDir: string): void {
  const { fileName } = entry;

  if (fileName.includes('\0')) {
    throw new UnsafeZipEntryError(fileName, 'name contains a NUL byte');
  }

  // POSIX path.* treats `\` as an ordinary filename character, so normalise
  // separators before resolving or a Windows-authored `..\..\` name would look
  // like a single innocuous filename. yauzl normally does this first, but not
  // when `strictFileNames` is enabled.
  const normalizedName = fileName.replace(/\\/g, '/');

  if (path.posix.isAbsolute(normalizedName) || /^[a-zA-Z]:/.test(normalizedName)) {
    throw new UnsafeZipEntryError(fileName, 'name is an absolute path');
  }

  const resolvedDest = path.resolve(destDir);
  const resolvedEntry = path.resolve(resolvedDest, normalizedName);
  if (resolvedEntry !== resolvedDest && !resolvedEntry.startsWith(resolvedDest + path.sep)) {
    throw new UnsafeZipEntryError(fileName, 'name escapes the extraction directory');
  }

  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  if ((mode & IFMT) === IFLNK) {
    throw new UnsafeZipEntryError(fileName, 'entry is a symlink');
  }
}
