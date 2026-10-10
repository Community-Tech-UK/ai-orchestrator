import type { CredentialVaultError } from './browser-credential-vault';
import {
  CREDENTIAL_VAULT_ERROR_CODES,
  WRITE_CONFIRMATION_CODES,
} from './browser-credential-vault-codes';

/**
 * Credential fill targeting and failure classification.
 *
 * Two questions every credential/secret fill has to answer, split out of
 * browser-form-fill-operations so the fill loop stays readable:
 *
 *  1. WHERE does a value typed into this control land? A site may embed its
 *     login form in a cross-origin subframe (LCN serves
 *     https://www.lcn.com/login's form from https://login.lcn.com through
 *     #login-iframe), and the origin-bound writer types only into frames of
 *     the receiving origin. The frame origin is resolved BEFORE any secret
 *     exists in the process, from a secret-free control read.
 *  2. WHY did a fill fail? Only fixed codes may cross the credential failure
 *     boundary — a DOM/Chrome/page error can quote the value being written —
 *     and the exact failure step plus cause must reach both the tool result
 *     and the audit row (LT-703).
 */

/** Fixed failure-step vocabulary, prefixed onto the fill's reason code. */
export type CredentialFillStep =
  | 'fill_guard'
  | 'authorization'
  | 'secure_extension'
  | 'vault_resolve'
  | 'origin_recheck'
  | 'pre_dispatch_guard'
  | 'dispatch'
  | 'write_confirmation';

/**
 * The complete failure vocabulary that may cross the credential failure
 * boundary: the extension's fixed origin-bound writer codes (see the matching
 * allowlist in resources/browser-extension/background.js) plus the
 * main-process refusals. Everything else — DOM errors, Chrome errors,
 * mailbox/driver errors, ANY free-form or code-shaped message — collapses to
 * the fallback, because such a message may quote the value that was being
 * written (a generated secret can itself look like an identifier).
 */
export const SAFE_CREDENTIAL_CODES: ReadonlySet<string> = new Set([
  // Extension origin-bound writer.
  'invalid_credential_origin',
  'invalid_credential_protection',
  'credential_origin_changed_before_write',
  'credential_origin_changed_may_have_applied',
  'credential_authorized_origin_not_in_frames',
  'credential_selector_not_found',
  'credential_selector_outside_authorized_origin',
  'credential_selector_ambiguous_may_have_applied',
  'credential_write_invalid_selector',
  'credential_write_refused',
  'credential_password_requires_masked_input',
  'credential_write_dispatch_failed_or_may_have_applied_DO_NOT_retry_without_verifying_page_state',
  'credential_write_failed_or_may_have_applied_DO_NOT_retry_without_verifying_page_state',
  // Main-process refusals and write confirmations.
  'shared_tab_secure_credential_fill_unavailable',
  'shared_tab_secure_credential_write_not_confirmed',
  'shared_tab_public_credential_write_not_confirmed',
  'credential_authorization_changed',
  'browser_verify_readback_invalid',
]);

export function credentialFailureCode(error: unknown, fallback: string): string {
  if (isCredentialVaultError(error)) {
    // Vault codes are a closed vocabulary minted in-process (and re-checked
    // here so a foreign error that merely CALLS itself a CredentialVaultError
    // cannot widen the boundary with a dynamic code).
    return VAULT_ERROR_CODES.test(error.code) ? error.code : fallback;
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return SAFE_CREDENTIAL_CODES.has(message) ? message : fallback;
}

// Structural check rather than `instanceof`, so a vault error that crossed a
// realm (worker, VM context in tests) is still classified by its code.
function isCredentialVaultError(error: unknown): error is CredentialVaultError {
  return error instanceof Error
    && error.name === 'CredentialVaultError'
    && typeof (error as { code?: unknown }).code === 'string';
}

/**
 * Built from the vault's own closed code list (which is exhaustiveness-pinned
 * against `CredentialVaultErrorCode` at compile time) rather than hand-copied,
 * so the two can never drift apart.
 */
const VAULT_ERROR_CODES = new RegExp(
  `^(?:${CREDENTIAL_VAULT_ERROR_CODES.map((code) => code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`,
);

export type ResolveFillOriginInput = {
  toolName: string;
  profileId: string;
  targetId: string;
  /** Every field must be reachable; each has a control selector. */
  fields: ReadonlyArray<{ selector: string }>;
  /** The tab's top-level page origin (what a navigation re-check watches). */
  pageOrigin: string;
  resolveFieldFrameOrigin?: (
    profileId: string,
    targetId: string,
    selector: string,
  ) => Promise<string | undefined>;
};

export type FillOriginResolution =
  | { fillOrigin: string; denial?: undefined }
  | { fillOrigin?: undefined; denial: { reason: string; summary: string } };

/**
 * Resolve the exact origin that will RECEIVE the values. Falls back to the
 * page origin when a control reports no frame origin (managed profiles, older
 * extensions), which keeps single-origin fills byte-identical. Refuses to split
 * one credential across frames of different origins: the authorization and the
 * vault binding name ONE origin, so a mixed fill could not be authorized as a
 * unit and would strand half a credential on an unchecked origin.
 *
 * Precision note: a control that matches in several frames reports the FIRST
 * match's frame origin. That pick can be wrong only when one selector matches
 * in two frames of different origins, and it then fails CLOSED — the vault
 * binding refuses `origin_mismatch`, or the write finds nothing in the bound
 * origin's frames. The exact-origin checks at the write itself (frame selection
 * plus the in-page `location.origin` re-check) are the authority, not this
 * probe.
 */
/**
 * Fixed prefixes the extension's secret-observation guard throws when it
 * refuses a read (background.js `assertSecretObservationAllowed`). They mean
 * "we may not look", which is NOT the same as "the control is missing".
 */
const PROBE_REFUSAL_CODES: ReadonlyArray<string> = [
  'browser_secret_observation_blocked_for_tainted_origin',
  'browser_secret_inspection_unavailable',
];

function probeRefusalCode(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return PROBE_REFUSAL_CODES.find((code) => message.startsWith(code));
}

/**
 * The step a failure actually belongs to. The write confirmation runs INSIDE
 * `driverType` (after the extension command succeeded), so a confirmation
 * refusal surfaces while the loop's step variable still says `dispatch` —
 * classify it by its code instead of by position.
 */
export function credentialFailureStep(
  step: CredentialFillStep,
  code: string,
): CredentialFillStep {
  return WRITE_CONFIRMATION_CODES.has(code) ? 'write_confirmation' : step;
}

export async function resolveFillOrigin(
  input: ResolveFillOriginInput,
): Promise<FillOriginResolution> {
  const fieldFrameOrigins = new Set<string>();
  for (const field of input.fields) {
    let frameOrigin: string | undefined;
    try {
      frameOrigin = await input.resolveFieldFrameOrigin?.(input.profileId, input.targetId, field.selector);
    } catch (error) {
      const refusal = probeRefusalCode(error);
      if (refusal) {
        // The guard refused the read (e.g. a secret-tainted tab), so we cannot
        // know where the value would land — and writing blind is exactly what
        // the origin lock forbids. Report the refusal rather than guess; no
        // value has been read or typed at this point.
        return {
          denial: {
            reason: `resolve_field_origin:${refusal}`,
            summary: `${input.toolName} could not resolve where its fields live (${refusal}); `
              + 'no secret was read or typed',
          },
        };
      }
      // No such control (or an unreadable frame): do NOT invent the page origin
      // for it — that would misreport a bad selector as a multi-origin split.
      // The dispatch step reports precisely why it could not write.
      frameOrigin = undefined;
    }
    if (frameOrigin) {
      fieldFrameOrigins.add(frameOrigin);
    }
  }
  if (fieldFrameOrigins.size > 1) {
    return {
      denial: {
        reason: 'credential_fields_span_multiple_origins',
        summary: `${input.toolName} refuses to split one credential across frames of different origins `
          + `(${[...fieldFrameOrigins].join(', ')}); fill each origin in its own call`,
      },
    };
  }
  return { fillOrigin: [...fieldFrameOrigins][0] ?? input.pageOrigin };
}
