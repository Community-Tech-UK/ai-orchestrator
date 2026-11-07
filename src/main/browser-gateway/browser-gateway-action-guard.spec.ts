import { describe, expect, it, vi } from 'vitest';
import type {
  BrowserApprovalRequest,
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
  TWO_FACTOR_CHALLENGE_REASON,
} from './browser-action-classifier';
import type { BrowserExistingTabAttachment } from './browser-extension-tab-store';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import {
  BrowserOneTimeCodeFillLedger,
  ONE_TIME_CODE_SUBMIT_REASON,
  ONE_TIME_CODE_SUBMIT_WINDOW_MS,
} from './browser-one-time-code-submit';

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
function makeGuard(opts: {
  withEscalations?: boolean;
  grants?: BrowserPermissionGrant[];
  approvals?: BrowserApprovalRequest[];
  probe?: BrowserGatewayActionGuardOptions['probePageChallenge'];
  managed?: boolean;
  oneTimeCodeFills?: BrowserGatewayActionGuardOptions['oneTimeCodeFills'];
  elementText?: string;
} = {}) {
  const withEscalations = opts.withEscalations ?? true;
  const grants = opts.grants ?? [];
  const approvals = opts.approvals ?? [];
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

  const consumeGrant = vi.fn();
  const options: BrowserGatewayActionGuardOptions = {
    profileStore: { getProfile: vi.fn(() => opts.managed ? {
      id: 'p1', allowedOrigins: attachment.allowedOrigins, executionNodeId: 'local',
    } : undefined) } as unknown as BrowserGatewayActionGuardOptions['profileStore'],
    targetRegistry: { listTargets: vi.fn(() => opts.managed ? [{ id: 't1' }] : []) } as unknown as BrowserGatewayActionGuardOptions['targetRegistry'],
    driver: {
      refreshTarget: vi.fn(async () => ({ id: 't1', url: attachment.url, origin: attachment.origin })),
      inspectElement: vi.fn(async () => ({ visibleText: opts.elementText ?? 'ordinary field' })),
    } as unknown as BrowserGatewayActionGuardOptions['driver'],
    extensionTabStore: { getTab: vi.fn(() => opts.managed ? undefined : attachment) } as unknown as BrowserGatewayActionGuardOptions['extensionTabStore'],
    grantStore: {
      listGrants: vi.fn(() => grants),
      createGrant: vi.fn(),
      consumeGrant,
    } as unknown as BrowserGatewayActionGuardOptions['grantStore'],
    approvalStore: {
      createRequest,
      getRequest: vi.fn((requestId: string) =>
        approvals.find((approval) => approval.requestId === requestId) ?? null),
      listRequests: vi.fn(() => approvals),
      resolveRequest: vi.fn(),
    } as unknown as BrowserGatewayActionGuardOptions['approvalStore'],
    autoApproveRequests: () => false,
    result: result as unknown as BrowserGatewayActionGuardOptions['result'],
    ...(withEscalations ? { escalations: { raise } } : {}),
    ...(opts.probe ? { probePageChallenge: opts.probe } : {}),
    ...(opts.oneTimeCodeFills ? { oneTimeCodeFills: opts.oneTimeCodeFills } : {}),
  };

  return { guard: new BrowserGatewayActionGuard(options), raise, createRequest, consumeGrant, result };
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

describe('BrowserGatewayActionGuard exact credential approval redemption', () => {
  const credentialGrant: BrowserPermissionGrant = {
    id: 'credential-grant',
    mode: 'session',
    instanceId: 'i1',
    provider: 'orchestrator',
    profileId: 'p1',
    targetId: 't1',
    allowedOrigins: [{ scheme: 'https', hostPattern: 'portal.example.gov.uk', includeSubdomains: false }],
    allowedActionClasses: ['credential'],
    allowExternalNavigation: false,
    autonomous: false,
    requestedBy: 'i1',
    decidedBy: 'user',
    decision: 'allow',
    expiresAt: 4_102_444_800_000,
    createdAt: 0,
  };
  const approvedRequest: BrowserApprovalRequest = {
    id: 'approval-row',
    requestId: 'credential-request',
    instanceId: 'i1',
    provider: 'orchestrator',
    profileId: 'p1',
    targetId: 't1',
    toolName: 'browser.type',
    action: 'type into field',
    actionClass: 'credential',
    origin: 'https://portal.example.gov.uk',
    url: 'https://portal.example.gov.uk/apply',
    selector: '#field',
    proposedGrant: {
      mode: 'per_action',
      allowedOrigins: credentialGrant.allowedOrigins,
      allowedActionClasses: ['credential'],
      allowExternalNavigation: false,
      autonomous: false,
    },
    status: 'approved',
    grantId: credentialGrant.id,
    createdAt: 1,
    expiresAt: 4_102_444_800_000,
    decidedAt: 2,
  };

  it('runs one exact approved credential retry and consumes its linked grant after success', async () => {
    const { guard, createRequest, consumeGrant } = makeGuard({
      grants: [credentialGrant],
      approvals: [approvedRequest],
    });

    const prepared = await guard.prepareMutatingAction(
      { ...CONTEXT, requestId: approvedRequest.requestId },
      approvedRequest.action,
      approvedRequest.toolName,
      approvedRequest.selector!,
      'challenge',
      { actionClass: 'credential', hardStop: true, reason: CREDENTIAL_CHALLENGE_REASON },
    );

    expect((prepared as BrowserGatewayPreparedMutation).grant.id).toBe(credentialGrant.id);
    expect(createRequest).not.toHaveBeenCalled();
    guard.recordMutationSucceeded(prepared as BrowserGatewayPreparedMutation);
    expect(consumeGrant).toHaveBeenCalledWith(credentialGrant.id);
  });

  it('redeems and rechecks an exact approval for a caller with no instanceId', async () => {
    const grant = { ...credentialGrant, instanceId: 'unknown', requestedBy: 'unknown' };
    const approval = { ...approvedRequest, instanceId: 'unknown' };
    const { guard, createRequest } = makeGuard({ grants: [grant], approvals: [approval] });
    const request = { provider: 'orchestrator', profileId: 'p1', targetId: 't1', requestId: approval.requestId };

    const prepared = await guard.prepareMutatingAction(
      request, approval.action, approval.toolName, approval.selector!, 'challenge',
      { actionClass: 'credential', hardStop: true, reason: CREDENTIAL_CHALLENGE_REASON },
    );

    expect((prepared as BrowserGatewayPreparedMutation).grant.id).toBe(grant.id);
    expect(guard.recheckPreparedGrant(request, approval.action, approval.toolName,
      prepared as BrowserGatewayPreparedMutation)).toBeNull();
    expect(createRequest).not.toHaveBeenCalled();
  });

  it.each([undefined, 'wrong-request'])('does not redeem an omitted or wrong request ID (%s)', async (requestId) => {
    const { guard, createRequest } = makeGuard({ grants: [credentialGrant], approvals: [approvedRequest] });

    const result = resultOf(await guard.prepareMutatingAction(
      { ...CONTEXT, requestId },
      approvedRequest.action,
      approvedRequest.toolName,
      approvedRequest.selector!,
      'challenge',
      { actionClass: 'credential', hardStop: true, reason: CREDENTIAL_CHALLENGE_REASON },
    ));

    expect(result.decision).toBe('requires_user');
    expect(createRequest).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent redemption of the same one-use approval', async () => {
    const { guard, createRequest } = makeGuard({ grants: [credentialGrant], approvals: [approvedRequest] });
    const retry = () => guard.prepareMutatingAction(
      { ...CONTEXT, requestId: approvedRequest.requestId },
      approvedRequest.action,
      approvedRequest.toolName,
      approvedRequest.selector!,
      'challenge',
      { actionClass: 'credential' as const, hardStop: true, reason: CREDENTIAL_CHALLENGE_REASON },
    );

    const first = await retry();
    const second = resultOf(await retry());

    expect((first as BrowserGatewayPreparedMutation).grant.id).toBe(credentialGrant.id);
    expect(second).toMatchObject({
      decision: 'requires_user',
      requestId: approvedRequest.requestId,
      reason: 'approval_redemption_in_progress',
    });
    expect(createRequest).not.toHaveBeenCalled();
  });

  it('rejects an approved credential request when the selector fingerprint differs', async () => {
    const { guard, createRequest } = makeGuard({
      grants: [credentialGrant],
      approvals: [approvedRequest],
    });

    const result = resultOf(await guard.prepareMutatingAction(
      { ...CONTEXT, requestId: approvedRequest.requestId },
      approvedRequest.action,
      approvedRequest.toolName,
      '#different-field',
      'challenge',
      { actionClass: 'credential', hardStop: true, reason: CREDENTIAL_CHALLENGE_REASON },
    ));

    expect(result.decision).toBe('requires_user');
    expect(createRequest).toHaveBeenCalledTimes(1);
  });

  it('rejects an approved credential request when the target fingerprint differs', async () => {
    const { guard, createRequest } = makeGuard({
      grants: [credentialGrant],
      approvals: [{ ...approvedRequest, targetId: 'different-target' }],
    });

    const result = resultOf(await guard.prepareMutatingAction(
      { ...CONTEXT, requestId: approvedRequest.requestId },
      approvedRequest.action,
      approvedRequest.toolName,
      approvedRequest.selector!,
      'challenge',
      { actionClass: 'credential', hardStop: true, reason: CREDENTIAL_CHALLENGE_REASON },
    ));

    expect(result.decision).toBe('requires_user');
    expect(createRequest).toHaveBeenCalledTimes(1);
  });

  it('never redeems an ordinary approval for a captcha hard stop', async () => {
    const { guard, raise } = makeGuard({ grants: [credentialGrant], approvals: [approvedRequest] });

    const result = resultOf(await guard.prepareMutatingAction(
      { ...CONTEXT, requestId: approvedRequest.requestId },
      approvedRequest.action,
      approvedRequest.toolName,
      approvedRequest.selector!,
      'challenge',
      { actionClass: 'credential', hardStop: true, reason: CAPTCHA_CHALLENGE_REASON },
    ));

    expect(result.decision).toBe('requires_user');
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it('never redeems an ordinary approval for a two-factor hard stop', async () => {
    const { guard, raise } = makeGuard({ grants: [credentialGrant], approvals: [approvedRequest] });

    const result = resultOf(await guard.prepareMutatingAction(
      { ...CONTEXT, requestId: approvedRequest.requestId },
      approvedRequest.action,
      approvedRequest.toolName,
      approvedRequest.selector!,
      'challenge',
      { actionClass: 'credential', hardStop: true, reason: TWO_FACTOR_CHALLENGE_REASON },
    ));

    expect(result.decision).toBe('requires_user');
    expect(raise).toHaveBeenCalledTimes(1);
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
        getRequest: vi.fn(() => null),
        listRequests: vi.fn(() => []),
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

describe('BrowserGatewayActionGuard omitted instance identity', () => {
  const grant: BrowserPermissionGrant = {
    ...CAMPAIGN_SUBMIT_GRANT,
    id: 'anonymous-input-grant',
    mode: 'session',
    instanceId: 'unknown',
    requestedBy: 'unknown',
    allowedActionClasses: ['input'],
    autonomous: false,
  };
  const request = { provider: 'orchestrator', profileId: 'p1', targetId: 't1' };

  it.each([false, true])('accepts the caller\'s approved grant on managed=%s path', async (managed) => {
    const { guard, createRequest } = makeGuard({ grants: [grant], managed });

    const prepared = await guard.prepareMutatingAction(
      request, 'type into field', 'browser.type', '#field', 'ordinary field',
      { actionClass: 'input', hardStop: false },
    );

    expect((prepared as BrowserGatewayPreparedMutation).grant.id).toBe(grant.id);
    expect(guard.recheckPreparedGrant(request, 'type into field', 'browser.type',
      prepared as BrowserGatewayPreparedMutation)).toBeNull();
    expect(createRequest).not.toHaveBeenCalled();
  });
});

describe('BrowserGatewayActionGuard CAPTCHA evidence (2026-09-15 §3.4)', () => {
  const INPUT_GRANT: BrowserPermissionGrant = {
    ...CAMPAIGN_SUBMIT_GRANT,
    id: 'input-grant',
    mode: 'session',
    autonomous: false,
    allowedActionClasses: ['input'],
  };

  it('does not park a shared-tab click whose agent hint merely mentions reCAPTCHA', async () => {
    const probe = vi.fn(async () => ({ detected: false }));
    const { guard, raise } = makeGuard({ grants: [INPUT_GRANT], probe });

    const prep = await guard.prepareMutatingAction(
      CONTEXT, 'click', 'browser.click', '#enable', 'Enable the reCAPTCHA Enterprise API in the Comtech project',
    );

    expect(raise).not.toHaveBeenCalled();
    expect(prep).toMatchObject({ grant: { id: 'input-grant' }, actionClass: 'input' });
    expect(probe).toHaveBeenCalledWith({ profileId: 'p1', targetId: 't1', toolName: 'browser.click' });
  });

  it('parks a click when the page probe finds a live challenge, even with a grant', async () => {
    const { guard, raise } = makeGuard({ grants: [INPUT_GRANT], probe: async () => ({ detected: true }) });

    const result = resultOf(await guard.prepareMutatingAction(CONTEXT, 'click', 'browser.click', '#submit', 'Send'));

    expect(raise).toHaveBeenCalledWith(expect.objectContaining({ kind: 'captcha' }));
    expect(result.reason).toContain('captcha_parked');
  });

  it('runs the same page check for browser.evaluate despite its fixed classification override', async () => {
    const { guard, raise, createRequest } = makeGuard({ probe: async () => ({ detected: true }) });
    await guard.prepareMutatingAction(CONTEXT, 'evaluate', 'browser.evaluate', ':root', 'evaluate: document.forms[0].submit()', {
      actionClass: 'unknown', hardStop: true, reason: 'browser_evaluate_requires_user',
    });
    expect(raise).toHaveBeenCalledWith(expect.objectContaining({ kind: 'captcha' }));
    expect(createRequest).not.toHaveBeenCalled();

    const clean = makeGuard({ probe: async () => ({ detected: false }) });
    await clean.guard.prepareMutatingAction(CONTEXT, 'evaluate', 'browser.evaluate', ':root', 'evaluate: 1', {
      actionClass: 'unknown', hardStop: true, reason: 'browser_evaluate_requires_user',
    });
    expect(clean.raise).not.toHaveBeenCalled();
    expect(clean.createRequest).toHaveBeenCalledTimes(1);
  });

  it('lets field input go ahead beside a live CAPTCHA (only the code box check applies to typing)', async () => {
    const probe = vi.fn(async () => ({ detected: true }));
    const { guard, raise } = makeGuard({ grants: [INPUT_GRANT], probe });

    const prep = await guard.prepareMutatingAction(
      { ...CONTEXT, selector: '#name' }, 'type', 'browser.type', '#name', 'Type the contact name',
    );

    expect(probe).toHaveBeenCalledWith({
      profileId: 'p1', targetId: 't1', toolName: 'browser.type',
      inputTargets: { selectors: ['#name'], uids: [] },
    });
    expect(raise).not.toHaveBeenCalled();
    expect(prep).toMatchObject({ grant: { id: 'input-grant' }, actionClass: 'input' });
  });
});

describe('BrowserGatewayActionGuard sign-in code box evidence (Report MI, 2026-11-05)', () => {
  const REPORT_MI = 'https://portal.example.gov.uk';
  const INPUT_GRANT: BrowserPermissionGrant = { ...CAMPAIGN_SUBMIT_GRANT, id: 'input-grant', allowedActionClasses: ['input'] };
  const codeBox = (filled: boolean, targetIsCodeField = false) => vi.fn(async () => ({
    detected: false,
    oneTimeCode: { codeField: true, filled, targetIsCodeField },
  }));

  it('parks a plainly described "Continue" that would submit a code the agent typed itself', async () => {
    const { guard, raise } = makeGuard({ grants: [CAMPAIGN_SUBMIT_GRANT], probe: codeBox(true) });

    const result = resultOf(await guard.prepareMutatingAction(CONTEXT, 'click', 'browser.click', '#continue', 'Continue'));

    expect(result.reason).toBe('two_factor_unavailable_parked_to_escalation_queue');
    expect(raise).toHaveBeenCalledWith(expect.objectContaining({ kind: 'two_factor_unavailable' }));
  });

  it('releases that click as an ordinary submit after browser.fill_credential typed the code', async () => {
    const ledger = new BrowserOneTimeCodeFillLedger();
    ledger.record({ instanceId: 'i1', profileId: 'p1', targetId: 't1', origin: REPORT_MI });
    const { guard, raise } = makeGuard({ grants: [CAMPAIGN_SUBMIT_GRANT], probe: codeBox(true), oneTimeCodeFills: ledger });

    const prep = await guard.prepareMutatingAction(CONTEXT, 'click', 'browser.click', '#continue', 'Continue');

    expect(prep).toMatchObject({ grant: { id: 'g1' }, actionClass: 'submit' });
    expect(raise).not.toHaveBeenCalled();
  });

  it('lets a click through while the code box is still empty', async () => {
    const { guard, raise } = makeGuard({ grants: [CAMPAIGN_SUBMIT_GRANT], probe: codeBox(false) });

    const prep = await guard.prepareMutatingAction(CONTEXT, 'click', 'browser.click', '#resend', 'Send a new code');

    expect(prep).toMatchObject({ grant: { id: 'g1' }, actionClass: 'submit' });
    expect(raise).not.toHaveBeenCalled();
  });

  it('parks browser.type into the code box but not into another field on the same page', async () => {
    const intoCode = makeGuard({ grants: [INPUT_GRANT], probe: codeBox(false, true) });
    const typed = resultOf(await intoCode.guard.prepareMutatingAction(
      { ...CONTEXT, selector: '#code' }, 'type', 'browser.type', '#code', 'Type it',
    ));
    expect(typed.reason).toBe('two_factor_unavailable_parked_to_escalation_queue');

    const elsewhere = makeGuard({ grants: [INPUT_GRANT], probe: codeBox(false, false) });
    const prep = await elsewhere.guard.prepareMutatingAction(
      { ...CONTEXT, selector: '#email' }, 'type', 'browser.type', '#email', 'Type the email',
    );
    expect(prep).toMatchObject({ grant: { id: 'input-grant' }, actionClass: 'input' });
  });

  it('checks every field of a shared-tab fill_form despite its fixed input classification', async () => {
    const probe = codeBox(false, true);
    const { guard } = makeGuard({ grants: [INPUT_GRANT], probe });

    const result = resultOf(await guard.prepareMutatingAction(
      { ...CONTEXT, fields: [{ selector: '#email' }, { uid: 'a11y-7' }] },
      'fill_form', 'browser.fill_form', '#email', 'Fill the form', { actionClass: 'input', hardStop: false },
    ));

    expect(result.reason).toBe('two_factor_unavailable_parked_to_escalation_queue');
    expect(probe).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'browser.fill_form', inputTargets: { selectors: ['#email'], uids: ['a11y-7'] },
    }));
  });

  it('keeps hint-only behaviour when the probe has no code box evidence (older extension)', async () => {
    const { guard, raise } = makeGuard({ grants: [CAMPAIGN_SUBMIT_GRANT], probe: async () => ({ detected: false }) });

    const prep = await guard.prepareMutatingAction(CONTEXT, 'click', 'browser.click', '#continue', 'Submit');

    expect(prep).toMatchObject({ grant: { id: 'g1' }, actionClass: 'submit' });
    expect(raise).not.toHaveBeenCalled();
  });
});

describe('BrowserGatewayActionGuard password box evidence (2026-11-07)', () => {
  const INPUT_GRANT: BrowserPermissionGrant = { ...CAMPAIGN_SUBMIT_GRANT, id: 'input-grant', allowedActionClasses: ['input'] };
  const box = (passwordField: boolean | undefined, targetIsCodeField = false) => vi.fn(async () => ({
    detected: false,
    oneTimeCode: { codeField: targetIsCodeField, filled: false, targetIsCodeField },
    ...(passwordField === undefined ? {} : { passwordField }),
  }));
  const type = (guard: BrowserGatewayActionGuard, hint: string) =>
    guard.prepareMutatingAction({ ...CONTEXT, selector: '#field' }, 'type', 'browser.type', '#field', hint);

  // Real descriptions from the approval log that stopped typing into ordinary boxes.
  it.each([
    'Pre-fill DBT Jaggaer username (non-secret)',
    'Enter the known business email only; do not handle a password.',
    'Set a non-secret description for the Community Tech Desk client secret.',
  ])('lets typing go ahead when the box is not a password box: %s', async (hint) => {
    const { guard, createRequest } = makeGuard({ grants: [INPUT_GRANT], probe: box(false) });
    expect(await type(guard, hint)).toMatchObject({ grant: { id: 'input-grant' }, actionClass: 'input' });
    expect(createRequest).not.toHaveBeenCalled();
  });

  it('stops typing into a real password box however the agent describes it', async () => {
    const { guard, createRequest } = makeGuard({ grants: [INPUT_GRANT], probe: box(true) });
    const result = resultOf(await type(guard, 'Fill in the second field'));
    expect(result).toMatchObject({ decision: 'requires_user', reason: CREDENTIAL_CHALLENGE_REASON });
    expect(createRequest).toHaveBeenCalledWith(expect.objectContaining({ actionClass: 'credential' }));
  });

  it('falls back to the agent\'s words only when the box could not be checked', async () => {
    const unknown = makeGuard({ grants: [INPUT_GRANT], probe: box(undefined) });
    expect(resultOf(await type(unknown.guard, 'Enter Instagram password')))
      .toMatchObject({ decision: 'requires_user', reason: CREDENTIAL_CHALLENGE_REASON });
    const plain = makeGuard({ grants: [INPUT_GRANT], probe: box(undefined) });
    expect(await type(plain.guard, 'Type the email')).toMatchObject({ actionClass: 'input' });
  });

  it('stops a shared-tab fill_form that writes a password box, despite its fixed input classification', async () => {
    const { guard } = makeGuard({ grants: [INPUT_GRANT], probe: box(true) });
    const result = resultOf(await guard.prepareMutatingAction(
      { ...CONTEXT, fields: [{ selector: '#user' }, { selector: '#pass' }] },
      'fill_form', 'browser.fill_form', '#user', 'Fill the sign-in form', { actionClass: 'input', hardStop: false },
    ));
    expect(result).toMatchObject({ decision: 'requires_user', reason: CREDENTIAL_CHALLENGE_REASON });
  });

  it('treats a masked sign-in code box as the two-factor step, not a password', async () => {
    const { guard, raise } = makeGuard({ grants: [INPUT_GRANT], probe: box(true, true) });
    const result = resultOf(await type(guard, 'Type the passcode'));
    expect(result.reason).toBe('two_factor_unavailable_parked_to_escalation_queue');
    expect(raise).toHaveBeenCalledWith(expect.objectContaining({ kind: 'two_factor_unavailable' }));
  });

  it('judges an inspected managed-tab box by its own type, not nearby words', async () => {
    const nearby = makeGuard({ grants: [INPUT_GRANT], managed: true, elementText: 'Username. Forgot password?' });
    expect(await type(nearby.guard, 'Type the username')).toMatchObject({ actionClass: 'input' });
  });
});

describe('BrowserGatewayActionGuard one-time code submit (British Council TAP, 2026-10-30)', () => {
  it('parks the "Validate OTP" click when Harness did not fill the code', async () => {
    const { guard, raise, result: audit } = makeGuard({ grants: [CAMPAIGN_SUBMIT_GRANT] });

    const result = resultOf(await guard.prepareMutatingAction(
      CONTEXT, 'click', 'browser.click', '#validate-otp', 'Validate OTP',
    ));

    expect(raise).toHaveBeenCalledWith(expect.objectContaining({ kind: 'two_factor_unavailable' }));
    expect(result.reason).toBe('two_factor_unavailable_parked_to_escalation_queue');
    // The parked step says the code will expire and names the path that works.
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'two_factor_unavailable_parked_to_escalation_queue',
      summary: expect.stringMatching(/expire[\s\S]*browser\.fill_credential/),
    }));
    expect(raise).toHaveBeenCalledWith(expect.objectContaining({ reason: expect.stringContaining('expire') }));
  });

  const PORTAL = 'https://portal.example.gov.uk';
  const clickValidate = (guard: BrowserGatewayActionGuard, context = CONTEXT) =>
    guard.prepareMutatingAction(context, 'click', 'browser.click', '#validate-otp', 'Validate OTP');

  it('checks the click as an ordinary submit after Harness filled the code on this tab', async () => {
    const ledger = new BrowserOneTimeCodeFillLedger();
    ledger.record({ instanceId: 'i1', profileId: 'p1', targetId: 't1', origin: PORTAL });
    const { guard, raise, createRequest, result } = makeGuard({ grants: [CAMPAIGN_SUBMIT_GRANT], oneTimeCodeFills: ledger });

    const prep = await clickValidate(guard);

    expect(prep).toMatchObject({ grant: { id: 'g1' }, actionClass: 'submit', origin: PORTAL });
    expect(raise).not.toHaveBeenCalled();
    expect(createRequest).not.toHaveBeenCalled();
    expect(result).toHaveBeenCalledWith(expect.objectContaining({
      reason: ONE_TIME_CODE_SUBMIT_REASON, actionClass: 'submit', decision: 'allowed', toolName: 'browser.click',
    }));
  });

  it('does the same on a managed profile, where the element itself is inspected', async () => {
    const ledger = new BrowserOneTimeCodeFillLedger();
    ledger.record({ instanceId: 'i1', profileId: 'p1', targetId: 't1', origin: PORTAL });
    const { guard, raise } = makeGuard({
      grants: [CAMPAIGN_SUBMIT_GRANT], oneTimeCodeFills: ledger, managed: true, elementText: 'Submit verification code',
    });

    const prep = await clickValidate(guard);

    expect(prep).toMatchObject({ grant: { id: 'g1' }, actionClass: 'submit' });
    expect(raise).not.toHaveBeenCalled();

    // Without the fill, the same inspected element parks.
    const unfilled = makeGuard({ grants: [CAMPAIGN_SUBMIT_GRANT], managed: true, elementText: 'Submit verification code' });
    expect(resultOf(await clickValidate(unfilled.guard)).reason).toBe('two_factor_unavailable_parked_to_escalation_queue');
  });

  it('releases only one click per fill', async () => {
    const ledger = new BrowserOneTimeCodeFillLedger();
    ledger.record({ instanceId: 'i1', profileId: 'p1', targetId: 't1', origin: PORTAL });
    const { guard, raise } = makeGuard({ grants: [CAMPAIGN_SUBMIT_GRANT], oneTimeCodeFills: ledger });

    await clickValidate(guard);
    const second = resultOf(await clickValidate(guard));

    expect(second.reason).toBe('two_factor_unavailable_parked_to_escalation_queue');
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['another tab', { instanceId: 'i1', profileId: 'p1', targetId: 't2', origin: PORTAL }],
    ['another origin', { instanceId: 'i1', profileId: 'p1', targetId: 't1', origin: 'https://evil.example' }],
    ['another session', { instanceId: 'i2', profileId: 'p1', targetId: 't1', origin: PORTAL }],
  ])('keeps parking when the fill was on %s', async (_label, scope) => {
    const ledger = new BrowserOneTimeCodeFillLedger();
    ledger.record(scope);
    const { guard, raise } = makeGuard({ grants: [CAMPAIGN_SUBMIT_GRANT], oneTimeCodeFills: ledger });

    const result = resultOf(await clickValidate(guard));

    expect(result.reason).toBe('two_factor_unavailable_parked_to_escalation_queue');
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it('keeps parking when the fill is older than the window', async () => {
    let now = 1_000;
    const ledger = new BrowserOneTimeCodeFillLedger(() => now);
    ledger.record({ instanceId: 'i1', profileId: 'p1', targetId: 't1', origin: PORTAL });
    now += ONE_TIME_CODE_SUBMIT_WINDOW_MS + 1;
    const { guard, raise } = makeGuard({ grants: [CAMPAIGN_SUBMIT_GRANT], oneTimeCodeFills: ledger });

    const result = resultOf(await clickValidate(guard));

    expect(result.reason).toBe('two_factor_unavailable_parked_to_escalation_queue');
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it('never releases typing into a two-factor field, and does not spend the fill on it', async () => {
    const ledger = new BrowserOneTimeCodeFillLedger();
    ledger.record({ instanceId: 'i1', profileId: 'p1', targetId: 't1', origin: PORTAL });
    const { guard, raise } = makeGuard({ grants: [CAMPAIGN_SUBMIT_GRANT], oneTimeCodeFills: ledger });

    const typed = resultOf(await guard.prepareMutatingAction(CONTEXT, 'type', 'browser.type', '#otp', 'Enter OTP'));
    expect(typed.reason).toBe('two_factor_unavailable_parked_to_escalation_queue');
    expect(raise).toHaveBeenCalledTimes(1);

    expect(await clickValidate(guard)).toMatchObject({ grant: { id: 'g1' }, actionClass: 'submit' });
  });

  it('still parks a live captcha after a code fill', async () => {
    const ledger = new BrowserOneTimeCodeFillLedger();
    ledger.record({ instanceId: 'i1', profileId: 'p1', targetId: 't1', origin: PORTAL });
    const { guard, raise } = makeGuard({
      grants: [CAMPAIGN_SUBMIT_GRANT], oneTimeCodeFills: ledger, probe: async () => ({ detected: true }),
    });

    const result = resultOf(await clickValidate(guard));

    expect(raise).toHaveBeenCalledWith(expect.objectContaining({ kind: 'captcha' }));
    expect(result.reason).toContain('captcha_parked');
  });

  it('still needs a submit grant: without one the click goes to approval, and the retry is released', async () => {
    const ledger = new BrowserOneTimeCodeFillLedger();
    ledger.record({ instanceId: 'i1', profileId: 'p1', targetId: 't1', origin: PORTAL });
    const grants: BrowserPermissionGrant[] = [];
    const { guard, raise, createRequest } = makeGuard({ grants, oneTimeCodeFills: ledger });

    const result = resultOf(await clickValidate(guard));

    expect(result.decision).toBe('requires_user');
    expect(raise).not.toHaveBeenCalled();
    expect(createRequest).toHaveBeenCalledWith(expect.objectContaining({ actionClass: 'submit' }));

    // The approval is granted; the agent retries the same click.
    grants.push(CAMPAIGN_SUBMIT_GRANT);
    expect(await clickValidate(guard)).toMatchObject({ grant: { id: 'g1' }, actionClass: 'submit' });
    expect(raise).not.toHaveBeenCalled();
  });

  it('checks a code click that also sets a password as an ordinary submit', async () => {
    const ledger = new BrowserOneTimeCodeFillLedger();
    ledger.record({ instanceId: 'i1', profileId: 'p1', targetId: 't1', origin: PORTAL });
    const { guard, raise } = makeGuard({ grants: [CAMPAIGN_SUBMIT_GRANT], oneTimeCodeFills: ledger });

    expect(await guard.prepareMutatingAction(
      CONTEXT, 'click', 'browser.click', '#verify', 'Verify OTP and set new password',
    )).toMatchObject({ grant: { id: 'g1' }, actionClass: 'submit' });
    expect(raise).not.toHaveBeenCalled();
  });

  it('keeps parking a code click that also makes a declaration', async () => {
    const ledger = new BrowserOneTimeCodeFillLedger();
    ledger.record({ instanceId: 'i1', profileId: 'p1', targetId: 't1', origin: PORTAL });
    const { guard, raise } = makeGuard({ grants: [CAMPAIGN_SUBMIT_GRANT], oneTimeCodeFills: ledger });

    const result = resultOf(await guard.prepareMutatingAction(
      CONTEXT, 'click', 'browser.click', '#verify', 'Verify OTP, I declare the details are accurate',
    ));

    expect(result.reason).toBe('two_factor_unavailable_parked_to_escalation_queue');
    expect(raise).toHaveBeenCalledTimes(1);
    // The fill was not spent, so the real verify button still works.
    expect(await clickValidate(guard)).toMatchObject({ grant: { id: 'g1' }, actionClass: 'submit' });
  });
});
