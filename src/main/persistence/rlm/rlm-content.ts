/**
 * RLM Content Module
 *
 * Content file management (save, load, delete).
 */

import * as path from 'path';
import * as fs from 'fs';
import { INLINE_THRESHOLD } from './rlm-types';

/**
 * Canonical on-disk layout for a section's external content:
 *
 *   <contentDir>/<first two chars of section id>/<section id>.txt
 *
 * THIS IS THE ONLY DEFINITION OF THE LAYOUT. Everything that reads, writes,
 * deletes, backs up or verifies external content resolves through here, keyed
 * on the SECTION id.
 *
 * In particular, resolution never trusts `context_sections.content_file`. That
 * column holds the absolute path captured when the section was written, so it
 * can name a userData root that no longer exists after an app rename or a
 * profile migration. It is a "content lives on disk" flag, not an address.
 * Storage maintenance previously re-derived this layout in its own copy of the
 * function, and the copies drifted; keep it single-sourced.
 */
export function contentRelativePath(sectionId: string): string {
  return path.join(sectionId.substring(0, 2), `${sectionId}.txt`);
}

/**
 * Resolve a section's content path without touching the filesystem.
 *
 * Refuses to escape the content directory. Section ids are generated
 * internally, but a corrupt or hostile id (`../../etc/passwd`) would otherwise
 * let a read or a delete walk out of the managed tree, and deletes here run
 * unattended during storage maintenance.
 */
export function resolveContentPath(contentDir: string, sectionId: string): string {
  const root = path.resolve(contentDir);
  const resolved = path.resolve(root, contentRelativePath(sectionId));
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(
      `Refusing to resolve section content outside the RLM content directory: ${sectionId}`,
    );
  }
  return resolved;
}

/**
 * Get the content file path for a section, creating its prefix directory.
 * Distributes files across subdirectories to avoid filesystem limits.
 */
export function getContentPath(contentDir: string, sectionId: string): string {
  const filePath = resolveContentPath(contentDir, sectionId);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return filePath;
}

/**
 * Save content to a file.
 */
export function saveContent(contentDir: string, sectionId: string, content: string): string {
  const filePath = getContentPath(contentDir, sectionId);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

/**
 * Load content from a file.
 *
 * Resolves without creating directories: reading is not a reason to
 * materialise an empty prefix directory.
 */
export function loadContent(contentDir: string, sectionId: string): string | null {
  const filePath = resolveContentPath(contentDir, sectionId);
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, 'utf-8');
  }
  return null;
}

/**
 * Delete a section's content file.
 *
 * Reports whether a file was actually removed. `missing` is not an error: a
 * section whose content was written under a previous userData root has no file
 * under the current one. But it is a signal worth surfacing rather than
 * swallowing, because it is also what a path-derivation bug looks like.
 */
export function deleteContent(
  contentDir: string,
  sectionId: string,
): 'deleted' | 'missing' {
  const filePath = resolveContentPath(contentDir, sectionId);
  if (!fs.existsSync(filePath)) {
    return 'missing';
  }
  fs.unlinkSync(filePath);
  pruneEmptyPrefixDirectory(filePath);
  return 'deleted';
}

/**
 * Remove a now-empty prefix directory (e.g. content/se/) after its last file
 * is deleted. These are zero bytes but not zero inodes, and without this the
 * fan-out tree only ever grows.
 */
function pruneEmptyPrefixDirectory(filePath: string): void {
  try {
    fs.rmdirSync(path.dirname(filePath));
  } catch {
    // Directory is not empty, or already gone. Both are fine.
  }
}

/**
 * Check if content should be stored inline.
 */
export function shouldStoreInline(content: string): boolean {
  return Buffer.byteLength(content, 'utf-8') <= INLINE_THRESHOLD;
}

/**
 * Copy a directory recursively.
 */
export function copyDirectoryRecursive(source: string, target: string): void {
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }

  const entries = fs.readdirSync(source, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(source, entry.name);
    const destPath = path.join(target, entry.name);

    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Get the total size of a directory.
 */
export function getDirectorySize(dirPath: string): number {
  let size = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      size += getDirectorySize(entryPath);
    } else {
      size += fs.statSync(entryPath).size;
    }
  }

  return size;
}

/**
 * Ensure directories exist.
 */
export function ensureDirectories(dbPath: string, contentDir: string): void {
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  if (!fs.existsSync(contentDir)) {
    fs.mkdirSync(contentDir, { recursive: true });
  }
}
