import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserGatewayResult, BrowserListGrantsRequest, BrowserPermissionGrant } from '@contracts/types/browser';
import { PERSISTENT_BROWSER_GRANT_EXPIRES_AT } from '@contracts/types/browser';
import { BrowserListGrantsRequestSchema } from '@contracts/schemas/browser';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { BrowserApprovalStore } from './browser-approval-store';
import { BrowserGrantStore, type BrowserGrantInput } from './browser-grant-store';
import { BrowserGatewayApprovalOperations } from './browser-gateway-approval-operations';
import type { BrowserGatewayResultInput } from './browser-gateway-result';

const input: BrowserGrantInput = {
  mode: 'persistent', instanceId: 'instance-1', provider: 'codex', nodeId: 'windows-pc',
  allowedOrigins: [{ scheme: 'https', hostPattern: 'example.com', includeSubdomains: false }],
  allowedActionClasses: ['credential'], allowExternalNavigation: false, autonomous: true,
  userApprovedCredentials: true, requestedBy: 'operator', decidedBy: 'user', decision: 'allow',
  expiresAt: PERSISTENT_BROWSER_GRANT_EXPIRES_AT,
};

function cursor(grant: BrowserPermissionGrant): NonNullable<BrowserListGrantsRequest['before']> {
  return { createdAt: grant.createdAt, id: grant.id };
}

describe('browser grant keyset pagination', () => {
  let db: SqliteDriver;
  let store: BrowserGrantStore;
  let operations: BrowserGatewayApprovalOperations;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    db = defaultDriverFactory(':memory:');
    createTables(db);
    createMigrationsTable(db);
    runMigrations(db);
    store = new BrowserGrantStore(db);
    operations = new BrowserGatewayApprovalOperations({
      grantStore: store, approvalStore: new BrowserApprovalStore(db),
      profileStore: { getProfile: () => null, setRuntimeState: vi.fn() },
      result: <T>(value: BrowserGatewayResultInput<T>): BrowserGatewayResult<T> => ({ ...value, auditId: 'audit' }) as BrowserGatewayResult<T>,
    });
  });

  afterEach(() => { db.close(); vi.useRealTimers(); });

  it('traverses more than 100 grants with identical timestamps and exposes the oldest forever grant for revocation', async () => {
    const standing = store.createGrant(input);
    vi.setSystemTime(2_000);
    const newer = Array.from({ length: 151 }, () => store.createGrant({ ...input, mode: 'session', userApprovedCredentials: false }));
    const expected = newer.map(({ id }) => id).sort().reverse().concat(standing.id);
    const visited: string[] = [];
    let before: BrowserListGrantsRequest['before'];
    for (let page = 0; page < 10; page++) {
      const response = await operations.listGrants({ limit: 25, before });
      const rows = response.data!;
      expect(rows.length).toBeLessThanOrEqual(25);
      visited.push(...rows.map(({ id }) => id));
      if (rows.length < 25) break;
      before = cursor(rows.at(-1)!);
    }
    expect(visited).toEqual(expected);
    expect(new Set(visited).size).toBe(152);
    expect(await operations.revokeGrant({ grantId: visited.at(-1)! })).toMatchObject({
      decision: 'allowed', data: { id: standing.id, decidedBy: 'revoked' },
    });
  });

  it('continues after the cursor row is deleted and newer rows arrive without skipping original rows', () => {
    const original = Array.from({ length: 60 }, () => store.createGrant(input));
    const expected = original.map(({ id }) => id).sort().reverse();
    const first = store.listGrants({ limit: 25 });
    const before = cursor(first.at(-1)!);
    db.prepare('DELETE FROM browser_permission_grants WHERE id = ?').run(before.id);
    vi.setSystemTime(2_000);
    const inserted = store.createGrant(input);
    const second = store.listGrants({ limit: 25, before });
    const third = store.listGrants({ limit: 25, before: cursor(second.at(-1)!) });
    expect([...first, ...second, ...third].map(({ id }) => id)).toEqual(expected);
    expect(store.listGrants({ limit: 25 })[0].id).toBe(inserted.id);
    expect(store.listGrants({ limit: 25, before: cursor(third.at(-1)!) })).toEqual([]);
  });

  it('filters inactive and wrong-computer grants before paginating', () => {
    const oldest = store.createGrant(input);
    vi.setSystemTime(2_000);
    const revoked = store.createGrant(input);
    const consumed = store.createGrant(input);
    store.revokeGrant(revoked.id);
    store.consumeGrant(consumed.id);
    store.createGrant({ ...input, expiresAt: 2_000 });
    store.createGrant({ ...input, decision: 'deny' });
    store.createGrant({ ...input, nodeId: 'other-worker' });
    const newest = store.createGrant(input);
    const first = store.listGrants({ nodeId: 'windows-pc', limit: 1 });
    expect(first.map(({ id }) => id)).toEqual([newest.id]);
    expect(store.listGrants({ nodeId: 'windows-pc', limit: 1, before: cursor(first[0]) }).map(({ id }) => id)).toEqual([oldest.id]);
  });

  it('does not apply the operator cursor to standing authorization lookup', () => {
    const standing = store.createGrant(input);
    const filter = { instanceId: 'another-instance', nodeId: 'windows-pc', before: { createdAt: 0, id: 'cursor' } };
    expect(store.listGrants(filter)).toEqual([]);
    expect(store.listGrants({ ...filter, authorizationOrigin: 'https://example.com' })).toEqual([standing]);
    expect(store.listGrants({ ...filter, nodeId: 'other-worker', authorizationOrigin: 'https://example.com' })).toEqual([]);
    store.revokeGrant(standing.id);
    expect(store.listGrants({ ...filter, authorizationOrigin: 'https://example.com' })).toEqual([]);
  });

  it('validates the complete cursor while retaining existing list requests', () => {
    expect(BrowserListGrantsRequestSchema.safeParse({ limit: 25 }).success).toBe(true);
    expect(BrowserListGrantsRequestSchema.safeParse({ limit: 25, before: { createdAt: 0, id: 'grant-1' } }).success).toBe(true);
    for (const before of [
      { createdAt: -1, id: 'grant' }, { createdAt: 1.5, id: 'grant' },
      { createdAt: Number.POSITIVE_INFINITY, id: 'grant' }, { createdAt: Number.NaN, id: 'grant' },
      { createdAt: 1, id: '' }, { createdAt: 1, id: 'g'.repeat(201) },
      { createdAt: 1 }, { id: 'grant' }, { createdAt: 1, id: 'grant', unexpected: true },
    ]) expect(BrowserListGrantsRequestSchema.safeParse({ limit: 25, before }).success).toBe(false);
  });
});
