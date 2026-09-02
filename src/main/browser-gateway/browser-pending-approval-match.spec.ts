import { describe, expect, it, vi } from 'vitest';
import type { BrowserApprovalRequest } from '@contracts/types/browser';
import type { BrowserApprovalRequestInput } from './browser-approval-store';
import { createOrReusePendingBrowserApproval } from './browser-pending-approval-match';

const input: BrowserApprovalRequestInput = {
  instanceId: 'instance-1',
  provider: 'orchestrator',
  profileId: 'profile-1',
  targetId: 'target-1',
  toolName: 'browser.click',
  action: 'click',
  actionClass: 'credential',
  origin: 'https://auth.example.gov.uk',
  url: 'https://auth.example.gov.uk/login',
  selector: 'button[name="action"]',
  proposedGrant: {
    mode: 'per_action',
    allowedOrigins: [{
      scheme: 'https',
      hostPattern: 'auth.example.gov.uk',
      includeSubdomains: false,
    }],
    allowedActionClasses: ['credential'],
    allowExternalNavigation: false,
    autonomous: false,
  },
  expiresAt: 4_102_444_800_000,
};

function existing(overrides: Partial<BrowserApprovalRequest> = {}): BrowserApprovalRequest {
  return {
    ...input,
    id: 'row-1',
    requestId: 'request-1',
    status: 'pending',
    createdAt: 1,
    ...overrides,
  };
}

describe('createOrReusePendingBrowserApproval', () => {
  it('reuses an identical pending request instead of stacking another popup', () => {
    const createRequest = vi.fn();
    const store = {
      listRequests: vi.fn(() => [existing()]),
      createRequest,
    };

    const result = createOrReusePendingBrowserApproval(store, input);

    expect(result).toEqual({ approval: expect.objectContaining({ requestId: 'request-1' }), reused: true });
    expect(createRequest).not.toHaveBeenCalled();
  });

  it('creates a new request when the selector changes', () => {
    const created = existing({ id: 'row-2', requestId: 'request-2', selector: '#other' });
    const store = {
      listRequests: vi.fn(() => [existing()]),
      createRequest: vi.fn(() => created),
    };

    const result = createOrReusePendingBrowserApproval(store, { ...input, selector: '#other' });

    expect(result).toEqual({ approval: created, reused: false });
    expect(store.createRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    existing({ status: 'approved' }),
    existing({ expiresAt: 1 }),
  ])('does not reuse an expired or already decided request', (ineligible) => {
    const created = existing({ id: 'row-3', requestId: 'request-3' });
    const store = {
      listRequests: vi.fn(() => [ineligible]),
      createRequest: vi.fn(() => created),
    };

    expect(createOrReusePendingBrowserApproval(store, input)).toEqual({
      approval: created,
      reused: false,
    });
  });
});
