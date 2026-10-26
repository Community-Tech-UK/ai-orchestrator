import type {
  BrowserActionClass,
  BrowserAllowedOrigin,
  BrowserApprovalRequest,
  BrowserApproveRequestPayload,
  BrowserGrantMode,
  BrowserGrantProposal,
} from '@contracts/types/browser';

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

export const CREDENTIAL_ACCESS_DURATIONS: readonly {
  value: CredentialAccessDuration;
  label: string;
}[] = [
  { value: 'task', label: 'Current task only' },
  { value: '1h', label: 'Remember for 1 hour' },
  { value: '24h', label: 'Remember for 24 hours' },
  { value: '7d', label: 'Remember for 7 days' },
  { value: '30d', label: 'Remember for 30 days' },
  { value: '90d', label: 'Remember for 90 days' },
  { value: '365d', label: 'Remember for 1 year' },
];

export function credentialAccessChoice(
  duration: CredentialAccessDuration,
): NonNullable<BrowserApproveRequestPayload['credentialAccess']> {
  const rememberForMs = {
    '1h': 3_600_000, '24h': 86_400_000, '7d': 604_800_000,
    '30d': 2_592_000_000, '90d': 7_776_000_000, '365d': 31_536_000_000,
  };
  return duration === 'task'
    ? { permission: 'task' }
    : { permission: 'remember', rememberForMs: rememberForMs[duration] };
}

export function credentialAccessPurpose(approval: BrowserApprovalRequest): string {
  return approval.credentialAccess?.purposes.map((purpose) =>
    purpose === 'totp' ? 'use a one-time sign-in code' : 'sign in with this saved login',
  ).join(' and ') ?? '';
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
  return CREDENTIAL_ACCESS_ERROR_TEXT[reason] ?? reason.replaceAll('_', ' ');
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

export function bannerModeLabel(mode: BannerGrantMode): string {
  switch (mode) {
    case 'per_action':
      return 'Approve once';
    case 'session':
      return 'Allow for session';
    case 'autonomous':
      return 'Allow unattended';
    case 'persistent':
      return 'Allow forever';
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
