import type { Migration } from './rlm-types';
import type { SqliteDriver } from '../../db/sqlite-driver';

/** Additive only: historical counts cannot reconstruct individual showings. */
export const WAKE_HINT_HISTORY_MIGRATION: Migration = {
  name: '082_wake_hint_showings_and_source_snapshots',
  up: `
    CREATE TABLE wake_hint_showings (
      hint_id TEXT NOT NULL REFERENCES wake_hints(id) ON DELETE CASCADE,
      showing_id TEXT NOT NULL,
      shown_at INTEGER NOT NULL,
      PRIMARY KEY(hint_id, showing_id)
    );
    CREATE INDEX idx_wake_hint_showings_time ON wake_hint_showings(shown_at);
    CREATE TABLE wake_hint_sources (
      hint_id TEXT NOT NULL REFERENCES wake_hints(id) ON DELETE CASCADE,
      source_uri TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      PRIMARY KEY(hint_id, source_uri)
    );
    CREATE TABLE wake_hint_tracking (started_at INTEGER NOT NULL);
    INSERT INTO wake_hint_tracking VALUES (CAST(strftime('%s', 'now') AS INTEGER) * 1000);
  `,
  down: 'DROP TABLE wake_hint_showings; DROP TABLE wake_hint_sources; DROP TABLE wake_hint_tracking;',
};

export function captureWakeHintSource(db: SqliteDriver, hintId: string, sourceUri: string, fingerprint: string): void {
  db.prepare(`INSERT INTO wake_hint_sources (hint_id, source_uri, fingerprint) VALUES (?, ?, ?)
    ON CONFLICT(hint_id, source_uri) DO UPDATE SET fingerprint = excluded.fingerprint`)
    .run(hintId, sourceUri, fingerprint);
}

/** Counter and rolling facts commit together; only the exact non-empty rendered ids enter here. */
export function recordWakeHintShowing(db: SqliteDriver, hintIds: string[], showingId: string, now: number): void {
  if (hintIds.length === 0) return;
  db.transaction(() => {
    const ids = [...new Set(hintIds)];
    // The select and insert are one SQLite statement, so a hint removed after
    // the caller rendered it cannot cause a foreign-key failure here.
    db.prepare(`INSERT INTO wake_hint_showings (hint_id, showing_id, shown_at)
      SELECT id, ?, ? FROM wake_hints WHERE id IN (${ids.map(() => '?').join(', ')})`)
      .run(showingId, now, ...ids);
    db.prepare(`UPDATE wake_hints SET last_used = ?, usage_count = usage_count + 1
      WHERE id IN (SELECT hint_id FROM wake_hint_showings WHERE showing_id = ?)`).run(now, showingId);
    db.prepare('DELETE FROM wake_hint_showings WHERE shown_at < ?').run(now - 30 * 86_400_000);
  })();
}
