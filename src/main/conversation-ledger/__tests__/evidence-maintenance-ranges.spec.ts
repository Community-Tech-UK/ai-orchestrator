import { beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { ContextEvidenceLedgerStore } from '../context-evidence-ledger-store';
import { runConversationLedgerMigrations } from '../conversation-ledger-schema';
import { seedEvidenceMaintenanceFixture } from '../../../../scripts/evidence-maintenance-fixture';

describe('evidence maintenance ranges and reconciliation guards', () => {
  let db: SqliteDriver;
  let store: ContextEvidenceLedgerStore;
  let conversationId: string;

  beforeEach(() => {
    db = new Database(':memory:') as unknown as SqliteDriver;
    db.pragma('foreign_keys = ON');
    conversationId = seedEvidenceMaintenanceFixture(db, { rows: 1_001 }).conversationId;
    store = new ContextEvidenceLedgerStore(db);
  });

  it.each([1, 1000])('matches the trusted complete union with page size %s', limit => {
    db.exec(`UPDATE evidence_cards SET blob_ref = 'placeholder/record-0000000.aioev'
      WHERE id = 'placeholder-card-0000000';
      UPDATE evidence_records SET status = 'staging', completed_at = NULL
      WHERE id = 'placeholder-evidence-0000001';
      UPDATE evidence_records SET status = 'deleted' WHERE id = 'placeholder-evidence-0000002';
      INSERT INTO evidence_deletion_queue
        (id, conversation_id, blob_ref, grace_deadline, next_attempt_at, created_at, completed_at)
      VALUES ('pending', 'deleted-placeholder-conversation', 'placeholder/queued', 1, 1, 1, NULL),
        ('completed', 'deleted-placeholder-conversation', 'placeholder/excluded', 1, 1, 1, 2)`);
    db.prepare('UPDATE evidence_cards SET blob_ref = ? WHERE id = ?')
      .run('placeholder/\u{10000}', 'placeholder-card-0000003');
    db.prepare('UPDATE evidence_cards SET blob_ref = ? WHERE id = ?')
      .run('placeholder/\ue000', 'placeholder-card-0000004');
    const expected = db.prepare(`SELECT blob_ref FROM evidence_records
      WHERE blob_ref IS NOT NULL AND status <> 'deleted'
      UNION SELECT blob_ref FROM evidence_cards WHERE blob_ref IS NOT NULL
      UNION SELECT blob_ref FROM evidence_deletion_queue WHERE completed_at IS NULL
      ORDER BY blob_ref`).all<{ blob_ref: string }>().map(row => row.blob_ref);
    const actual: string[] = [];
    let afterBlobRef: string | undefined;
    for (;;) {
      const refs = store.listReferencedEvidenceBlobRefs({ afterBlobRef, limit });
      if (!refs.length) break;
      actual.push(...refs);
      afterBlobRef = refs.at(-1);
    }
    expect(actual).toEqual(expected);
    const scanned: string[] = [];
    afterBlobRef = undefined;
    for (;;) {
      const page = store.listEvidenceBlobReferenceScanPage({ afterBlobRef, limit });
      scanned.push(...page.blobRefs);
      if (page.done) break;
      afterBlobRef = page.afterBlobRef;
    }
    expect(scanned).toEqual(expected);
    expect(store.listReferencedEvidenceBlobRefsForCandidates([
      'placeholder/record-0000001.aioev', 'placeholder/card-0000002.aioev',
      'placeholder/record-0000002.aioev', 'placeholder/queued', 'placeholder/excluded',
    ])).toEqual(['placeholder/card-0000002.aioev', 'placeholder/queued', 'placeholder/record-0000001.aioev']);
  });

  it('uses range searches inside every reference branch and tuple maintenance cursors', () => {
    const sqls: string[] = [];
    const observing = Object.create(db) as SqliteDriver;
    observing.prepare = sql => { sqls.push(sql); return db.prepare(sql); };
    const observed = new ContextEvidenceLedgerStore(observing);
    observed.listReferencedEvidenceBlobRefs({ afterBlobRef: 'placeholder/card-0000500.aioev', limit: 1000 });
    for (const sql of sqls.splice(0)) {
      const details = db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all<{ detail: string }>('placeholder/card-0000500.aioev', 1000).map(row => row.detail).join('\n');
      expect(details).toMatch(/SEARCH .*idx_evidence_.*blob.*\(blob_ref>\?\)/);
      expect(details).not.toMatch(/TEMP B-TREE/);
    }
    observed.listEvidenceForMaintenance({ statuses: ['staging'], afterUpdatedAt: 1, afterId: 'placeholder', limit: 1000 });
    const maintenanceSql = sqls.at(-1)!;
    expect(maintenanceSql).toContain('(evidence_records.updated_at, evidence_records.id) > (?, ?)');
    const details = db.prepare(`EXPLAIN QUERY PLAN ${maintenanceSql}`)
      .all<{ detail: string }>('staging', 1, 'placeholder', 1000).map(row => row.detail).join('\n');
    expect(details).toContain('idx_evidence_records_maintenance');
    expect(details).not.toMatch(/TEMP B-TREE/);
  });

  it('excludes deleted conversations while retaining unfinished deletion protections', () => {
    db.prepare('UPDATE conversation_threads SET deleted_at = ? WHERE id = ?').run('placeholder-deleted', conversationId);
    expect(store.listReferencedEvidenceBlobRefs({ limit: 1000 })).toEqual([]);
    expect(store.listReferencedEvidenceBlobRefsForCandidates(['placeholder/record-0000000.aioev'])).toEqual([]);
    expect(store.getEvidenceForMaintenance(conversationId, 'placeholder-evidence-0000000')).toBeNull();
    expect(store.listEvidenceForMaintenance({ statuses: ['complete'], limit: 1000 })).toEqual([]);
    expect(store.listReferencedEvidenceBlobRefsForCandidates([])).toEqual([]);
    expect(() => store.listReferencedEvidenceBlobRefsForCandidates(Array(101).fill('placeholder')))
      .toThrow('EVIDENCE_BLOB_CANDIDATES_INVALID');
  });

  it('never fails or finalizes a staging snapshot changed by capture, completion, or deletion', () => {
    const evidenceId = 'placeholder-staging';
    const staged = store.stageEvidence({ id: evidenceId, conversationId, provider: 'codex',
      toolName: 'placeholder', sourceKind: 'other', mimeType: 'text/plain', sensitivity: 'normal',
      provenanceTrust: 'runtime-authenticated', captureMode: 'pre-retention', captureCompleteness: 'complete',
      captureKey: evidenceId, createdAt: 1 });
    const preparedInput = { conversationId, evidenceId, blobRef: 'placeholder/prepared.aioev',
      keyedContentId: 'a'.repeat(64), byteCount: 1, keyVersion: 1, completedAt: 2 };
    store.prepareEvidenceBlob(preparedInput);
    expect(() => store.failEvidence({ conversationId, evidenceId,
      expectedUpdatedAt: staged.updatedAt, expectedBlobRef: staged.blobRef })).toThrow('EVIDENCE_RECONCILIATION_CHANGED');
    expect(() => store.finalizeEvidence({ ...preparedInput,
      expectedUpdatedAt: staged.updatedAt, expectedBlobRef: staged.blobRef })).toThrow('EVIDENCE_RECONCILIATION_CHANGED');
    expect(store.getEvidenceForMaintenance(conversationId, evidenceId)?.status).toBe('staging');
    store.finalizeEvidence({ ...preparedInput, expectedUpdatedAt: 2, expectedBlobRef: preparedInput.blobRef });
    expect(() => store.failEvidence({ conversationId, evidenceId,
      expectedUpdatedAt: 2, expectedBlobRef: preparedInput.blobRef })).toThrow('EVIDENCE_RECONCILIATION_CHANGED');
    expect(() => store.finalizeEvidence({ ...preparedInput,
      expectedUpdatedAt: 2, expectedBlobRef: preparedInput.blobRef })).toThrow('EVIDENCE_RECONCILIATION_CHANGED');
    expect(() => store.failEvidence({ conversationId, evidenceId, expectedUpdatedAt: 2 }))
      .toThrow('EVIDENCE_RECONCILIATION_GUARD_INVALID');
    expect(store.failEvidence({ conversationId, evidenceId }).status).toBe('failed');
  });

  it('guards null blob identity and live ownership, and advances equal-time rows after transitions', () => {
    for (const id of ['placeholder-a', 'placeholder-b', 'placeholder-c']) {
      store.stageEvidence({ id, conversationId, provider: 'codex', toolName: 'placeholder',
        sourceKind: 'other', mimeType: 'text/plain', sensitivity: 'normal',
        provenanceTrust: 'runtime-authenticated', captureMode: 'pre-retention',
        captureCompleteness: 'complete', captureKey: id, createdAt: 1 });
    }
    const first = store.listEvidenceForMaintenance({ statuses: ['staging'], updatedBefore: 1, limit: 1 });
    expect(first.map(row => row.id)).toEqual(['placeholder-a']);
    expect(store.failEvidence({ conversationId, evidenceId: first[0]!.id,
      expectedUpdatedAt: 1, expectedBlobRef: null, updatedAt: 3 }).status).toBe('failed');
    expect(store.listEvidenceForMaintenance({ statuses: ['staging'], updatedBefore: 1,
      afterUpdatedAt: first[0]!.updatedAt, afterId: first[0]!.id, limit: 1000 }).map(row => row.id))
      .toEqual(['placeholder-b', 'placeholder-c']);
    db.prepare('UPDATE conversation_threads SET deleted_at = ? WHERE id = ?').run('placeholder-deleted', conversationId);
    expect(() => store.failEvidence({ conversationId, evidenceId: 'placeholder-b',
      expectedUpdatedAt: 1, expectedBlobRef: null })).toThrow('EVIDENCE_RECONCILIATION_CHANGED');
    expect(() => store.finalizeEvidence({ conversationId, evidenceId: 'placeholder-c',
      expectedUpdatedAt: 1, expectedBlobRef: null, blobRef: 'placeholder/new',
      keyedContentId: 'a'.repeat(64), byteCount: 1, keyVersion: 1, completedAt: 2 }))
      .toThrow('EVIDENCE_RECONCILIATION_CHANGED');
    expect(db.prepare("SELECT status FROM evidence_records WHERE id = 'placeholder-b'")
      .get()).toEqual({ status: 'staging' });
  });

  it('upgrades populated v6 transactionally and leaves rows and migration records untouched on rerun', () => {
    for (const name of ['idx_evidence_records_maintenance', 'idx_evidence_records_live_blob',
      'idx_evidence_cards_live_blob', 'idx_evidence_deletion_queue_pending_blob']) db.exec(`DROP INDEX ${name}`);
    db.exec('DELETE FROM conversation_ledger_migrations WHERE version = 7');
    const before = db.prepare('SELECT * FROM evidence_records ORDER BY id').all();
    const cardsBefore = db.prepare('SELECT * FROM evidence_cards ORDER BY id').all();
    db.exec(`CREATE INDEX idx_evidence_cards_live_blob ON evidence_cards(created_at)`);
    expect(() => runConversationLedgerMigrations(db)).toThrow();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_evidence_records_maintenance'").get()).toBeUndefined();
    db.exec('DROP INDEX idx_evidence_cards_live_blob');
    runConversationLedgerMigrations(db);
    const migrations = db.prepare('SELECT * FROM conversation_ledger_migrations ORDER BY version').all();
    runConversationLedgerMigrations(db);
    expect(db.prepare('SELECT * FROM conversation_ledger_migrations ORDER BY version').all()).toEqual(migrations);
    expect(db.prepare('SELECT * FROM evidence_records ORDER BY id').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM evidence_cards ORDER BY id').all()).toEqual(cardsBefore);
  });

  it('advances bounded raw pages through deleted histories even when no live refs remain', () => {
    db.prepare('UPDATE conversation_threads SET deleted_at = ? WHERE id = ?').run('placeholder-deleted', conversationId);
    const first = store.listEvidenceBlobReferenceScanPage({ limit: 1000 });
    expect(first.blobRefs).toEqual([]);
    expect(first.afterBlobRef).toBeDefined();
    expect(first.done).toBe(false);
    let afterBlobRef = first.afterBlobRef;
    let calls = 1;
    for (;;) {
      const page = store.listEvidenceBlobReferenceScanPage({ afterBlobRef, limit: 1000 });
      expect(page.blobRefs).toEqual([]);
      calls++;
      if (page.done) break;
      expect(Buffer.compare(Buffer.from(page.afterBlobRef!), Buffer.from(afterBlobRef!))).toBeGreaterThan(0);
      afterBlobRef = page.afterBlobRef;
    }
    expect(calls).toBeLessThanOrEqual(4);
  });

  it('never jumps past hidden values when duplicate rows fill one source page', () => {
    db.exec(`UPDATE evidence_records SET blob_ref = 'placeholder/a';
      UPDATE evidence_records SET blob_ref = 'placeholder/b' WHERE id = 'placeholder-evidence-0001000';
      UPDATE evidence_cards SET blob_ref = 'placeholder/z-' || id`);
    const expected = db.prepare(`SELECT blob_ref FROM evidence_records
      UNION SELECT blob_ref FROM evidence_cards ORDER BY blob_ref`)
      .all<{ blob_ref: string }>().map(row => row.blob_ref);
    const first = store.listEvidenceBlobReferenceScanPage({ limit: 1000 });
    expect(first.afterBlobRef).toBe('placeholder/a');
    expect(first.blobRefs).toEqual(['placeholder/a']);
    const actual = [...first.blobRefs];
    let afterBlobRef = first.afterBlobRef;
    for (;;) {
      const page = store.listEvidenceBlobReferenceScanPage({ afterBlobRef, limit: 1000 });
      actual.push(...page.blobRefs);
      if (page.done) break;
      afterBlobRef = page.afterBlobRef;
    }
    expect(actual).toEqual(expected);
  });

  it('does not finish when short source pages together exceed the requested union page', () => {
    db.exec(`UPDATE evidence_records SET status = 'deleted' WHERE id > 'placeholder-evidence-0000002';
      UPDATE evidence_cards SET blob_ref = NULL WHERE id > 'placeholder-card-0000002'`);
    const first = store.listEvidenceBlobReferenceScanPage({ limit: 4 });
    expect(first.blobRefs).toHaveLength(4);
    expect(first.done).toBe(false);
    const second = store.listEvidenceBlobReferenceScanPage({ afterBlobRef: first.afterBlobRef, limit: 4 });
    expect(second.blobRefs).toHaveLength(2);
    expect(second.done).toBe(true);
  });
  it('limits actual raw rows before deleted-owner filtering and keeps candidate checks at one hundred refs', () => {
    db.prepare('UPDATE conversation_threads SET deleted_at = ? WHERE id = ?').run('placeholder-deleted', conversationId);
    const rawQueries: { sql: string; rowCount: number; params: unknown[] }[] = [];
    const candidateSizes: number[] = [];
    const observing = Object.create(db) as SqliteDriver;
    observing.prepare = sql => {
      const statement = db.prepare(sql);
      const wrapped = Object.create(statement) as typeof statement;
      wrapped.all = <T>(...params: unknown[]) => {
        const rows = statement.all<T>(...params);
        if (sql.includes('blob_ref AS blob_ref') && !sql.includes('SELECT DISTINCT')) {
          rawQueries.push({ sql, rowCount: rows.length, params });
        } else if (sql.includes('SELECT DISTINCT')) {
          candidateSizes.push(params.length);
        }
        return rows;
      };
      return wrapped;
    };
    const page = new ContextEvidenceLedgerStore(observing)
      .listEvidenceBlobReferenceScanPage({ limit: 1000, afterBlobRef: 'placeholder/card-0000000.aioev' });
    expect(page.blobRefs).toEqual([]);
    expect(page.done).toBe(false);
    expect(rawQueries).toHaveLength(3);
    for (const { sql, rowCount, params } of rawQueries) {
      expect(rowCount).toBeLessThanOrEqual(1000);
      expect(sql).not.toMatch(/DISTINCT|EXISTS|conversation_threads/);
      const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all<{ detail: string }>(...params).map(row => row.detail).join('\n');
      expect(plan).toMatch(/SEARCH .*idx_evidence_.*blob.*\(blob_ref>\?\)/);
      expect(plan).not.toMatch(/TEMP B-TREE/);
    }
    expect(candidateSizes.length).toBeGreaterThan(0);
    expect(Math.max(...candidateSizes)).toBeLessThanOrEqual(100);
  });

});
