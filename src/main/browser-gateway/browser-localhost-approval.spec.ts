import { describe, expect, it, vi } from 'vitest';
import type { BrowserApprovalRequest } from '@contracts/types/browser';
import { makeProfile, makeService, makeTarget } from './browser-gateway-service.test-helpers';
import { withLocalBrowserAutoApproval } from './browser-auto-approve';

function makeLocalApproval(overrides: Partial<BrowserApprovalRequest> = {}): BrowserApprovalRequest {
  return {
    id: 'approval-local', requestId: 'approval-local', instanceId: 'instance-1', provider: 'copilot',
    profileId: 'profile-1', targetId: 'target-1', toolName: 'browser.request_grant', action: 'request_grant',
    actionClass: 'submit', origin: 'http://localhost:4567', url: 'http://localhost:4567/form',
    status: 'pending', createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    proposedGrant: {
      mode: 'session', allowedOrigins: makeProfile().allowedOrigins,
      allowedActionClasses: ['input', 'submit', 'destructive'],
      allowExternalNavigation: false, autonomous: true,
    },
    ...overrides,
  };
}

function shouldApprove(approval: BrowserApprovalRequest): boolean {
  return withLocalBrowserAutoApproval()({
    approval, instanceId: approval.instanceId, provider: approval.provider,
    toolName: approval.toolName, action: approval.action, actionClass: approval.actionClass,
  });
}

describe('localhost browser approvals', () => {
  it('grants localhost development access without a pending user prompt', async () => {
    const { service, approvalRequests, grants } = makeService({ autoApproveRequests: withLocalBrowserAutoApproval(() => false) });
    const result = await service.requestGrant({
      instanceId: 'instance-1', provider: 'copilot', profileId: 'profile-1', targetId: 'target-1',
      proposedGrant: {
        mode: 'session', allowedOrigins: makeProfile().allowedOrigins,
        allowedActionClasses: ['input', 'submit', 'destructive'],
        allowExternalNavigation: false, autonomous: true,
      },
    });
    expect(result.decision).toBe('allowed');
    expect(result.outcome).toBe('succeeded');
    expect(approvalRequests.filter((request) => request.status === 'pending')).toEqual([]);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.autonomous).toBe(true);
    expect(grants[0]?.reason).toBe('auto_approved_localhost');
  });

  it('still asks for approval on an external site', async () => {
    const profile = makeProfile({ allowedOrigins: [{ scheme: 'https', hostPattern: 'example.com', includeSubdomains: false }] });
    const target = makeTarget({ url: 'https://example.com', origin: 'https://example.com' });
    const { service, approvalRequests, grants } = makeService({ profile, target, autoApproveRequests: withLocalBrowserAutoApproval(() => false) });
    const result = await service.requestGrant({
      instanceId: 'instance-1', provider: 'copilot', profileId: profile.id, targetId: target.id,
      proposedGrant: {
        mode: 'session', allowedOrigins: profile.allowedOrigins, allowedActionClasses: ['input'],
        allowExternalNavigation: false, autonomous: false,
      },
    });
    expect(result.decision).toBe('requires_user');
    expect(approvalRequests.filter((request) => request.status === 'pending')).toHaveLength(1);
    expect(grants).toEqual([]);
  });

  it.each([
    ['http://localhost:4315', 'http', 'localhost', 4315],
    ['https://LOCALHOST', 'https', 'localhost', 443],
    ['http://127.0.0.1:3000', 'http', '127.0.0.1', 3000],
    ['http://127.0.0.2:3000', 'http', '127.0.0.2', 3000],
    ['http://[::1]:8080', 'http', '[::1]', 8080],
  ] as const)('approves the loopback origin %s', (url, scheme, hostPattern, port) => {
    const approval = makeLocalApproval();
    approval.origin = new URL(url).origin;
    approval.url = `${url}/form`;
    approval.proposedGrant.allowedOrigins = [{ scheme, hostPattern, port, includeSubdomains: false }];
    expect(shouldApprove(approval)).toBe(true);
  });

  it.each(['http://localhost.example.com:4567', 'http://example.com:4567', 'http://192.168.0.1:4567',
    'http://0.0.0.0:4567', 'http://[::ffff:127.0.0.1]:4567', 'file:///localhost', 'invalid-url'])
  ('does not trust a non-loopback page %s', (url) => {
    const approval = makeLocalApproval({ url });
    // Match the page and proposal so this exercises host trust, rather than
    // merely being rejected by the separate origin-mismatch check.
    if (URL.canParse(url)) {
      const parsed = new URL(url);
      approval.origin = parsed.origin;
      approval.proposedGrant.allowedOrigins = [{
        scheme: 'http', hostPattern: parsed.hostname, port: 4567, includeSubdomains: false,
      }];
    }
    expect(shouldApprove(approval)).toBe(false);
  });

  it.each(['credential', 'payment', 'financial_identity', 'sensitive_identity'] as const)
  ('retains the %s restriction on localhost', (actionClass) => {
    const approval = makeLocalApproval({ actionClass });
    approval.proposedGrant.allowedActionClasses.push(actionClass);
    expect(shouldApprove(approval)).toBe(false);
  });

  it('rejects broader origins, external navigation, and persistent grants', () => {
    const broader = makeLocalApproval();
    broader.proposedGrant.allowedOrigins.push({ scheme: 'https', hostPattern: 'example.com', includeSubdomains: false });
    expect(shouldApprove(broader)).toBe(false);
    const subdomains = makeLocalApproval();
    subdomains.proposedGrant.allowedOrigins[0]!.includeSubdomains = true;
    expect(shouldApprove(subdomains)).toBe(false);
    const wildcard = makeLocalApproval();
    wildcard.proposedGrant.allowedOrigins[0]!.hostPattern = '*.localhost';
    expect(shouldApprove(wildcard)).toBe(false);
    const external = makeLocalApproval();
    external.proposedGrant.allowExternalNavigation = true;
    expect(shouldApprove(external)).toBe(false);
    const persistent = makeLocalApproval();
    persistent.proposedGrant.mode = 'persistent';
    expect(shouldApprove(persistent)).toBe(false);
  });

  it('requires matching origin, non-empty scope, and an unexpired pending request', () => {
    expect(shouldApprove(makeLocalApproval({ origin: 'http://localhost:9999' }))).toBe(false);
    expect(shouldApprove(makeLocalApproval({ origin: undefined }))).toBe(false);
    expect(shouldApprove(makeLocalApproval({ url: undefined }))).toBe(false);
    expect(shouldApprove(makeLocalApproval({ expiresAt: Date.now() - 1 }))).toBe(false);
    expect(shouldApprove(makeLocalApproval({ status: 'denied' }))).toBe(false);
    const empty = makeLocalApproval();
    empty.proposedGrant.allowedOrigins = [];
    expect(shouldApprove(empty)).toBe(false);
    empty.proposedGrant.allowedOrigins = makeProfile().allowedOrigins;
    empty.proposedGrant.allowedActionClasses = [];
    expect(shouldApprove(empty)).toBe(false);
  });

  it.each(['browser.request_user_login', 'browser.pause_for_manual_step'])
  ('preserves the manual handoff for %s', (toolName) => {
    const approval = makeLocalApproval({ toolName, actionClass: 'credential' });
    approval.proposedGrant.allowedActionClasses = ['read'];
    expect(shouldApprove(approval)).toBe(false);
  });

  it('preserves existing automation policy for external sites', () => {
    const approval = makeLocalApproval({ origin: 'https://example.com', url: 'https://example.com/form' });
    const fallback = vi.fn(() => true);
    expect(withLocalBrowserAutoApproval(fallback)({
      approval, instanceId: approval.instanceId, provider: approval.provider,
      toolName: approval.toolName, action: approval.action, actionClass: approval.actionClass,
    })).toBe(true);
    expect(fallback).toHaveBeenCalledOnce();
  });

  it('runs a local submit through the managed action guard without prompting', async () => {
    const { service, approvalRequests, grants, driver } = makeService({
      autoApproveRequests: withLocalBrowserAutoApproval(),
      inspectElement: async () => ({ role: 'button', accessibleName: 'Save changes' }),
    });
    const result = await service.click({
      instanceId: 'instance-1', provider: 'copilot', profileId: 'profile-1', targetId: 'target-1', selector: '#save',
    });
    expect(result).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    expect(driver.click).toHaveBeenCalledWith('profile-1', 'target-1', '#save');
    expect(approvalRequests.every((request) => request.status === 'approved')).toBe(true);
    expect(grants[0]).toMatchObject({ autonomous: true, allowedActionClasses: ['submit'] });
    expect(grants[0]?.consumedAt).toBeGreaterThan(0);
  });

  it('scopes shared-tab grants to their worker and reuses them on a repeat request', async () => {
    const profileId = 'existing-tab:n.worker-1:7:42';
    const targetId = `${profileId}:target`;
    const sendCommand = vi.fn(async () => ({ ok: true }));
    const { service, grants, approvalRequests } = makeService({
      autoApproveRequests: withLocalBrowserAutoApproval(),
      existingTab: {
        profileId, targetId, nodeId: 'worker-1', title: 'Development', url: 'http://localhost:4567',
        origin: 'http://localhost:4567', allowedOrigins: makeProfile().allowedOrigins,
      },
      extensionCommandStore: { sendCommand },
    });
    const request = {
      instanceId: 'instance-1', provider: 'copilot', profileId, targetId, proposedGrant: makeLocalApproval().proposedGrant,
    };
    expect(await service.requestGrant(request)).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    expect(await service.requestGrant(request)).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatchObject({ nodeId: 'worker-1', reason: 'auto_approved_localhost' });
    expect(grants[0]?.profileId).toBeUndefined();
    expect(approvalRequests).toHaveLength(1);
    const clicked = await service.click({ ...request, selector: '#save', actionHint: 'Save changes' });
    expect(clicked).toMatchObject({ decision: 'allowed', outcome: 'succeeded' });
    expect(sendCommand).toHaveBeenCalledWith(expect.objectContaining({
      queueKey: 'node:worker-1', command: 'click', target: expect.objectContaining({ profileId, targetId }),
    }));
  });

  it('resolves an already-pending localhost request when the banner polls', async () => {
    const fixture = makeService({ autoApproveRequests: withLocalBrowserAutoApproval() });
    fixture.approvalRequests.push(makeLocalApproval());
    const result = await fixture.service.listApprovalRequests({ instanceId: 'instance-1', status: 'pending' });
    expect(result.data).toEqual([]);
    expect(fixture.approvalRequests[0]?.status).toBe('approved');
    expect(fixture.grants).toHaveLength(1);
  });
});
