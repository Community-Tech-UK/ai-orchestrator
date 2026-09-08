import type {
  BrowserActionClass,
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

/** Hard stops the main process will narrow to a one-action grant. */
const EXACT_APPROVAL_CLASSES = new Set<BrowserActionClass>([
  'credential',
  'unknown',
]);

/** Always allow is only for ordinary browsing, not uploads, submits, or secrets. */
const ALWAYS_ALLOW_CLASSES = new Set<BrowserActionClass>([
  'read',
  'navigate',
  'input',
]);

export type BannerGrantMode = Extract<BrowserGrantMode, 'per_action' | 'session' | 'autonomous'>;

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
    modes.push('session');
  }
  if (
    proposed.length > 0 &&
    proposed.every((actionClass) => ALWAYS_ALLOW_CLASSES.has(actionClass))
  ) {
    modes.push('autonomous');
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
      return 'Always allow';
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
    allowedActionClasses,
    autonomous: mode === 'autonomous',
  };
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
  if (mode === 'per_action' && approval.toolName !== 'browser.request_grant') {
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
