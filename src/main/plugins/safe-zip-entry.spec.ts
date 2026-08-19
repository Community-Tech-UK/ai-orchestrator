import * as path from 'path';
import type { Entry } from 'yauzl';
import { describe, expect, it } from 'vitest';
import { UnsafeZipEntryError, assertSafeZipEntry } from './safe-zip-entry';

const DEST = path.resolve('/tmp/staged-plugin');

/** Builds the subset of a yauzl `Entry` that `assertSafeZipEntry` reads. */
function entry(fileName: string, mode = 0o100644): Entry {
  return { fileName, externalFileAttributes: mode << 16 } as Entry;
}

describe('assertSafeZipEntry', () => {
  it('accepts an ordinary file inside the destination', () => {
    expect(() => assertSafeZipEntry(entry('index.js'), DEST)).not.toThrow();
    expect(() => assertSafeZipEntry(entry('.codex-plugin/plugin.json'), DEST)).not.toThrow();
  });

  it('accepts an interior traversal that stays inside the destination', () => {
    expect(() => assertSafeZipEntry(entry('nested/../index.js'), DEST)).not.toThrow();
  });

  it('rejects a sibling directory sharing the destination as a string prefix', () => {
    // Guards the prefix check: `/tmp/staged-plugin-evil` starts with
    // `/tmp/staged-plugin`, so comparing without the trailing separator would
    // wrongly accept it as a child.
    expect(() => assertSafeZipEntry(entry('../staged-plugin-evil/x'), DEST)).toThrow(
      /escapes the extraction directory/,
    );
  });

  it('rejects a parent-directory traversal', () => {
    expect(() => assertSafeZipEntry(entry('../escaped.txt'), DEST)).toThrow(UnsafeZipEntryError);
    expect(() => assertSafeZipEntry(entry('a/../../escaped.txt'), DEST)).toThrow(
      /escapes the extraction directory/,
    );
  });

  it('rejects a backslash-separated traversal from a Windows-authored archive', () => {
    // yauzl normally folds `\` to `/` before we see the name, so this covers the
    // strictFileNames case where it does not.
    expect(() => assertSafeZipEntry(entry('..\\..\\escaped.txt'), DEST)).toThrow(
      UnsafeZipEntryError,
    );
  });

  it('rejects absolute paths', () => {
    expect(() => assertSafeZipEntry(entry('/etc/passwd'), DEST)).toThrow(/absolute path/);
    expect(() => assertSafeZipEntry(entry('C:\\Windows\\system32'), DEST)).toThrow(
      /absolute path/,
    );
  });

  it('rejects a NUL byte in the name', () => {
    expect(() => assertSafeZipEntry(entry('index.js\0.png'), DEST)).toThrow(/NUL byte/);
  });

  it('rejects a symlink even when its own name stays inside the destination', () => {
    // GHSA-jmr9-qjv8-65gv: `link -> /` is harmless alone, but a later entry
    // named `link/etc/passwd` then writes outside the destination.
    expect(() => assertSafeZipEntry(entry('link', 0o120777), DEST)).toThrow(/symlink/);
  });

  it('reports the offending entry name', () => {
    try {
      assertSafeZipEntry(entry('../escaped.txt'), DEST);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UnsafeZipEntryError);
      expect((error as UnsafeZipEntryError).entryName).toBe('../escaped.txt');
    }
  });
});
