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
  return {
    headline: `Resume browser access for ${sites} on ${computer}`,
    facts: [
      ...(approval.requestReason ? [{ label: 'Reason', value: approval.requestReason }] : []),
      { label: 'What happened', value: `A saved password was entered on ${site}, so Harness stopped agents reading it.` },
      { label: 'If you allow it', value: `Harness stops protecting ${site} in this Chrome profile (${tabs} now). Agents still need their usual permission to read it.` },
      { label: 'Risk', value: 'The site may still hold the password, for example in a filled password box. The agent could then read it.' },
      { label: 'Computer', value: computer },
      { label: 'Reply before', value: replyBefore },
    ],
    allowLabel: 'Recover access',
    allowHint: `Ends protection for ${site} in this Chrome profile. Entering a saved password again protects it again.`,
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
    return progress.state === 'manual_security_review_required'
      ? `Protection for ${site} was lifted, but this tab still holds another protected site, so the agent may still be blocked.`
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
        protection_not_protected: `Not needed: protection for ${site} was already cleared, so ${site === 'this site' ? 'it is' : 'they are'} no longer protected.`,
        target_tab_gone: `Not restored: the tab was closed. Protection for ${site} stays on.`,
        target_tab_moved: `Not restored: the tab moved to another browser. Protection for ${site} stays on.`,
        approval_no_longer_current: `Not restored: the request was stopped or timed out before Harness finished. Protection for ${site} stays on.`,
        protection_inspection_unavailable: `Not restored: Harness couldn't check the tab safely. Protection for ${site} stays on.`,
      };
      return stale[progress.reasonCode]
        ?? `Not restored: the browser changed after you approved, for example a password was entered again. Protection for ${site} stays on.`;
    }
    case 'manual_security_review_required':
      return `Not restored: Harness could not safely tell which sites this tab holds. Protection for ${site} stays on.`;
    case 'indeterminate':
      return `Harness couldn't confirm whether protection for ${site} was lifted.`;
    case 'failed':
      return `Not restored: something went wrong. Protection for ${site} stays on.`;
  }
}
