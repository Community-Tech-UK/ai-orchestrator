import { createHash } from 'node:crypto';
import type { BrowserGatewayResult } from '@contracts/types/browser';
import type { BrowserGatewayResultInput } from './browser-gateway-result';
import type { BrowserGatewayContext } from './browser-gateway-service-types';
import {
  CAPTCHA_CHALLENGE_REASON,
  TWO_FACTOR_CHALLENGE_REASON,
  type BrowserActionClassification,
} from './browser-action-classifier';
import type {
  BrowserEscalationKind,
  BrowserEscalationService,
} from './browser-escalation-store';

/**
 * Hard-stop handling helpers factored out of the action guard: routing captcha
 * / 2FA to the batch escalation queue, and the audit note for an auto-fired
 * legal declaration. Kept as free functions (deps passed in) so the guard file
 * stays within the size ratchet and this policy is unit-testable in isolation.
 */

export interface HardStopScope {
  profileId: string;
  targetId: string;
  origin: string;
  url: string;
}

export interface HardStopResultDeps {
  result: <T>(params: BrowserGatewayResultInput<T>) => BrowserGatewayResult<T>;
}

export interface ChallengeEscalationDeps extends HardStopResultDeps {
  escalations: Pick<BrowserEscalationService, 'raise'> | undefined;
}

type DeclarationTextContext =
  | { visibleText?: string; nearbyText?: string; label?: string; accessibleName?: string }
  | undefined;

/**
 * Map a credential-class hard-stop reason to the batch-queue escalation kind.
 * Only captcha and 2FA are parked; a real password/token hard stop (or any
 * other reason) returns null and stays on the per-action approval path.
 */
function escalationKindForReason(reason: string | undefined): BrowserEscalationKind | null {
  if (reason === CAPTCHA_CHALLENGE_REASON) {
    return 'captcha';
  }
  if (reason === TWO_FACTOR_CHALLENGE_REASON) {
    return 'two_factor_unavailable';
  }
  return null;
}

/**
 * Captcha / 2FA hard stops park to the batch escalation queue (phone push +
 * morning triage) and the action stops, instead of a blocking per-action
 * approval an unattended run cannot answer. Returns a not-run result when it
 * escalated, or null so the caller falls through to the normal approval path
 * (no escalation service wired, or a non-captcha/2FA hard stop such as a
 * password, payment or legal declaration).
 */
export function escalationResultForChallenge(
  deps: ChallengeEscalationDeps,
  request: BrowserGatewayContext & { profileId: string; targetId: string },
  action: string,
  toolName: string,
  classification: BrowserActionClassification,
  scope: HardStopScope,
): BrowserGatewayResult<null> | null {
  if (!deps.escalations) {
    return null;
  }
  const kind = escalationKindForReason(classification.reason);
  if (!kind) {
    return null;
  }
  deps.escalations.raise({
    profileId: scope.profileId,
    targetId: scope.targetId,
    kind,
    reason: classification.reason ?? kind,
    url: scope.url,
  });
  return deps.result({
    context: request,
    profileId: scope.profileId,
    targetId: scope.targetId,
    action,
    toolName,
    actionClass: classification.actionClass,
    decision: 'requires_user',
    outcome: 'not_run',
    reason: `${kind}_parked_to_escalation_queue`,
    summary: `${toolName} parked to the escalation queue (${kind}) for batch handling`,
    origin: scope.origin,
    url: scope.url,
    data: null,
  });
}

/**
 * Terminal deny for a hard stop that no grant OR approval can ever satisfy
 * (a genuine payment field). Returns a clear, actionable `denied` result and —
 * unlike the normal hard-stop path — the caller creates NO approval request, so
 * an unattended run is never left waiting on an approval that could never permit
 * the action (the approval loop reported in the Constellia repro).
 */
export function neverGrantableDenyResult(
  deps: HardStopResultDeps,
  request: BrowserGatewayContext & { profileId: string; targetId: string },
  action: string,
  toolName: string,
  classification: BrowserActionClassification,
  scope: HardStopScope,
): BrowserGatewayResult<null> {
  const guidance =
    classification.actionClass === 'financial_identity' ||
    classification.actionClass === 'sensitive_identity'
      ? 'Fill it via browser.fill_secret under a standing secret-fill authorization instead of a raw type.'
      : 'Complete this step manually in your browser.';
  return deps.result({
    context: request,
    profileId: scope.profileId,
    targetId: scope.targetId,
    action,
    toolName,
    actionClass: classification.actionClass,
    decision: 'denied',
    outcome: 'not_run',
    reason: classification.reason ?? 'action_never_automatable',
    summary: `${toolName} is blocked: ${classification.actionClass} fields are never automated by an ordinary grant — no approval can authorize this. ${guidance}`,
    origin: scope.origin,
    url: scope.url,
    data: null,
  });
}

/** A short, redacted snippet of the declaration text for the audit note. */
function declarationSnippet(ctx: DeclarationTextContext): string {
  if (!ctx) {
    return '';
  }
  const text = [ctx.accessibleName, ctx.label, ctx.visibleText, ctx.nearbyText]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 200 ? `${text.slice(0, 200)}...` : text;
}

/** Stable short fingerprint of the declaration text, for correlating notes. */
function declarationHash8(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

/**
 * Record a NON-blocking audit note that a binding legal declaration was
 * auto-fired under a standing autonomous campaign grant (operator opted into
 * hands-off submits). Does not stop the action; it exists so every
 * auto-submitted declaration is reviewable and mistakes are learnable (grep the
 * audit log for `legal_declaration_auto_fired`). The real submit audits
 * separately as a normal allowed/succeeded mutation.
 */
export function recordDeclarationAutoFireNote(
  deps: HardStopResultDeps,
  request: BrowserGatewayContext & { profileId: string; targetId: string },
  action: string,
  toolName: string,
  scope: HardStopScope,
  elementContext: DeclarationTextContext,
): void {
  const text = declarationSnippet(elementContext);
  deps.result({
    context: request,
    profileId: scope.profileId,
    targetId: scope.targetId,
    action,
    toolName,
    actionClass: 'submit',
    decision: 'allowed',
    outcome: 'not_run',
    reason: 'legal_declaration_auto_fired',
    summary: `Auto-fired binding declaration under campaign lease [${declarationHash8(text)}]: ${text || '(no declaration text captured)'}`,
    origin: scope.origin,
    url: scope.url,
    data: null,
  });
}
