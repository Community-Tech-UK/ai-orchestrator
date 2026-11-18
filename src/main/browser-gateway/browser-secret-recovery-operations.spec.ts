import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserApprovalRequest, BrowserGatewayResult, BrowserSecretRecoveryOutcome } from '@contracts/types/browser';
import { BrowserApprovalRequestSchema } from '@contracts/schemas/browser';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { BrowserApprovalStore } from './browser-approval-store';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import { BrowserGatewayApprovalOperations } from './browser-gateway-approval-operations';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import { BrowserSecretRecoveryOperations, outcomeForApproval } from './browser-secret-recovery-operations';
import { currentBrowserSessionOwner, withBrowserSession } from './browser-session-context';
import { MARKER, PROTECTED_ORIGIN, PUBLIC_ORIGIN, recoveryHarness, settle } from './browser-secret-recovery.testutil';

const SESSION = 'session-test-only';
const PROFILE = 'existing-tab:local:7:42';
const TARGET = 'target-test-only-42';
const OTHER_ORIGIN = 'https://test-only-other-protected.example';
const USER_DATA = '/tmp/test-only-harness-user-data';

function result<T>(params: BrowserGatewayResultInput<T>): BrowserGatewayResult<T> {
  return {
    decision: params.decision, outcome: params.outcome, reason: params.reason, summary: params.summary,
    requestId: params.requestId, data: params.data, auditId: 'audit-test-only',
  } as BrowserGatewayResult<T>;
}

describe('browser.recover_secret_observation (main process with the shipped extension)', () => {
  let db: SqliteDriver;
  let store: BrowserApprovalStore;

  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    createTables(db); createMigrationsTable(db); runMigrations(db);
    store = new BrowserApprovalStore(db);
  });
  afterEach(() => db.close());

  async function setup(options: {
    supports?: boolean;
    login?: boolean | null;
    stored?: unknown;
    failCommand?: (command: string, payload: Record<string, unknown>, sent: Array<{ command: string }>) => boolean;
    beforeCommand?: (command: string, h: ReturnType<typeof recoveryHarness>) => Promise<void>;
    /** Go through the extension's tab claims, as production does, with session owners. */
    claims?: 'in_session' | 'owner_less';
  } = {}) {
    const h = recoveryHarness(options.stored ?? {
      version: 2, origins: [PROTECTED_ORIGIN, OTHER_ORIGIN], tabs: { '42': PROTECTED_ORIGIN, '77': OTHER_ORIGIN },
    });
    await settle();
    await h.setGatewayEnabled(true);
    h.tabs.set(77, { id: 77, windowId: 7, url: OTHER_ORIGIN + '/', title: 'Other' });
    const attachment: BrowserExistingTabAttachment = {
      profileId: PROFILE, targetId: TARGET, tabId: 42, windowId: 7, url: 'https://redacted.invalid/',
      origin: 'https://redacted.invalid', allowedOrigins: [], attachedAt: 1, updatedAt: 1, nodeName: 'Test PC',
    };
    const sent: Array<{ command: string; payload: Record<string, unknown> }> = [];
    let count = 0;
    let tabPresent = true;
    const sendCommand = vi.fn(async (_attachment: BrowserExistingTabAttachment, command: string, payload: Record<string, unknown>) => {
      sent.push({ command, payload });
      await options.beforeCommand?.(command, h);
      const owner = currentBrowserSessionOwner();
      const reply = await h.run({
        id: `cmd-${++count}`, command, target: { tabId: 42 }, payload: { ...payload }, timeoutMs: 5000,
        ...(owner ? { sessionOwner: owner } : {}),
      }, { sessionScoped: Boolean(options.claims) });
      if (options.failCommand?.(command, payload, sent)) throw new Error('browser_extension_command_timeout');
      if (reply['ok'] === true) return reply['result'];
      throw new Error(String(reply['error']));
    });
    const checkLogin = vi.fn(async () => options.login ?? null);
    const recovery = new BrowserSecretRecoveryOperations({
      approvalStore: store,
      getExistingTab: (profileId, targetId) => (tabPresent && profileId === PROFILE && targetId === TARGET ? attachment : undefined),
      sendCommand,
      supportsRecovery: () => options.supports ?? true,
      checkLogin,
      result,
      inSession: (instanceId, work) => (options.claims === 'in_session'
        ? withBrowserSession(USER_DATA, instanceId, work)
        : work()),
    });
    const createGrant = vi.fn();
    const autoApproveApproval = vi.fn(() => ({ id: 'grant-test-only' }) as never);
    const approvals = new BrowserGatewayApprovalOperations({
      approvalStore: store,
      grantStore: { listGrants: vi.fn(() => []), createGrant, revokeGrant: vi.fn() },
      profileStore: { getProfile: () => null, setRuntimeState: vi.fn() },
      autoApproveApproval,
      onSecretRecoveryApproved: (approval) => void recovery.start(approval),
      result,
    });
    // The agent's own calls arrive through the RPC server, which runs them as the session's owner.
    const ask = (extra: Record<string, unknown> = {}) => withBrowserSession(USER_DATA, SESSION, () => recovery.recover({
      instanceId: SESSION, provider: 'claude', profileId: PROFILE, targetId: TARGET, reason: 'Finish the bid', ...extra,
    }));
    const approve = async (requestId: string, choice: Record<string, unknown> = { secretRecovery: { permission: 'operation' } }) => {
      const approval = store.getRequest(requestId)!;
      const answer = await approvals.approveRequest({ requestId, grant: approval.proposedGrant, ...choice });
      await recovery.completion(requestId);
      return answer;
    };
    const closeTab = () => { tabPresent = false; };
    return { h, store, recovery, approvals, sendCommand, sent, createGrant, autoApproveApproval, checkLogin, ask, approve, closeTab };
  }

  function data(answer: BrowserGatewayResult<BrowserSecretRecoveryOutcome | null>): BrowserSecretRecoveryOutcome {
    expect(answer.data).not.toBeNull();
    return answer.data!;
  }

  it('asks once, releases only the reviewed site after the exact approval, and verifies it', async () => {
    const t = await setup({ login: true });
    const asked = await t.ask();
    expect(asked.decision).toBe('requires_user');
    const pending = data(asked);
    expect(pending).toMatchObject({ state: 'approval_pending', origins: [PROTECTED_ORIGIN], affectedTabCount: 1 });

    const approval = t.store.getRequest(pending.requestId!)!;
    expect(BrowserApprovalRequestSchema.safeParse(approval).success).toBe(true);
    expect(approval.secretRecovery).toMatchObject({
      ownerSessionId: SESSION, nodeId: 'local', computerName: 'Test PC', targetId: TARGET, origins: [PROTECTED_ORIGIN],
    });
    // The review token never leaves the operation: not stored, not returned.
    const tokens = t.sent.filter((entry) => entry.command === 'secret_protection_review');
    expect(tokens).toHaveLength(1);
    expect(JSON.stringify(approval)).not.toMatch(/reviewToken/);
    expect(JSON.stringify(pending)).not.toMatch(/reviewToken/);
    expect(t.h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);

    // Asking again for the same state reuses the request.
    expect(data(await t.ask()).requestId).toBe(pending.requestId);

    const approved = await t.approve(pending.requestId!);
    expect(approved).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    expect(t.createGrant).not.toHaveBeenCalled();
    expect([...t.h.secretTaintedOrigins]).toEqual([OTHER_ORIGIN]);

    const done = data(await t.ask({ requestId: pending.requestId }));
    expect(done).toMatchObject({
      state: 'recovered', reasonCode: 'protection_released_and_verified', loginVerified: true,
      receiptId: approval.secretRecovery!.operationId,
    });
    expect(t.checkLogin).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(done)).not.toContain(MARKER);
  });

  it.each([
    ['a generic approval with no recovery choice', {}],
    ['a device sign-in choice', { deviceLogin: { permission: 'operation' } }],
    ['a saved-login choice', { secretRecovery: { permission: 'operation' }, credentialAccess: { permission: 'task' } }],
  ])('does not recover with %s', async (_label, choice) => {
    const t = await setup();
    const pending = data(await t.ask());
    const answer = await t.approve(pending.requestId!, choice);
    expect(answer).toMatchObject({ decision: 'denied', reason: 'secret_recovery_approval_not_applied' });
    expect(t.store.getRequest(pending.requestId!)!.status).toBe('pending');
    expect(t.h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);
    expect(t.createGrant).not.toHaveBeenCalled();
  });

  it('does not recover when the approved grant was altered', async () => {
    const t = await setup();
    const pending = data(await t.ask());
    const approval = t.store.getRequest(pending.requestId!)!;
    const answer = await t.approvals.approveRequest({
      requestId: approval.requestId, grant: { ...approval.proposedGrant, mode: 'session' },
      secretRecovery: { permission: 'operation' },
    });
    expect(answer.decision).toBe('denied');
    expect(t.h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);
  });

  it('is never auto-approved, whatever the session allows', async () => {
    const t = await setup();
    const pending = data(await t.ask());
    const status = await t.approvals.getApprovalStatus({ requestId: pending.requestId!, instanceId: SESSION });
    expect(status.data?.status).toBe('pending');
    expect(t.autoApproveApproval).not.toHaveBeenCalled();
  });

  it('keeps the site protected when the user keeps it protected', async () => {
    const t = await setup();
    const pending = data(await t.ask());
    const denied = await t.approvals.denyRequest({ requestId: pending.requestId! });
    expect(denied).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    expect(data(await t.ask({ requestId: pending.requestId }))).toMatchObject({ state: 'denied' });
    expect(t.h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);
    // A late approval of the denied request changes nothing.
    expect((await t.approve(pending.requestId!)).decision).toBe('denied');
    expect(t.h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);
  });

  it('refuses another session, profile or tab using the request id', async () => {
    const t = await setup();
    const pending = data(await t.ask());
    for (const request of [
      { instanceId: 'other-session', profileId: PROFILE, targetId: TARGET },
      { instanceId: SESSION, profileId: 'existing-tab:local:7:99', targetId: TARGET },
      { instanceId: SESSION, profileId: PROFILE, targetId: 'other-target' },
    ]) {
      const answer = await t.recovery.recover({ ...request, provider: 'claude', requestId: pending.requestId });
      expect(answer).toMatchObject({ decision: 'denied', reason: 'secret_recovery_request_not_found' });
    }
  });

  it('marks the review stale when a password is entered again before approval', async () => {
    const t = await setup();
    const pending = data(await t.ask());
    await t.h.markSecretTaint(42, PROTECTED_ORIGIN);
    await t.approve(pending.requestId!);
    expect(data(await t.ask({ requestId: pending.requestId }))).toMatchObject({
      state: 'stale_review', reasonCode: 'protected_state_changed',
    });
    expect(t.h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);
    // A new request is a new review of the new state.
    const fresh = data(await t.ask());
    expect(fresh.requestId).not.toBe(pending.requestId);
    expect(fresh.state).toBe('approval_pending');
  });

  it('stops a recovery whose session was stopped before it ran', async () => {
    const t = await setup();
    const pending = data(await t.ask());
    const approval = t.store.getRequest(pending.requestId!)!;
    t.store.resolveSecretRecoveryRequest(approval.requestId, approval.secretRecovery!, 'approved');
    expect(t.store.expireForInstance(SESSION)).toBe(1);
    await t.recovery.start(t.store.getRequest(approval.requestId)!);
    expect(t.sent.filter((entry) => entry.command === 'release_secret_observation')).toHaveLength(0);
    expect(t.h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);
    expect(data(await t.ask({ requestId: pending.requestId })).state).toBe('stale_review');
  });

  it('reconciles a release whose reply was lost, without releasing twice', async () => {
    let failRelease = true;
    const t = await setup({ failCommand: (command) => command === 'release_secret_observation' && failRelease });
    const pending = data(await t.ask());
    await t.approve(pending.requestId!);
    expect(t.store.getRequest(pending.requestId!)!.secretRecoveryProgress).toMatchObject({ state: 'indeterminate' });
    // The release did reach the extension.
    expect([...t.h.secretTaintedOrigins]).toEqual([OTHER_ORIGIN]);
    // While replies are still lost, asking again cannot confirm it either way.
    expect(data(await t.ask({ requestId: pending.requestId }))).toMatchObject({
      state: 'indeterminate', reasonCode: 'release_outcome_unknown',
    });
    failRelease = false;
    const reconciled = data(await t.ask({ requestId: pending.requestId }));
    expect(reconciled).toMatchObject({ state: 'recovered' });
    const receipts = (t.h.storage['browserGatewaySecretTaints'] as { recoveryReceipts: unknown[] }).recoveryReceipts;
    expect(receipts).toHaveLength(1);
  });

  it('runs the approved recovery as the asking session, so the tab it holds accepts it', async () => {
    const t = await setup({ claims: 'in_session', login: true });
    const pending = data(await t.ask());
    // The approval comes from the Harness window, outside any agent call.
    await t.approve(pending.requestId!);
    expect(data(await t.ask({ requestId: pending.requestId }))).toMatchObject({ state: 'recovered' });
    expect([...t.h.secretTaintedOrigins]).toEqual([OTHER_ORIGIN]);
  });

  it('is refused by the extension when the approved work does not carry the session owner', async () => {
    const t = await setup({ claims: 'owner_less' });
    const pending = data(await t.ask());
    await t.approve(pending.requestId!);
    expect(t.store.getRequest(pending.requestId!)!.secretRecoveryProgress).toMatchObject({ state: 'failed' });
    expect(t.h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);
  });

  it('asks again when another tab inherited protection after the user approved', async () => {
    const t = await setup();
    const pending = data(await t.ask());
    t.h.tabs.set(43, { id: 43, windowId: 7, url: PUBLIC_ORIGIN + '/child', title: 'Child', openerTabId: 42 });
    await t.h.secretTaintOriginForTab(t.h.tabs.get(43)!);
    await t.approve(pending.requestId!);
    expect(data(await t.ask({ requestId: pending.requestId }))).toMatchObject({
      state: 'stale_review', reasonCode: 'protected_state_changed',
    });
    expect(t.h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(true);
    // The new request shows the new tab count.
    expect(data(await t.ask())).toMatchObject({ state: 'approval_pending', affectedTabCount: 2 });
  });

  it('never says protection is unchanged once the release was confirmed', async () => {
    // The release lands; the check afterwards cannot reach the extension.
    const t = await setup({ failCommand: (command, _payload, sent) => command === 'secret_protection_review'
      && sent.some((entry) => entry.command === 'release_secret_observation') });
    const pending = data(await t.ask());
    await t.approve(pending.requestId!);
    const progress = t.store.getRequest(pending.requestId!)!.secretRecoveryProgress!;
    expect(progress).toMatchObject({ state: 'indeterminate', reasonCode: 'released_check_unavailable' });
    expect(progress.receiptId).toBe(t.store.getRequest(pending.requestId!)!.secretRecovery!.operationId);
    expect(t.h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(false);
  });

  it('keeps reporting a confirmed release when the agent calls back while the extension is still unreachable', async () => {
    let unreachable = false;
    const t = await setup({ failCommand: (command, _payload, sent) => unreachable
      || (command === 'secret_protection_review' && sent.some((entry) => entry.command === 'release_secret_observation')) });
    const pending = data(await t.ask());
    await t.approve(pending.requestId!);
    unreachable = true;
    const outcome = data(await t.ask({ requestId: pending.requestId }));
    expect(outcome).toMatchObject({ state: 'indeterminate', reasonCode: 'released_check_unavailable' });
    expect(outcome.receiptId).toBeDefined();
    expect(outcome.nextAction).toMatch(/^Protection for the reviewed site was lifted/);
    expect(t.store.getRequest(pending.requestId!)!.secretRecoveryProgress!.receiptId).toBe(outcome.receiptId);
    // Nothing was sent again.
    expect(t.sent.filter((entry) => entry.command === 'release_secret_observation')).toHaveLength(1);
  });

  it.each(['unreachable', 'tab_closed'] as const)(
    'never says "unchanged" on a retry after a lost release reply when the extension is %s',
    async (problem) => {
      let lostReply = true;
      let unreachable = false;
      const t = await setup({ failCommand: (command) => unreachable || (lostReply && command === 'release_secret_observation') });
      const pending = data(await t.ask());
      await t.approve(pending.requestId!);
      expect(t.store.getRequest(pending.requestId!)!.secretRecoveryProgress).toMatchObject({ state: 'indeterminate' });
      lostReply = false;
      if (problem === 'unreachable') unreachable = true;
      else t.closeTab();
      const outcome = data(await t.ask({ requestId: pending.requestId }));
      expect(outcome).toMatchObject({ state: 'indeterminate', reasonCode: 'release_outcome_unknown' });
      expect(outcome.nextAction).not.toMatch(/unchanged/);
    },
  );

  it('finds the release receipt first when the tab moved to another protected site after a lost reply', async () => {
    let lostReply = true;
    const t = await setup({ failCommand: (command) => lostReply && command === 'release_secret_observation' });
    const pending = data(await t.ask());
    await t.approve(pending.requestId!);
    lostReply = false;
    // Like a cross-origin sign-in redirect: the tab now shows a site that is already protected.
    t.h.tabs.get(42)!.url = OTHER_ORIGIN + '/landing';
    await t.h.markSecretTaint(42, OTHER_ORIGIN);
    const outcome = data(await t.ask({ requestId: pending.requestId }));
    expect(outcome.receiptId).toBeDefined();
    expect(outcome).toMatchObject({ state: 'manual_security_review_required', reasonCode: 'released_tab_still_protected_by_another_site' });
    expect(outcome.nextAction).toMatch(/^Protection for the reviewed site was lifted/);
    expect(t.h.secretTaintedOrigins.has(PROTECTED_ORIGIN)).toBe(false);
  });

  it('says protection is off, not "stays on", when it was switched off just before the release', async () => {
    const t = await setup({ beforeCommand: async (command, h) => {
      if (command === 'release_secret_observation') await h.applySecretObservationProtectionEnabled(false);
    } });
    const pending = data(await t.ask());
    await t.approve(pending.requestId!);
    expect(t.store.getRequest(pending.requestId!)!.secretRecoveryProgress).toMatchObject({
      state: 'stale_review', reasonCode: 'protection_protection_off',
    });
  });

  it('still reports a real failure as unchanged when the release never arrived and the site is protected again', async () => {
    let dropRelease = true;
    const t = await setup({ beforeCommand: async (command) => {
      // The release is lost before it reaches the extension.
      if (command === 'release_secret_observation' && dropRelease) {
        dropRelease = false;
        throw new Error('browser_extension_command_timeout');
      }
    } });
    const pending = data(await t.ask());
    await t.approve(pending.requestId!);
    expect(t.store.getRequest(pending.requestId!)!.secretRecoveryProgress).toMatchObject({ state: 'indeterminate' });
    await t.h.markSecretTaint(42, PROTECTED_ORIGIN);
    // The retry first asks for a receipt; there is none, so the new fill decides.
    const outcome = data(await t.ask({ requestId: pending.requestId }));
    expect(outcome).toMatchObject({ state: 'stale_review', reasonCode: 'protected_state_changed' });
    expect(outcome.receiptId).toBeUndefined();
  });

  it('says the same site was protected again, and allows a fresh request, when a new password entry follows the release', async () => {
    const t = await setup({ beforeCommand: async (command, h) => {
      // Another task's password entry lands right after the release.
      if (command === 'secret_protection_review' && t.sent.some((entry) => entry.command === 'release_secret_observation')) {
        await h.markSecretTaint(42, PROTECTED_ORIGIN);
      }
    } });
    const pending = data(await t.ask());
    await t.approve(pending.requestId!);
    const outcome = data(await t.ask({ requestId: pending.requestId }));
    expect(outcome).toMatchObject({ state: 'stale_review', reasonCode: 'released_then_protected_again' });
    expect(outcome.receiptId).toBeDefined();
    expect(outcome.nextAction).toMatch(/ask for a fresh approval/);
    expect(data(await t.ask())).toMatchObject({ state: 'approval_pending' });
  });

  it('says protection was lifted when the tab still holds another protected site', async () => {
    const t = await setup();
    const pending = data(await t.ask());
    // A frame of the other protected site appears only after the release.
    const probe = t.h.chrome.scripting.executeScript;
    const original = probe.getMockImplementation()!;
    probe.mockImplementation(async (input: { func: { name: string }; target: { tabId: number } }) => (
      input.func.name === 'credentialFrameOriginProbe' && t.sent.some((entry) => entry.command === 'release_secret_observation')
        ? [{ frameId: 0, result: { origin: PUBLIC_ORIGIN } }, { frameId: 5, result: { origin: OTHER_ORIGIN } }]
        : original(input as never)));
    await t.approve(pending.requestId!);
    const outcome = data(await t.ask({ requestId: pending.requestId }));
    expect(outcome).toMatchObject({ state: 'manual_security_review_required', reasonCode: 'released_tab_still_protected_by_another_site' });
    expect(outcome.receiptId).toBeDefined();
    expect(outcome.nextAction).toMatch(/^Protection for the reviewed site was lifted/);
  });

  it('can still report a recovery that stopped before anyone asked for its end', async () => {
    const t = await setup();
    const pending = data(await t.ask());
    t.closeTab();
    const approval = t.store.getRequest(pending.requestId!)!;
    await t.approvals.approveRequest({ requestId: approval.requestId, grant: approval.proposedGrant, secretRecovery: { permission: 'operation' } });
    await new Promise((resolve) => setImmediate(resolve));
    const finished = await t.recovery.completion(pending.requestId!);
    expect(finished?.secretRecoveryProgress).toMatchObject({ state: 'stale_review', reasonCode: 'target_tab_gone' });
  });

  it('reports an older extension without sending it anything', async () => {
    const t = await setup({ supports: false });
    expect(data(await t.ask())).toMatchObject({ state: 'unsupported_extension', reasonCode: 'extension_older_than_0_2_55' });
    expect(t.sendCommand).not.toHaveBeenCalled();
  });

  it('says a tab is not protected without creating an approval', async () => {
    const t = await setup({ stored: { version: 2, origins: [], tabs: {} } });
    t.h.tabs.get(42)!.url = PUBLIC_ORIGIN + '/';
    expect(data(await t.ask())).toMatchObject({ state: 'not_protected' });
    expect(t.store.listRequests({ instanceId: SESSION })).toHaveLength(0);
  });

  it('needs an agent session and a shared tab', async () => {
    const t = await setup();
    expect(await t.recovery.recover({ profileId: PROFILE, targetId: TARGET }))
      .toMatchObject({ decision: 'denied', reason: 'secret_recovery_requires_agent_session' });
    expect(await t.recovery.recover({ instanceId: SESSION, profileId: 'managed-profile', targetId: TARGET }))
      .toMatchObject({ decision: 'denied', reason: 'secret_recovery_requires_shared_extension_tab' });
  });
});

describe('secret recovery approval records', () => {
  let db: SqliteDriver;
  let store: BrowserApprovalStore;
  beforeEach(() => {
    db = defaultDriverFactory(':memory:');
    createTables(db); createMigrationsTable(db); runMigrations(db);
    store = new BrowserApprovalStore(db);
  });
  afterEach(() => db.close());

  const metadata = {
    operationId: '00000000-0000-4000-8000-000000000001', ownerSessionId: SESSION, nodeId: 'local', computerName: 'Test PC',
    targetId: TARGET, origins: [PROTECTED_ORIGIN], affectedTabCount: 1, writeGeneration: 'generation-test-only',
    expiresAt: Date.now() + 60_000,
  };
  const input = {
    instanceId: SESSION, provider: 'claude' as const, profileId: PROFILE, targetId: TARGET,
    toolName: 'browser.recover_secret_observation', action: 'recover_secret_observation', actionClass: 'credential' as const,
    origin: PROTECTED_ORIGIN, expiresAt: metadata.expiresAt, secretRecovery: metadata,
    proposedGrant: {
      mode: 'per_action' as const, allowedOrigins: [{ scheme: 'https' as const, hostPattern: 'test-only-protected.example', includeSubdomains: false }],
      allowedActionClasses: ['read' as const], allowExternalNavigation: false, autonomous: false,
    },
  };

  it.each([
    ['another session', { instanceId: 'other-session' }],
    ['another origin', { origin: OTHER_ORIGIN }],
    ['a wider grant', { proposedGrant: { ...input.proposedGrant, allowedActionClasses: ['read', 'submit'] } }],
    ['a reusable grant', { proposedGrant: { ...input.proposedGrant, mode: 'session' } }],
    ['another tool', { toolName: 'browser.click' }],
  ])('refuses a recovery approval bound to %s', (_label, change) => {
    expect(() => store.createRequest({ ...input, ...change } as never)).toThrow();
  });

  it('expires an approved, unfinished recovery when its session is discarded, but keeps a finished one', () => {
    const running = store.createRequest(input);
    store.resolveSecretRecoveryRequest(running.requestId, running.secretRecovery!, 'approved');
    const finished = store.createRequest({
      ...input, secretRecovery: { ...metadata, operationId: '00000000-0000-4000-8000-000000000002' },
    });
    store.resolveSecretRecoveryRequest(finished.requestId, finished.secretRecovery!, 'approved');
    store.setSecretRecoveryProgress(finished.requestId, {
      state: 'recovered', reasonCode: 'protection_released_and_verified', loginVerified: null, updatedAt: 1,
    });
    expect(store.expireForInstance(SESSION)).toBe(1);
    expect(store.getRequest(running.requestId)!.status).toBe('expired');
    expect(store.getRequest(finished.requestId)!.status).toBe('approved');
    // Progress can only be written while approved.
    expect(store.setSecretRecoveryProgress(running.requestId, {
      state: 'running', reasonCode: 'secret_recovery_running', loginVerified: null, updatedAt: 2,
    })).toBeNull();
  });

  it('expires only recovery approvals when their session is removed', () => {
    const recovery = store.createRequest(input);
    const ordinary = store.createRequest({
      instanceId: SESSION, provider: 'claude', profileId: PROFILE, toolName: 'browser.click', action: 'click',
      actionClass: 'submit', expiresAt: Date.now() + 60_000,
      proposedGrant: { ...input.proposedGrant, allowedActionClasses: ['submit'] },
    });
    expect(store.expireSecretRecoveriesForInstance(SESSION)).toBe(1);
    expect(store.getRequest(recovery.requestId)!.status).toBe('expired');
    expect(store.getRequest(ordinary.requestId)!.status).toBe('pending');
  });

  it('never lets the generic resolver approve a recovery', () => {
    const recovery = store.createRequest(input);
    store.resolveRequest(recovery.requestId, { status: 'approved', grantId: 'grant-test-only' });
    expect(store.getRequest(recovery.requestId)!.status).toBe('pending');
    store.resolveRequest(recovery.requestId, { status: 'expired' });
    expect(store.getRequest(recovery.requestId)!.status).toBe('expired');
  });

  it('keeps a release receipt visible after Stop or expiry ends the approval', () => {
    const created = store.createRequest(input);
    store.resolveSecretRecoveryRequest(created.requestId, created.secretRecovery!, 'approved');
    store.setSecretRecoveryProgress(created.requestId, {
      state: 'indeterminate', reasonCode: 'released_check_unavailable', loginVerified: null,
      receiptId: metadata.operationId, updatedAt: 1,
    });
    expect(store.expireSecretRecoveriesForInstance(SESSION)).toBe(1);
    const stopped = store.getRequest(created.requestId)!;
    expect(stopped.status).toBe('expired');
    for (const now of [Date.now(), metadata.expiresAt + 1]) {
      const outcome = outcomeForApproval(stopped, false, now);
      expect(outcome).toMatchObject({ state: 'indeterminate', receiptId: metadata.operationId });
      expect(outcome.nextAction).toMatch(/^Protection for the reviewed site was lifted/);
    }
  });

  it('records a release that landed while Stop expired the approval, but nothing else', () => {
    const created = store.createRequest(input);
    store.resolveSecretRecoveryRequest(created.requestId, created.secretRecovery!, 'approved');
    store.expireSecretRecoveriesForInstance(SESSION);
    expect(store.setSecretRecoveryProgress(created.requestId, {
      state: 'failed', reasonCode: 'secret_recovery_failed', loginVerified: null, updatedAt: 1,
    })).toBeNull();
    expect(store.setSecretRecoveryProgress(created.requestId, {
      state: 'recovered', reasonCode: 'protection_released_and_verified', loginVerified: null,
      receiptId: metadata.operationId, updatedAt: 2,
    })?.secretRecoveryProgress?.receiptId).toBe(metadata.operationId);
  });

  it('finds the reusable request for the exact same review only', () => {
    const created = store.createRequest(input);
    const binding = { ownerSessionId: SESSION, nodeId: 'local', targetId: TARGET, origins: [PROTECTED_ORIGIN], writeGeneration: 'generation-test-only' };
    expect(store.findReusableSecretRecoveryRequest(binding)?.requestId).toBe(created.requestId);
    expect(store.findReusableSecretRecoveryRequest({ ...binding, writeGeneration: 'generation-other' })).toBeNull();
    expect(store.findReusableSecretRecoveryRequest({ ...binding, origins: [OTHER_ORIGIN] })).toBeNull();
    expect(store.findReusableSecretRecoveryRequest({ ...binding, ownerSessionId: 'other-session' })).toBeNull();
    const approval: BrowserApprovalRequest = store.resolveSecretRecoveryRequest(created.requestId, created.secretRecovery!, 'denied')!;
    expect(approval.status).toBe('denied');
    expect(store.findReusableSecretRecoveryRequest(binding)).toBeNull();
  });
});
