import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserPermissionGrant } from '@contracts/types/browser';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { BrowserApprovalStore } from './browser-approval-store';
import { CredentialAuthorizationService, InMemoryCredentialAuthorizationStore } from './browser-credential-authorization-store';
import { CredentialVaultError } from './browser-credential-vault';
import { BrowserCredentialAccessService } from './browser-credential-access-service';

const closers: (() => void)[] = [];
afterEach(() => { closers.splice(0).forEach((close) => close()); });

function harness() {
  let now = Date.now();
  let target = { origin: 'https://login.example.test', scope: 'node-placeholder', computerName: 'Windows test computer' };
  let session = { instanceId: 'instance-placeholder', taskScope: 'conversation:placeholder', sessionName: 'Test task' };
  const db = defaultDriverFactory(':memory:');
  createTables(db); createMigrationsTable(db); runMigrations(db); closers.push(() => db.close());
  const store = new BrowserApprovalStore(db);
  const auth = new CredentialAuthorizationService(new InMemoryCredentialAuthorizationStore(), () => now);
  const grants: BrowserPermissionGrant[] = [];
  const createGrant = vi.fn((input: Omit<BrowserPermissionGrant, 'id' | 'createdAt' | 'revokedAt' | 'consumedAt'>) => {
    const grant = { ...input, id: `grant-${grants.length}`, createdAt: now }; grants.push(grant); return grant;
  });
  const inspect = vi.fn(async () => ({ vaultItemRef: 'vault-placeholder', title: 'Saved test login', folderName: 'AIO-Agent', requiresMoveIntoFolder: true }));
  const enrol = vi.fn(async () => ({ vaultItemRef: 'vault-placeholder', username: 'NON_SECRET_USERNAME_PLACEHOLDER', movedIntoFolder: true }));
  const service = new BrowserCredentialAccessService({
    store, authorizations: auth,
    vault: { inspectExistingCredential: inspect, enrolExistingCredential: enrol },
    grants: {
      createGrant,
      getGrant: (id) => grants.find((grant) => grant.id === id) ?? null,
      revokeGrant: () => null,
    },
    resolveSession: (id) => id === session.instanceId ? session : undefined,
    findSession: (scope) => scope === session.taskScope ? session : undefined,
    readTarget: async () => target,
    now: () => now,
    result: (input) => ({ ...input, auditId: 'audit-placeholder' }) as never,
  });
  const input = { profileId: 'profile-placeholder', targetId: 'target-placeholder', item: 'Saved test login', reason: 'Sign in for this task' };
  const context = () => ({ instanceId: session.instanceId, provider: 'codex' });
  return { service, store, auth, inspect, enrol, input, grants, createGrant, context,
    setTarget: (next: typeof target) => { target = next; },
    resume: () => { session = { ...session, instanceId: 'resumed-placeholder' }; },
    advance: (ms: number) => { now += ms; },
  };
}

describe('saved login access workflow', () => {
  it('creates one visible pending reference and changes no credential permissions', async () => {
    const h = harness();
    const [first, second] = await Promise.all([h.service.request(h.input, h.context()), h.service.request(h.input, h.context())]);
    expect(first).toMatchObject({ decision: 'requires_user', requestId: expect.any(String), data: { status: 'pending', credentialAccess: { itemTitle: 'Saved test login', moveIntoFolder: true, permission: 'task' } } });
    expect(second.data?.requestId).toBe(first.data?.requestId);
    expect(h.store.listRequests({ status: 'pending' })).toHaveLength(1);
    expect(h.enrol).not.toHaveBeenCalled(); expect(h.auth.list()).toHaveLength(0);
  });

  it('approves once and grants only the approved task, item, site, computer and purpose', async () => {
    const h = harness(); const pending = (await h.service.request(h.input, h.context())).data!;
    const [a, b] = await Promise.all([h.service.approve(pending, { permission: 'task' }), h.service.approve(pending, { permission: 'task' })]);
    expect(a).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    expect(b).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    expect(h.enrol).toHaveBeenCalledOnce(); expect(h.auth.list()).toHaveLength(1); expect(h.grants).toHaveLength(1);
    expect(h.grants[0].userApprovedCredentials).toBe(false);
    const check = { profileId: 'node-placeholder', origin: 'https://login.example.test', purpose: 'login' as const, taskScope: 'conversation:placeholder', vaultItemRef: 'vault-placeholder', computerId: 'node-placeholder' };
    expect(h.auth.check(check).authorized).toBe(true);
    for (const change of [{ profileId: 'other-node' }, { computerId: 'other-node' }, { origin: 'https://other.example.test' }, { taskScope: 'other-task' }, { vaultItemRef: 'other-item' }, { purpose: 'totp' as const }]) expect(h.auth.check({ ...check, ...change }).authorized).toBe(false);
    expect(JSON.stringify(a)).not.toContain('NON_SECRET_USERNAME_PLACEHOLDER');
  });

  it('denies and cancels without enrolment or authorisation', async () => {
    const h = harness(); const p = (await h.service.request(h.input, h.context())).data!;
    expect((await h.service.deny(p)).data?.status).toBe('denied');
    expect((await h.service.approve(p)).decision).toBe('denied');
    expect((await h.service.cancel(p.requestId, h.context())).data?.status).toBe('denied');
    expect(h.enrol).not.toHaveBeenCalled(); expect(h.auth.list()).toHaveLength(0);
  });

  it.each(['origin', 'scope'] as const)('refuses a changed %s while approval is pending', async (key) => {
    const h = harness(); const p = (await h.service.request(h.input, h.context())).data!;
    h.setTarget({ origin: 'https://login.example.test', scope: 'node-placeholder', computerName: 'Windows test computer', [key]: key === 'origin' ? 'https://other.example.test' : 'other-node' });
    const result = await h.service.approve(p);
    expect(result.decision).toBe('denied'); expect(h.enrol).not.toHaveBeenCalled(); expect(h.auth.list()).toHaveLength(0);
    expect(h.store.getRequest(p.requestId)?.status).toBe('pending');
  });

  it('retains a locked-vault failure visibly without claiming approval', async () => {
    const h = harness(); const p = (await h.service.request(h.input, h.context())).data!;
    h.inspect.mockRejectedValueOnce(new CredentialVaultError('locked', 'vault_locked'));
    expect(await h.service.approve(p)).toMatchObject({ decision: 'denied', reason: 'vault_locked' });
    expect(h.store.getRequest(p.requestId)).toMatchObject({ status: 'pending', credentialAccess: { operationError: 'vault_locked' } });
    expect(h.auth.list()).toHaveLength(0);
  });

  it('expires pending requests and approved permissions truthfully', async () => {
    const h = harness(); const p = (await h.service.request(h.input, h.context())).data!;
    h.advance(31 * 60_000);
    expect((await h.service.status(p.requestId, h.context())).data?.status).toBe('expired');
    expect((await h.service.approve(p)).decision).toBe('denied');
    const next = (await h.service.request(h.input, h.context())).data!;
    await h.service.approve(next);
    h.advance(9 * 60 * 60_000);
    expect((await h.service.status(next.requestId, h.context())).data?.status).toBe('expired');
  });

  it('survives resumption without prompting twice or letting another task read the request', async () => {
    const h = harness(); const p = (await h.service.request(h.input, h.context())).data!;
    h.resume();
    expect((await h.service.status(p.requestId, h.context())).data?.requestId).toBe(p.requestId);
    const retry = (await h.service.request(h.input, h.context())).data!;
    expect(retry.requestId).toBe(p.requestId);
    expect((await h.service.approve(retry)).data?.instanceId).toBe('resumed-placeholder');
    expect((await h.service.status(p.requestId, { instanceId: 'other-session' })).decision).toBe('denied');
  });

  it('remembers only an explicit limited period and respects revocation', async () => {
    const h = harness(); const p = (await h.service.request(h.input, h.context())).data!;
    await h.service.approve(p, { permission: 'remember', rememberForMs: 86_400_000 });
    const auth = h.auth.list()[0]; expect(auth.taskScope).toBeUndefined(); expect(auth.vaultItemRef).toBe('vault-placeholder');
    h.auth.revoke(auth.id);
    expect((await h.service.status(p.requestId, h.context())).data?.status).toBe('expired');
  });

  it('does not authorise after cancellation while enrolment is waiting', async () => {
    const h = harness(); const p = (await h.service.request(h.input, h.context())).data!;
    let finish!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    h.enrol.mockImplementationOnce(async () => {
      started(); await new Promise<void>((resolve) => { finish = resolve; });
      return { vaultItemRef: 'vault-placeholder', username: 'NON_SECRET_USERNAME_PLACEHOLDER', movedIntoFolder: true };
    });
    const approving = h.service.approve(p);
    await begun; await h.service.cancel(p.requestId, h.context()); finish();
    expect((await approving).decision).toBe('denied');
    expect(h.auth.list()).toHaveLength(0); expect(h.grants).toHaveLength(0);
    expect((await h.service.status(p.requestId, h.context())).data?.status).toBe('denied');
  });

  it('finds the original pending request beyond the UI page limit', async () => {
    const h = harness(); const p = (await h.service.request(h.input, h.context())).data!;
    for (let i = 0; i < 105; i++) h.store.createRequest({ ...p, instanceId: 'unrelated-placeholder', credentialAccess: { ...p.credentialAccess!, taskScope: `unrelated-${i}` } });
    expect((await h.service.request(h.input, h.context())).data?.requestId).toBe(p.requestId);
  });

  it('does not prompt again immediately after a denial', async () => {
    const h = harness(); const p = (await h.service.request(h.input, h.context())).data!;
    await h.service.deny(p);
    expect(await h.service.request(h.input, h.context())).toMatchObject({ decision: 'denied', data: { requestId: p.requestId, status: 'denied' } });
    expect(h.store.listRequests({})).toHaveLength(1);
  });

  it('bounds a changed retry choice after enrolment fails', async () => {
    const h = harness(); const p = (await h.service.request(h.input, h.context())).data!;
    h.enrol.mockRejectedValueOnce(new CredentialVaultError('locked', 'vault_locked'));
    expect((await h.service.approve(p, { permission: 'remember', rememberForMs: 7 * 86_400_000 })).decision).toBe('denied');
    const before = Date.now();
    expect((await h.service.approve(p, { permission: 'task' })).decision).toBe('allowed');
    expect(h.auth.list()[0].taskScope).toBe('conversation:placeholder');
    expect(h.auth.list()[0].expiresAt).toBeLessThanOrEqual(before + 8 * 60 * 60_000);
  });

  it('expires a rolled-back request so a fresh explicit approval can recover', async () => {
    const h = harness(); const p = (await h.service.request(h.input, h.context())).data!;
    h.createGrant.mockImplementationOnce(() => { throw new Error('grant_write_failed'); });
    expect((await h.service.approve(p)).decision).toBe('denied');
    expect((await h.service.status(p.requestId, h.context())).data?.status).toBe('expired');
    expect(h.auth.list()).toHaveLength(0);
    const next = (await h.service.request(h.input, h.context())).data!;
    expect(next.requestId).not.toBe(p.requestId);
    expect((await h.service.approve(next)).decision).toBe('allowed');
    expect(h.createGrant).toHaveBeenCalledTimes(2);
  });
});
