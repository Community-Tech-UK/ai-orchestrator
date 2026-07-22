import type { DesktopElementCandidate } from '../../shared/types/desktop-gateway.types';

/**
 * Sensitivity classification for observed desktop controls.
 *
 * Classification used to be one flat substring regex over role+label+value,
 * which blocked any control whose *text* happened to contain an action verb —
 * a breadcrumb reading "PA23 - 07A - Publish Tender Pack (Auto Invite)" was
 * denied as a publish/invite action, making read-only navigation impossible.
 * The rules below classify by semantics instead: what the control IS (role and
 * destination), not merely what it says.
 */

/**
 * Always sensitive, whatever the control is: secrets, payment instruments and
 * privilege elevation. Matched on the element's own text regardless of role,
 * because a "password" anything is a password.
 */
const ALWAYS_SENSITIVE_PATTERN =
  /secure|password|passcode|credential|secret|api\s*key|access\s*token|credit\s*card|card\s*number|\bcvv\b|\bcvc\b|security\s*code|account\s*security|two[- ]?factor|\b2fa\b|payment|purchase|buy\s*now|place\s*order|administrator|admin\s*prompt|elevat|keychain|wallet/;

/**
 * Externally visible, hard-to-reverse state changes. Gated whatever the role,
 * and explicitly NOT eligible for the navigation exemption, because portals
 * routinely implement exactly these as a plain GET link. `unsubscribe`,
 * `opt out`, `withdraw` and `revoke` were previously matched by no pattern at
 * all, so the single most consequential step of a portal journey ran ungated.
 */
const STATE_CHANGE_PATTERN =
  /unsubscribe|opt[-\s]?out|withdraw|revoke|delete|remove\s*account|stop\s+notification|turn\s+off\s+notification|stop\s+emails|stop\s+receiving|unfollow/;

/**
 * Sensitive only on a control that COMMANDS something. On a navigation link
 * these almost always describe a destination ("Sent messages", "Published
 * notices") rather than perform the act.
 */
const COMMAND_ACTION_PATTERN =
  /send|post|publish|sign\s*in|log\s*in|login|submit|confirm|authorize/;

/** Accessibility roles that navigate rather than command. */
const NAVIGATION_ROLES = new Set(['axlink', 'link']);

/**
 * A URL scheme that actually navigates. `javascript:` and friends are arbitrary
 * commands wearing a link's role, so they never earn the navigation exemption.
 */
const NAVIGABLE_URL_PATTERN = /^(https?|file|mailto):/i;

export function isSensitiveObservedElement(candidate: DesktopElementCandidate): boolean {
  if (candidate.redacted) {
    return true;
  }
  const description = [candidate.role, candidate.label, candidate.value]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  const url = candidate.url?.trim().toLowerCase() ?? '';
  if (ALWAYS_SENSITIVE_PATTERN.test(description)) {
    return true;
  }
  // Checked against the destination too: a link labelled "Manage notifications"
  // pointing at /account/unsubscribe is an unsubscribe.
  if (STATE_CHANGE_PATTERN.test(`${description} ${url}`)) {
    return true;
  }
  if (!COMMAND_ACTION_PATTERN.test(description)) {
    return false;
  }
  // Only a control that PROVES it is a navigation link escapes the command
  // pattern. Missing proof (no role, no url, an older helper that does not
  // report urls) keeps the gated behaviour.
  return !isProvableNavigationLink(candidate, url);
}

function isProvableNavigationLink(candidate: DesktopElementCandidate, url: string): boolean {
  if (!candidate.role || !NAVIGATION_ROLES.has(candidate.role.trim().toLowerCase())) {
    return false;
  }
  return Boolean(url) && NAVIGABLE_URL_PATTERN.test(url);
}
