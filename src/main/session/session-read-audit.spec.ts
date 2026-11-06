import { beforeEach, describe, expect, it } from 'vitest';
import { OperatorDatabase, getOperatorDatabase } from '../operator/operator-database';
import { writeSessionReadAuditRow } from './session-read-audit';
describe('session read audit storage', () => {
  beforeEach(() => OperatorDatabase._resetForTesting());
  it('stores read and refused-read rows in the shared audit table without a transcript column', () => {
    const db = getOperatorDatabase({ dbPath: ':memory:' }).db;
    for (const outcome of ['read', 'not-allowed', 'not-found', 'rate-limited', 'ambiguous']) {
      writeSessionReadAuditRow({ sourceId: 'caller', sourceDisplayName: 'Caller', targetId: null, targetDisplayName: null,
        outcome, reason: outcome === 'read' ? 'self' : outcome, contentLength: outcome === 'read' ? 42 : 0,
        contentHash: 'hash-placeholder', createdAt: 1 });
    }
    const rows = db.prepare('SELECT * FROM session_messages ORDER BY created_at').all<Record<string, unknown>>();
    expect(rows).toHaveLength(5); expect(rows.find((row) => row['outcome'] === 'read')).toMatchObject({ outcome: 'read', content_length: 42, content_hash: 'hash-placeholder' });
    expect(rows.every((row) => !('content' in row))).toBe(true);
    OperatorDatabase._resetForTesting();
  });
});
