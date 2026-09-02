import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserApprovalRequest } from '@contracts/types/browser';
import { BrowserGatewayIpcService } from '../services/ipc/browser-gateway-ipc.service';
import { BrowserApprovalsStore } from './browser-approvals.store';

function approval(requestId: string): BrowserApprovalRequest {
  return {
    id: requestId,
    requestId,
    instanceId: 'instance-1',
    provider: 'codex',
    profileId: 'profile-1',
    targetId: 'target-1',
    toolName: 'browser.click',
    action: 'click',
    actionClass: 'credential',
    origin: 'https://auth.example.gov.uk',
    selector: 'button[name="action"]',
    proposedGrant: {
      mode: 'per_action',
      allowedOrigins: [],
      allowedActionClasses: ['credential'],
      allowExternalNavigation: false,
      autonomous: false,
    },
    status: 'pending',
    createdAt: 1,
    expiresAt: 4_102_444_800_000,
  };
}

function response(requests: BrowserApprovalRequest[]) {
  return {
    success: true as const,
    data: {
      decision: 'allowed' as const,
      outcome: 'succeeded' as const,
      data: requests,
      auditId: 'audit-1',
    },
  };
}

describe('BrowserApprovalsStore', () => {
  const gateway = { listApprovalRequests: vi.fn() };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        BrowserApprovalsStore,
        { provide: BrowserGatewayIpcService, useValue: gateway },
      ],
    });
  });

  it('loads the shared pending list once for every consumer', async () => {
    gateway.listApprovalRequests.mockResolvedValue(response([approval('request-1')]));
    const store = TestBed.inject(BrowserApprovalsStore);

    await Promise.all([store.refresh(), store.refresh()]);

    expect(gateway.listApprovalRequests).toHaveBeenCalledTimes(1);
    expect(store.pendingRequests().map((item) => item.requestId)).toEqual(['request-1']);
  });

  it('minimizes only the current request set and expands automatically for a new request', async () => {
    gateway.listApprovalRequests
      .mockResolvedValueOnce(response([approval('request-1')]))
      .mockResolvedValueOnce(response([approval('request-1'), approval('request-2')]))
      .mockResolvedValueOnce(response([approval('request-1')]));
    const store = TestBed.inject(BrowserApprovalsStore);

    await store.refresh();
    store.minimizeCurrentSet();
    expect(store.isMinimized()).toBe(true);

    await store.refresh();
    expect(store.isMinimized()).toBe(false);

    await store.refresh();
    expect(store.isMinimized()).toBe(false);
  });

  it('removes a decided request immediately without waiting for the next poll', async () => {
    gateway.listApprovalRequests.mockResolvedValue(response([
      approval('request-1'),
      approval('request-2'),
    ]));
    const store = TestBed.inject(BrowserApprovalsStore);
    await store.refresh();

    store.removeRequest('request-1');

    expect(store.pendingRequests().map((item) => item.requestId)).toEqual(['request-2']);
  });
});
