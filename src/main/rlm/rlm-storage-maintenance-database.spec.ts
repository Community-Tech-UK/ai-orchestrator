import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyExternalContentBackup } from './rlm-storage-maintenance-database';

/**
 * External content lives at <contentDir>/<sectionId[0:2]>/<sectionId>.txt.
 * That layout is owned by getContentPath() in persistence/rlm/rlm-content.ts,
 * and verifyExternalContentBackup re-derives it from context_sections.id — NOT
 * from the content_file column, which can hold a stale absolute path from a
 * previous userData root. Fixtures here mirror the canonical layout and key it
 * on the section id, so they exercise the paths production actually reads.
 */
function canonicalRelativePath(sectionId: string): string {
  return path.join(sectionId.substring(0, 2), `${sectionId}.txt`);
}

describe('verifyExternalContentBackup', () => {
  const temporaryDirectories: string[] = [];

  function makeRoots(): { source: string; backup: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rlm-maintenance-backup-'));
    temporaryDirectories.push(root);
    const source = path.join(root, 'content');
    const backup = path.join(root, 'backup_content');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(backup, { recursive: true });
    return { source, backup };
  }

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      fs.rmSync(directory, { force: true, recursive: true });
    }
  });

  it('requires every external-content reference in the SQLite snapshot', () => {
    const { source, backup } = makeRoots();
    const sectionId = 'section-alpha';
    const relative = canonicalRelativePath(sectionId);
    const sourceFile = path.join(source, relative);
    fs.mkdirSync(path.dirname(sourceFile), { recursive: true });
    fs.writeFileSync(sourceFile, 'live content');

    // Backup directory exists, but this section's file was never copied into it.
    expect(() => verifyExternalContentBackup(
      [{ id: sectionId, content_file: sourceFile }],
      source,
      backup,
    )).toThrow('External-content backup is incomplete');

    const backupFile = path.join(backup, relative);
    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    fs.writeFileSync(backupFile, 'backed up content');

    expect(() => verifyExternalContentBackup(
      [{ id: sectionId, content_file: sourceFile }],
      source,
      backup,
    )).not.toThrow();
  });

  it('verifies the canonical path even when content_file holds a stale root', () => {
    const { source, backup } = makeRoots();
    const sectionId = 'section-beta';
    const backupFile = path.join(backup, canonicalRelativePath(sectionId));
    fs.mkdirSync(path.dirname(backupFile), { recursive: true });
    fs.writeFileSync(backupFile, 'backed up content');

    // content_file still points at a userData root that no longer exists. The
    // backup is complete under the current content directory, so this must pass.
    expect(() => verifyExternalContentBackup(
      [{ id: sectionId, content_file: '/previous-app-root/rlm/content/se/section-beta.txt' }],
      source,
      backup,
    )).not.toThrow();
  });

  it('rejects references outside the managed RLM content directory', () => {
    const { source, backup } = makeRoots();

    // A section id that escapes the content root via traversal must be refused
    // rather than silently resolved against a directory we do not manage.
    expect(() => verifyExternalContentBackup(
      [{ id: '../../unmanaged', content_file: path.join(source, 'unmanaged.txt') }],
      source,
      backup,
    )).toThrow('outside the RLM content directory');
  });
});
