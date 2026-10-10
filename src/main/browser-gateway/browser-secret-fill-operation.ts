import type { BrowserActionClass, BrowserGatewayResult } from '@contracts/types/browser';
import type {
  BrowserGatewayContext,
  BrowserGatewayFillSecretRequest,
} from './browser-gateway-service-types';
import {
  credentialFailureCode,
  credentialFailureStep,
  resolveFillOrigin,
  type CredentialFillStep,
} from './browser-credential-fill-targeting';
import type { FillOperationDeps } from './browser-form-fill-operations';
import { buildCredentialAuthorizationDenial } from './browser-credential-authorization-denial';
import { verifyFilledSecret, type GenericSecretKind } from './browser-credential-vault';

/**
 * browser.fill_secret — the procurement secret broker. Fills GENERIC secret
 * fields (bank account number, sort code, IBAN, BIC/SWIFT, tax id, policy
 * number, or an arbitrary named vault field) into a page WITHOUT the value ever
 * entering model context, a tool result, a log, or the audit trail.
 *
 * Security contract (all enforced below):
 *  - The request carries only opaque references (vaultItemRef, semantic
 *    secretType, non-secret fieldName, selector) — never a secret.
 *  - The secret is resolved in the main process (folder-jailed + origin-bound)
 *    and typed straight into the page via the raw driver.
 *  - Authorized ONLY by a standing `secret_fill` CredentialAuthorization bound to
 *    (profile scope, live origin, semantic secret type, optional selector).
 *  - Verification is done IN THE WORKER by non-reversible digest comparison; the
 *    read-back value and the vault value both stay in-process. Only counts
 *    (filled / verified) are returned — never a value, digest, or masked shape.
 *  - Existing shared tabs re-confirm the live origin immediately before each type
 *    (TOCTOU) and require the operator opt-in, exactly like fill_credential.
 */
export async function fillSecretOperation(
  deps: FillOperationDeps,
  request: BrowserGatewayFillSecretRequest,
): Promise<BrowserGatewayResult<{ filled: number; verified: number } | null>> {
  const toolName = 'browser.fill_secret';
  const action = 'fill_secret';
  const context = contextOf(request);
  const opActionClass = operationActionClass(request.fields.map((field) => field.secretType));
  let origin = '';
  const deny = (reason: string, summary: string): BrowserGatewayResult<null> =>
    deps.result({
      context,
      profileId: request.profileId,
      targetId: request.targetId,
      action,
      toolName,
      actionClass: opActionClass,
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
  if (!vault.getGenericSecretForFill) {
    return deny('secret_broker_unavailable', `${toolName} generic-secret resolution is unavailable`);
  }
  if (request.fields.length === 0) {
    return deny('no_fields', `${toolName} requires at least one field`);
  }

  // Shared existing tabs stay managed-only unless the operator opted in; the
  // standing secret_fill authorization below still has to pass, so an
  // unauthorized origin/type can never be filled.
  const isExistingTab = deps.hasExistingTab(request.profileId, request.targetId);
  if (isExistingTab && !deps.sharedTabCredentialFillAllowed?.(request.profileId)) {
    return deny(
      'fill_secret_managed_profile_only',
      `${toolName} runs on agent-owned managed profiles only, not shared tabs`,
    );
  }
  if (isExistingTab && !deps.sharedTabSecureCredentialFillSupported?.(request.profileId)) {
    return deny(
      'shared_tab_secure_credential_fill_unavailable',
      `${toolName} requires a current secure Browser Gateway extension on this shared tab`,
    );
  }

  try {
    origin = await deps.refreshTargetOrigin(request.profileId, request.targetId);
  } catch {
    return deny('target_unavailable', `${toolName} could not resolve the live page origin`);
  }
  if (!origin) {
    return deny('origin_unknown', `${toolName} could not determine the live page origin`);
  }
  if (isExistingTab && !deps.sharedTabSecureCredentialFillSupported?.(request.profileId)) {
    return deny(
      'shared_tab_secure_credential_fill_unavailable',
      `${toolName} requires a current secure Browser Gateway extension on this shared tab`,
    );
  }
  // The tab's page origin is what the navigation re-check below watches.
  const pageOrigin = origin;

  // WHERE THE SECRET LANDS is the frame that holds the field (see
  // browser-credential-fill-targeting): a site may embed its form in a
  // cross-origin subframe, and the origin-bound writer only types into frames
  // of the receiving origin. Resolved before any secret exists in this process.
  const fillResolution = await resolveFillOrigin({
    toolName,
    profileId: request.profileId,
    targetId: request.targetId,
    fields: request.fields.map((field) => ({ selector: field.selector })),
    pageOrigin,
    ...(deps.resolveFieldFrameOrigin
      ? { resolveFieldFrameOrigin: deps.resolveFieldFrameOrigin }
      : {}),
  });
  if (fillResolution.denial) {
    return deny(fillResolution.denial.reason, fillResolution.denial.summary);
  }
  origin = fillResolution.fillOrigin;

  // Managed profiles authorize by their own id; a shared existing tab authorizes
  // by its stable node scope (its own profileId is per-tab/ephemeral).
  const authProfileId = deps.resolveCredentialProfileScope?.(request.profileId) ?? request.profileId;

  // Per-field authorization: every field must be covered by a live secret_fill
  // authorization for (origin, secret type, selector). Checked up front so no
  // secret is resolved before every field is authorized.
  for (const field of request.fields) {
    const decision = authorizations.check({
      profileId: authProfileId,
      origin,
      purpose: 'secret_fill',
      secretType: field.secretType,
      selector: field.selector,
    });
    if (!decision.authorized) {
      const denial = buildCredentialAuthorizationDenial(authorizations.list?.bind(authorizations), {
        toolName,
        origin,
        purpose: 'secret_fill',
        reason: decision.reason ?? 'unknown',
        scope: authProfileId,
        detail: field.secretType,
      });
      return deny(denial.reason, denial.summary);
    }
  }

  let filled = 0;
  let verified = 0;
  let secretObservationBlocked = false;
  let step: CredentialFillStep = 'secure_extension';
  // 1-based index of the field being worked on; starts at 1 so a failure before
  // the loop still names a real field position.
  let fieldIndex = 1;
  try {
    for (const field of request.fields) {
      // Revalidate at the last secret-free boundary. A disconnect or service-
      // worker replacement during origin/authorization work must prevent the
      // vault resolver from being called for the now-untrusted generation.
      step = 'secure_extension';
      if (isExistingTab && !deps.sharedTabSecureCredentialFillSupported?.(request.profileId)) {
        return deny(
          'shared_tab_secure_credential_fill_unavailable',
          `${toolName} requires a current secure Browser Gateway extension on this shared tab`,
        );
      }
      // Resolve the secret first (no page contact) so the origin re-check sits
      // back-to-back with the type command. It exists only in this scope.
      let secret: string;
      step = 'vault_resolve';
      if (request.vaultItemRef.startsWith('secret://')) {
        if (!deps.resolveWorkspaceSecret) {
          return deny(
            'workspace_secret_resolver_unavailable',
            `${toolName} cannot resolve a workspace secret on this instance`,
          );
        }
        try {
          secret = deps.resolveWorkspaceSecret({
            instanceId: request.instanceId,
            reference: request.vaultItemRef,
          });
        } catch {
          return deny(
            'workspace_secret_unresolved',
            `${toolName} could not resolve the workspace secret reference`,
          );
        }
      } else {
        secret = await vault.getGenericSecretForFill({
          vaultItemRef: request.vaultItemRef,
          origin,
          kind: field.secretType as GenericSecretKind,
          ...(field.fieldName ? { fieldName: field.fieldName } : {}),
        });
      }

      // TOCTOU: a shared tab is the user's real browser — re-confirm the live
      // origin still matches immediately before typing.
      step = 'origin_recheck';
      if (isExistingTab && !secretObservationBlocked) {
        let liveOrigin: string;
        try {
          liveOrigin = await deps.refreshTargetOrigin(request.profileId, request.targetId);
        } catch {
          return deny(
            'target_unavailable',
            `${toolName} could not re-confirm the live page origin before filling`,
          );
        }
        if (liveOrigin !== pageOrigin) {
          return deny(
            'origin_changed_during_fill',
            `${toolName} aborted: the tab navigated away from ${pageOrigin} before the secret was typed`,
          );
        }
      }
      if (isExistingTab && !deps.sharedTabSecureCredentialFillSupported?.(request.profileId)) {
        return deny(
          'shared_tab_secure_credential_fill_unavailable',
          `${toolName} aborted because the secure Browser Gateway extension changed before filling`,
        );
      }

      step = 'dispatch';
      const writeResult = await deps.driverType(
        request.profileId,
        request.targetId,
        field.selector,
        secret,
        origin,
        'secret',
        undefined,
        // `origin` is the receiving FRAME's origin (possibly a cross-origin
        // embedded form); the navigation guard watches the tab's page origin.
        pageOrigin,
      );
      step = 'write_confirmation';
      secretObservationBlocked = isExistingTab;
      filled += 1;

      // Worker-side verification: read the control back IN-PROCESS and compare by
      // non-reversible digest. The read-back value never leaves this function —
      // only the boolean result is kept.
      let writeVerified = writeResult?.valueApplied === true;
      if (!isExistingTab) {
        let readbackValue: string | undefined;
        try {
          readbackValue = (await deps.readControl(
            request.profileId,
            request.targetId,
            field.selector,
          )).value;
        } catch {
          readbackValue = undefined; // unverifiable → counts as not verified
        }
        writeVerified = verifyFilledSecret(secret, readbackValue);
      }
      if (writeVerified) {
        verified += 1;
      }
      fieldIndex += 1;
    }
  } catch (error) {
    // A driver/DOM error may quote the value it was asked to write, so an
    // exception from a secret-bearing operation is never surfaced verbatim:
    // only vault codes and the extension's fixed snake_case codes pass through
    // (see credentialFailureCode), and the reason prefixes the exact step.
    const code = credentialFailureCode(error, 'secret_fill_failed');
    const failureStep = credentialFailureStep(step, code);
    const failing = request.fields[fieldIndex - 1];
    return deps.result({
      context,
      profileId: request.profileId,
      targetId: request.targetId,
      action,
      toolName,
      actionClass: opActionClass,
      decision: 'denied',
      outcome: 'failed',
      reason: `${failureStep}:${code}`,
      summary: `${toolName} failed at ${failureStep} on field ${fieldIndex} of ${request.fields.length} `
        + `(${failing?.selector ?? 'unknown'}) after filling ${filled} field(s): ${code}`,
      data: null,
    });
  }

  const allVerified = verified === filled;
  return deps.result({
    context,
    profileId: request.profileId,
    targetId: request.targetId,
    action,
    toolName,
    actionClass: opActionClass,
    decision: 'allowed',
    outcome: allVerified ? 'succeeded' : 'failed',
    // Counts only — no value, digest, or masked shape reaches the model or audit.
    summary: `Filled ${filled} secret field(s) from the vault; verified ${verified}/${filled}`,
    ...(allVerified ? {} : { reason: 'secret_verification_failed' }),
    data: { filled, verified },
  });
}

/** Sensitive-identity secret types; the rest are financial-identity. */
const SENSITIVE_IDENTITY_SECRETS: ReadonlySet<GenericSecretKind> = new Set([
  'tax_identifier',
  'arbitrary_named_vault_field',
]);

/** Representative audit action class for a mixed set of secret fields. */
function operationActionClass(secretTypes: GenericSecretKind[]): BrowserActionClass {
  return secretTypes.some((type) => SENSITIVE_IDENTITY_SECRETS.has(type))
    ? 'sensitive_identity'
    : 'financial_identity';
}

function contextOf(request: BrowserGatewayContext): BrowserGatewayContext {
  return {
    ...(request.instanceId ? { instanceId: request.instanceId } : {}),
    ...(request.provider ? { provider: request.provider } : {}),
  };
}
