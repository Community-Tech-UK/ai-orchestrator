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
 * Guards `extract-zip` against GHSA-jmr9-qjv8-65gv (unvalidated symlink path
 * traversal), for which no patched release exists.
 *
 * `extract-zip` calls `onEntry` before it creates anything on disk and rejects
 * the extraction if the callback throws, so validating here stops a hostile
 * entry from ever being written.
 *
 * The load-bearing check is the symlink one. yauzl (which extract-zip reads
 * through) already rejects absolute and `../` entry names, normalising `\` to
 * `/` first unless `strictFileNames` is set — see yauzl `index.js` lines
 * 421-423 and 605-618. It does *not* inspect symlink entries, and extract-zip
 * creates them with `fs.symlink` without validating the target, so `evil -> /`
 * followed by `evil/etc/passwd` escapes `destDir` even though neither name is
 * itself invalid. That is the advisory, and rejecting symlinks closes it.
 *
 * The name checks below duplicate yauzl's and are kept deliberately: they cost
 * nothing, they document the full threat model at the point of use, and they
 * still hold if extract-zip ever enables `strictFileNames` (which disables the
 * separator normalisation those checks depend on) or swaps its zip reader.
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
