import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  BrowserGatewayResult,
  BrowserPermissionGrant,
  BrowserProfile,
  BrowserTarget,
} from '@contracts/types/browser';
import { BrowserRequestGrantRequestSchema } from '@contracts/schemas/browser';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createMigrationsTable, createTables, runMigrations } from '../persistence/rlm/rlm-schema';
import { BrowserApprovalStore } from './browser-approval-store';
import { BrowserGrantStore } from './browser-grant-store';
import { BrowserGrantRequestOperations } from './browser-grant-request-operations';
import { BrowserGatewayApprovalOperations } from './browser-gateway-approval-operations';
import { BrowserGatewayActionGuard, type BrowserGatewayActionGuardOptions } from './browser-gateway-action-guard';
import { BrowserManualHandoffOperations } from './browser-manual-handoff-operations';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import { useSqliteTemplate } from '../db/sqlite-template.test-helpers';

/**
 * The agent's stated reason, from the tool call to the person who decides:
 * request -> action guard (or grant request) -> real approval store -> the
 * approval list the cards read. Everything between the tool call and the
 * database is real; only the browser itself is faked.
 */

const rlmTemplate = useSqliteTemplate((db) => {
  createTables(db);
  createMigrationsTable(db);
  runMigrations(db);
});
const dbs: SqliteDriver[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

const shop = { scheme: 'https' as const, hostPattern: 'shop.example.com', includeSubdomains: false };
const result = <T>(value: BrowserGatewayResultInput<T>): BrowserGatewayResult<T> =>
  ({ ...value, auditId: 'audit' }) as BrowserGatewayResult<T>;

function database(): { db: SqliteDriver; store: BrowserApprovalStore } {
  const db = rlmTemplate.open();
  dbs.push(db);
  return { db, store: new BrowserApprovalStore(db) };
}

function attachment(profileId: string): BrowserExistingTabAttachment {
  return {
    profileId, targetId: `${profileId}:target`, tabId: 1, windowId: 1,
    url: 'https://shop.example.com/checkout', origin: 'https://shop.example.com',
    allowedOrigins: [shop], attachedAt: 0, updatedAt: 0,
  };
}

function guardOnRealStore(options: { managed?: boolean; inspectFails?: boolean; grants?: BrowserPermissionGrant[] } = {}) {
  const { db, store } = database();
  const tab = attachment('existing-tab:n.windows-pc:1:2');
  const profile = { id: 'p1', allowedOrigins: [shop], executionNodeId: 'local' };
  const guardOptions: BrowserGatewayActionGuardOptions = {
    profileStore: { getProfile: vi.fn(() => (options.managed ? profile : undefined)) } as unknown as BrowserGatewayActionGuardOptions['profileStore'],
    targetRegistry: { listTargets: vi.fn(() => (options.managed ? [{ id: 't1' }] : [])) } as unknown as BrowserGatewayActionGuardOptions['targetRegistry'],
    driver: {
      refreshTarget: vi.fn(async () => ({ id: 't1', url: tab.url, origin: tab.origin })),
      inspectElement: vi.fn(async () => {
        if (options.inspectFails) throw new Error('element detached');
        return { role: 'button', accessibleName: 'Submit order' };
      }),
    } as unknown as BrowserGatewayActionGuardOptions['driver'],
    extensionTabStore: { getTab: vi.fn(() => (options.managed ? undefined : tab)) } as unknown as BrowserGatewayActionGuardOptions['extensionTabStore'],
    grantStore: {
      listGrants: vi.fn(() => options.grants ?? []), createGrant: vi.fn(), consumeGrant: vi.fn(),
    } as unknown as BrowserGatewayActionGuardOptions['grantStore'],
    approvalStore: store,
    autoApproveRequests: () => false,
    result: result as unknown as BrowserGatewayActionGuardOptions['result'],
  };
  return { db, store, guard: new BrowserGatewayActionGuard(guardOptions) };
}

const context = (reason?: string) => ({
  instanceId: 'i1', provider: 'claude', profileId: 'p1', targetId: 't1', ...(reason === undefined ? {} : { reason }),
});
const submit = { actionClass: 'submit' as const, hardStop: false };

describe('a stated reason reaches the approval store from the action guard', () => {
  it.each([
    ['a shared tab', { managed: false }],
    ['a managed profile', { managed: true }],
  ])('keeps the reason on the pending approval for %s', async (_name, options) => {
    const { db, store, guard } = guardOnRealStore(options);

    await guard.prepareMutatingAction(context('Placing the order you asked for'), 'click', 'browser.click', '#buy', 'Submit order', submit);

    const [approval] = store.listRequests({ status: 'pending' });
    expect(approval?.requestReason).toBe('Placing the order you asked for');
    expect(approval?.toolName).toBe('browser.click');
    expect(db.prepare('SELECT request_reason FROM browser_approval_requests').get())
      .toEqual({ request_reason: 'Placing the order you asked for' });
  });

  it('keeps the reason when the page could not be inspected', async () => {
    const { store, guard } = guardOnRealStore({ managed: true, inspectFails: true });

    await guard.prepareMutatingAction(context('Opening your basket'), 'click', 'browser.click', '#basket', 'Open basket');

    expect(store.listRequests({ status: 'pending' })[0]).toMatchObject({
      actionClass: 'unknown',
      requestReason: 'Opening your basket',
    });
  });

  it('keeps the reason when a grant changed between preparing and acting', async () => {
    const { store, guard } = guardOnRealStore({ managed: true });
    const staleGrant = {
      id: 'stale', mode: 'per_action', instanceId: 'i1', provider: 'claude', profileId: 'p1',
      allowedOrigins: [shop], allowedActionClasses: ['input'], allowExternalNavigation: false, autonomous: false,
      requestedBy: 'i1', decidedBy: 'user', decision: 'allow', expiresAt: 4_102_444_800_000, createdAt: 0,
    } as BrowserPermissionGrant;

    const outcome = guard.recheckPreparedGrant(
      context('Filling in the delivery name'), 'type', 'browser.type',
      { grant: staleGrant, actionClass: 'input', origin: shop.hostPattern, url: 'https://shop.example.com/checkout' },
    );

    expect(outcome).toMatchObject({ decision: 'requires_user' });
    expect(store.listRequests({ status: 'pending' })[0]?.requestReason).toBe('Filling in the delivery name');
  });

  it('stores nothing when the agent gave no reason', async () => {
    const { store, guard } = guardOnRealStore();

    await guard.prepareMutatingAction(context(), 'click', 'browser.click', '#buy', 'Submit order', submit);

    const [approval] = store.listRequests({ status: 'pending' });
    expect(approval).toBeDefined();
    expect('requestReason' in approval!).toBe(false);
  });

  it('never stores a secret the agent put in its reason, or text from the page', async () => {
    const { db, guard } = guardOnRealStore();

    await guard.prepareMutatingAction(
      context('Signing in with password=PLACEHOLDER\nthen continuing'), 'click', 'browser.click', '#buy',
      'Submit order', submit,
    );

    const stored = (db.prepare('SELECT request_reason, element_context_json FROM browser_approval_requests').get() as
      { request_reason: string; element_context_json: string | null });
    expect(stored.request_reason).not.toContain('PLACEHOLDER');
    expect(stored.request_reason).toContain('[REDACTED]');
    expect(stored.request_reason).not.toContain('\n');
    // The page-derived element context is stored separately and never carries the reason.
    expect(stored.element_context_json ?? '').not.toContain('Signing in');
  });

  it('shows one card for a retry, and keeps the first reason', async () => {
    const { store, guard } = guardOnRealStore();

    await guard.prepareMutatingAction(context('Placing the order you asked for'), 'click', 'browser.click', '#buy', 'Submit order', submit);
    await guard.prepareMutatingAction(context('Trying the order again'), 'click', 'browser.click', '#buy', 'Submit order', submit);

    const pending = store.listRequests({ status: 'pending' });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.requestReason).toBe('Placing the order you asked for');
  });
});

describe('a stated reason on a standing-permission request', () => {
  function grantRequests(options: { managed: boolean }) {
    const { db, store } = database();
    const profileId = options.managed ? 'managed-profile' : 'existing-tab:n.windows-pc:1:2';
    const tab = attachment(profileId);
    const profile: BrowserProfile = {
      id: 'managed-profile', label: 'Test profile', browser: 'chrome', mode: 'session', status: 'running',
      allowedOrigins: [shop], createdAt: 1, updatedAt: 1,
    };
    const target: BrowserTarget = {
      id: tab.targetId, profileId, mode: 'session', driver: 'cdp', status: 'available',
      lastSeenAt: 1, url: tab.url, origin: tab.origin,
    };
    const operations = new BrowserGrantRequestOperations({
      approvalStore: store, grantStore: new BrowserGrantStore(db),
      profileStore: { getProfile: () => (options.managed ? profile : null) },
      result, extensionTabStore: { getTab: () => (options.managed ? null : tab) },
      getLiveTarget: async () => ({ target }),
    });
    const payload = (reason?: string) => BrowserRequestGrantRequestSchema.parse({
      profileId, targetId: tab.targetId, ...(reason === undefined ? {} : { reason }),
      proposedGrant: {
        mode: 'session', allowedOrigins: [shop], allowedActionClasses: ['input'],
        allowExternalNavigation: false, autonomous: false,
      },
    });
    return { store, operations, payload };
  }

  it.each([{ managed: false }, { managed: true }])(
    'carries the reason the agent gave through to the stored approval (managed=$managed)',
    async ({ managed }) => {
      const { store, operations, payload } = grantRequests({ managed });

      const pending = await operations.requestGrant({ ...payload('Booking the venue you chose'), instanceId: 'agent-1', provider: 'claude' });
      if (pending.decision !== 'requires_user') throw new Error('Expected an approval request');

      expect(store.getRequest(pending.requestId)?.requestReason).toBe('Booking the venue you chose');
    },
  );

  it('stores no reason when the agent gave none', async () => {
    const { store, operations, payload } = grantRequests({ managed: false });

    const pending = await operations.requestGrant({ ...payload(), instanceId: 'agent-1', provider: 'claude' });
    if (pending.decision !== 'requires_user') throw new Error('Expected an approval request');

    expect('requestReason' in store.getRequest(pending.requestId)!).toBe(false);
  });
});

describe('a hand-off keeps only the message the agent wrote', () => {
  function handoffs() {
    const { store } = database();
    const tab = attachment('existing-tab:3:4');
    const operations = new BrowserManualHandoffOperations({
      approvalStore: store,
      extensionTabStore: { getTab: () => tab },
      profileStore: { getProfile: () => null, setRuntimeState: vi.fn() },
      getLiveTarget: async () => ({ target: null }),
      result,
    });
    const ask = (reason?: string) => operations.createManualHandoffApproval({
      request: { profileId: tab.profileId, targetId: tab.targetId, instanceId: 'agent-1', provider: 'claude', ...(reason === undefined ? {} : { reason }) },
      toolName: 'browser.request_user_login',
      action: 'request_user_login',
      actionClass: 'credential',
      resultReason: 'manual_login_required',
      defaultPrompt: 'User login is required before Browser Gateway automation can continue.',
      summary: 'Browser Gateway user login request requires manual completion',
    });
    return { store, ask };
  }

  it('records the agent’s message as its reason', async () => {
    const { store, ask } = handoffs();
    await ask('Please sign in to your account, then tell me.');
    expect(store.listRequests({ status: 'pending' })[0]?.requestReason).toBe('Please sign in to your account, then tell me.');
  });

  it('does not present the system’s own default prompt as the agent’s reason', async () => {
    const { store, ask } = handoffs();
    await ask();
    const [approval] = store.listRequests({ status: 'pending' });
    expect(approval).toBeDefined();
    expect('requestReason' in approval!).toBe(false);
    // The default prompt is still kept where it always was.
    expect(approval?.elementContext?.nearbyText).toContain('User login is required');
  });
});

describe('the approval list says which computer, from the profile and the tab, never from the agent', () => {
  function list(options: { profile: Partial<BrowserProfile> | null; profileId: string; agentNode?: string }) {
    const { store } = database();
    const created = store.createRequest({
      instanceId: 'i1', provider: 'claude', profileId: options.profileId, targetId: 't1',
      toolName: 'browser.click', action: 'click', actionClass: 'input', origin: 'https://shop.example.com',
      requestReason: 'Adding it to your basket',
      proposedGrant: {
        mode: 'per_action', ...(options.agentNode ? { nodeId: options.agentNode } : {}),
        allowedOrigins: [shop], allowedActionClasses: ['input'], allowExternalNavigation: false, autonomous: false,
      },
      expiresAt: 4_102_444_800_000,
    });
    const profile = options.profile ? { id: options.profileId, ...options.profile } as BrowserProfile : null;
    const operations = new BrowserGatewayApprovalOperations({
      approvalStore: store, grantStore: new BrowserGrantStore(dbs[dbs.length - 1]!),
      profileStore: { getProfile: () => profile, setRuntimeState: vi.fn() }, result,
    });
    return { created, operations };
  }

  it.each([
    ['a shared tab on this computer', 'existing-tab:7:42', null, 'local'],
    ['a shared tab with a Chrome profile segment on this computer', 'existing-tab:p.chrome-1:7:42', null, 'local'],
    ['a shared tab on another computer', 'existing-tab:n.windows-pc:7:42', null, 'windows-pc'],
    ['a shared tab on another computer with a Chrome profile segment', 'existing-tab:n.windows-pc:p.chrome-1:7:42', null, 'windows-pc'],
    ['a managed profile on this computer', 'managed-1', {}, 'local'],
    ['a managed profile on another computer', 'managed-1', { executionNodeId: 'studio-pc' }, 'studio-pc'],
  ])('%s', async (_name, profileId, profile, expected) => {
    const { created, operations } = list({ profileId, profile: profile as Partial<BrowserProfile> | null });
    const listed = await operations.listApprovalRequests({ status: 'pending' });
    expect(listed.data).toEqual([expect.objectContaining({
      requestId: created.requestId, computerId: expected, requestReason: 'Adding it to your basket',
    })]);
  });

  it('ignores a computer the agent proposed', async () => {
    const { operations } = list({ profileId: 'existing-tab:n.windows-pc:7:42', profile: null, agentNode: 'attacker-pc' });
    const listed = await operations.listApprovalRequests({ status: 'pending' });
    expect(listed.data?.[0]?.computerId).toBe('windows-pc');
    const managed = list({ profileId: 'managed-1', profile: {}, agentNode: 'attacker-pc' });
    expect((await managed.operations.listApprovalRequests({ status: 'pending' })).data?.[0]?.computerId).toBe('local');
  });

  it('names no computer for a managed profile that no longer exists, rather than guessing', async () => {
    const { operations } = list({ profileId: 'deleted-profile', profile: null });
    const listed = await operations.listApprovalRequests({ status: 'pending' });
    expect(listed.data?.[0]).toBeDefined();
    expect('computerId' in listed.data![0]!).toBe(false);
  });

  it('does not store the computer it works out', async () => {
    const { created, operations } = list({ profileId: 'existing-tab:n.windows-pc:7:42', profile: null });
    await operations.listApprovalRequests({ status: 'pending' });
    const row = dbs[dbs.length - 1]!.prepare('SELECT * FROM browser_approval_requests WHERE request_id = ?').get(created.requestId);
    expect(Object.keys(row as object)).not.toContain('computer_id');
  });
});
