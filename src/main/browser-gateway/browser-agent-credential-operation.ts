import type {
  BrowserGatewayCreateAgentCredentialRequest,
} from './browser-gateway-service-types';
import type { BrowserGatewayResult } from '@contracts/types/browser';
import { credentialFailureCode } from './browser-credential-fill-targeting';
import { buildCredentialAuthorizationDenial } from './browser-credential-authorization-denial';
import { contextOf, type FillOperationDeps } from './browser-form-fill-operations';

/**
 * browser.create_agent_credential, split out of browser-form-fill-operations.ts
 * to keep that file under its size ceiling. It shares that file's deps facade.
 */

export async function createAgentCredentialOperation(
  deps: FillOperationDeps,
  request: BrowserGatewayCreateAgentCredentialRequest,
): Promise<BrowserGatewayResult<{ vaultItemRef: string; username: string } | null>> {
  const toolName = 'browser.create_agent_credential';
  const action = 'create_agent_credential';
  const context = contextOf(request);
  let origin = '';
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
      ...(origin ? { origin } : {}),
      data: null,
    });

  const vault = deps.credentialVault;
  const authorizations = deps.credentialAuthorizations;
  if (!vault || !authorizations) {
    return deny('credential_vault_unavailable', `${toolName} is not configured on this instance`);
  }
  // Never let an extension-shaped caller fall through to the managed driver.
  // Shared-tab profile ids encode the worker node used by authorization scope,
  // so the trusted extension store must contain this exact profile/target pair
  // before any caller-controlled node id can influence a grant lookup.
  if (
    request.profileId.startsWith('existing-tab:') &&
    !deps.hasExistingTab(request.profileId, request.targetId)
  ) {
    return deny('target_unavailable', `${toolName} could not resolve the shared browser target`);
  }
  let liveOrigin: string;
  try {
    liveOrigin = await deps.refreshTargetOrigin(request.profileId, request.targetId);
  } catch {
    return deny('target_unavailable', `${toolName} could not resolve the live page origin`);
  }
  if (!liveOrigin) {
    return deny('origin_unknown', `${toolName} could not determine the live page origin`);
  }

  origin = liveOrigin;
  if (request.loginUri) {
    const parsed = parseCredentialLoginUri(request.loginUri);
    if (!parsed) {
      return deny(
        'invalid_login_uri',
        `${toolName} requires an http(s) login URI without embedded credentials`,
      );
    }
    origin = parsed.origin;
  }

  // The target was proved live above before its scope can authorize anything.
  // Shared extension tabs have ephemeral profile ids, so register permission is
  // checked against their stable worker-node scope. The explicit login URI can
  // differ from the currently shared Meta tab, but the credential remains bound
  // exactly to that URI's origin; fill_credential still refuses every other origin.
  const authProfileId = deps.resolveCredentialProfileScope?.(request.profileId) ?? request.profileId;
  const decision = authorizations.check({ profileId: authProfileId, origin, purpose: 'register' });
  if (!decision.authorized) {
    const denial = buildCredentialAuthorizationDenial(authorizations.list?.bind(authorizations), {
      toolName,
      origin,
      purpose: 'register',
      reason: decision.reason ?? 'unknown',
      scope: authProfileId,
    });
    return deny(denial.reason, denial.summary);
  }

  try {
    const created = await vault.createAgentCredential({
      origin,
      ...(request.itemTitle ? { itemTitle: request.itemTitle } : {}),
      ...(request.loginUri ? { loginUri: request.loginUri } : {}),
      username: request.username,
    });
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
      data: { vaultItemRef: created.vaultItemRef, username: created.username },
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
      reason: credentialFailureCode(error, 'create_agent_credential_failed'),
      summary: `${toolName} failed`,
      data: null,
    });
  }
}

function parseCredentialLoginUri(value: string): URL | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}
