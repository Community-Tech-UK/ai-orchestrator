import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { DocReviewStore } from './doc-review-store';

describe('DocReviewStore', () => {
  let db: SqliteDriver;

  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
  });

  afterEach(() => db.close());

  it('imports legacy ElectronStore sessions once and preserves their decisions', () => {
    const legacy = {
      get: () => [{
        id: 'dr_legacy', instanceId: 'instance-1', workspacePath: '/repo', title: 'Plan',
        artifactPath: '/repo/.aio-review/plan.html', status: 'approved', decisions: [],
        createdAt: 1, decidedAt: 2,
      }],
    };
    const first = new DocReviewStore(db, legacy);

    expect(first.get('dr_legacy')).toMatchObject({
      status: 'approved', deliveryAttempts: [],
    });

    const second = new DocReviewStore(db, { get: () => [] });
    expect(second.list()).toHaveLength(1);
  });

  it('updates one review without dropping other delivery evidence', () => {
    const store = new DocReviewStore(db, null);
    const base = {
      instanceId: 'instance-1', workspacePath: '/repo', title: 'Plan',
      artifactPath: '/repo/.aio-review/plan.html', status: 'pending' as const,
      decisions: [], createdAt: 1, deliveryAttempts: [],
    };
    store.put({ ...base, id: 'dr_one' });
    store.put({ ...base, id: 'dr_two' });
    store.put({
      ...base, id: 'dr_one', status: 'approved', decidedAt: 2,
      deliveryAttempts: [{ id: 'dra_1', state: 'delivered', mechanism: 'direct-send', at: 2 }],
      delivery: { status: 'delivered', mechanism: 'direct-send', attempts: 1 },
    });

    expect(store.get('dr_one')?.delivery?.status).toBe('delivered');
    expect(store.get('dr_two')?.status).toBe('pending');
  });
});
