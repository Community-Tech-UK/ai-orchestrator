import { getDomain } from 'tldts';
import type {
  BrowserGatewayContext,
  BrowserGatewayExecuteFillPlanRequest,
  BrowserGatewayFillCredentialRequest,
  BrowserGatewayCreateAgentCredentialRequest,
} from './browser-gateway-service-types';
import type { BrowserGatewayResult } from '@contracts/types/browser';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type { CredentialPurpose } from './browser-credential-authorization-store';
import type { CredentialVault, CredentialFieldKind } from './browser-credential-vault';
import type { CredentialAuthorizationService } from './browser-credential-authorization-store';
import type { BrowserEmailCodeReader } from './browser-email-code-reader';
import {
  executeFillPlan as runFillPlan,
  validateFillPlan,
  type FillPlanBrowserOps,
  type FillControlReadback,
  type FillPlanResult,
} from './browser-fill-plan-executor';

/**
 * The two compound form-fill service operations (execute_fill_plan +
 * fill_credential) extracted from browser-gateway-service.ts. They take an
 * explicit deps facade rather than `this` so the (large) service file stays
 * under its size ceiling and the operations are independently readable.
 */

type GuardedMutation = (req: {
  instanceId?: string;
  provider?: string;
  profileId: string;
  targetId: string;
  selector: string;
  value?: string;
}) => Promise<BrowserGatewayResult<unknown>>;

export interface FillOperationDeps {
  result: <T>(input: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
  hasExistingTab: (profileId: string, targetId: string) => boolean;
  /**
   * Operator opt-in: may fill_credential / execute_fill_plan run on the user's
   * SHARED existing tabs (not just managed profiles)? Default absent = false, so
   * the shared-tab denies behave byte-for-byte as before. A standing
   * authorization is still required on top of this flag.
   */
  sharedTabCredentialFillAllowed?: (profileId: string) => boolean;
  /**
   * Map a live target profileId to the profile scope the credential
   * authorization is keyed by. Identity for managed profiles; for a shared
   * existing tab it returns the stable node scope (nodeId, or 'local') because
   * the tab's own profileId is ephemeral. Default absent = identity.
   */
  resolveCredentialProfileScope?: (profileId: string) => string;
  /** Guarded per-action service methods (they classify + grant-check + audit). */
  type: GuardedMutation;
  select: GuardedMutation;
  click: (req: {
    instanceId?: string;
    provider?: string;
    profileId: string;
    targetId: string;
    selector: string;
  }) => Promise<BrowserGatewayResult<unknown>>;
  readControl: (profileId: string, targetId: string, selector: string) => Promise<FillControlReadback>;
  /**
   * Raw driver type — bypasses the classifier's credential hard-stop. Used ONLY
   * by fill_credential, which is authorized by a standing credential
   * authorization instead of per-action approval.
   */
  driverType: (profileId: string, targetId: string, selector: string, value: string) => Promise<void>;
  refreshTargetOrigin: (profileId: string, targetId: string) => Promise<string>;
  credentialVault?: Pick<CredentialVault, 'getSecretForFill' | 'createAgentCredential'>;
  credentialAuthorizations?: Pick<CredentialAuthorizationService, 'check'>;
  /** Mailbox one-time-code reader; absent = email_code fills unavailable. */
  emailCodeReader?: Pick<BrowserEmailCodeReader, 'fetchCode'>;
  /** Count successful agent-owned account creation against a campaign lease. */
  recordNewAccount?: (request: BrowserGatewayCreateAgentCredentialRequest & { url: string }) => void;
}

export async function executeFillPlanOperation(
  deps: FillOperationDeps,
  request: BrowserGatewayExecuteFillPlanRequest,
): Promise<BrowserGatewayResult<FillPlanResult | null>> {
  const toolName = 'browser.execute_fill_plan';
  const action = 'execute_fill_plan';
  const context = contextOf(request);

  // Shared existing tabs are managed-only UNLESS the operator has opted in. When
  // allowed, every step still routes through the per-action guard (grants +
  // classification + audit) and read-back runs via the extension, so the only
  // thing the flag unlocks is the shared-tab surface itself.
  if (
    deps.hasExistingTab(request.profileId, request.targetId) &&
    !deps.sharedTabCredentialFillAllowed?.(request.profileId)
  ) {
    return deps.result({
      context,
      profileId: request.profileId,
      targetId: request.targetId,
      action,
      toolName,
      actionClass: 'input',
      decision: 'denied',
      outcome: 'not_run',
      reason: 'execute_fill_plan_managed_profile_only',
      summary: `${toolName} runs on managed browser profiles only, not shared existing tabs`,
      data: null,
    });
  }

  const validationError = validateFillPlan(request.steps);
  if (validationError) {
    return deps.result({
      context,
      profileId: request.profileId,
      targetId: request.targetId,
      action,
      toolName,
      actionClass: 'input',
      decision: 'denied',
      outcome: 'not_run',
      reason: validationError,
      summary: `${toolName} rejected an invalid plan: ${validationError}`,
      data: null,
    });
  }

  const base = { ...context, profileId: request.profileId, targetId: request.targetId };
  const throwIfNotApplied = (label: string, result: BrowserGatewayResult<unknown>): void => {
    if (result.decision !== 'allowed' || result.outcome !== 'succeeded') {
      throw new Error(
        result.reason ? `${label}: ${result.reason}` : `${label}: ${result.decision}/${result.outcome}`,
      );
    }
  };

  const ops: FillPlanBrowserOps = {
    setValue: async (target, value) => {
      throwIfNotApplied('set', await deps.type({ ...base, selector: target, value }));
    },
    selectOption: async (target, value) => {
      throwIfNotApplied('select', await deps.select({ ...base, selector: target, value }));
    },
    setChecked: async (target, checked) => {
      const state = await deps.readControl(request.profileId, request.targetId, target);
      if (state.checked !== checked) {
        throwIfNotApplied('check', await deps.click({ ...base, selector: target }));
      }
    },
    save: async (target) => {
      throwIfNotApplied('section_save', await deps.click({ ...base, selector: target }));
    },
    read: async (target) => deps.readControl(request.profileId, request.targetId, target),
  };

  const planResult = await runFillPlan(request.steps, {
    ops,
    ...(typeof request.maxAttempts === 'number' ? { maxAttempts: request.maxAttempts } : {}),
  });

  const failed = planResult.failedAt !== undefined ? planResult.steps[planResult.failedAt] : undefined;
  return deps.result({
    context,
    profileId: request.profileId,
    targetId: request.targetId,
    action,
    toolName,
    actionClass: 'input',
    decision: 'allowed',
    outcome: planResult.ok ? 'succeeded' : 'failed',
    summary: planResult.ok
      ? `Filled and verified ${planResult.steps.length} field(s)`
      : `Fill plan failed at step ${planResult.failedAt} (${failed?.field ?? 'unknown'})`,
    ...(failed ? { reason: failed.error ?? `read-back did not match for "${failed.field}"` } : {}),
    data: planResult,
  });
}

export async function fillCredentialOperation(
  deps: FillOperationDeps,
  request: BrowserGatewayFillCredentialRequest,
): Promise<BrowserGatewayResult<{ filled: number } | null>> {
  const toolName = 'browser.fill_credential';
  const action = 'fill_credential';
  const context = contextOf(request);
  const deny = (reason: string, summary: string): BrowserGatewayResult<null> =>
    deps.result({
      context,
      profileId: request.profileId,
      targetId: request.targetId,
      action,
      toolName,
      actionClass: 'credential',
      decision: 'denied',
      outcome: 'not_run',
      reason,
      summary,
      data: null,
    });

  const vault = deps.credentialVault;
  const authorizations = deps.credentialAuthorizations;
  if (!vault || !authorizations) {
    return deny('credential_vault_unavailable', `${toolName} is not configured on this instance`);
  }
  // Shared existing tabs stay managed-only unless the operator opted in via
  // `browserAllowSharedTabCredentialFill`. The flag only unlocks the surface;
  // the standing-authorization gate below still has to pass for the resolved
  // node scope + live origin, so an unauthorized origin can never be filled.
  const isExistingTab = deps.hasExistingTab(request.profileId, request.targetId);
  if (isExistingTab && !deps.sharedTabCredentialFillAllowed?.(request.profileId)) {
    return deny(
      'fill_credential_managed_profile_only',
      `${toolName} runs on agent-owned managed profiles only, not shared tabs`,
    );
  }
  if (request.fields.length === 0) {
    return deny('no_fields', `${toolName} requires at least one field`);
  }

  let origin: string;
  try {
    origin = await deps.refreshTargetOrigin(request.profileId, request.targetId);
  } catch {
    return deny('target_unavailable', `${toolName} could not resolve the live page origin`);
  }
  if (!origin) {
    return deny('origin_unknown', `${toolName} could not determine the live page origin`);
  }

  const hasEmailCodeField = request.fields.some((field) => field.kind === 'email_code');
  if (hasEmailCodeField && !deps.emailCodeReader) {
    return deny('email_code_reader_unavailable', `${toolName} has no mailbox reader configured`);
  }

  // Managed profiles authorize by their own id; a shared existing tab authorizes
  // by its stable node scope (its own profileId is per-tab/ephemeral).
  const authProfileId = deps.resolveCredentialProfileScope?.(request.profileId) ?? request.profileId;

  const purposes = new Set<CredentialPurpose>();
  for (const field of request.fields) {
    purposes.add(
      field.kind === 'totp' ? 'totp' : field.kind === 'email_code' ? 'email_code' : 'login',
    );
  }
  for (const purpose of purposes) {
    const decision = authorizations.check({ profileId: authProfileId, origin, purpose });
    if (!decision.authorized) {
      return deny(
        `credential_not_authorized:${decision.reason ?? 'unknown'}`,
        `${toolName} is not authorized for ${origin} (${purpose})`,
      );
    }
  }

  let emailSenderDomains: string[] | null = null;
  if (hasEmailCodeField) {
    emailSenderDomains = resolveEmailSenderDomains(origin, request.emailCode?.senderDomains);
    if (!emailSenderDomains) {
      return deny(
        'email_code_sender_domain_not_allowed',
        `${toolName} rejected sender domains unrelated to ${origin}`,
      );
    }
  }

  let filled = 0;
  try {
    for (const field of request.fields) {
      // The secret exists only in this main-process scope; it is typed into the
      // page and never returned or logged. Resolve it first (no page contact) so the
      // origin re-check below sits back-to-back with the type command.
      const secret =
        field.kind === 'email_code'
          ? await resolveEmailCode(deps.emailCodeReader!, emailSenderDomains!, request.emailCode)
          : await vault.getSecretForFill({
              vaultItemRef: request.vaultItemRef,
              origin,
              kind: field.kind as CredentialFieldKind,
            });
      // A shared tab is the user's real browser: they can navigate it between the
      // authorization check and this type. Re-confirm the live origin still matches the
      // authorized one immediately before typing, so a secret can never land on a page we
      // never authorized (TOCTOU). Managed profiles are agent-controlled — left untouched.
      if (isExistingTab) {
        let liveOrigin: string;
        try {
          liveOrigin = await deps.refreshTargetOrigin(request.profileId, request.targetId);
        } catch {
          return deny(
            'target_unavailable',
            `${toolName} could not re-confirm the live page origin before filling`,
          );
        }
        if (liveOrigin !== origin) {
          return deny(
            'origin_changed_during_fill',
            `${toolName} aborted: the tab navigated away from ${origin} before the secret was typed`,
          );
        }
      }
      await deps.driverType(request.profileId, request.targetId, field.selector, secret);
      filled += 1;
    }
  } catch (error) {
    return deps.result({
      context,
      profileId: request.profileId,
      targetId: request.targetId,
      action,
      toolName,
      actionClass: 'credential',
      decision: 'denied',
      outcome: 'failed',
      reason: error instanceof Error ? error.message : 'credential_fill_failed',
      summary: `${toolName} failed after filling ${filled} field(s)`,
      data: null,
    });
  }

  return deps.result({
    context,
    profileId: request.profileId,
    targetId: request.targetId,
    action,
    toolName,
    actionClass: 'credential',
    decision: 'allowed',
    outcome: 'succeeded',
    summary: `Filled ${filled} credential field(s) from the vault`,
    data: { filled },
  });
}

export async function createAgentCredentialOperation(
  deps: FillOperationDeps,
  request: BrowserGatewayCreateAgentCredentialRequest,
): Promise<BrowserGatewayResult<{ vaultItemRef: string; username: string } | null>> {
  const toolName = 'browser.create_agent_credential';
  const action = 'create_agent_credential';
  const context = contextOf(request);
  const deny = (reason: string, summary: string): BrowserGatewayResult<null> =>
    deps.result({
      context,
      profileId: request.profileId,
      targetId: request.targetId,
      action,
      toolName,
      actionClass: 'credential',
      decision: 'denied',
      outcome: 'not_run',
      reason,
      summary,
      data: null,
    });

  const vault = deps.credentialVault;
  const authorizations = deps.credentialAuthorizations;
  if (!vault || !authorizations) {
    return deny('credential_vault_unavailable', `${toolName} is not configured on this instance`);
  }
  if (deps.hasExistingTab(request.profileId, request.targetId)) {
    return deny(
      'create_agent_credential_managed_profile_only',
      `${toolName} runs on agent-owned managed profiles only, not shared tabs`,
    );
  }

  let origin: string;
  try {
    origin = await deps.refreshTargetOrigin(request.profileId, request.targetId);
  } catch {
    return deny('target_unavailable', `${toolName} could not resolve the live page origin`);
  }
  if (!origin) {
    return deny('origin_unknown', `${toolName} could not determine the live page origin`);
  }

  const decision = authorizations.check({ profileId: request.profileId, origin, purpose: 'register' });
  if (!decision.authorized) {
    return deny(
      `credential_not_authorized:${decision.reason ?? 'unknown'}`,
      `${toolName} is not authorized to register accounts on ${origin}`,
    );
  }

  try {
    const created = await vault.createAgentCredential({ origin, username: request.username });
    deps.recordNewAccount?.({ ...request, url: origin });
    return deps.result({
      context,
      profileId: request.profileId,
      targetId: request.targetId,
      action,
      toolName,
      actionClass: 'credential',
      decision: 'allowed',
      outcome: 'succeeded',
      summary: `Created a vaulted credential for ${request.username} on ${origin}`,
      // Returns a reference + username only — the generated password stays in the vault.
      data: created,
    });
  } catch (error) {
    return deps.result({
      context,
      profileId: request.profileId,
      targetId: request.targetId,
      action,
      toolName,
      actionClass: 'credential',
      decision: 'denied',
      outcome: 'failed',
      reason: error instanceof Error ? error.message : 'create_agent_credential_failed',
      summary: `${toolName} failed`,
      data: null,
    });
  }
}

function contextOf(request: BrowserGatewayContext): BrowserGatewayContext {
  return {
    ...(request.instanceId ? { instanceId: request.instanceId } : {}),
    ...(request.provider ? { provider: request.provider } : {}),
  };
}

const DEFAULT_EMAIL_CODE_WINDOW_MS = 15 * 60 * 1000;

/**
 * Validate agent-supplied sender domains against the live page origin: each
 * domain must equal the origin host, be a subdomain of it, or share the same
 * REGISTRABLE domain (public-suffix aware via tldts). This keeps email_code
 * disambiguation scoped to the site being filled — an agent can never point
 * the reader at an unrelated inbox sender (e.g. a bank) to harvest someone
 * else's code, and a public suffix like 'co.uk' or 'github.io' is never
 * accepted as "related" (its registrable domain is null). Hosts without a
 * registrable domain (localhost, IPs) fail closed to exact/subdomain matches.
 * Returns null when any domain fails; defaults to [originHost] when none are
 * supplied.
 */
export function resolveEmailSenderDomains(
  origin: string,
  requested: string[] | undefined,
): string[] | null {
  let host: string;
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!requested || requested.length === 0) {
    return [host];
  }
  // allowPrivateDomains: platform suffixes (github.io, netlify.app, …) are
  // boundaries too — two tenants of one platform are unrelated parties.
  const PSL_OPTIONS = { allowPrivateDomains: true };
  const registrable = getDomain(host, PSL_OPTIONS);
  const related = (domain: string): boolean => {
    if (domain === host || domain.endsWith(`.${host}`)) {
      return true;
    }
    return registrable !== null && getDomain(domain, PSL_OPTIONS) === registrable;
  };
  const normalized = requested.map((domain) => domain.trim().toLowerCase());
  return normalized.every((domain) => domain.length > 0 && related(domain))
    ? normalized
    : null;
}

async function resolveEmailCode(
  reader: Pick<BrowserEmailCodeReader, 'fetchCode'>,
  senderDomains: string[],
  options: { sinceMs?: number; withinMs?: number } | undefined,
): Promise<string> {
  const withinMs = options?.withinMs ?? DEFAULT_EMAIL_CODE_WINDOW_MS;
  const result = await reader.fetchCode({
    expectedSenderDomains: senderDomains,
    sinceMs: options?.sinceMs ?? Date.now() - withinMs,
    withinMs,
  });
  return result.code;
}
