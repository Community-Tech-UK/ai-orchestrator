import ElectronStore from 'electron-store';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getRLMDatabase } from '../persistence/rlm-database';
import { DocReviewSessionSchema, type DocReviewSession } from '@contracts/schemas/doc-review';

const LEGACY_IMPORT_KEY = 'electron-store-import-v1';

export interface DocReviewStorePort {
  list(): DocReviewSession[];
  get(reviewId: string): DocReviewSession | undefined;
  put(session: DocReviewSession): void;
  remove(reviewId: string): boolean;
}

interface Row {
  session_json: string;
}

interface LegacyReviewStore {
  get(key: 'sessions'): unknown;
}

/**
 * SQLite persistence for doc-review state. The full session JSON keeps the review
 * contract versioned in one place while indexed columns keep list/recovery queries cheap.
 */
export class DocReviewStore implements DocReviewStorePort {
  constructor(
    private readonly db: SqliteDriver = getRLMDatabase().getRawDb(),
    legacyStore?: LegacyReviewStore | null,
  ) {
    this.ensureSchema();
    this.importLegacyOnce(legacyStore === undefined ? this.openLegacyStore() : legacyStore);
  }

  list(): DocReviewSession[] {
    return this.db.prepareCached(
      'SELECT session_json FROM doc_review_sessions ORDER BY created_at DESC, review_id DESC',
    ).all<Row>().flatMap((row) => this.parse(row.session_json));
  }

  get(reviewId: string): DocReviewSession | undefined {
    const row = this.db.prepareCached(
      'SELECT session_json FROM doc_review_sessions WHERE review_id = ?',
    ).get<Row>(reviewId);
    return row ? this.parse(row.session_json)[0] : undefined;
  }

  put(session: DocReviewSession): void {
    const parsed = DocReviewSessionSchema.parse(session);
    this.db.prepareCached(`
      INSERT INTO doc_review_sessions (review_id, status, created_at, decided_at, session_json)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(review_id) DO UPDATE SET
        status = excluded.status,
        created_at = excluded.created_at,
        decided_at = excluded.decided_at,
        session_json = excluded.session_json
    `).run(parsed.id, parsed.status, parsed.createdAt, parsed.decidedAt ?? null, JSON.stringify(parsed));
  }

  remove(reviewId: string): boolean {
    return this.db.prepareCached('DELETE FROM doc_review_sessions WHERE review_id = ?').run(reviewId).changes > 0;
  }

  private ensureSchema(): void {
    // This remains idempotent for callers created before migration bootstrap. The
    // matching additive migration is still authoritative for normal startup.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS doc_review_sessions (
        review_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        decided_at INTEGER,
        session_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_doc_review_sessions_status_created
        ON doc_review_sessions(status, created_at DESC);
      CREATE TABLE IF NOT EXISTS doc_review_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  private importLegacyOnce(legacyStore: LegacyReviewStore | null | undefined): void {
    const imported = this.db.prepareCached(
      'SELECT value FROM doc_review_metadata WHERE key = ?',
    ).get<{ value: string }>(LEGACY_IMPORT_KEY);
    if (imported) return;

    const importSessions = this.db.transaction(() => {
      const legacy = legacyStore?.get('sessions');
      if (Array.isArray(legacy)) {
        for (const candidate of legacy) {
          const session = DocReviewSessionSchema.safeParse(candidate);
          if (session.success) this.put(session.data);
        }
      }
      this.db.prepareCached(
        'INSERT INTO doc_review_metadata (key, value) VALUES (?, ?)',
      ).run(LEGACY_IMPORT_KEY, String(Date.now()));
    });
    importSessions();
  }

  private openLegacyStore(): LegacyReviewStore | null {
    try {
      return new ElectronStore<{ sessions: unknown }>({ name: 'doc-reviews' });
    } catch {
      return null;
    }
  }

  private parse(json: string): DocReviewSession[] {
    try {
      const parsed = DocReviewSessionSchema.safeParse(JSON.parse(json));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  }
}
