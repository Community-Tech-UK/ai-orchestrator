import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserApprovalRequest } from '@contracts/types/browser';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { BrowserApprovalStore } from './browser-approval-store';
import { BrowserAuditStore } from './browser-audit-store';
import { BrowserCredentialAccessService } from './browser-credential-access-service';
import { CredentialAuthorizationService } from './browser-credential-authorization-store';
import { BrowserGatewayResultRecorder } from './browser-gateway-result';
import { BrowserGrantStore } from './browser-grant-store';
import { SqliteCredentialAuthorizationStore } from './browser-unattended-sqlite-stores';

const databases: SqliteDriver[] = [];
afterEach(() => { databases.splice(0).forEach((database) => database.close()); });

function harness() {
  const db = defaultDriverFactory(':memory:');
  databases.push(db);
  createTables(db); createMigrationsTable(db); runMigrations(db);
  const approvals = new BrowserApprovalStore(db);
  const grants = new BrowserGrantStore(db);
  const authorizations = new CredentialAuthorizationService(new SqliteCredentialAuthorizationStore(db));
  const recorder = new BrowserGatewayResultRecorder(new BrowserAuditStore(db));
  const session = { instanceId: 'test-instance', taskScope: 'test-task', sessionName: 'Test task' };
  const origin = 'https://login.example.test';
  let enrolled = false;
  const enrol = vi.fn(async () => {
    enrolled = true;
    return { vaultItemRef: 'test-item', username: 'TEST_ONLY_USERNAME_PLACEHOLDER', movedIntoFolder: true };
  });
  const notifications: { status: BrowserApprovalRequest['status']; storedStatus: BrowserApprovalRequest['status']; authorizations: number; grants: number }[] = [];
  const service = new BrowserCredentialAccessService({
    store: approvals, grants, authorizations, now: Date.now,
    result: (input) => recorder.record(input),
    resolveSession: (id) => id === session.instanceId ? session : undefined,
    findSession: (scope) => scope === session.taskScope ? session : undefined,
    readTarget: async () => ({ origin, scope: 'test-computer', computerId: 'test-computer', computerName: 'Test computer' }),
    vault: {
      inspectExistingCredential: async () => ({ vaultItemRef: 'test-item', title: 'Saved test login', folderName: 'AIO-Agent', requiresMoveIntoFolder: !enrolled, ...(enrolled ? { existingBinding: { origin, createdAt: 1 } } : {}) }),
      enrolExistingCredential: enrol,
    },
    notify: (request) => {
      notifications.push({ status: request.status, storedStatus: approvals.getRequest(request.requestId)!.status, authorizations: authorizations.list().length, grants: grants.listGrants({}).length });
    },
  });
  const context = { instanceId: session.instanceId, provider: 'codex' };
  const request = () => service.request({ profileId: 'test-profile', targetId: 'test-target', item: 'Saved test login', reason: 'Sign in for this test task' }, context);
  const permission = { profileId: 'test-computer', origin, computerId: 'test-computer', taskScope: session.taskScope, vaultItemRef: 'test-item', purpose: 'login' as const };
  return { db, approvals, grants, authorizations, service, context, request, permission, enrol, notifications };
}

describe('credential decisions remain safe when database writes fail', () => {
  it('commits one usable approval and notifies only after all durable records exist', async () => {
    const h = harness();
    const pending = (await h.request()).data!;
    const [first, duplicate] = await Promise.all([h.service.approve(pending), h.service.approve(pending)]);
    expect(first).toMatchObject({ decision: 'allowed', outcome: 'succeeded', reason: 'approved' });
    expect(duplicate.data?.id).toBe(first.data?.id);
    expect(h.enrol).toHaveBeenCalledOnce();
    const stored = new BrowserApprovalStore(h.db).getRequest(pending.requestId)!;
    const restoredAuth = new CredentialAuthorizationService(new SqliteCredentialAuthorizationStore(h.db));
    const restoredGrants = new BrowserGrantStore(h.db);
    expect(stored).toMatchObject({ status: 'approved', grantId: first.data!.id });
    expect(restoredAuth.check(h.permission)).toMatchObject({ authorized: true, authorizationId: stored.credentialAccess!.authorizationId });
    expect(restoredGrants.getGrant(stored.grantId!)).toMatchObject({ id: first.data!.id, decision: 'allow', nodeId: 'test-computer' });
    expect(restoredAuth.list()).toHaveLength(1);
    expect(restoredGrants.listGrants({})).toHaveLength(1);
    expect(h.notifications).toEqual([{ status: 'approved', storedStatus: 'approved', authorizations: 1, grants: 1 }]);
  });

  it.each(['grant', 'terminal approval'] as const)('rolls back a failed %s write and requires a new explicit approval', async (failure) => {
    const h = harness();
    const pending = (await h.request()).data!;
    // Real SQLite faults exercise the production stores and transaction, not
    // mock return values. The terminal fault happens after both inserts ran.
    h.db.exec(failure === 'grant'
      ? `CREATE TRIGGER test_decision_failure BEFORE INSERT ON browser_permission_grants
          BEGIN SELECT RAISE(ABORT, 'TEST_ONLY_DATABASE_FAULT'); END`
      : `CREATE TRIGGER test_decision_failure BEFORE UPDATE OF status ON browser_approval_requests
          WHEN NEW.status = 'approved'
          BEGIN SELECT RAISE(ABORT, 'TEST_ONLY_DATABASE_FAULT'); END`);
    const failed = await h.service.approve(pending);
    expect(failed).toMatchObject({ decision: 'denied', outcome: 'not_run', data: null });
    expect(JSON.stringify(failed)).not.toContain('TEST_ONLY_DATABASE_FAULT');
    // A newly constructed reader must also see zero rows, rather than merely
    // revoked leftovers that could accidentally be reused after reconnect.
    expect(h.db.prepare('SELECT count(*) AS count FROM browser_credential_authorizations').get()).toEqual({ count: 0 });
    expect(h.db.prepare('SELECT count(*) AS count FROM browser_permission_grants').get()).toEqual({ count: 0 });
    const restoredAuth = new CredentialAuthorizationService(new SqliteCredentialAuthorizationStore(h.db));
    expect(restoredAuth.check(h.permission).authorized).toBe(false);
    expect(new BrowserApprovalStore(h.db).getRequest(pending.requestId)).toMatchObject({ status: 'expired', grantId: undefined });
    expect((await h.service.status(pending.requestId, h.context)).data?.status).toBe('expired');
    expect(h.notifications).toEqual([{ status: 'expired', storedStatus: 'expired', authorizations: 0, grants: 0 }]);

    h.db.exec('DROP TRIGGER test_decision_failure');
    expect((await h.service.approve(pending)).decision).toBe('denied');
    const retry = await h.request();
    expect(retry).toMatchObject({ decision: 'requires_user', data: { status: 'pending' } });
    expect(retry.data!.requestId).not.toBe(pending.requestId);
    expect(restoredAuth.check(h.permission).authorized).toBe(false);
    expect(h.grants.listGrants({})).toHaveLength(0);
    // Successful enrolment before the fault alone cannot confer permission.
    expect(h.enrol).toHaveBeenCalledOnce();
    expect((await h.service.approve(retry.data!)).decision).toBe('allowed');
    expect(restoredAuth.check(h.permission).authorized).toBe(true);
    expect(h.grants.listGrants({})).toHaveLength(1);
    expect(h.notifications.at(-1)).toEqual({ status: 'approved', storedStatus: 'approved', authorizations: 1, grants: 1 });
  });
});
