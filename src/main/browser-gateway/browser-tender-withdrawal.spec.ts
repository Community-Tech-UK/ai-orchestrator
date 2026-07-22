// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { BrowserElementContext } from '@contracts/types/browser';
import { classifyBrowserAction } from './browser-action-classifier';
import { selectBrowserTargetForUrl } from './browser-target-preflight';
import { makeService } from './browser-gateway-service.test-helpers';
import {
  MOCK_TENDER_ACTIVITY_HTML,
  MOCK_TENDER_ACTIVITY_URL,
  MOCK_TENDER_PORTAL_ORIGIN,
  MOCK_TENDER_TITLE,
  MOCK_TENDER_WITHDRAWN_STATUS,
} from './mock-tender-activity.fixture';

/**
 * End-to-end acceptance for the tender-withdrawal journey, driven against the
 * REAL classifier, preflight selector and gateway approval flow over the real
 * parsed DOM of the fixture. Deterministic and offline; the live shared-tab run
 * against the packaged app is tracked separately as a live test.
 *
 * The journey: discover the user's own logged-in tab, navigate a breadcrumb
 * whose label reads like a publish/invite action, tell "stop notifications"
 * apart from "withdraw interest", get exactly one action-time approval before
 * the mutation, execute once, and verify the persisted state.
 */

const LOCAL_TAB = {
  profileId: 'existing-tab:7:42',
  targetId: 'existing-tab:7:42:target',
  tabId: 42,
  windowId: 7,
  title: MOCK_TENDER_TITLE,
  url: MOCK_TENDER_ACTIVITY_URL,
  origin: MOCK_TENDER_PORTAL_ORIGIN,
  allowedOrigins: [{
    scheme: 'https' as const,
    hostPattern: 'procontract.example',
    includeSubdomains: false,
  }],
};

function loadActivityPage(): void {
  document.body.innerHTML = MOCK_TENDER_ACTIVITY_HTML;
}

/** Build a classifier context from the real DOM node, as the gateway does. */
function contextFor(selector: string): BrowserElementContext {
  const node = document.querySelector(selector);
  if (!node) {
    throw new Error(`missing element ${selector}`);
  }
  const isLink = node.tagName === 'A';
  const section = node.closest('section');
  const href = node.getAttribute('href');
  return {
    role: isLink ? 'link' : 'button',
    accessibleName: node.textContent?.replace(/\s+/g, ' ').trim() ?? '',
    ...(href ? { attributes: { href } } : {}),
    ...(section
      ? { nearbyText: section.textContent?.replace(/\s+/g, ' ').trim() ?? '' }
      : {}),
  };
}

describe('tender withdrawal end-to-end', () => {
  it('discovers the user own logged-in tab through computer: "local"', () => {
    const preflight = selectBrowserTargetForUrl({
      url: MOCK_TENDER_ACTIVITY_URL,
      requestedComputer: { localOnly: true },
      targets: [
        {
          id: 'managed',
          mode: 'session',
          driver: 'cdp',
          status: 'available',
          lastSeenAt: 9_000,
          url: MOCK_TENDER_ACTIVITY_URL,
        },
        {
          id: LOCAL_TAB.targetId,
          profileId: LOCAL_TAB.profileId,
          mode: 'existing-tab',
          driver: 'extension',
          status: 'available',
          lastSeenAt: 1_000,
          url: MOCK_TENDER_ACTIVITY_URL,
          title: MOCK_TENDER_TITLE,
        },
      ],
    });

    expect(preflight.selected).toMatchObject({
      targetId: LOCAL_TAB.targetId,
      channel: 'local-extension',
      computer: 'local',
      usesRealUserSession: true,
    });
    // The signed-out automation profile is reported, never substituted.
    expect(preflight.rejected).toContainEqual(expect.objectContaining({
      targetId: 'managed',
      reason: 'managed_profile_is_not_the_user_session',
    }));
  });

  it('navigates the "Auto Invite" breadcrumb without a false-sensitive denial', () => {
    loadActivityPage();

    expect(classifyBrowserAction({
      toolName: 'browser.click',
      elementContext: contextFor('#crumb-stage'),
    })).toMatchObject({
      actionClass: 'navigate',
      hardStop: false,
      reason: 'navigation_link_semantics',
    });
  });

  it('distinguishes stopping notifications from withdrawing interest', () => {
    loadActivityPage();

    const text = (selector: string): string =>
      document.querySelector(selector)!.textContent!.replace(/\s+/g, ' ').trim();
    const notificationsSection = text('#notifications');
    const withdrawSection = text('#withdraw');

    // Only the notification control claims the buyer sees no change.
    expect(notificationsSection).toContain('buyer sees no change');
    expect(withdrawSection).toContain('buyer and project team can see');
    expect(withdrawSection).toContain('cannot re-register interest');

    // Both are gated. "Stop notifications" is an unsubscribe under a friendlier
    // label, so link semantics must not wave it through...
    expect(classifyBrowserAction({
      toolName: 'browser.click',
      elementContext: contextFor('#stop-notifications'),
    })).toMatchObject({ actionClass: 'destructive' });
    // ...and withdrawing interest is destructive rather than a plain submit:
    // the buyer sees it and it cannot be re-registered after the deadline.
    expect(classifyBrowserAction({
      toolName: 'browser.click',
      elementContext: contextFor('#confirm-withdraw'),
    })).toMatchObject({ actionClass: 'destructive' });
  });

  it('requires one action-time approval, then executes once and verifies persistence', async () => {
    const sendCommand = vi.fn(async () => ({ clicked: true }));
    const { service, driver, approvalRequests } = makeService({
      existingTab: LOCAL_TAB,
      extensionCommandStore: { sendCommand },
    });
    driver.inspectElement.mockResolvedValue({
      role: 'button',
      accessibleName: 'Withdraw interest',
    });
    const click = () => service.click({
      profileId: LOCAL_TAB.profileId,
      targetId: LOCAL_TAB.targetId,
      selector: '#confirm-withdraw',
      instanceId: 'instance-1',
      provider: 'claude',
    });

    const first = await click();
    expect(first).toMatchObject({ decision: 'requires_user', outcome: 'not_run' });
    expect(approvalRequests).toHaveLength(1);
    expect(sendCommand).not.toHaveBeenCalled();

    await service.approveRequest({
      requestId: approvalRequests[0]!.requestId,
      grant: approvalRequests[0]!.proposedGrant,
      reason: 'User approved the tender withdrawal',
    });

    const retry = await click();
    expect(retry).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    // Executed exactly once, and no second approval was raised.
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(approvalRequests).toHaveLength(1);

    // Persisted state read-back.
    loadActivityPage();
    document.querySelector('#status')!.textContent = MOCK_TENDER_WITHDRAWN_STATUS;
    expect(document.querySelector('#status')!.textContent).toContain('Interest withdrawn');
  });

  it('does not execute the withdrawal when the approval is denied', async () => {
    const sendCommand = vi.fn(async () => ({ clicked: true }));
    const { service, driver, approvalRequests } = makeService({
      existingTab: LOCAL_TAB,
      extensionCommandStore: { sendCommand },
    });
    driver.inspectElement.mockResolvedValue({
      role: 'button',
      accessibleName: 'Withdraw interest',
    });

    const first = await service.click({
      profileId: LOCAL_TAB.profileId,
      targetId: LOCAL_TAB.targetId,
      selector: '#confirm-withdraw',
      instanceId: 'instance-1',
      provider: 'claude',
    });
    expect(first.decision).toBe('requires_user');

    await service.denyRequest({
      requestId: approvalRequests[0]!.requestId,
      reason: 'Not now',
    });

    const retry = await service.click({
      profileId: LOCAL_TAB.profileId,
      targetId: LOCAL_TAB.targetId,
      selector: '#confirm-withdraw',
      instanceId: 'instance-1',
      provider: 'claude',
    });
    expect(retry.decision).not.toBe('allowed');
    expect(sendCommand).not.toHaveBeenCalled();
  });

  it('treats the free-text withdrawal message as its own gated action', () => {
    loadActivityPage();

    // Typing into the buyer-facing message box sits inside the withdraw
    // section, so it inherits that section's gated classification rather than
    // slipping through as ordinary input.
    const classification = classifyBrowserAction({
      toolName: 'browser.type',
      elementContext: {
        label: 'Message to the buyer (optional)',
        inputName: 'withdrawMessage',
        nearbyText: document.querySelector('#withdraw')!.textContent!
          .replace(/\s+/g, ' ')
          .trim(),
      },
    });

    expect(classification.actionClass).not.toBe('input');
    expect(['submit', 'destructive']).toContain(classification.actionClass);
  });
});
