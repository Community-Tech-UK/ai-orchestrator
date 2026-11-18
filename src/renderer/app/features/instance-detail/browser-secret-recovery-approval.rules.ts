/**
 * Plain words for the one approval that restores an agent's access to a site
 * after a saved password was entered there, and for what Harness then did.
 * Every word comes from trusted approval state (origins, tab count, computer,
 * the agent's stated reason), never from the website.
 */

import type {
  BrowserApprovalRequest,
  BrowserSecretRecoveryMetadata,
  BrowserSecretRecoveryProgress,
} from '@contracts/types/browser';
import { secretRecoverySites } from '../../core/state/browser-approvals-banner.rules';

export interface SecretRecoveryCardText {
  readonly headline: string;
  readonly facts: readonly { label: string; value: string }[];
  readonly allowLabel: string;
  readonly allowHint: string;
  readonly keepLabel: string;
  readonly note: string;
}

export function secretRecoveryCardText(
  approval: BrowserApprovalRequest,
  recovery: BrowserSecretRecoveryMetadata,
  computer: string,
  replyBefore: string,
): SecretRecoveryCardText {
  const sites = secretRecoverySites(recovery);
  const tabs = recovery.affectedTabCount === 1 ? '1 tab' : `${recovery.affectedTabCount} tabs`;
  const site = recovery.origins.length === 1 ? 'this site' : 'these sites';
  const it = recovery.origins.length === 1 ? 'it' : 'them';
  // Only deeper reads (page scripts, logs, traffic, downloads) are still refused there.
  const deepOnly = recovery.affectedTabCount === 0;
  return {
    headline: `Resume browser access for ${sites} on ${computer}`,
    facts: [
      ...(approval.requestReason ? [{ label: 'Reason', value: approval.requestReason }] : []),
      { label: 'What happened', value: deepOnly
        ? `A saved password was entered on ${site} earlier, so Harness still blocks deeper reads there, such as downloads, page scripts, logs and network traffic.`
        : `A saved password was entered on ${site}, so Harness stopped agents reading ${it}.` },
      { label: 'If you allow it', value: deepOnly
        ? `Harness lifts the last protection on ${site} in this Chrome profile, so downloads and other deeper reads work again. Agents still need their usual permission.`
        : `Harness stops protecting ${site} in this Chrome profile (${tabs} now). Agents still need their usual permission to read ${it}.` },
      { label: 'Risk', value: deepOnly
        ? 'The site may still hold the password, for example in page memory, logs or network traffic. The agent could then read it.'
        : `${site === 'this site' ? 'The site' : 'These sites'} may still hold the password, for example in a filled password box. The agent could then read it.` },
      { label: 'Computer', value: computer },
      { label: 'Reply before', value: replyBefore },
    ],
    allowLabel: 'Recover access',
    allowHint: `Ends protection for ${site} in this Chrome profile. Entering a saved password again protects ${it} again.`,
    keepLabel: 'Keep protected',
    note: 'This does not allow sending, paying or submitting anything else.',
  };
}

/** What the session page shows after approval, in plain words. Codes stay under Details. */
export function secretRecoveryProgressText(
  progress: BrowserSecretRecoveryProgress | undefined,
  recovery?: BrowserSecretRecoveryMetadata,
): string {
  const site = recovery && recovery.origins.length > 1 ? 'these sites' : 'this site';
  if (!progress) return 'Recovering access…';
  // A receipt means protection was lifted; never say the site stays protected.
  if (progress.receiptId && progress.state !== 'recovered') {
    if (progress.reasonCode === 'released_then_protected_again') {
      return `Protection for ${site} was lifted, then a new password entry protected it again. The agent can ask you again.`;
    }
    if (progress.reasonCode === 'released_tab_still_protected_by_another_site') {
      return `Protection for ${site} was lifted, but this tab still holds another protected site, so the agent may still be blocked.`;
    }
    return progress.reasonCode === 'released_tab_isolation_unavailable'
      ? `Protection for ${site} was lifted, but Harness couldn't check this tab safely yet, so the agent may still be blocked.`
      : `Protection for ${site} was lifted, but Harness couldn't confirm the tab is readable yet.`;
  }
  switch (progress.state) {
    case 'running':
      return 'Recovering access…';
    case 'recovered':
      return `Protection for ${site} was lifted. Agents with permission can read ${site === 'this site' ? 'it' : 'them'} again.${progress.loginVerified === true
        ? ' Sign-in confirmed.'
        : progress.loginVerified === false ? ' The site still looks signed out.' : ''}`;
    case 'stale_review': {
      const stale: Readonly<Record<string, string>> = {
        protection_protection_off: `Not needed: protection was switched off in Settings, so ${site} ${site === 'this site' ? 'is' : 'are'} no longer protected.`,
        protection_not_protected: 'Not needed: this tab is no longer protected.',
        target_tab_gone: `Not restored: the tab was closed. Harness did not lift protection for ${site}.`,
        target_tab_moved: `Not restored: the tab moved to another browser. Harness did not lift protection for ${site}.`,
        protected_sites_changed: 'Not restored: the protected sites on this tab changed after you approved. The agent can ask you again.',
        approval_no_longer_current: `Not restored: the request was stopped or timed out before Harness finished. Harness did not lift protection for ${site}.`,
        protection_inspection_unavailable: `Not restored: Harness couldn't check the tab safely. Harness did not lift protection for ${site}.`,
      };
      return stale[progress.reasonCode]
        ?? `Not restored: the browser changed after you approved, for example a password was entered again. Harness did not lift protection for ${site}.`;
    }
    case 'manual_security_review_required':
      return `Not restored: Harness could not safely tell which sites this tab holds. Harness did not lift protection for ${site}.`;
    case 'indeterminate':
      return `Harness couldn't confirm whether protection for ${site} was lifted.`;
    case 'failed':
      return `Not restored: something went wrong. Harness did not lift protection for ${site}.`;
  }
}
