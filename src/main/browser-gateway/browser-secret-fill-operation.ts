import type { BrowserActionClass, BrowserGatewayResult } from '@contracts/types/browser';
import type {
  BrowserGatewayContext,
  BrowserGatewayFillSecretRequest,
} from './browser-gateway-service-types';
import type { FillOperationDeps } from './browser-form-fill-operations';
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

  let origin: string;
  try {
    origin = await deps.refreshTargetOrigin(request.profileId, request.targetId);
  } catch {
    return deny('target_unavailable', `${toolName} could not resolve the live page origin`);
  }
  if (!origin) {
    return deny('origin_unknown', `${toolName} could not determine the live page origin`);
  }

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
      return deny(
        `secret_not_authorized:${decision.reason ?? 'unknown'}`,
        `${toolName} is not authorized for ${origin} (${field.secretType})`,
      );
    }
  }

  let filled = 0;
  let verified = 0;
  try {
    for (const field of request.fields) {
      // Resolve the secret first (no page contact) so the origin re-check sits
      // back-to-back with the type command. It exists only in this scope.
      const secret = await vault.getGenericSecretForFill({
        vaultItemRef: request.vaultItemRef,
        origin,
        kind: field.secretType as GenericSecretKind,
        ...(field.fieldName ? { fieldName: field.fieldName } : {}),
      });

      // TOCTOU: a shared tab is the user's real browser — re-confirm the live
      // origin still matches immediately before typing.
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

      // Worker-side verification: read the control back IN-PROCESS and compare by
      // non-reversible digest. The read-back value never leaves this function —
      // only the boolean result is kept.
      let readbackValue: string | undefined;
      try {
        readbackValue = (await deps.readControl(request.profileId, request.targetId, field.selector)).value;
      } catch {
        readbackValue = undefined; // unverifiable → counts as not verified
      }
      if (verifyFilledSecret(secret, readbackValue)) {
        verified += 1;
      }
    }
  } catch (error) {
    return deps.result({
      context,
      profileId: request.profileId,
      targetId: request.targetId,
      action,
      toolName,
      actionClass: opActionClass,
      decision: 'denied',
      outcome: 'failed',
      // Vault errors are code-only (never a value); safe to surface.
      reason: error instanceof Error ? error.message : 'secret_fill_failed',
      summary: `${toolName} failed after filling ${filled} field(s)`,
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
