import { afterEach, describe, expect, it } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { SessionAdmissionStore } from './session-admission-store';

describe('queued messages after session revival', () => {
  const db = defaultDriverFactory(':memory:');
  afterEach(() => db.close());
  it('moves only unsent rows to the new runtime and retains content, attachments and order', () => {
    const store = new SessionAdmissionStore(db);
    store.createQueued({ admissionId: 'old-first', instanceId: 'old', message: 'First', attachmentFiles: [] });
    store.createQueued({ admissionId: 'old-second', instanceId: 'old', message: 'Second', contextBlock: 'Keep context' });
    store.create({ admissionId: 'delivered', instanceId: 'old', origin: 'user', message: 'Already sent', state: 'delivered' });
    store.reassignQueued('old', 'revived');
    expect(store.listQueued('old')).toEqual([]);
    expect(store.listQueued('revived').map((row) => [row.admissionId, row.message, row.contextBlock]))
      .toEqual([['old-first', 'First', null], ['old-second', 'Second', 'Keep context']]);
    expect(store.get('delivered')?.instanceId).toBe('old');
    store.reassignQueued('old', 'revived');
    expect(store.listQueued('revived')).toHaveLength(2);
  });
});
