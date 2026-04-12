/**
 * Walk a directory tree and produce a SyncManifest — an inventory of every
 * file with its relative path, size, mtime, and SHA-256 content hash.
 *
 * Respects the same security filters (restricted files, skip directories)
 * used by the rest of the remote filesystem subsystem.
 */

import { createHash } from 'crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { SecurityFilter } from '../security-filter';
import type { SyncManifest, SyncFileEntry } from '../../../shared/types/sync.types';

/**
 * Scan a directory and produce a manifest of all files.
 *
 * @param rootPath  Absolute path to the directory to scan.
 * @param exclude   Optional glob-like patterns to exclude (simple substring match).
 */
export async function scanDirectory(
  rootPath: string,
  exclude: string[] = [],
): Promise<SyncManifest> {
  const entries: SyncFileEntry[] = [];
  let totalSize = 0;

  await walk(rootPath, rootPath, exclude, entries);

  for (const entry of entries) {
    totalSize += entry.size;
  }

  // Sort for deterministic output
  entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  return {
    rootPath,
    entries,
    totalSize,
    scannedAt: Date.now(),
  };
}

async function walk(
  rootPath: string,
  currentPath: string,
  exclude: string[],
  entries: SyncFileEntry[],
): Promise<void> {
  let dirents: import('node:fs').Dirent[];
  try {
    dirents = await fs.readdir(currentPath, { withFileTypes: true });
  } catch {
    return; // Permission denied or deleted during scan
  }

  for (const dirent of dirents) {
    const name = dirent.name;
    const fullPath = path.join(currentPath, name);
    const relativePath = path.relative(rootPath, fullPath).split(path.sep).join('/');

    // Skip hidden files at root decision: we include them (they might matter)
    // but skip security-restricted names and standard skip directories.
    if (SecurityFilter.isRestricted(name)) continue;
    if (dirent.isDirectory() && SecurityFilter.shouldSkipDirectory(name)) continue;

    // Exclude patterns (simple substring match)
    if (exclude.length > 0 && exclude.some(pat => relativePath.includes(pat))) continue;

    if (dirent.isDirectory()) {
      await walk(rootPath, fullPath, exclude, entries);
    } else if (dirent.isFile()) {
      try {
        const stat = await fs.stat(fullPath);
        const hash = await hashFile(fullPath);
        entries.push({
          relativePath,
          size: stat.size,
          modifiedAt: stat.mtimeMs,
          hash,
        });
      } catch {
        // File disappeared or isn't readable — skip
      }
    }
    // Symlinks are intentionally skipped to avoid cycles / escaping sandbox
  }
}

/**
 * Compute SHA-256 of a file by streaming in 64 KB chunks.
 * This avoids loading the entire file into memory for large files.
 */
async function hashFile(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, 'r');
  try {
    const hasher = createHash('sha256');
    const buf = Buffer.allocUnsafe(65536);
    let bytesRead: number;
    let position = 0;

    do {
      const result = await handle.read(buf, 0, buf.length, position);
      bytesRead = result.bytesRead;
      if (bytesRead > 0) {
        hasher.update(buf.subarray(0, bytesRead));
        position += bytesRead;
      }
    } while (bytesRead > 0);

    return hasher.digest('hex');
  } finally {
    await handle.close();
  }
}
