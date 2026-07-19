import { describe, expect, it, vi } from 'vitest';
import type {
  BrowserGatewayResult,
  BrowserPermissionGrant,
} from '@contracts/types/browser';
import {
  BrowserGatewayActionGuard,
  type BrowserGatewayActionGuardOptions,
  type BrowserGatewayPreparedMutation,
} from './browser-gateway-action-guard';
import {
  CAPTCHA_CHALLENGE_REASON,
  CREDENTIAL_CHALLENGE_REASON,
  LEGAL_DECLARATION_REASON,
} from './browser-action-classifier';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import type { BrowserGatewayResultInput } from './browser-gateway-result';

const CAMPAIGN_SUBMIT_GRANT: BrowserPermissionGrant = {
  id: 'g1',
  mode: 'autonomous',
  instanceId: 'i1',
  provider: 'orchestrator',
  profileId: 'p1',
  allowedOrigins: [{ scheme: 'https', hostPattern: 'portal.example.gov.uk', includeSubdomains: false }],
  allowedActionClasses: ['submit'],
  allowExternalNavigation: false,
  autonomous: true,
  requestedBy: 'campaign:c1',
  decidedBy: 'user',
  decision: 'allow',
  expiresAt: 4_102_444_800_000, // year 2100
  createdAt: 0,
};

/**
 * Focused coverage for the captcha/2FA -> escalation-queue routing added to the
 * guard. Driven through the existing-tab hard-stop path (no live driver needed)
 * with a classification override, so the test isolates the routing decision.
 */
function makeGuard(opts: { withEscalations?: boolean; grants?: BrowserPermissionGrant[] } = {}) {
  const withEscalations = opts.withEscalations ?? true;
  const grants = opts.grants ?? [];
  const raise = vi.fn(() => ({ escalationId: 'esc-1', parked: true as const }));
  // The real approval store echoes the request back with a requestId; mirror
  // that so the guard's downstream auto-approve read of proposedGrant works.
  const createRequest = vi.fn((input: Record<string, unknown>) => ({ ...input, requestId: 'req-1' }));
  const result = vi.fn(
    <T>(params: BrowserGatewayResultInput<T>) => params as unknown as BrowserGatewayResult<T>,
  );

  const attachment: BrowserExistingTabAttachment = {
    profileId: 'p1',
    targetId: 't1',
    tabId: 1,
    windowId: 1,
    url: 'https://portal.example.gov.uk/apply',
    origin: 'https://portal.example.gov.uk',
    allowedOrigins: [{ scheme: 'https', hostPattern: 'portal.example.gov.uk', includeSubdomains: false }],
    attachedAt: 0,
    updatedAt: 0,
  };

  const options: BrowserGatewayActionGuardOptions = {
    profileStore: { getProfile: vi.fn(() => undefined) } as unknown as BrowserGatewayActionGuardOptions['profileStore'],
    targetRegistry: { listTargets: vi.fn(() => []) } as unknown as BrowserGatewayActionGuardOptions['targetRegistry'],
    driver: { refreshTarget: vi.fn(), inspectElement: vi.fn() } as unknown as BrowserGatewayActionGuardOptions['driver'],
    extensionTabStore: { getTab: vi.fn(() => attachment) } as unknown as BrowserGatewayActionGuardOptions['extensionTabStore'],
    grantStore: { listGrants: vi.fn(() => grants), createGrant: vi.fn() } as unknown as BrowserGatewayActionGuardOptions['grantStore'],
    approvalStore: { createRequest, resolveRequest: vi.fn() } as unknown as BrowserGatewayActionGuardOptions['approvalStore'],
    autoApproveRequests: () => false,
    result: result as unknown as BrowserGatewayActionGuardOptions['result'],
    ...(withEscalations ? { escalations: { raise } } : {}),
  };

  return { guard: new BrowserGatewayActionGuard(options), raise, createRequest, result };
}

const CONTEXT = { instanceId: 'i1', provider: 'orchestrator', profileId: 'p1', targetId: 't1' };

async function drive(
  guard: BrowserGatewayActionGuard,
  reason: string,
  actionClass: BrowserPermissionGrant['allowedActionClasses'][number] = 'credential',
) {
  return guard.prepareMutatingAction(
    CONTEXT,
    'type into field',
    'browser.type',
    '#field',
    'challenge',
    { actionClass, hardStop: true, reason },
  );
}

function resultOf(prep: Awaited<ReturnType<BrowserGatewayActionGuard['prepareMutatingAction']>>) {
  return (prep as { result: BrowserGatewayResult<null> }).result;
}

describe('BrowserGatewayActionGuard captcha/2FA escalation routing', () => {
  it('parks a captcha hard stop to the escalation queue instead of a per-action approval', async () => {
    const { guard, raise, createRequest } = makeGuard();
    const result = resultOf(await drive(guard, CAPTCHA_CHALLENGE_REASON));

    expect(raise).toHaveBeenCalledTimes(1);
    expect(raise).toHaveBeenCalledWith(expect.objectContaining({ kind: 'captcha' }));
    expect(createRequest).not.toHaveBeenCalled();
    expect(result.decision).toBe('requires_user');
    expect(result.outcome).toBe('not_run');
    expect(result.reason).toContain('captcha_parked');
  });

  it('leaves a real password hard stop on the per-action approval path (never queued)', async () => {
    const { guard, raise, createRequest } = makeGuard();
    await drive(guard, CREDENTIAL_CHALLENGE_REASON);

    expect(raise).not.toHaveBeenCalled();
    expect(createRequest).toHaveBeenCalledTimes(1);
  });

  it('falls back to the approval path for captcha when no escalation service is wired', async () => {
    const { guard, raise, createRequest } = makeGuard({ withEscalations: false });
    await drive(guard, CAPTCHA_CHALLENGE_REASON);

    expect(raise).not.toHaveBeenCalled();
    expect(createRequest).toHaveBeenCalledTimes(1);
  });
});

describe('BrowserGatewayActionGuard never-grantable hard stop', () => {
  // A payment field can never be authorized by any grant OR approval (grant
  // policy refuses it). Creating a per-action approval for it produced an
  // approval the user could approve but which could never permit the action —
  // the loop reported in the Constellia repro. It must terminate instead.
  it('returns a terminal deny for a payment hard stop, with no approval request', async () => {
    const { guard, raise, createRequest } = makeGuard();
    const result = resultOf(
      await drive(guard, 'payment_field_never_automated', 'payment'),
    );

    expect(createRequest).not.toHaveBeenCalled();
    expect(raise).not.toHaveBeenCalled();
    expect(result.decision).toBe('denied');
    expect(result.outcome).toBe('not_run');
    expect(result.reason).toBe('payment_field_never_automated');
    expect((result as { requestId?: string }).requestId).toBeUndefined();
  });
});

describe('BrowserGatewayActionGuard legal-declaration auto-fire', () => {
  it('auto-fires a binding declaration under a campaign grant and records an audit note', async () => {
    const { guard, createRequest, raise, result } = makeGuard({ grants: [CAMPAIGN_SUBMIT_GRANT] });
    const prep = await drive(guard, LEGAL_DECLARATION_REASON, 'submit');

    // Proceeds under the grant (no blocking approval, no escalation)...
    expect((prep as { grant?: { id: string } }).grant?.id).toBe('g1');
    expect(createRequest).not.toHaveBeenCalled();
    expect(raise).not.toHaveBeenCalled();
    // ...and leaves a distinct, greppable audit note.
    expect(result).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'legal_declaration_auto_fired', actionClass: 'submit' }),
    );
  });

  it('does NOT auto-fire a declaration without a campaign grant (falls to approval, no note)', async () => {
    const { guard, createRequest, result } = makeGuard({ grants: [] });
    await drive(guard, LEGAL_DECLARATION_REASON, 'submit');

    expect(createRequest).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'legal_declaration_auto_fired' }),
    );
  });
});

describe('BrowserGatewayActionGuard existing-tab grant scope (LT-001 regression)', () => {
  // Existing-tab grants are deliberately stored node-scoped (profileId
  // omitted, nodeId set to 'local'/remote id) because the tab's own
  // profileId is per-attachment/ephemeral — see browser-grant-scope.ts and
  // browser-grant-store.ts's `profile_id IS NULL AND node_id = ?` query.
  const EXISTING_TAB_PROFILE_ID = 'existing-tab:t1';
  const EXISTING_TAB_TARGET_ID = 't1';
  const EXISTING_TAB_GRANT: BrowserPermissionGrant = {
    id: 'g-existing-tab',
    mode: 'session',
    instanceId: 'i1',
    provider: 'orchestrator',
    nodeId: 'local',
    allowedOrigins: [{ scheme: 'https', hostPattern: 'portal.example.gov.uk', includeSubdomains: false }],
    allowedActionClasses: ['input'],
    allowExternalNavigation: false,
    autonomous: false,
    requestedBy: 'i1',
    decidedBy: 'user',
    decision: 'allow',
    expiresAt: 4_102_444_800_000, // year 2100
    createdAt: 0,
  };
  const REQUEST = {
    instanceId: 'i1',
    provider: 'orchestrator',
    profileId: EXISTING_TAB_PROFILE_ID,
    targetId: EXISTING_TAB_TARGET_ID,
  };

  function makeExistingTabGuard(grants: BrowserPermissionGrant[]) {
    const listGrants = vi.fn(() => grants);
    const attachment: BrowserExistingTabAttachment = {
      profileId: EXISTING_TAB_PROFILE_ID,
      targetId: EXISTING_TAB_TARGET_ID,
      tabId: 1,
      windowId: 1,
      url: 'https://portal.example.gov.uk/apply',
      origin: 'https://portal.example.gov.uk',
      allowedOrigins: [{ scheme: 'https', hostPattern: 'portal.example.gov.uk', includeSubdomains: false }],
      attachedAt: 0,
      updatedAt: 0,
    };
    const result = vi.fn(
      <T>(params: BrowserGatewayResultInput<T>) => params as unknown as BrowserGatewayResult<T>,
    );
    const options: BrowserGatewayActionGuardOptions = {
      profileStore: { getProfile: vi.fn(() => undefined) } as unknown as BrowserGatewayActionGuardOptions['profileStore'],
      targetRegistry: { listTargets: vi.fn(() => []) } as unknown as BrowserGatewayActionGuardOptions['targetRegistry'],
      driver: { refreshTarget: vi.fn(), inspectElement: vi.fn() } as unknown as BrowserGatewayActionGuardOptions['driver'],
      extensionTabStore: { getTab: vi.fn(() => attachment) } as unknown as BrowserGatewayActionGuardOptions['extensionTabStore'],
      grantStore: { listGrants, createGrant: vi.fn() } as unknown as BrowserGatewayActionGuardOptions['grantStore'],
      approvalStore: {
        createRequest: vi.fn((input: Record<string, unknown>) => ({ ...input, requestId: 'req-1' })),
        resolveRequest: vi.fn(),
      } as unknown as BrowserGatewayActionGuardOptions['approvalStore'],
      autoApproveRequests: () => false,
      result: result as unknown as BrowserGatewayActionGuardOptions['result'],
    };
    return { guard: new BrowserGatewayActionGuard(options), listGrants };
  }

  it('matches an approved existing-tab session grant on the immediately retried input action', async () => {
    const { guard, listGrants } = makeExistingTabGuard([EXISTING_TAB_GRANT]);

    const prepared = await guard.prepareMutatingAction(
      REQUEST,
      'type into field',
      'browser.type',
      '#field',
      'harmless field',
      { actionClass: 'input', hardStop: false },
    );
    expect((prepared as { grant?: { id: string } }).grant?.id).toBe('g-existing-tab');

    const recheck = guard.recheckPreparedGrant(
      REQUEST,
      'type',
      'browser.type',
      prepared as BrowserGatewayPreparedMutation,
    );

    // Before the fix, recheckPreparedGrant never scoped its lookup to the
    // node, so it could never re-find the just-matched existing-tab grant
    // and always re-prompted the user instead of proceeding (LT-001).
    expect(recheck).toBeNull();
    expect(listGrants).toHaveBeenLastCalledWith(
      expect.objectContaining({ profileId: EXISTING_TAB_PROFILE_ID, nodeId: 'local' }),
    );
  });

  it('does not broaden an existing-tab grant to a different node scope', async () => {
    const remoteGrant: BrowserPermissionGrant = { ...EXISTING_TAB_GRANT, id: 'g-remote', nodeId: 'remote-node-1' };
    const { guard } = makeExistingTabGuard([remoteGrant]);

    const prepared: BrowserGatewayPreparedMutation = {
      grant: remoteGrant,
      actionClass: 'input',
      origin: 'https://portal.example.gov.uk',
      url: 'https://portal.example.gov.uk/apply',
    };

    const recheck = guard.recheckPreparedGrant(REQUEST, 'type', 'browser.type', prepared);

    // REQUEST's profileId ('existing-tab:t1') derives node scope 'local',
    // which must never match a grant scoped to a different remote node.
    expect(recheck).not.toBeNull();
  });
});
