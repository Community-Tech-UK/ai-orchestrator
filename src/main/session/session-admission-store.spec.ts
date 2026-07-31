import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import type { SqliteDriver } from '../db/sqlite-driver';
import {
  SessionAdmissionStore,
  MAX_PENDING_ADMISSIONS_PER_INSTANCE,
  ADMISSION_RETENTION_DAYS,
  STALE_PROMOTION_RECLAIM_MS,
} from './session-admission-store';

function makeDb(): SqliteDriver {
  return new Database(':memory:') as unknown as SqliteDriver;
}

describe('SessionAdmissionStore', () => {
  let db: SqliteDriver;
  let store: SessionAdmissionStore;

  beforeEach(() => {
    db = makeDb();
    store = new SessionAdmissionStore(db);
  });

  it('creates a migration idempotently (constructor can run twice against the same db)', () => {
    expect(() => new SessionAdmissionStore(db)).not.toThrow();
  });

  it('persists a recorded row and reads it back', () => {
    const rec = store.create({
      admissionId: 'adm-1',
      instanceId: 'inst-1',
      origin: 'user',
      message: 'hello',
      state: 'recorded',
    });
    expect(rec.state).toBe('recorded');
    expect(rec.attachmentRefs).toEqual([]);
    expect(rec.sourceMetadata).toBeNull();

    const fetched = store.get('adm-1');
    expect(fetched?.instanceId).toBe('inst-1');
    expect(fetched?.message).toBe('hello');
  });

  it('round-trips attachment refs and source metadata', () => {
    store.create({
      admissionId: 'adm-2',
      instanceId: 'inst-1',
      origin: 'channel',
      message: 'hi',
      attachmentRefs: ['a.png:image/png:10'],
      sourceMetadata: { chatId: 'c1' },
      state: 'suppressed',
      suppressReason: 'awaiting-human',
    });
    const rec = store.get('adm-2');
    expect(rec?.attachmentRefs).toEqual(['a.png:image/png:10']);
    expect(rec?.sourceMetadata).toEqual({ chatId: 'c1' });
    expect(rec?.suppressReason).toBe('awaiting-human');
  });

  it('updateState transitions state, stamps delivered_at only on delivered, and preserves earlier fields via COALESCE', () => {
    store.create({
      admissionId: 'adm-3',
      instanceId: 'inst-1',
      origin: 'reaction',
      message: 'msg',
      state: 'suppressed',
      suppressReason: 'quota-parked',
    });

    const failed = store.updateState('adm-3', 'failed', { errorText: 'boom' });
    expect(failed?.state).toBe('failed');
    expect(failed?.errorText).toBe('boom');
    expect(failed?.deliveredAt).toBeNull();
    // suppressReason from creation must survive an update that doesn't pass one.
    expect(failed?.suppressReason).toBe('quota-parked');

    const delivered = store.updateState('adm-3', 'delivered');
    expect(delivered?.state).toBe('delivered');
    expect(delivered?.deliveredAt).not.toBeNull();
    // errorText from the prior transition must survive.
    expect(delivered?.errorText).toBe('boom');
  });

  it('updateState on an unknown id returns undefined without throwing', () => {
    expect(store.updateState('missing', 'delivered')).toBeUndefined();
  });

  it('list() filters by instanceId and state, newest first', () => {
    store.create({ admissionId: 'a', instanceId: 'i1', origin: 'user', message: 'm1', state: 'recorded' });
    store.create({ admissionId: 'b', instanceId: 'i1', origin: 'user', message: 'm2', state: 'delivered' });
    store.create({ admissionId: 'c', instanceId: 'i2', origin: 'user', message: 'm3', state: 'recorded' });

    const forI1 = store.list({ instanceId: 'i1' });
    expect(forI1.map((r) => r.admissionId).sort()).toEqual(['a', 'b']);

    const delivered = store.list({ instanceId: 'i1', states: ['delivered'] });
    expect(delivered.map((r) => r.admissionId)).toEqual(['b']);
  });

  it('sweepExpired purges terminal rows older than the retention window', () => {
    const old = Date.now() - (ADMISSION_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000;
    store.create({ admissionId: 'stale', instanceId: 'i1', origin: 'user', message: 'm', state: 'delivered' });
    // Force updated_at into the past directly (create() always stamps "now").
    db.prepare('UPDATE prompt_admissions SET updated_at = ? WHERE admission_id = ?').run(old, 'stale');

    store.create({ admissionId: 'fresh', instanceId: 'i1', origin: 'user', message: 'm', state: 'delivered' });

    const result = store.sweepExpired();
    expect(result.purged).toBe(1);
    expect(store.get('stale')).toBeUndefined();
    expect(store.get('fresh')).toBeDefined();
  });

  it('sweepExpired caps per-instance suppressed rows, expiring the oldest excess', () => {
    const base = Date.now() - 1_000_000;
    for (let i = 0; i < MAX_PENDING_ADMISSIONS_PER_INSTANCE + 3; i++) {
      store.create({
        admissionId: `s-${i}`,
        instanceId: 'busy-instance',
        origin: 'reaction',
        message: 'm',
        state: 'suppressed',
        suppressReason: 'awaiting-human',
      });
      // Stagger created_at so ordering is deterministic (create() always uses Date.now()).
      db.prepare('UPDATE prompt_admissions SET created_at = ? WHERE admission_id = ?').run(base + i, `s-${i}`);
    }

    const result = store.sweepExpired();
    expect(result.capped).toBe(3);

    const remainingSuppressed = store.list({ instanceId: 'busy-instance', states: ['suppressed'] });
    expect(remainingSuppressed.length).toBe(MAX_PENDING_ADMISSIONS_PER_INSTANCE);
    // The three oldest (s-0, s-1, s-2) must be the ones expired.
    expect(store.get('s-0')?.state).toBe('expired');
    expect(store.get('s-1')?.state).toBe('expired');
    expect(store.get('s-2')?.state).toBe('expired');
    expect(store.get(`s-${MAX_PENDING_ADMISSIONS_PER_INSTANCE + 2}`)?.state).toBe('suppressed');
  });

  describe('Phase B: durable send-queue rows', () => {
    it('applies the queue_position/attachment_files_json migration idempotently against an existing Phase A table', () => {
      // Simulate a pre-Phase-B table (no new columns) and confirm the store
      // still constructs cleanly and ALTERs the columns in.
      const legacyDb = new Database(':memory:') as unknown as SqliteDriver;
      legacyDb.exec(`
        CREATE TABLE prompt_admissions (
          admission_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL, origin TEXT NOT NULL,
          message TEXT NOT NULL, attachment_refs_json TEXT NOT NULL DEFAULT '[]',
          context_block TEXT, source_metadata_json TEXT, state TEXT NOT NULL,
          suppress_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
          delivered_at INTEGER, error_text TEXT
        );
      `);
      expect(() => new SessionAdmissionStore(legacyDb)).not.toThrow();
      const migrated = new SessionAdmissionStore(legacyDb);
      const rec = migrated.createQueued({ admissionId: 'q-mig', instanceId: 'i1', message: 'hi' });
      expect(rec.queuePosition).toBe(0);
      expect(rec.attachmentFiles).toEqual([]);
    });

    it('createQueued assigns ascending queue_position per instance and defaults origin to user/state to queued', () => {
      const a = store.createQueued({ admissionId: 'q1', instanceId: 'i1', message: 'first' });
      const b = store.createQueued({ admissionId: 'q2', instanceId: 'i1', message: 'second' });
      const other = store.createQueued({ admissionId: 'q3', instanceId: 'i2', message: 'other-instance' });

      expect(a.state).toBe('queued');
      expect(a.origin).toBe('user');
      expect(a.queuePosition).toBe(0);
      expect(b.queuePosition).toBe(1);
      expect(other.queuePosition).toBe(0);
    });

    it('round-trips attachmentFiles refs', () => {
      const rec = store.createQueued({
        admissionId: 'q-att',
        instanceId: 'i1',
        message: 'with file',
        attachmentFiles: [{ name: 'a.png', type: 'image/png', size: 10, contentRef: { inline: true, content: 'xx' } }],
      });
      expect(rec.attachmentFiles).toEqual([
        { name: 'a.png', type: 'image/png', size: 10, contentRef: { inline: true, content: 'xx' } },
      ]);
      expect(store.get('q-att')?.attachmentFiles).toEqual(rec.attachmentFiles);
    });

    it('updateQueuedContent edits message/context/attachments only while queued (CAS)', () => {
      store.createQueued({ admissionId: 'q-upd', instanceId: 'i1', message: 'orig' });
      const updated = store.updateQueuedContent('q-upd', { message: 'edited', contextBlock: 'ctx' });
      expect(updated?.message).toBe('edited');
      expect(updated?.contextBlock).toBe('ctx');

      // Promote it, then an update must be rejected (still queued-only edit).
      store.promoteQueued('q-upd');
      const rejected = store.updateQueuedContent('q-upd', { message: 'too-late' });
      expect(rejected).toBeUndefined();
      expect(store.get('q-upd')?.message).toBe('edited');
    });

    it('updateQueuedContent can clear contextBlock to null explicitly', () => {
      store.createQueued({ admissionId: 'q-ctx', instanceId: 'i1', message: 'm', contextBlock: 'has-ctx' });
      const updated = store.updateQueuedContent('q-ctx', { contextBlock: null });
      expect(updated?.contextBlock).toBeNull();
    });

    it('cancelQueued transitions queued or promoting to cancelled, and is a no-op once terminal', () => {
      store.createQueued({ admissionId: 'q-c1', instanceId: 'i1', message: 'm1' });
      expect(store.cancelQueued('q-c1')?.state).toBe('cancelled');
      expect(store.cancelQueued('q-c1')).toBeUndefined();

      store.createQueued({ admissionId: 'q-c2', instanceId: 'i1', message: 'm2' });
      store.promoteQueued('q-c2');
      expect(store.cancelQueued('q-c2')?.state).toBe('cancelled');
    });

    it('promoteQueued is a compare-and-swap: queued -> promoting once, second call is a no-op', () => {
      store.createQueued({ admissionId: 'q-p1', instanceId: 'i1', message: 'm' });
      const first = store.promoteQueued('q-p1');
      expect(first?.state).toBe('promoting');
      const second = store.promoteQueued('q-p1');
      expect(second).toBeUndefined();
      expect(store.get('q-p1')?.state).toBe('promoting');
    });

    it('promoteQueued on an unknown or already-terminal id returns undefined', () => {
      expect(store.promoteQueued('missing')).toBeUndefined();
      store.createQueued({ admissionId: 'q-term', instanceId: 'i1', message: 'm' });
      store.cancelQueued('q-term');
      expect(store.promoteQueued('q-term')).toBeUndefined();
    });

    it('listQueued returns queued+promoting rows for an instance ordered by queue_position, excludes other instances/states', () => {
      store.createQueued({ admissionId: 'q-l1', instanceId: 'i1', message: 'm1' });
      store.createQueued({ admissionId: 'q-l2', instanceId: 'i1', message: 'm2' });
      store.createQueued({ admissionId: 'q-l3', instanceId: 'i1', message: 'm3' });
      store.promoteQueued('q-l2');
      store.cancelQueued('q-l3');
      store.createQueued({ admissionId: 'q-other', instanceId: 'i2', message: 'other' });

      const list = store.listQueued('i1');
      expect(list.map((r) => r.admissionId)).toEqual(['q-l1', 'q-l2']);
    });

    it('listQueued with no instanceId returns rows across all instances', () => {
      store.createQueued({ admissionId: 'q-all-1', instanceId: 'i1', message: 'm' });
      store.createQueued({ admissionId: 'q-all-2', instanceId: 'i2', message: 'm' });
      const list = store.listQueued();
      expect(list.map((r) => r.admissionId).sort()).toEqual(['q-all-1', 'q-all-2']);
    });

    it('reorderQueued reassigns queue_position to match orderedIds and ignores non-queued ids', () => {
      store.createQueued({ admissionId: 'q-r1', instanceId: 'i1', message: 'm1' });
      store.createQueued({ admissionId: 'q-r2', instanceId: 'i1', message: 'm2' });
      store.createQueued({ admissionId: 'q-r3', instanceId: 'i1', message: 'm3' });
      store.promoteQueued('q-r3'); // no longer 'queued' — reorder must ignore it

      store.reorderQueued('i1', ['q-r2', 'q-r1', 'q-r3']);

      const list = store.listQueued('i1');
      expect(list.map((r) => r.admissionId)).toEqual(['q-r2', 'q-r1', 'q-r3']);
    });

    it('findRecentPromoting matches instance+message within the window and ignores stale/other-instance/other-message rows', () => {
      store.createQueued({ admissionId: 'q-fp', instanceId: 'i1', message: 'hello there' });
      store.promoteQueued('q-fp');

      expect(store.findRecentPromoting('i1', 'hello there', 30_000)).toMatchObject({ admissionId: 'q-fp' });
      expect(store.findRecentPromoting('i1', 'different message', 30_000)).toBeUndefined();
      expect(store.findRecentPromoting('i2', 'hello there', 30_000)).toBeUndefined();

      // Force updated_at into the past to simulate an expired window.
      db.prepare('UPDATE prompt_admissions SET updated_at = ? WHERE admission_id = ?').run(Date.now() - 60_000, 'q-fp');
      expect(store.findRecentPromoting('i1', 'hello there', 30_000)).toBeUndefined();
    });

    it('sweepExpired caps per-instance queued rows, expiring the oldest excess to cancelled', () => {
      const base = Date.now() - 1_000_000;
      for (let i = 0; i < MAX_PENDING_ADMISSIONS_PER_INSTANCE + 2; i++) {
        store.createQueued({ admissionId: `qq-${i}`, instanceId: 'busy-queue-instance', message: 'm' });
        db.prepare('UPDATE prompt_admissions SET created_at = ? WHERE admission_id = ?').run(base + i, `qq-${i}`);
      }

      const result = store.sweepExpired();
      expect(result.capped).toBeGreaterThanOrEqual(2);
      expect(store.get('qq-0')?.state).toBe('cancelled');
      expect(store.get('qq-1')?.state).toBe('cancelled');
      expect(store.get(`qq-${MAX_PENDING_ADMISSIONS_PER_INSTANCE + 1}`)?.state).toBe('queued');
    });

    it('sweepExpired reclaims a promoting row older than STALE_PROMOTION_RECLAIM_MS back to queued', () => {
      store.createQueued({ admissionId: 'q-stale', instanceId: 'i1', message: 'm' });
      store.promoteQueued('q-stale');
      db.prepare('UPDATE prompt_admissions SET updated_at = ? WHERE admission_id = ?')
        .run(Date.now() - STALE_PROMOTION_RECLAIM_MS - 1000, 'q-stale');

      const result = store.sweepExpired();
      expect(result.reclaimed).toBe(1);
      expect(store.get('q-stale')?.state).toBe('queued');
    });

    it('sweepExpired does NOT reclaim a fresh promoting row', () => {
      store.createQueued({ admissionId: 'q-fresh', instanceId: 'i1', message: 'm' });
      store.promoteQueued('q-fresh');
      const result = store.sweepExpired();
      expect(result.reclaimed).toBe(0);
      expect(store.get('q-fresh')?.state).toBe('promoting');
    });
  });
});
