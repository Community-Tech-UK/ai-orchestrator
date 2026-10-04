import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../../db/sqlite-driver';
import { runConversationLedgerMigrations } from '../conversation-ledger-schema';
import { ConversationLedgerStore } from '../conversation-ledger-store';
import { getLatestUserMessage, LATEST_USER_MESSAGE_SQL } from '../conversation-message-source-query';
import { ConversationLedgerService } from '../conversation-ledger-service';
import { getLogger } from '../../logging/logger';

describe('latest recorded user source', () => {
  let db: SqliteDriver;
  let store: ConversationLedgerStore;
  let threadId: string;
  const latest = (owner: string | null, thread = threadId) => store.getLatestUserMessage(thread, owner);

  beforeEach(() => {
    db = new Database(':memory:') as unknown as SqliteDriver;
    db.pragma('foreign_keys = ON');
    runConversationLedgerMigrations(db);
    store = new ConversationLedgerStore(db);
    threadId = store.upsertThread({ provider: 'orchestrator', sourceKind: 'orchestrator' }).id;
  });
  afterEach(() => db.close());

  function user(id: string, sequence: number, owner?: unknown): void {
    store.upsertMessages(threadId, [{ id, role: 'user', content: 'Synthetic source', sequence, createdAt: 10_000 - sequence,
      rawJson: owner === undefined ? {} : { metadata: { instanceId: owner } } }]);
  }

  it('finds the recorded user behind more than 1000 tool and system messages', () => {
    user('source', 1, 'current');
    store.upsertMessages(threadId, Array.from({ length: 1205 }, (_, index) => ({
      id: `tail-${index}`, sequence: index + 2, role: index % 2 ? 'tool' as const : 'system' as const,
      phase: 'tool_result', content: 'Synthetic result',
    })));
    expect(store.getRecentMessages(threadId, 200).every(row => row.role !== 'user')).toBe(true);
    expect(latest('current')).toMatchObject({ id: 'source', sequence: 1 });
  });

  it('selects the newest current or legacy user while excluding newer foreign users', () => {
    user('current', 1, 'current');
    user('legacy', 2);
    for (let sequence = 3; sequence < 1005; sequence++) user(`foreign-${sequence}`, sequence, 'foreign');
    expect(latest('current')?.id).toBe('legacy');
    user('current-new', 1005, 'current');
    expect(latest('current')?.id).toBe('current-new');
  });

  it('distinguishes explicit null from strings and rejects invalid owner types and malformed JSON', () => {
    user('null-owner', 1, null);
    user('text-null', 2, 'null');
    user('numeric', 3, 1);
    user('boolean', 4, true);
    user('array', 5, ['current']);
    user('object', 6, { value: 'current' });
    user('malformed', 7, 'current');
    db.prepare('UPDATE conversation_messages SET raw_json = ? WHERE id = ?').run('{synthetic malformed', 'malformed');
    expect(latest(null)?.id).toBe('null-owner');
    expect(latest('null')?.id).toBe('text-null');
    expect(latest('current')).toBeNull();
  });

  it('does not confuse string owners with reserved typed owner keys', () => {
    user('absent-text', 1, 'absent');
    user('invalid-text', 2, 'invalid');
    user('prefixed-text', 3, 'text:current');
    expect(latest('current')).toBeNull();
    expect(latest(null)).toBeNull();
    expect(latest('absent')?.id).toBe('absent-text');
    expect(latest('invalid')?.id).toBe('invalid-text');
    expect(latest('text:current')?.id).toBe('prefixed-text');
  });

  it.each([
    ['owner foreign last', '{"metadata":{"instanceId":"current","instanceId":"foreign"}}'],
    ['owner foreign first', '{"metadata":{"instanceId":"foreign","instanceId":"current"}}'],
    ['owner null last', '{"metadata":{"instanceId":"current","instanceId":null}}'],
    ['owner null first', '{"metadata":{"instanceId":null,"instanceId":"current"}}'],
    ['owner same twice', '{"metadata":{"instanceId":"current","instanceId":"current"}}'],
    ['metadata foreign last', '{"metadata":{"instanceId":"current"},"metadata":{"instanceId":"foreign"}}'],
    ['metadata foreign first', '{"metadata":{"instanceId":"foreign"},"metadata":{"instanceId":"current"}}'],
    ['metadata null last', '{"metadata":{"instanceId":"current"},"metadata":null}'],
    ['metadata null first', '{"metadata":null,"metadata":{"instanceId":"current"}}'],
    ['metadata primitive first', '{"metadata":7,"metadata":{"instanceId":"foreign"}}'],
    ['escaped owner last', '{"metadata":{"instanceId":"current","instance\\u0049d":"foreign"}}'],
    ['escaped owner first', '{"metadata":{"instance\\u0049d":"current","instanceId":"foreign"}}'],
    ['escaped metadata last', '{"metadata":{"instanceId":"current"},"metad\\u0061ta":{"instanceId":"foreign"}}'],
    ['escaped metadata first', '{"metad\\u0061ta":{"instanceId":"current"},"metadata":{"instanceId":"foreign"}}'],
  ])('excludes ambiguous %s while retaining the older eligible source', (_name, rawJson) => {
    user('anchor', 1, 'current');
    user('ambiguous', 2, 'current');
    db.prepare('UPDATE conversation_messages SET raw_json = ? WHERE id = ?').run(rawJson, 'ambiguous');
    expect(latest('current')?.id).toBe('anchor');
    db.prepare('DELETE FROM conversation_messages WHERE id = ?').run('anchor');
    expect(latest('current')).toBeNull();
    expect(latest(null)).toBeNull();
  });

  it.each([
    '{"metadata":{"instance\\u0049d":"current"}}',
    '{"metad\\u0061ta":{"instanceId":"current"}}',
    '{"metad\\u0061ta":{"instance\\u0049d":"curr\\u0065nt"}}',
  ])('accepts unambiguous Unicode-escaped ownership %s', rawJson => {
    user('escaped', 1, 'current');
    db.prepare('UPDATE conversation_messages SET raw_json = ? WHERE id = ?').run(rawJson, 'escaped');
    expect(latest('current')?.id).toBe('escaped');
    expect(latest('foreign')).toBeNull();
  });

  it.each(['foreign', null, 1, true, [], {}])(
    'fails closed when decoded SQL candidate ownership disagrees: %s', owner => {
      user('inconsistent', 1, 'current');
      const row = db.prepare('SELECT * FROM conversation_messages WHERE id = ?')
        .get<Record<string, unknown>>('inconsistent')!;
      const returnedRow = { ...row, source_owner_key: 'text:current',
        raw_json: JSON.stringify({ metadata: { instanceId: owner } }) };
      const inconsistentDriver = {
        prepare: () => ({ get: () => returnedRow }),
      } as unknown as SqliteDriver;
      expect(() => getLatestUserMessage(inconsistentDriver, threadId, 'current'))
        .toThrow(/^SOURCE_OWNER_MISMATCH$/);
    },
  );

  it('rejects SQL-absent ownership that decodes as explicit current ownership', () => {
    user('inconsistent', 1, 'current');
    const row = db.prepare('SELECT * FROM conversation_messages WHERE id = ?')
      .get<Record<string, unknown>>('inconsistent')!;
    const inconsistentDriver = {
      prepare: () => ({ get: () => ({ ...row, source_owner_key: 'absent' }) }),
    } as unknown as SqliteDriver;
    expect(() => getLatestUserMessage(inconsistentDriver, threadId, 'current'))
      .toThrow(/^SOURCE_OWNER_MISMATCH$/);
  });

  it('maps corrupt retained message JSON without exposing source content in diagnostics', () => {
    const warning = vi.spyOn(getLogger('ConversationLedgerStore'), 'warn').mockImplementation(() => undefined);
    try {
      user('corrupt', 1, 'current');
      db.prepare('UPDATE conversation_messages SET raw_json = ? WHERE id = ?')
        .run('{synthetic-source-content-sentinel', 'corrupt');
      expect(store.getRecentMessages(threadId, 1)[0]?.rawJson).toEqual({});
      expect(warning).toHaveBeenCalledWith('Corrupt conversation ledger JSON encountered', { code: 'INVALID_JSON' });
      expect(JSON.stringify(warning.mock.calls)).not.toContain('synthetic-source-content-sentinel');
      expect(latest('current')).toBeNull();
    } finally {
      warning.mockRestore();
    }
  });

  it.each([null, '{}', '{"metadata":null}', '{"metadata":7}', '{"metadata":"synthetic"}',
    '{"metadata":[]}', '[]', 'null'])('retains absent legacy ownership for raw JSON %s', rawJson => {
    user('legacy', 1, 'foreign');
    db.prepare('UPDATE conversation_messages SET raw_json = ? WHERE id = ?').run(rawJson, 'legacy');
    expect(latest('current')?.id).toBe('legacy');
  });

  it('does not cross conversation boundaries or return soft-deleted history', () => {
    user('source', 1, 'current');
    const other = store.upsertThread({ provider: 'orchestrator', sourceKind: 'orchestrator' }).id;
    expect(latest('current', other)).toBeNull();
    expect(latest('current', 'missing')).toBeNull();
    db.prepare('UPDATE conversation_threads SET deleted_at = ? WHERE id = ?').run('synthetic-deleted', threadId);
    expect(latest('current')).toBeNull();
  });

  it('uses two owner index seeks and active-thread primary-key lookups without scanning message history', () => {
    user('source', 1, 'current');
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${LATEST_USER_MESSAGE_SQL}`)
      .all<{ detail: string }>(threadId, threadId, 'text:current').map(row => row.detail);
    expect(plan.filter(detail => /SEARCH conversation_messages USING INDEX idx_conversation_messages_user_source_owner/.test(detail)))
      .toHaveLength(2);
    expect(plan.filter(detail => /SEARCH conversation_threads USING INDEX sqlite_autoindex_conversation_threads_1/.test(detail)))
      .toHaveLength(2);
    expect(plan.some(detail => /SCAN conversation_messages/.test(detail))).toBe(false);
  });

  it('migration 6 preserves legacy, malformed and foreign rows and existing ledger relations', () => {
    // Migration 6 adds only this index: removing it and its version row restores
    // the exact v5 schema, on which existing data can then be populated.
    db.exec('DROP INDEX idx_conversation_messages_user_source_owner; DELETE FROM conversation_ledger_migrations WHERE version = 6;');
    user('legacy', 1);
    user('foreign', 2, 'foreign');
    user('malformed', 3, 'current');
    db.prepare('UPDATE conversation_messages SET raw_json = ? WHERE id = ?').run('{synthetic malformed', 'malformed');
    store.writeCheckpoint(threadId, { upToSequence: 1, summary: 'Synthetic summary', summarizedMessageCount: 1, summaryTokens: 2 });
    db.prepare(`INSERT INTO evidence_access_log (id, requester, conversation_id, operation, outcome_code, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run('audit', 'synthetic', threadId, 'list', 'success', 1);
    const snapshot = () => ['conversation_threads', 'conversation_messages', 'conversation_checkpoints', 'evidence_access_log']
      .map(table => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all());
    const before = snapshot();
    runConversationLedgerMigrations(db);
    runConversationLedgerMigrations(db);
    expect(snapshot()).toEqual(before);
    expect(latest('current')?.id).toBe('legacy');
    expect(db.prepare('SELECT version FROM conversation_ledger_migrations WHERE version = 6').all()).toEqual([{ version: 6 }]);
  });

  it('routes service lookups through the in-process port and preserves active ownership checks', async () => {
    user('source', 1, 'current');
    user('foreign', 2, 'foreign');
    const service = new ConversationLedgerService({ store });
    expect(await service.getLatestUserMessage(threadId, 'current')).toMatchObject({ id: 'source' });
    db.prepare('UPDATE conversation_threads SET deleted_at = ? WHERE id = ?').run('synthetic-deleted', threadId);
    expect(await service.getLatestUserMessage(threadId, 'current')).toBeNull();
  });
});
