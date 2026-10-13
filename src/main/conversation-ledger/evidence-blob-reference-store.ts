import type { SqliteDriver } from '../db/sqlite-driver';
import type { EvidenceBlobReferenceQuery, EvidenceBlobReferenceScanPage } from './context-evidence-ledger.types';

/** Indexed reference access; maintenance bounds raw rows before live-owner filtering. */
export class EvidenceBlobReferenceStore {
  constructor(private readonly db: SqliteDriver) {}

  listReferencedEvidenceBlobRefs(query: EvidenceBlobReferenceQuery): string[] {
    const limit = Math.max(1, Math.min(query.limit, 1000));
    const cursor = query.afterBlobRef;
    // Each branch is bounded before merging: a value outside a branch's first
    // limit distinct refs cannot appear in the union's first limit refs.
    const branches = this.referenceBranches();
    const refs = new Set<string>();
    for (const { table, where, index } of branches) {
      const cursorPredicate = cursor === undefined ? '' : ` AND ${table}.blob_ref > ?`;
      const params: unknown[] = cursor === undefined ? [limit] : [cursor, limit];
      const rows = this.db.prepare(`
        SELECT DISTINCT ${table}.blob_ref AS blob_ref FROM ${table} INDEXED BY ${index}
        WHERE ${where}${cursorPredicate}
        ORDER BY ${table}.blob_ref ASC LIMIT ?
      `).all<{ blob_ref: string }>(...params);
      for (const row of rows) refs.add(row.blob_ref);
    }
    return sortBlobRefs(refs).slice(0, limit);
  }

  listEvidenceBlobReferenceScanPage(query: EvidenceBlobReferenceQuery): EvidenceBlobReferenceScanPage {
    const limit = Math.max(1, Math.min(query.limit, 1000));
    const rawRefs = new Set<string>();
    const fullBranchEnds = new Set<string>();
    let allBranchesExhausted = true;
    for (const { table, rawWhere, index } of this.referenceBranches()) {
      const cursorPredicate = query.afterBlobRef === undefined ? '' : ` AND ${table}.blob_ref > ?`;
      const params: unknown[] = query.afterBlobRef === undefined ? [limit] : [query.afterBlobRef, limit];
      // LIMIT applies to actual indexed rows before DISTINCT or ownership checks.
      // A deleted history therefore consumes pages rather than being re-scanned.
      const rows = this.db.prepare(`
        SELECT ${table}.blob_ref AS blob_ref FROM ${table} INDEXED BY ${index}
        WHERE ${rawWhere}${cursorPredicate}
        ORDER BY ${table}.blob_ref ASC LIMIT ?
      `).all<{ blob_ref: string }>(...params);
      if (rows.length === limit) {
        allBranchesExhausted = false;
        fullBranchEnds.add(rows.at(-1)!.blob_ref);
      }
      for (const row of rows) rawRefs.add(row.blob_ref);
    }
    const sorted = sortBlobRefs(rawRefs);
    // A full branch may hide another ref immediately after its last raw row.
    // Never jump beyond the earliest full-branch end, even if duplicates fill it.
    const frontier = sortBlobRefs(fullBranchEnds)[0];
    const candidates = sorted.filter(ref => frontier === undefined
      || Buffer.compare(Buffer.from(ref, 'utf8'), Buffer.from(frontier, 'utf8')) <= 0).slice(0, limit);
    const blobRefs: string[] = [];
    for (let offset = 0; offset < candidates.length; offset += 100) {
      blobRefs.push(...this.listReferencedEvidenceBlobRefsForCandidates(candidates.slice(offset, offset + 100)));
    }
    return {
      blobRefs,
      ...(candidates.length ? { afterBlobRef: candidates.at(-1)! } : {}),
      done: allBranchesExhausted && sorted.length <= limit,
    };
  }

  listReferencedEvidenceBlobRefsForCandidates(blobRefs: string[]): string[] {
    if (!Array.isArray(blobRefs) || blobRefs.length > 100
      || blobRefs.some(ref => typeof ref !== 'string')) {
      throw new Error('EVIDENCE_BLOB_CANDIDATES_INVALID');
    }
    const candidates = [...new Set(blobRefs)];
    if (!candidates.length) return [];
    const refs = new Set<string>();
    for (const { table, where, index } of this.referenceBranches()) {
      const rows = this.db.prepare(`
        SELECT DISTINCT ${table}.blob_ref AS blob_ref FROM ${table} INDEXED BY ${index}
        WHERE ${where} AND ${table}.blob_ref IN (${candidates.map(() => '?').join(', ')})
      `).all<{ blob_ref: string }>(...candidates);
      for (const row of rows) refs.add(row.blob_ref);
    }
    return sortBlobRefs(refs);
  }

  private referenceBranches(): { table: string; where: string; rawWhere: string; index: string }[] {
    const liveConversation = (table: string) => `EXISTS (
      SELECT 1 FROM conversation_threads WHERE conversation_threads.id = ${table}.conversation_id
        AND conversation_threads.deleted_at IS NULL
    )`;
    return [
      { table: 'evidence_records', index: 'idx_evidence_records_live_blob', rawWhere: "evidence_records.blob_ref IS NOT NULL AND evidence_records.status <> 'deleted'", where: `evidence_records.blob_ref IS NOT NULL
        AND evidence_records.status <> 'deleted' AND ${liveConversation('evidence_records')}` },
      { table: 'evidence_cards', index: 'idx_evidence_cards_live_blob', rawWhere: 'evidence_cards.blob_ref IS NOT NULL', where: `evidence_cards.blob_ref IS NOT NULL
        AND ${liveConversation('evidence_cards')}` },
      { table: 'evidence_deletion_queue', index: 'idx_evidence_deletion_queue_pending_blob', rawWhere: 'evidence_deletion_queue.completed_at IS NULL', where: 'evidence_deletion_queue.completed_at IS NULL' },
    ];
  }

}

/** Match SQLite BINARY text ordering, including supplementary Unicode code points. */
function sortBlobRefs(refs: ReadonlySet<string>): string[] {
  return [...refs].map(ref => ({ ref, bytes: Buffer.from(ref, 'utf8') }))
    .sort((left, right) => Buffer.compare(left.bytes, right.bytes)).map(entry => entry.ref);
}
