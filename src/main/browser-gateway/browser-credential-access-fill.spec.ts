import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserPermissionGrant } from '@contracts/types/browser';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { BrowserApprovalStore } from './browser-approval-store';
import { BrowserCredentialAccessService } from './browser-credential-access-service';
import { CredentialAuthorizationService, InMemoryCredentialAuthorizationStore } from './browser-credential-authorization-store';
import { CredentialVaultError } from './browser-credential-vault';
import { BrowserGatewayService } from './browser-gateway-service';
import { BrowserGatewayResultRecorder } from './browser-gateway-result';
import { makeService } from './browser-gateway-service.test-helpers';
import type { BrowserGatewayFillCredentialRequest } from './browser-gateway-service-types';
import {
  findCredentialAccessSession,
  resetCredentialAccessSessionResolverForTesting,
  resolveCredentialAccessSession,
  setCredentialAccessSessionResolver,
} from './browser-credential-access-session';

// The test browser is makeService's isolated driver; its trusted registry
// boundary mirrors that driver's exact target and computer identity.
const computer = vi.hoisted(() => ({ id: 'test-computer', connected: true }));
vi.mock('./browser-target-registry', async (importOriginal) => ({
  ...await importOriginal<typeof import('./browser-target-registry')>(),
  getBrowserTargetRegistry: () => ({ listTargets: () => [{ id: 'target-1', profileId: 'profile-1', status: 'available' }] }),
}));
vi.mock('./browser-profile-store', async (importOriginal) => ({
  ...await importOriginal<typeof import('./browser-profile-store')>(),
  getBrowserProfileStore: () => ({ getProfile: () => ({ status: 'running', executionNodeId: computer.id }) }),
}));
vi.mock('../remote-node/remote-node-roster-service', async (importOriginal) => ({
  ...await importOriginal<typeof import('../remote-node/remote-node-roster-service')>(),
  getRemoteNodeRosterService: () => ({ get: () => ({ connected: computer.connected, status: computer.connected ? 'connected' : 'disconnected' }) }),
}));

const closers: (() => void)[] = [];
afterEach(() => {
  closers.splice(0).forEach((close) => close());
  resetCredentialAccessSessionResolverForTesting();
  BrowserGatewayService._resetForTesting();
});

function harness() {
  let now = Date.now();
  computer.id = 'test-computer';
  computer.connected = true;
  const origin = 'http://localhost:4567';
  let primary = { instanceId: 'instance-1', taskScope: 'test-task', sessionName: 'Test task' };
  const other = { instanceId: 'instance-2', taskScope: 'other-task', sessionName: 'Other task' };
  setCredentialAccessSessionResolver(
    (id) => id === primary.instanceId ? primary : id === other.instanceId ? other : undefined,
    () => [primary, other],
  );
  const db = defaultDriverFactory(':memory:');
  createTables(db); createMigrationsTable(db); runMigrations(db);
  closers.push(() => db.close());
  const store = new BrowserApprovalStore(db);
  const authorizations = new CredentialAuthorizationService(new InMemoryCredentialAuthorizationStore(), () => now);
  const vault = {
    inspectExistingCredential: vi.fn(async () => ({ vaultItemRef: 'item-placeholder', title: 'Saved test login', folderName: 'AIO-Agent', requiresMoveIntoFolder: true })),
    enrolExistingCredential: vi.fn(async () => ({ vaultItemRef: 'item-placeholder', username: 'TEST_ONLY_USERNAME_PLACEHOLDER', movedIntoFolder: true })),
    getSecretForFill: vi.fn(async () => 'TEST_ONLY_PASSWORD_PLACEHOLDER'),
    createAgentCredential: vi.fn(),
    getGenericSecretForFill: vi.fn(),
  };
  const gateway = makeService({ credentialVault: vault, credentialAuthorizations: authorizations });
  const recorder = new BrowserGatewayResultRecorder(gateway.auditStore);
  const grants: BrowserPermissionGrant[] = [];
  const access = new BrowserCredentialAccessService({
    store, authorizations, vault, now: () => now,
    resolveSession: resolveCredentialAccessSession, findSession: findCredentialAccessSession,
    readTarget: async () => ({ origin, scope: 'profile-1', computerName: 'Test computer', computerId: computer.id }),
    result: (input) => recorder.record(input),
    grants: {
      createGrant: (input) => { const grant = { ...input, id: `grant-${grants.length}`, createdAt: now }; grants.push(grant); return grant; },
      getGrant: (id) => grants.find((grant) => grant.id === id) ?? null,
      revokeGrant: (id) => { const grant = grants.find((item) => item.id === id); if (grant) grant.revokedAt = now; return grant ?? null; },
    },
  });
  const fillRequest: BrowserGatewayFillCredentialRequest = { profileId: 'profile-1', targetId: 'target-1', instanceId: 'instance-1', provider: 'codex', vaultItemRef: 'item-placeholder', fields: [{ selector: '#password', kind: 'password' }] };
  const request = () => access.request({ profileId: 'profile-1', targetId: 'target-1', item: 'Saved test login', reason: 'Sign in for this test task' }, { instanceId: primary.instanceId, provider: 'codex' });
  const approve = async () => {
    const pending = (await request()).data!;
    expect((await access.approve(pending)).decision).toBe('allowed');
    return pending;
  };
  return { access, request, approve, store, authorizations, vault, ...gateway, fillRequest,
    advance: (ms: number) => { now += ms; },
    resume: () => { primary = { ...primary, instanceId: 'resumed-instance' }; },
    changeTask: () => { primary = { ...primary, taskScope: 'changed-task' }; },
  };
}

describe('approved credential access reaches the actual secure fill path', () => {
  it('stays blocked while pending, then fills only after enrolment and approval', async () => {
    const h = harness();
    const pending = (await h.request()).data!;
    expect(pending.status).toBe('pending');
    expect((await h.service.fillCredential(h.fillRequest)).decision).toBe('denied');
    expect(h.vault.getSecretForFill).not.toHaveBeenCalled();
    expect(h.vault.enrolExistingCredential).not.toHaveBeenCalled();
    expect((await h.access.approve(pending)).decision).toBe('allowed');
    expect(h.vault.enrolExistingCredential).toHaveBeenCalledWith({ item: 'item-placeholder', expectedVaultItemRef: 'item-placeholder', origin: 'http://localhost:4567', moveIntoFolder: true });
    const result = await h.service.fillCredential(h.fillRequest);
    expect(result, result.reason).toMatchObject({ decision: 'allowed', outcome: 'succeeded', data: { filled: 1 } });
    expect(h.driver.type).toHaveBeenCalledWith('profile-1', 'target-1', '#password', 'TEST_ONLY_PASSWORD_PLACEHOLDER', 'http://localhost:4567', expect.any(Function));
    expect(JSON.stringify({ result, audits: h.audits })).not.toContain('TEST_ONLY_PASSWORD_PLACEHOLDER');
  });

  it.each(['task', 'item', 'computer', 'origin', 'purpose'] as const)('rejects the approved login for another %s before reading a secret', async (change) => {
    const h = harness(); await h.approve();
    const request = { ...h.fillRequest };
    if (change === 'task') request.instanceId = 'instance-2';
    if (change === 'item') request.vaultItemRef = 'other-item';
    if (change === 'computer') computer.id = 'other-computer';
    if (change === 'origin') h.driver.refreshTarget.mockResolvedValueOnce({ ...await h.driver.refreshTarget(), origin: 'https://other.example.test' });
    if (change === 'purpose') request.fields = [{ selector: '#code', kind: 'totp' }];
    expect((await h.service.fillCredential(request)).decision).toBe('denied');
    expect(h.vault.getSecretForFill).not.toHaveBeenCalled();
    expect(h.driver.type).not.toHaveBeenCalled();
  });

  it('reuses task permission after the same logical session resumes', async () => {
    const h = harness(); await h.approve(); h.resume();
    expect((await h.service.fillCredential({ ...h.fillRequest, instanceId: 'resumed-instance' })).decision).toBe('allowed');
    expect(h.vault.enrolExistingCredential).toHaveBeenCalledOnce();
  });

  it('denial never reaches enrolment or secure fill', async () => {
    const h = harness(); const pending = (await h.request()).data!;
    await h.access.deny(pending);
    expect((await h.service.fillCredential(h.fillRequest)).decision).toBe('denied');
    expect(h.vault.enrolExistingCredential).not.toHaveBeenCalled();
    expect(h.vault.getSecretForFill).not.toHaveBeenCalled();
    expect(h.driver.type).not.toHaveBeenCalled();
  });

  it.each(['revoke', 'expire', 'task', 'computer', 'disconnect'] as const)('does not type a resolved secret if permission changes by %s while the vault is awaiting', async (change) => {
    const h = harness(); await h.approve();
    let started!: () => void;
    let finish!: (secret: string) => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    h.vault.getSecretForFill.mockImplementationOnce(() => { started(); return new Promise<string>((resolve) => { finish = resolve; }); });
    const filling = h.service.fillCredential(h.fillRequest);
    await begun;
    if (change === 'revoke') h.authorizations.revoke(h.authorizations.list()[0].id);
    if (change === 'expire') h.advance(9 * 60 * 60_000);
    if (change === 'task') h.changeTask();
    if (change === 'computer') computer.id = 'other-computer';
    if (change === 'disconnect') computer.connected = false;
    finish('TEST_ONLY_PASSWORD_PLACEHOLDER');
    const result = await filling;
    expect(result).toMatchObject({ decision: 'denied', outcome: 'not_run', reason: 'credential_authorization_changed', data: null });
    expect(h.driver.type).not.toHaveBeenCalled();
    expect(JSON.stringify({ result, audits: h.audits })).not.toContain('TEST_ONLY_PASSWORD_PLACEHOLDER');
  });

  it('reports a locked vault without typing or reporting secure-fill success', async () => {
    const h = harness(); await h.approve();
    h.vault.getSecretForFill.mockRejectedValueOnce(new CredentialVaultError('Vault is locked', 'vault_locked'));
    expect(await h.service.fillCredential(h.fillRequest)).toMatchObject({ decision: 'denied', outcome: 'failed', reason: 'vault_locked', data: null });
    expect(h.driver.type).not.toHaveBeenCalled();
  });
});
