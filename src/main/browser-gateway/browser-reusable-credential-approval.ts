import type { BrowserPermissionGrant } from '@contracts/types/browser';
import { CREDENTIAL_CHALLENGE_REASON, type BrowserActionClassification } from './browser-action-classifier';
import type { BrowserGatewayPreparedMutation } from './browser-gateway-action-guard.types';

/** Only explicit operator credential consent can satisfy a reusable credential stop. */
export function prepareReusableCredentialApproval(
  classification: BrowserActionClassification,
  grant: BrowserPermissionGrant | undefined,
  origin: string,
  url: string,
): BrowserGatewayPreparedMutation | null {
  if (classification.actionClass !== 'credential' || classification.reason !== CREDENTIAL_CHALLENGE_REASON ||
    !grant || grant.mode === 'per_action' || grant.decidedBy !== 'user' || !grant.userApprovedCredentials) {
    return null;
  }
  // CAPTCHA, 2FA, unknown actions, payment, and broker-only identities never enter here.
  // Matching origin, computer/profile, revocation and expiry were checked by the caller.
  return { grant, actionClass: 'credential', origin, url };
}
