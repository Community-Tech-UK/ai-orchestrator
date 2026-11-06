import type {
  BrowserActionClass,
  BrowserAllowedOrigin,
  BrowserApprovalRequest,
  BrowserApproveRequestPayload,
  BrowserGrantMode,
  BrowserGrantProposal,
} from '@contracts/types/browser';
import {
  PERMISSION_SCOPE_WORDS,
  timedScopeWords,
  type PermissionScopeWords,
} from '../../../../shared/permissions/permission-scope-presentation';

/** Classes a banner decision must never mint. Send these to review. */
const NEVER_QUICK_APPROVE_CLASSES = new Set<BrowserActionClass>([
  'payment',
  'financial_identity',
  'sensitive_identity',
]);

/** Unclassified actions still require an exact, one-action decision. */
const EXACT_APPROVAL_CLASSES = new Set<BrowserActionClass>([
  'unknown',
]);

export type BannerGrantMode = BrowserGrantMode;
export type CredentialAccessDuration = 'task' | '1h' | '24h' | '7d' | '30d' | '90d' | '365d';

const REMEMBER_FOR_MS: Readonly<Record<Exclude<CredentialAccessDuration, 'task'>, number>> = {
  '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000,
  '30d': 2_592_000_000, '90d': 7_776_000_000, '365d': 31_536_000_000,
};

/**
 * The words for a saved-login length: the session phrase for the default (the
 * backend's task permission lasts as long as this session), or a fixed time
 * such as "For 7 days" for a remembered one.
 */
export function credentialAccessWords(duration: CredentialAccessDuration): PermissionScopeWords {
  return duration === 'task' ? PERMISSION_SCOPE_WORDS.session : timedScopeWords(REMEMBER_FOR_MS[duration]);
}

export const CREDENTIAL_ACCESS_DURATIONS: readonly {
  value: CredentialAccessDuration;
  label: string;
}[] = (['task', '1h', '24h', '7d', '30d', '90d', '365d'] as const).map((value) => ({
  value,
  label: credentialAccessWords(value).choice,
}));

export function credentialAccessChoice(
  duration: CredentialAccessDuration,
): NonNullable<BrowserApproveRequestPayload['credentialAccess']> {
  return duration === 'task'
    ? { permission: 'task' }
    : { permission: 'remember', rememberForMs: REMEMBER_FOR_MS[duration] };
}

export function credentialAccessPurpose(approval: BrowserApprovalRequest): string {
  const access = approval.credentialAccess;
  return access?.purposes.map((purpose) => {
    if (purpose === 'totp') return 'use a one-time sign-in code';
    if (purpose === 'email_code') {
      return access.senderDomains?.length
        ? `read sign-in codes emailed from ${access.senderDomains.join(', ')}`
        : 'read sign-in codes this website emails';
    }
    return 'sign in with this saved login';
  }).join(' and ') ?? '';
}

export function credentialAccessMovement(approval: BrowserApprovalRequest): string {
  const access = approval.credentialAccess;
  if (!access) return '';
  return access.moveIntoFolder
    ? `Approval will move this login into the ${access.vaultFolder} agent vault folder.`
    : `This login will stay in its current vault folder (${access.vaultFolder}).`;
}

const CREDENTIAL_ACCESS_ERROR_TEXT: Readonly<Record<string, string>> = {
  vault_locked: 'The password vault is locked. Unlock it, then approve again.',
  target_unavailable: 'The browser tab could not be reached. It may be closed, not responding, on a site Harness is not allowed to use, or on a computer that is offline.',
  target_closed: 'The sign-in tab has closed. The requesting session needs to open a fresh sign-in tab and request saved-login access again.',
  bw_command_failed: 'The password vault command failed. Check the vault is reachable, then approve again.',
  credential_access_failed: 'Something went wrong while preparing the saved login.',
  expired: 'This request timed out.',
  denied: 'This request was already denied.',
  computer_changed: 'The browser tab is now on a different computer, so this request can no longer be approved.',
  session_changed: 'The requesting session changed while approving. Try approving again.',
  session_unavailable: 'The requesting session is no longer running, or is open more than once.',
  saved_login_changed: 'The saved login changed in the vault after it was requested, so this request can no longer be approved.',
  item_not_found: 'The saved login could not be found in the vault.',
  item_ambiguous: 'More than one saved login matches this name.',
  request_no_longer_pending: 'This request was already decided, cancelled or timed out.',
  request_target_changed: 'This request now uses a different sign-in tab. Review it and approve again.',
  permission_expired: 'The chosen permission period has already ended.',
  authorization_revoked: 'This saved-login permission was revoked or ran out while approving, so the request has ended.',
  origin_mismatch: 'The website in the tab, or the website this saved login is already linked to, does not match this request. If the tab is on a normal web page and this keeps happening, deny it.',
  item_outside_agent_folder: 'The saved login is not in the agent vault folder.',
  secret_field_empty: 'The saved login is missing its username or password.',
  item_changed: 'The saved login changed in the vault while approving, so this request can no longer be approved.',
  shared_tab_credential_fill_not_allowed: 'Saved logins on shared browser tabs are turned off in settings.',
  shared_tab_secure_credential_fill_unavailable: 'The browser extension on that computer needs updating or reconnecting before it can use saved logins.',
};

/** Plain-language text for a saved-login approval failure code. */
export function credentialAccessErrorText(reason: string): string {
  if (reason.startsWith('vault_relock_failed:')) return 'The password vault could not be unlocked again. Check the vault login, then approve again.';
  return CREDENTIAL_ACCESS_ERROR_TEXT[reason] ?? "The saved login couldn't be prepared. Check Details, then try again.";
}

const APPROVAL_FAILURE_TEXT: Readonly<Record<string, string>> = {
  approval_request_not_found: 'This request is no longer there.',
  approval_request_expired: 'This request timed out.',
  approval_request_approved: 'This request was already approved.',
  approval_request_denied: 'This request was already denied.',
};

/** Closed wording shared by the permission bar and the session approval card. */
export function browserApprovalFailureText(reason: string): string {
  return APPROVAL_FAILURE_TEXT[reason] ?? "Harness couldn't record this decision. Check Details, then try again.";
}

export function bannerCanQuickApprove(approval: BrowserApprovalRequest): boolean {
  return Boolean(approval.credentialAccess) || bannerGrantModes(approval).length > 0;
}

export function bannerGrantModes(approval: BrowserApprovalRequest): BannerGrantMode[] {
  if (approval.credentialAccess) return [];
  if (NEVER_QUICK_APPROVE_CLASSES.has(approval.actionClass)) {
    return [];
  }
  const proposed = approval.proposedGrant.allowedActionClasses;
  if (proposed.some((actionClass) => NEVER_QUICK_APPROVE_CLASSES.has(actionClass))) {
    return [];
  }
  if (EXACT_APPROVAL_CLASSES.has(approval.actionClass)) {
    return ['per_action'];
  }
  const modes: BannerGrantMode[] = ['per_action'];
  if (classesForMode(approval, 'session').length > 0) {
    modes.push('session', 'autonomous');
    if (persistentBrowserApprovalOrigin(approval)) modes.push('persistent');
  }
  return modes;
}

/** The short name of a browser permission length, for lists of grants. */
export function bannerModeChoice(mode: BannerGrantMode): string {
  switch (mode) {
    case 'per_action':
      return PERMISSION_SCOPE_WORDS.once.choice;
    case 'session':
      return PERMISSION_SCOPE_WORDS.session.choice;
    case 'autonomous':
      return PERMISSION_SCOPE_WORDS['without-asking'].choice;
    case 'persistent':
      return PERMISSION_SCOPE_WORDS.always.choice;
  }
}

/** One wording for each browser permission length, shared with the other approval cards. */
export function bannerModeLabel(mode: BannerGrantMode): string {
  switch (mode) {
    case 'per_action':
      return PERMISSION_SCOPE_WORDS.once.allow;
    case 'session':
      return PERMISSION_SCOPE_WORDS.session.allow;
    case 'autonomous':
      return PERMISSION_SCOPE_WORDS['without-asking'].allow;
    case 'persistent':
      return `${PERMISSION_SCOPE_WORDS.always.allow} on this website`;
  }
}

export function buildBannerGrant(
  approval: BrowserApprovalRequest,
  mode: BannerGrantMode,
): BrowserGrantProposal | null {
  const modes = bannerGrantModes(approval);
  if (!modes.includes(mode)) {
    return null;
  }
  const allowedActionClasses = classesForMode(approval, mode);
  if (allowedActionClasses.length === 0) {
    return null;
  }
  return {
    ...approval.proposedGrant,
    mode,
    allowedOrigins: mode === 'persistent'
      ? [persistentBrowserApprovalOrigin(approval)!]
      : approval.proposedGrant.allowedOrigins,
    allowedActionClasses,
    autonomous: mode === 'autonomous' || mode === 'persistent',
  };
}

/** Forever approves only the displayed site, never a proposed wildcard or another site. */
export function persistentBrowserApprovalOrigin(
  approval: BrowserApprovalRequest,
): BrowserAllowedOrigin | null {
  try {
    const url = new URL(approval.origin ?? approval.url ?? '');
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') ||
      !url.hostname || url.hostname.includes('*') || url.username || url.password) return null;
    return {
      scheme: url.protocol === 'http:' ? 'http' : 'https',
      hostPattern: url.hostname,
      ...(url.port ? { port: Number(url.port) } : {}),
      includeSubdomains: false,
    };
  } catch {
    return null;
  }
}

/** Main promotes submit/destructive grants to autonomous; the phrase is the human gate. */
export function bannerGrantRequiresConfirmation(grant: BrowserGrantProposal): boolean {
  return grant.allowedActionClasses.some(
    (actionClass) => actionClass === 'submit' || actionClass === 'destructive',
  );
}

export function bannerConfirmationPhrase(approval: BrowserApprovalRequest): string {
  const location = approval.origin ?? approval.url;
  if (location) {
    try {
      return new URL(location).host;
    } catch {
      return location;
    }
  }
  return approval.profileId;
}

function classesForMode(
  approval: BrowserApprovalRequest,
  mode: BannerGrantMode,
): BrowserActionClass[] {
  const proposed = uniqueClasses(
    approval.proposedGrant.allowedActionClasses.filter(
      (actionClass) => !NEVER_QUICK_APPROVE_CLASSES.has(actionClass),
    ),
  );
  if (mode === 'per_action' && (
    approval.toolName !== 'browser.request_grant' || EXACT_APPROVAL_CLASSES.has(approval.actionClass)
  )) {
    return [approval.actionClass];
  }
  if (mode === 'per_action') {
    return proposed;
  }
  return proposed.filter((actionClass) => !EXACT_APPROVAL_CLASSES.has(actionClass));
}

function uniqueClasses(classes: readonly BrowserActionClass[]): BrowserActionClass[] {
  return [...new Set(classes)];
}
