import type { BrowserFillHttpAuthResult, BrowserGatewayResult } from '@contracts/types/browser';
import type {
  BrowserGatewayContext,
  BrowserGatewayFillHttpAuthRequest,
} from './browser-gateway-service-types';
import type { FillOperationDeps } from './browser-form-fill-operations';
import type { CredentialPurpose } from './browser-credential-authorization-store';
import {
  credentialFailureCode,
  credentialFailureStep,
  type CredentialFillStep,
} from './browser-credential-fill-targeting';
import { buildCredentialAuthorizationDenial } from './browser-credential-authorization-denial';
import { resolveCredentialTaskScope } from './browser-credential-access-session';
import { resolveCredentialComputerId } from './browser-credential-access-runtime';
import { isLoopbackHost } from './browser-auto-approve';

/**
 * browser.fill_http_auth — answer Chrome's OWN Basic/Digest sign-in box (the
 * browser pop-up, not a page form) for a tab waiting on it, using the saved
 * login a standing `login` authorization already covers — the same approval
 * fill_credential uses (Decision 4).
 *
 * Security contract (all enforced below, every gate BEFORE the vault read):
 *  - The request carries only `{ profileId, targetId, vaultItemRef, url? }` —
 *    never a secret and never an origin field; the receiving origin is derived
 *    from `url` (defaulting to the tab's live URL) and checked against the
 *    live tab.
 *  - The vault is folder- + origin-jailed and refuses a login bound to another
 *    origin; only `username` and `password` kinds are read.
 *  - The password travels straight to the extension, which stages it in memory
 *    for exactly this one navigation and offers it only to challenges on that
 *    exact origin. It NEVER enters the page DOM, so the tab stays observable —
 *    the agent can carry on checking the site it just entered.
 *  - Plain http is refused (http_auth_insecure_origin) except loopback: Basic
 *    Auth over http sends the password unencrypted.
 */
export async function fillHttpAuthOperation(
  deps: FillOperationDeps,
  request: BrowserGatewayFillHttpAuthRequest,
): Promise<BrowserGatewayResult<BrowserFillHttpAuthResult | null>> {
  const toolName = 'browser.fill_http_auth';
  const action = 'fill_http_auth';
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
  const isExistingTab = deps.hasExistingTab(request.profileId, request.targetId);
  // Managed profiles answer prompts through Puppeteer's page.authenticate in a
  // later step (the plan's Phase 4 / Decision 5). Until then the shared-tab
  // extension path is the only dispatch this build has.
  if (!isExistingTab) {
    return deny(
      'http_auth_managed_profiles_unsupported',
      `${toolName} answers Chrome's HTTP sign-in prompt on shared existing tabs only for now`,
    );
  }
  // Shared existing tabs are the user's real browser: same operator opt-in as
  // fill_credential, and the standing-authorization gate below still applies.
  if (!deps.sharedTabCredentialFillAllowed?.(request.profileId)) {
    return deny(
      'http_auth_shared_tab_not_allowed',
      `${toolName} runs on shared existing tabs only with the operator's browserAllowSharedTabCredentialFill opt-in`,
    );
  }
  if (!deps.sharedTabSecureHttpAuthSupported?.(request.profileId, request.targetId)) {
    return deny(
      'shared_tab_http_auth_unavailable',
      `${toolName} requires a current Browser Gateway extension on this shared tab that can answer HTTP sign-in prompts`,
    );
  }

  // Which URL are we signing into? Default: the tab's own current URL (the
  // request that is sitting unanswered). When the tab shows Chrome's error or
  // a blank page there is no usable default and the caller must pass `url` —
  // that is the one case the plan allows a url beyond the page origin.
  let effectiveUrl: string;
  let pageOrigin: string;
  if (request.url) {
    effectiveUrl = request.url;
    try {
      pageOrigin = await deps.refreshTargetOrigin(request.profileId, request.targetId);
    } catch {
      return deny('target_unavailable', `${toolName} could not resolve the live page origin`);
    }
    if (!pageOrigin) {
      // Chrome error / blank page: fall through to the authorization gate,
      // which must cover the target origin ("or with the authorised origin").
      pageOrigin = '';
    }
  } else {
    let liveUrl = '';
    try {
      liveUrl = await deps.readTargetUrl?.(request.profileId, request.targetId) ?? '';
    } catch {
      liveUrl = '';
    }
    const parsedLive = parseHttpUrl(liveUrl);
    if (!parsedLive) {
      return deny(
        'invalid_url',
        `${toolName} could not read a usable http(s) URL from the tab; pass url explicitly`,
      );
    }
    effectiveUrl = parsedLive.href;
    pageOrigin = parsedLive.origin;
  }

  const parsedUrl = parseHttpUrl(effectiveUrl);
  if (!parsedUrl) {
    return deny('invalid_url', `${toolName} requires a valid http(s) url`);
  }
  const urlOrigin = parsedUrl.origin;
  // Basic Auth over plain http sends the password unencrypted. Only https, or
  // the machine talking to itself (loopback), may carry it.
  if (parsedUrl.protocol === 'http:' && !isLoopbackHost(parsedUrl.hostname)) {
    return deny(
      'http_auth_insecure_origin',
      `${toolName} refuses to send a saved password over plain http to ${urlOrigin}`,
    );
  }
  // The navigation must stay on the page the tab is already showing — a
  // credential authorised for one site is never walked onto another.
  if (pageOrigin && pageOrigin !== urlOrigin) {
    return deny(
      'http_auth_origin_mismatch',
      `${toolName} refuses to sign into ${urlOrigin} while the tab is on ${pageOrigin}`,
    );
  }
  // The denial/audit `origin` is the origin that receives the credential.
  origin = urlOrigin;

  const authProfileId = deps.resolveCredentialProfileScope?.(request.profileId) ?? request.profileId;
  const checkAuthorization = (purpose: CredentialPurpose) => authorizations.check({
    profileId: authProfileId,
    origin,
    purpose,
    taskScope: resolveCredentialTaskScope(request.instanceId),
    vaultItemRef: request.vaultItemRef,
    computerId: deps.resolveCredentialComputerId?.(request.profileId, request.targetId)
      ?? resolveCredentialComputerId(request.profileId, request.targetId),
  });

  // Reuse the standing `login` approval (Decision 4): a site already approved
  // for form login may also answer its HTTP prompt with the same saved login.
  // No selector is passed: an authorization narrowed to specific controls does
  // not cover a prompt that has no controls at all.
  const decision = checkAuthorization('login');
  if (!decision.authorized) {
    const denial = buildCredentialAuthorizationDenial(authorizations.list?.bind(authorizations), {
      toolName,
      origin,
      purpose: 'login',
      reason: decision.reason ?? 'unknown',
      scope: authProfileId,
    });
    return deny(denial.reason, denial.summary);
  }

  let step: CredentialFillStep = 'fill_guard';
  try {
    const assertFillUnlocked = vault.captureFillGuard?.();
    step = 'fill_guard';
    assertFillUnlocked?.();
    step = 'authorization';
    if (!checkAuthorization('login').authorized) {
      return deny('credential_authorization_changed', `${toolName} permission is no longer valid`);
    }
    // Re-check the exact extension runtime immediately before asking the vault
    // to resolve anything, so a reload during the checks above cannot let an
    // unsafe generation receive the credential.
    step = 'secure_extension';
    if (!deps.sharedTabSecureHttpAuthSupported?.(request.profileId, request.targetId)) {
      return deny(
        'shared_tab_http_auth_unavailable',
        `${toolName} aborted because the Browser Gateway extension changed before answering`,
      );
    }
    // The secrets exist only in this main-process scope: resolved first (no
    // page contact) so the origin re-check below sits back-to-back with the
    // dispatch. The vault enforces folder jail + origin binding per read.
    step = 'vault_resolve';
    const username = await vault.getSecretForFill({
      vaultItemRef: request.vaultItemRef,
      origin,
      kind: 'username',
    });
    const password = await vault.getSecretForFill({
      vaultItemRef: request.vaultItemRef,
      origin,
      kind: 'password',
    });
    // A shared tab is the user's real browser: they can navigate it between the
    // checks and this dispatch. Re-confirm the live origin still matches the
    // authorised one immediately before answering, so the credential can never
    // land on a page we never authorized (TOCTOU).
    step = 'origin_recheck';
    let liveOrigin: string;
    try {
      liveOrigin = await deps.refreshTargetOrigin(request.profileId, request.targetId);
    } catch {
      return deny(
        'target_unavailable',
        `${toolName} could not re-confirm the live page origin before answering`,
      );
    }
    if (liveOrigin && liveOrigin !== urlOrigin) {
      return deny(
        'origin_changed_during_fill',
        `${toolName} aborted: the tab navigated away from ${urlOrigin} before the prompt was answered`,
      );
    }
    step = 'secure_extension';
    if (!deps.sharedTabSecureHttpAuthSupported?.(request.profileId, request.targetId)) {
      return deny(
        'shared_tab_http_auth_unavailable',
        `${toolName} aborted because the secure Browser Gateway extension changed before answering`,
      );
    }
    step = 'authorization';
    if (!checkAuthorization('login').authorized) {
      return deny('credential_authorization_changed', `${toolName} permission changed before answering`);
    }
    step = 'pre_dispatch_guard';
    assertFillUnlocked?.();
    step = 'dispatch';
    const dispatched = await deps.httpAuthNavigate(
      request.profileId,
      request.targetId,
      {
        url: parsedUrl.href,
        credentialOrigin: urlOrigin,
        username,
        password,
        protection: 'password',
      },
      () => {
        step = 'pre_dispatch_guard';
        assertFillUnlocked?.();
        if (!checkAuthorization('login').authorized) {
          throw new Error('credential_authorization_changed');
        }
        if (!deps.sharedTabSecureHttpAuthSupported?.(request.profileId, request.targetId)) {
          throw new Error('shared_tab_http_auth_unavailable');
        }
        step = 'dispatch';
      },
    );

    if (dispatched.httpAuth === 'rejected') {
      // Fixed vocabulary only. The prompt was cancelled and will not loop; the
      // saved password is simply wrong for this site.
      return deps.result({
        context,
        profileId: request.profileId,
        targetId: request.targetId,
        action,
        toolName,
        actionClass: 'credential',
        decision: 'denied',
        outcome: 'failed',
        reason: 'http_auth_rejected',
        summary: `${toolName}: the site refused this saved login on ${origin}. The prompt was cancelled and will not loop; do not ask the user to type it — the saved password is wrong for this site.`,
        origin,
        data: { httpAuth: 'rejected' },
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
      summary: dispatched.httpAuth === 'answered'
        ? `Answered the sign-in prompt on ${origin} from the saved login`
        : `Navigated to ${origin} but no sign-in prompt appeared (already signed in, or this URL does not challenge)`,
      origin,
      data: {
        httpAuth: dispatched.httpAuth,
        ...(dispatched.tab ? { tab: dispatched.tab } : {}),
      },
    });
  } catch (error) {
    // Fixed `<step>:<code>` pair: only vault codes and the extension's fixed
    // snake_case codes pass through, everything else collapses to the fixed
    // fallback (a Chrome/page error may quote the credential it was given).
    const code = credentialFailureCode(error, 'http_auth_fill_failed');
    const failureStep = credentialFailureStep(step, code);
    return deps.result({
      context,
      profileId: request.profileId,
      targetId: request.targetId,
      action,
      toolName,
      actionClass: 'credential',
      decision: 'denied',
      outcome: 'failed',
      reason: `${failureStep}:${code}`,
      summary: `${toolName} failed at ${failureStep}: ${code}`,
      origin,
      data: null,
    });
  }
}

function parseHttpUrl(value: string): URL | null {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

function contextOf(request: BrowserGatewayContext): BrowserGatewayContext {
  return {
    ...(request.instanceId ? { instanceId: request.instanceId } : {}),
    ...(request.provider ? { provider: request.provider } : {}),
  };
}
