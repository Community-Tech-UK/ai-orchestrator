import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserGatewayResult, BrowserGrantMode, BrowserProfile } from '@contracts/types/browser';
import { PERSISTENT_BROWSER_GRANT_EXPIRES_AT } from '@contracts/types/browser';
import { BrowserApproveRequestPayloadSchema, BrowserPermissionGrantSchema, BrowserRequestGrantRequestSchema } from '@contracts/schemas/browser';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { BrowserApprovalStore } from './browser-approval-store';
import { BrowserGrantStore } from './browser-grant-store';
import { BrowserGatewayApprovalOperations } from './browser-gateway-approval-operations';
import { BrowserGatewayActionGuard, type BrowserGatewayActionGuardOptions, type BrowserGatewayPreparedMutation } from './browser-gateway-action-guard';
import { autoApproveBrowserApproval } from './browser-auto-approve';
import { findMatchingBrowserGrant } from './browser-grant-policy';
import { BrowserGrantRequestOperations } from './browser-grant-request-operations';
import { BrowserExistingTabOperations } from './browser-existing-tab-operations';
import type { BrowserGatewayResultInput } from './browser-gateway-result';

const dbs: SqliteDriver[] = [];
const origin = { scheme: 'https' as const, hostPattern: 'entra.microsoft.com', includeSubdomains: false };
const hint = 'Open token configuration to add the optional amr claim.';

function fixture(managed = false) {
  const db = defaultDriverFactory(':memory:');
  dbs.push(db);
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
  const approvalStore = new BrowserApprovalStore(db);
  const grantStore = new BrowserGrantStore(db);
  const profile: BrowserProfile = { id: 'managed-profile', label: 'Test', mode: 'session', browser: 'chrome',
    executionNodeId: 'windows-pc', allowedOrigins: [origin], status: 'running', createdAt: 1, updatedAt: 1 };
  const tab = { profileId: managed ? profile.id : 'existing-tab:n.windows-pc:tab-1', targetId: 'tab-1',
    nodeId: 'windows-pc', tabId: 1, windowId: 1, url: 'https://entra.microsoft.com/configuration',
    origin: 'https://entra.microsoft.com', allowedOrigins: [origin], attachedAt: 1, updatedAt: 1 };
  const target = { id: tab.targetId, profileId: profile.id, pageId: 'page-1', mode: 'session' as const,
    driver: 'cdp' as const, status: 'selected' as const, lastSeenAt: 1, url: tab.url, origin: tab.origin };
  const result = <T>(value: BrowserGatewayResultInput<T>): BrowserGatewayResult<T> => ({ ...value, auditId: 'test-audit' }) as BrowserGatewayResult<T>;
  const profileStore = { getProfile: () => managed ? profile : null, setRuntimeState: vi.fn() };
  const options: BrowserGatewayActionGuardOptions = {
    approvalStore, grantStore, result, profileStore,
    targetRegistry: { listTargets: () => [target] },
    driver: { refreshTarget: async () => target, inspectElement: async () => ({ role: 'button', accessibleName: hint }) },
    extensionTabStore: { getTab: () => managed ? null : tab },
  };
  const guard = new BrowserGatewayActionGuard(options);
  const operations = new BrowserGatewayApprovalOperations({ approvalStore, grantStore, result, profileStore });
  const context = { profileId: tab.profileId, targetId: tab.targetId, instanceId: 'instance-1', provider: 'codex' };
  const prepare = (overrides: Partial<typeof context> & { requestId?: string } = {}) => guard.prepareMutatingAction(
    { ...context, ...overrides }, 'click', 'browser.click', 'uid:3219', hint,
  );
  const approve = async (mode: BrowserGrantMode) => {
    const pending = await prepare();
    const pendingResult = pending.result;
    if (!pendingResult || pendingResult.decision !== 'requires_user') throw new Error('Expected pending approval');
    const approval = approvalStore.getRequest(pendingResult.requestId)!;
    const approved = await operations.approveRequest({ requestId: approval.requestId,
      grant: { ...approval.proposedGrant, mode, autonomous: mode === 'autonomous' || mode === 'persistent' } });
    if (!approved.data) throw new Error('Expected approved grant');
    return { grant: approved.data, approval };
  };
  return { db, approvalStore, grantStore, guard, operations, context, prepare, approve, tab, profile, options };
}

afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

describe('explicit reusable browser approvals', () => {
  it.each(['session', 'autonomous', 'persistent'] as const)('honours %s credential consent and does not consume the requestId retry', async (mode) => {
    const f = fixture();
    const { grant, approval } = await f.approve(mode);
    expect(grant).toMatchObject({ mode, userApprovedCredentials: true });
    const retry = await f.prepare({ requestId: approval.requestId });
    expect(retry).toMatchObject({ grant: { id: grant.id } });
    expect((retry as BrowserGatewayPreparedMutation).exactApprovalRequestId).toBeUndefined();
    f.guard.recordMutationSucceeded(retry as BrowserGatewayPreparedMutation);
    expect(await f.prepare()).toMatchObject({ grant: { id: grant.id } });
    expect(f.grantStore.getGrant(grant.id)?.consumedAt).toBeUndefined();
  });

  it('keeps Allow once exact and consumable', async () => {
    const f = fixture();
    const { grant, approval } = await f.approve('per_action');
    expect(await f.prepare()).toMatchObject({ result: { decision: 'requires_user' } });
    const retry = await f.prepare({ requestId: approval.requestId });
    expect(retry).toMatchObject({ exactApprovalRequestId: approval.requestId });
    f.guard.recordMutationSucceeded(retry as BrowserGatewayPreparedMutation);
    expect(f.grantStore.getGrant(grant.id)?.consumedAt).toBeTypeOf('number');
    expect(await f.prepare({ requestId: approval.requestId })).toMatchObject({ result: { decision: 'requires_user' } });
  });

  it('persists forever across store and agent lifetimes, then stops on revocation', async () => {
    const f = fixture();
    const { grant } = await f.approve('persistent');
    expect(grant).toMatchObject({ expiresAt: PERSISTENT_BROWSER_GRANT_EXPIRES_AT, nodeId: 'windows-pc' });
    expect(BrowserPermissionGrantSchema.safeParse(grant).success).toBe(true);
    const reopened = new BrowserGrantStore(f.db);
    expect(reopened.listGrants({ instanceId: 'another-instance', nodeId: 'windows-pc' })).toEqual([grant]);
    const prepared = await f.prepare({ instanceId: 'another-instance', provider: 'claude' });
    expect(prepared).toMatchObject({ grant: { id: grant.id } });
    expect(f.guard.recheckPreparedGrant({ ...f.context, instanceId: 'another-instance', provider: 'claude' },
      'click', 'browser.click', prepared as BrowserGatewayPreparedMutation)).toBeNull();
    reopened.revokeGrant(grant.id);
    expect(await f.prepare({ instanceId: 'another-instance', provider: 'claude' })).toMatchObject({ result: { decision: 'requires_user' } });
  });

  it('does not make bounded approvals cross-session', async () => {
    const f = fixture();
    await f.approve('autonomous');
    expect(await f.prepare({ instanceId: 'another-instance' })).toMatchObject({ result: { decision: 'requires_user' } });
  });

  it('rechecks the prepared forever grant despite a newer matching grant, but still detects its revocation', async () => {
    const f = fixture();
    const { grant } = await f.approve('persistent');
    f.db.prepare('UPDATE browser_permission_grants SET created_at = 1 WHERE id = ?').run(grant.id);
    const future = { ...f.context, instanceId: 'future-instance', provider: 'claude' };
    const preparation = await f.prepare(future);
    if (preparation.result) throw new Error('Expected prepared mutation');
    expect(preparation.grant.id).toBe(grant.id);
    const replacement = (await f.operations.createGrant({
      mode: 'session', nodeId: 'windows-pc', instanceId: future.instanceId, provider: 'claude',
      requestedBy: 'operator', allowedOrigins: grant.allowedOrigins, allowedActionClasses: ['credential'],
      autonomous: false, allowExternalNavigation: false, expiresAt: Date.now() + 60_000,
    })).data!;
    expect(f.grantStore.listGrants({ instanceId: future.instanceId, nodeId: 'windows-pc' })[0].id).toBe(replacement.id);
    expect(await f.prepare(future)).toMatchObject({ grant: { id: replacement.id } });
    expect(f.guard.recheckPreparedGrant(future, 'click', 'browser.click', preparation)).toBeNull();
    f.grantStore.revokeGrant(grant.id);
    expect(f.guard.recheckPreparedGrant(future, 'click', 'browser.click', preparation))
      .toMatchObject({ decision: 'requires_user', outcome: 'not_run' });
    expect(await f.prepare(future)).toMatchObject({ grant: { id: replacement.id } });
  });

  it('keeps revocation of shared forever consent on the operator path', async () => {
    const f = fixture();
    const { grant } = await f.approve('persistent');
    expect(await f.operations.revokeGrant({ grantId: grant.id, instanceId: 'another-instance' }))
      .toMatchObject({ decision: 'denied', outcome: 'not_run' });
    expect(f.grantStore.getGrant(grant.id)?.revokedAt).toBeUndefined();
    expect(await f.operations.revokeGrant({ grantId: grant.id })).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
  });

  it('keeps forever navigation usable beyond newer bounded grants, until revoked, only on its approved site and computer', async () => {
    const f = fixture();
    const sendCommand = vi.fn(async () => null);
    const navigation = new BrowserExistingTabOperations({
      extensionCommandStore: { sendCommand }, extensionTabStore: { attachTab: vi.fn(), detachTab: vi.fn() },
      grantStore: f.grantStore, approvalStore: f.approvalStore, result: f.options.result,
      autoApproveApproval: () => null, isRemoteExtensionContactFresh: () => true, describeRemoteExtensionContact: () => 'ready',
    });
    const destination = 'https://approved.example/settings';
    const pending = await navigation.navigate({ ...f.context, url: destination }, f.tab);
    expect(pending.decision).toBe('requires_user');
    if (pending.decision !== 'requires_user') throw new Error('Expected navigation approval');
    const approval = f.approvalStore.getRequest(pending.requestId)!;
    const approved = await f.operations.approveRequest({ requestId: approval.requestId,
      grant: { ...approval.proposedGrant, mode: 'persistent', autonomous: true } });
    const standing = approved.data!;
    const futureRequest = { ...f.context, instanceId: 'future', provider: 'claude', url: destination };
    expect(await navigation.navigate(futureRequest, f.tab))
      .toMatchObject({ decision: 'allowed', outcome: 'succeeded', grantId: standing.id });
    expect(sendCommand).toHaveBeenCalledOnce();
    f.db.prepare('UPDATE browser_permission_grants SET created_at = 1 WHERE id = ?').run(standing.id);
    for (let index = 0; index < 101; index++) {
      const bounded = await f.operations.createGrant({
        mode: 'session', nodeId: 'windows-pc', instanceId: futureRequest.instanceId, provider: 'claude',
        requestedBy: 'operator', allowedOrigins: standing.allowedOrigins, allowedActionClasses: ['navigate', 'input'],
        autonomous: false, allowExternalNavigation: false, expiresAt: Date.now() + 60_000,
      });
      expect(bounded.decision).toBe('allowed');
    }
    const page = f.grantStore.listGrants({ instanceId: futureRequest.instanceId, nodeId: 'windows-pc' });
    expect(page).toHaveLength(100);
    expect(page.some(({ id }) => id === standing.id)).toBe(false);
    expect(await navigation.navigate(futureRequest, f.tab))
      .toMatchObject({ decision: 'allowed', outcome: 'succeeded', grantId: standing.id });
    expect(sendCommand).toHaveBeenCalledTimes(2);
    expect(await navigation.navigate({ ...futureRequest, url: 'https://unapproved.example' }, f.tab))
      .toMatchObject({ decision: 'requires_user', outcome: 'not_run' });
    expect(await navigation.navigate(futureRequest, { ...f.tab, nodeId: 'other-worker', profileId: 'existing-tab:n.other-worker:tab-1' }))
      .toMatchObject({ decision: 'requires_user', outcome: 'not_run' });
    expect(await f.operations.revokeGrant({ grantId: standing.id })).toMatchObject({ decision: 'allowed' });
    expect(await navigation.navigate(futureRequest, f.tab)).toMatchObject({ decision: 'requires_user', outcome: 'not_run' });
    expect(sendCommand).toHaveBeenCalledTimes(2);
  });

  it('pins managed forever approval to the profile and its execution computer', async () => {
    const f = fixture(true);
    const { grant } = await f.approve('persistent');
    expect(grant).toMatchObject({ profileId: f.profile.id, nodeId: 'windows-pc' });
    expect(grant.targetId).toBeUndefined();
    expect(await f.prepare({ instanceId: 'another-instance', provider: 'claude' })).toMatchObject({ grant: { id: grant.id } });
    f.profile.executionNodeId = undefined;
    expect(await f.prepare()).toMatchObject({ result: { decision: 'requires_user' } });
  });

  it.each(['local', 'other-worker'])('rejects a forever grant on a different computer (%s)', async (nodeId) => {
    const f = fixture();
    const { grant } = await f.approve('persistent');
    expect(findMatchingBrowserGrant({ grants: [grant], instanceId: 'new', provider: 'claude', nodeId,
      profileId: `existing-tab:n.${nodeId}:another-tab`, targetId: 'another-tab', origin: f.tab.origin,
      actionClass: 'credential' }).grant).toBeUndefined();
  });

  it('does not treat a missing node as a remote match or a shared-tab grant as a managed grant', async () => {
    const f = fixture();
    const { grant } = await f.approve('persistent');
    for (const profileId of ['existing-tab:tab-2', 'managed-profile']) {
      expect(findMatchingBrowserGrant({ grants: [grant], instanceId: 'new', provider: 'claude',
        profileId, origin: f.tab.origin, actionClass: 'credential' }).grant).toBeUndefined();
    }
  });

  it.each(['https://other.example', 'https://sub.entra.microsoft.com', 'http://entra.microsoft.com', 'https://entra.microsoft.com:8443'])('keeps forever scope off %s', async (site) => {
    const f = fixture();
    const { grant } = await f.approve('persistent');
    expect(findMatchingBrowserGrant({ grants: [grant], instanceId: 'new', provider: 'claude', nodeId: 'windows-pc',
      profileId: f.tab.profileId, origin: site, actionClass: 'credential' }).grant).toBeUndefined();
  });

  it.each([
    ['credential', 'captcha_challenge'], ['credential', 'two_factor_challenge'],
    ['payment', 'payment_field_never_automated'], ['financial_identity', 'financial_identity_requires_secure_broker'],
    ['sensitive_identity', 'sensitive_identity_requires_secure_broker'], ['unknown', 'element_context_unavailable'],
  ] as const)('retains %s / %s protections with a forever grant', async (actionClass, reason) => {
    const f = fixture();
    await f.approve('persistent');
    const prepared = await f.guard.prepareMutatingAction(f.context, 'type', 'browser.type', '#field', hint,
      { actionClass, hardStop: true, reason });
    expect(prepared).toHaveProperty('result');
    expect((prepared as { result: { decision: string } }).result.decision).not.toBe('allowed');
  });

  it('does not promote legacy or campaign credential grants to reusable credential consent', async () => {
    const f = fixture();
    const { grant } = await f.approve('autonomous');
    f.db.prepare('UPDATE browser_permission_grants SET user_approved_credentials = 0 WHERE id = ?').run(grant.id);
    expect(await f.prepare()).toMatchObject({ result: { decision: 'requires_user' } });
  });

  it('does not let a newer legacy grant hide valid forever credential consent', async () => {
    const f = fixture();
    const { grant } = await f.approve('persistent');
    const legacy = { ...grant, id: 'newer-campaign', mode: 'autonomous' as const, userApprovedCredentials: undefined };
    expect(findMatchingBrowserGrant({ grants: [legacy, grant], instanceId: f.context.instanceId, provider: 'codex',
      profileId: f.tab.profileId, nodeId: 'windows-pc', origin: f.tab.origin, actionClass: 'credential' }).grant?.id).toBe(grant.id);
  });

  it('refuses to issue a forever grant through auto-approval or agent request_grant', async () => {
    const f = fixture();
    const { approval } = await f.approve('per_action');
    const proposedGrant = { ...approval.proposedGrant, mode: 'persistent' as const, autonomous: true };
    const predicate = vi.fn(() => true);
    expect(autoApproveBrowserApproval({ approval: { ...approval, proposedGrant: { ...proposedGrant, allowedActionClasses: ['input'] } },
      approvalStore: f.approvalStore, grantStore: f.grantStore, autoApproveRequests: predicate })).toBeNull();
    expect(predicate).not.toHaveBeenCalled();
    const agentPayload = { profileId: f.context.profileId, targetId: f.context.targetId, proposedGrant };
    expect(BrowserRequestGrantRequestSchema.safeParse(agentPayload).success).toBe(false);
    expect(BrowserRequestGrantRequestSchema.safeParse({ ...agentPayload, proposedGrant: { ...proposedGrant, mode: 'autonomous' } }).success).toBe(true);
    const requests = new BrowserGrantRequestOperations({ ...f.options, getLiveTarget: async () => ({ target: null }) });
    await expect(requests.requestGrant({ ...f.context, proposedGrant })).rejects.toThrow('require_operator_approval');
  });

  it('rejects broad forever proposals and a caller-forged credential provenance flag', async () => {
    const f = fixture();
    const { approval } = await f.approve('per_action');
    const base = { requestId: approval.requestId, grant: { ...approval.proposedGrant, mode: 'persistent', autonomous: true } };
    for (const grant of [
      { ...base.grant, allowedOrigins: [] },
      { ...base.grant, allowedOrigins: [{ ...origin, includeSubdomains: true }] },
      { ...base.grant, allowedOrigins: [{ ...origin, hostPattern: '*' }] },
      { ...base.grant, autonomous: false },
      { ...base.grant, userApprovedCredentials: true },
    ]) expect(BrowserApproveRequestPayloadSchema.safeParse({ ...base, grant }).success).toBe(false);
  });
});
