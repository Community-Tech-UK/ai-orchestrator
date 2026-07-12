import * as fs from 'fs';
import * as path from 'path';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { RLMDatabase } from '../persistence/rlm-database';
import {
  contentRelativePath,
  getDirectorySize,
  resolveContentPath,
} from '../persistence/rlm/rlm-content';
import type {
  ExternalContentCleanupSummary,
  RlmMaintenanceDatabasePort,
  RlmMaintenanceInspection,
  RlmMaintenanceMeasurement,
} from './rlm-storage-maintenance';

interface StoreCountRow { count: number }

/**
 * `content_file` is selected only to filter sections that have external content
 * (`IS NOT NULL`). Its value is never used as an address: paths are always
 * re-derived from `id`. See rlm-content.ts for why.
 */
interface ContentFileRow { id: string; content_file: string }

export class RlmMaintenanceDatabaseAdapter implements RlmMaintenanceDatabasePort {
  constructor(private readonly database: RLMDatabase) {}

  measure(): RlmMaintenanceMeasurement {
    const db = this.database.getRawDb();
    const pageSize = Number(db.pragma('page_size', { simple: true })) || 0;
    const pageCount = Number(db.pragma('page_count', { simple: true })) || 0;
    const freePages = Number(db.pragma('freelist_count', { simple: true })) || 0;
    const databasePath = this.database.getDatabasePath();
    return {
      databaseSizeBytes: Math.max(
        fileSize(databasePath) + fileSize(`${databasePath}-wal`),
        pageSize * pageCount,
      ),
      externalContentSizeBytes: directorySize(this.database.getContentDir()),
      reclaimableDatabaseBytes: pageSize * freePages,
    };
  }

  inspect(cutoffTimestamp: number, protectedSessionIds: Set<string>): RlmMaintenanceInspection {
    const db = this.database.getRawDb();
    const protectedIds = [...protectedSessionIds];
    return {
      eligibleStoreCount: this.count(db, cutoffTimestamp, protectedIds, 'eligible'),
      protectedLiveStoreCount: this.count(db, cutoffTimestamp, protectedIds, 'live'),
      protectedCodebaseAutoStoreCount: this.count(db, cutoffTimestamp, protectedIds, 'codebase'),
    };
  }

  checkpoint(): void {
    this.database.checkpoint();
  }

  backup(targetPath: string, options: { includeContent: true }) {
    return this.database.backupDatabase(targetPath, options);
  }

  verifyBackup(backupPath: string): void {
    if (!fs.existsSync(backupPath) || fs.statSync(backupPath).size === 0) {
      throw new Error('RLM backup file was not created');
    }
    const backup = defaultDriverFactory(backupPath, { readonly: true });
    let contentFiles: ContentFileRow[] = [];
    try {
      const result = backup.pragma('integrity_check') as Record<string, unknown>[];
      const values = Array.isArray(result)
        ? result.flatMap((row) => Object.values(row))
        : [result];
      if (!values.some((value) => value === 'ok')) {
        throw new Error('SQLite backup integrity check did not return ok');
      }
      contentFiles = backup.prepare(`
        SELECT id, content_file FROM context_sections WHERE content_file IS NOT NULL
      `).all<ContentFileRow>();
    } finally {
      backup.close();
    }

    const contentBackupPath = backupPath.replace(/\.db$/, '') + '_content';
    if (!fs.existsSync(contentBackupPath) || !fs.statSync(contentBackupPath).isDirectory()) {
      throw new Error('External-content backup directory was not created');
    }
    verifyExternalContentBackup(
      contentFiles,
      this.database.getContentDir(),
      contentBackupPath,
    );
  }

  prune(cutoffTimestamp: number, protectedSessionIds: Set<string>) {
    const db = this.database.getRawDb();
    const protectedIds = [...protectedSessionIds];
    const transaction = db.transaction(() => {
      const joined = eligibleClause(cutoffTimestamp, protectedIds, 'store');
      const files = db.prepare(`
        SELECT cs.id, cs.content_file
        FROM context_sections cs
        JOIN context_stores store ON store.id = cs.store_id
        WHERE cs.content_file IS NOT NULL AND ${joined.clause}
      `).all<ContentFileRow>(...joined.params).map((row) => resolveContentPath(
        this.database.getContentDir(),
        row.id,
      ));
      const deletion = eligibleClause(cutoffTimestamp, protectedIds, 'context_stores');
      const result = db.prepare(`DELETE FROM context_stores WHERE ${deletion.clause}`).run(...deletion.params);
      return { storesDeleted: result.changes, externalContentFiles: files };
    });
    return transaction();
  }

  deleteExternalContent(files: string[]): ExternalContentCleanupSummary {
    const root = path.resolve(this.database.getContentDir());
    const summary: ExternalContentCleanupSummary = {
      deleted: 0,
      missing: 0,
      refused: 0,
      failed: 0,
    };
    for (const file of files) {
      const resolved = path.resolve(file);
      if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
        summary.refused += 1;
        continue;
      }
      try {
        // Deliberately not rmSync(force): force treats "the file was never
        // there" as success, which makes a silent no-op indistinguishable from
        // a real delete. That is precisely how a path-derivation bug hides —
        // maintenance reports a clean run while the content it was supposed to
        // reclaim is still on disk.
        if (!fs.existsSync(resolved)) {
          summary.missing += 1;
          continue;
        }
        fs.unlinkSync(resolved);
        summary.deleted += 1;
        try {
          fs.rmdirSync(path.dirname(resolved));
        } catch {
          // Prefix directory still holds other sections, or is already gone.
        }
      } catch {
        summary.failed += 1;
      }
    }
    return summary;
  }

  vacuum(): void {
    this.database.vacuum();
    this.database.checkpoint();
  }

  private count(
    db: SqliteDriver,
    cutoffTimestamp: number,
    protectedIds: string[],
    kind: 'eligible' | 'live' | 'codebase',
  ): number {
    const placeholders = protectedIds.map(() => '?').join(', ');
    const liveCondition = protectedIds.length > 0
      ? `instance_id IN (${placeholders})`
      : '0';
    const codebaseCondition = configKindSql('context_stores') + " = 'codebase-auto'";
    let condition: string;
    let params: unknown[] = [cutoffTimestamp];
    if (kind === 'live') {
      condition = liveCondition;
      params = [...params, ...protectedIds];
    } else if (kind === 'codebase') {
      condition = codebaseCondition;
    } else {
      const liveExclusion = protectedIds.length > 0
        ? `instance_id NOT IN (${placeholders})`
        : '1';
      condition = `${liveExclusion} AND ${configKindSql('context_stores')} != 'codebase-auto'`;
      params = [...params, ...protectedIds];
    }
    return db.prepare(`
      SELECT COUNT(*) AS count FROM context_stores
      WHERE last_accessed <= ? AND ${condition}
    `).get<StoreCountRow>(...params)?.count ?? 0;
  }
}

export function verifyExternalContentBackup(
  rows: ContentFileRow[],
  sourceContentDirectory: string,
  backupContentDirectory: string,
): void {
  const backupRoot = path.resolve(backupContentDirectory);
  for (const row of rows) {
    // Resolve by section id through the one canonical layout (rlm-content.ts),
    // never through row.content_file. That column records the absolute path at
    // write time and can name a userData root that no longer exists, so the
    // backup must be verified at the address the runtime actually reads from.
    // resolveContentPath throws if a corrupt id escapes the content directory.
    resolveContentPath(sourceContentDirectory, row.id);
    const backupFile = path.resolve(backupRoot, contentRelativePath(row.id));
    if (
      !backupFile.startsWith(`${backupRoot}${path.sep}`)
      || !fs.existsSync(backupFile)
      || !fs.statSync(backupFile).isFile()
    ) {
      throw new Error('External-content backup is incomplete');
    }
  }
}

function eligibleClause(cutoffTimestamp: number, protectedIds: string[], alias: string): {
  clause: string;
  params: unknown[];
} {
  const placeholders = protectedIds.map(() => '?').join(', ');
  const liveExclusion = protectedIds.length > 0
    ? `${alias}.instance_id NOT IN (${placeholders})`
    : '1';
  return {
    clause: `${alias}.last_accessed <= ? AND ${liveExclusion} AND ${configKindSql(alias)} != 'codebase-auto'`,
    params: [cutoffTimestamp, ...protectedIds],
  };
}

function configKindSql(alias: string): string {
  return `COALESCE(CASE WHEN json_valid(${alias}.config_json) THEN json_extract(${alias}.config_json, '$.kind') END, '')`;
}

function fileSize(filePath: string): number {
  try { return fs.statSync(filePath).size; } catch { return 0; }
}

function directorySize(directoryPath: string): number {
  try { return getDirectorySize(directoryPath); } catch { return 0; }
}
