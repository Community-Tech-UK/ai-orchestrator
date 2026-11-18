import { describe, expect, it } from 'vitest';
import type { BrowserApprovalRequest } from '@contracts/types/browser';
import { bannerCanQuickApprove, bannerGrantModes } from '../../core/state/browser-approvals-banner.rules';
import { presentBrowserApproval } from './browser-approval-request.rules';
import { secretRecoveryProgressText } from './browser-secret-recovery-approval.rules';

const PAGE_TEXT = 'TEST_ONLY_PAGE_TEXT';

function recoveryApproval(overrides: Partial<NonNullable<BrowserApprovalRequest['secretRecovery']>> = {}): BrowserApprovalRequest {
  const secretRecovery = {
    operationId: '00000000-0000-4000-8000-000000000001', ownerSessionId: 'instance-1', nodeId: 'node-win',
    computerName: 'Fallback name', targetId: 'target-1', origins: ['https://www.etenders.example'], affectedTabCount: 2,
    writeGeneration: 'generation-test-only', expiresAt: 5000, ...overrides,
  };
  return {
    id: 'request-1', requestId: 'request-1', instanceId: 'instance-1', provider: 'claude',
    profileId: 'existing-tab:n.node-win:1:2', targetId: 'target-1', toolName: 'browser.recover_secret_observation',
    action: 'recover_secret_observation', actionClass: 'credential', origin: 'https://www.etenders.example',
    requestReason: 'Finish the approved bid', computerId: 'node-win', secretRecovery,
    proposedGrant: {
      mode: 'per_action', allowedOrigins: [{ scheme: 'https', hostPattern: 'www.etenders.example', includeSubdomains: false }],
      allowedActionClasses: ['read'], allowExternalNavigation: false, autonomous: false,
    },
    status: 'pending', createdAt: 1000, expiresAt: 5000,
  };
}

const ctx = {
  node: (id: string) => (id === 'node-win' ? { name: 'Windows PC', platform: 'win32' } : undefined),
  localPlatform: 'darwin',
  formatTime: (timestamp: number) => `at ${timestamp}`,
};

describe('restoring browser access card', () => {
  it('names the site and computer, says what happened and the risk, and offers only this recovery', () => {
    const view = presentBrowserApproval(recoveryApproval(), ctx);
    expect(view.kind).toBe('secret-recovery');
    expect(view.headline).toBe('Resume browser access for www.etenders.example on Windows PC');
    expect(view.facts.map((fact) => fact.label)).toEqual(['Reason', 'What happened', 'If you allow it', 'Risk', 'Computer', 'Reply before']);
    expect(view.facts.find((fact) => fact.label === 'If you allow it')?.value).toBe(
      'Harness stops protecting this site in this Chrome profile (2 tabs now). Agents still need their usual permission to read it.');
    expect(view.choices).toHaveLength(1);
    expect(view.choices[0]).toMatchObject({ id: 'once', label: 'Recover access', needsPhrase: false });
    expect(view.choices[0].grant).toEqual(recoveryApproval().proposedGrant);
    expect(view.denyLabel).toBe('Keep protected');
    expect(view.phrase).toBeNull();
  });

  it('keeps the gateway-supplied computer name when the computer list does not know it', () => {
    const view = presentBrowserApproval({ ...recoveryApproval({ nodeId: 'node-gone' }), computerId: undefined }, ctx);
    expect(view.headline).toContain('on Fallback name');
  });

  it('is never quick-approved from the permission bar', () => {
    expect(bannerCanQuickApprove(recoveryApproval())).toBe(false);
    expect(bannerGrantModes(recoveryApproval())).toEqual([]);
  });

  it('describes every result in plain words without page content or raw codes', () => {
    const states = ['running', 'recovered', 'stale_review', 'manual_security_review_required', 'failed', 'indeterminate'] as const;
    for (const state of states) {
      const text = secretRecoveryProgressText({ state, reasonCode: 'code_test_only', loginVerified: null, updatedAt: 1 });
      expect(text).not.toContain('code_test_only');
      expect(text).not.toContain(PAGE_TEXT);
      expect(text).not.toMatch(/_/);
    }
    expect(secretRecoveryProgressText(undefined)).toBe('Recovering access…');
    expect(secretRecoveryProgressText({ state: 'stale_review', reasonCode: 'released_then_protected_again', loginVerified: null,
      receiptId: '00000000-0000-4000-8000-000000000001', updatedAt: 1 }))
      .toBe('Protection for this site was lifted, then a new password entry protected it again. The agent can ask you again.');
    for (const reasonCode of ['approval_no_longer_current', 'protection_inspection_unavailable']) {
      expect(secretRecoveryProgressText({ state: 'stale_review', reasonCode, loginVerified: null, updatedAt: 1 }))
        .not.toContain('password was entered again');
    }
    // Protection already off or cleared elsewhere: the site is not protected, so never say it is.
    for (const reasonCode of ['protection_protection_off', 'protection_not_protected']) {
      const text = secretRecoveryProgressText({ state: 'stale_review', reasonCode, loginVerified: null, updatedAt: 1 });
      expect(text).toMatch(/no longer protected\.$/);
      expect(text).not.toContain('stays on');
    }
    expect(secretRecoveryProgressText({ state: 'stale_review', reasonCode: 'target_tab_gone', loginVerified: null, updatedAt: 1 }))
      .toBe('Not restored: the tab was closed. Protection for this site stays on.');
    // Once a receipt exists protection was lifted: never claim the site stays protected.
    for (const state of ['manual_security_review_required', 'indeterminate', 'failed'] as const) {
      const text = secretRecoveryProgressText({ state, reasonCode: 'x', loginVerified: null, receiptId: '00000000-0000-4000-8000-000000000001', updatedAt: 1 });
      expect(text).toMatch(/^Protection for this site was lifted/);
      expect(text).not.toContain('stays on');
    }
    expect(secretRecoveryProgressText({ state: 'recovered', reasonCode: 'x', loginVerified: true, updatedAt: 1 }))
      .toBe('Protection for this site was lifted. Agents with permission can read it again. Sign-in confirmed.');
    const twoSites = { origins: ['https://a.example', 'https://b.example'] } as never;
    expect(secretRecoveryProgressText({ state: 'failed', reasonCode: 'x', loginVerified: null, updatedAt: 1 }, twoSites))
      .toBe('Not restored: something went wrong. Protection for these sites stays on.');
    expect(secretRecoveryProgressText({ state: 'recovered', reasonCode: 'x', loginVerified: null, updatedAt: 1 }, twoSites))
      .toBe('Protection for these sites was lifted. Agents with permission can read them again.');
    expect(secretRecoveryProgressText({ state: 'recovered', reasonCode: 'x', loginVerified: false, updatedAt: 1 }))
      .toContain('still looks signed out');
  });
});
