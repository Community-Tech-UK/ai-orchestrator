import type {
  BrowserActionClass,
  BrowserAllowedOrigin,
  BrowserApprovalRequest,
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

export function bannerCanQuickApprove(approval: BrowserApprovalRequest): boolean {
  return bannerGrantModes(approval).length > 0;
}

export function bannerGrantModes(approval: BrowserApprovalRequest): BannerGrantMode[] {
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
