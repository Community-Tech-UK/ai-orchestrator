import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserApprovalRequest } from '@contracts/types/browser';
import { BrowserApprovalsBannerComponent } from './browser-approvals-banner.component';
import { BrowserGatewayIpcService } from '../services/ipc/browser-gateway-ipc.service';

function makeApproval(overrides: Partial<BrowserApprovalRequest> = {}): BrowserApprovalRequest {
  return {
    id: 'row-1',
    requestId: 'request-1',
    instanceId: 'instance-1',
    provider: 'claude',
    profileId: 'existing-tab:7:42',
    targetId: 'existing-tab:7:42:target',
    toolName: 'browser.upload_file',
    action: 'upload_file',
    actionClass: 'file-upload',
    origin: 'https://instagram.com',
    filePath: '/tmp/rosette.jpg',
    proposedGrant: {
      mode: 'per_action',
      allowedOrigins: [
        { scheme: 'https', hostPattern: 'instagram.com', includeSubdomains: false },
      ],
      allowedActionClasses: ['file-upload'],
      allowExternalNavigation: false,
      autonomous: false,
    },
    status: 'pending',
    createdAt: 1_000,
    expiresAt: 2_000,
    ...overrides,
  };
}

function gatewayResponse(requests: BrowserApprovalRequest[]) {
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

function makeGateway(requests: BrowserApprovalRequest[]) {
  return {
    listApprovalRequests: vi.fn(async () => gatewayResponse(requests)),
    approveRequest: vi.fn(async () => gatewayResponse([])),
    denyRequest: vi.fn(async () => gatewayResponse([])),
  };
}

describe('BrowserApprovalsBannerComponent', () => {
  let gateway: ReturnType<typeof makeGateway>;
  const router = { navigateByUrl: vi.fn(async () => true) };

  function setup(requests: BrowserApprovalRequest[]) {
    TestBed.resetTestingModule();
    gateway = makeGateway(requests);
    TestBed.configureTestingModule({
      imports: [BrowserApprovalsBannerComponent],
      providers: [
        { provide: BrowserGatewayIpcService, useValue: gateway },
        { provide: Router, useValue: router },
      ],
    });
    const fixture = TestBed.createComponent(BrowserApprovalsBannerComponent);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stays hidden when no approvals are pending', async () => {
    const fixture = setup([]);
    await fixture.whenStable();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.approvals-banner')).toBeNull();
  });

  it('shows the oldest pending request from ANY instance with quick actions', async () => {
    const fixture = setup([
      makeApproval({ requestId: 'newer', instanceId: 'instance-2', createdAt: 5_000 }),
      makeApproval({ requestId: 'older', instanceId: 'instance-1', createdAt: 1_000 }),
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    const banner = element.querySelector('.approvals-banner');
    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.textContent).toContain('2 browser actions are waiting');
    // Oldest first: the request that has been blocking its agent longest.
    expect(banner?.textContent).toContain('session instance-1');
    // The global poll must not be scoped to one instance.
    expect(gateway.listApprovalRequests).toHaveBeenCalledWith({ status: 'pending', limit: 25 });

    element.querySelector<HTMLButtonElement>('.banner-btn.primary')?.click();
    await fixture.whenStable();
    expect(gateway.approveRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'older',
    }));
  });

  it('denies the oldest pending request on Deny', async () => {
    const fixture = setup([makeApproval()]);
    await fixture.whenStable();
    fixture.detectChanges();

    const buttons = (fixture.nativeElement as HTMLElement)
      .querySelectorAll<HTMLButtonElement>('.banner-btn');
    const denyButton = Array.from(buttons).find((btn) => btn.textContent?.trim() === 'Deny');
    denyButton?.click();
    await fixture.whenStable();

    expect(gateway.denyRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'request-1',
    }));
  });

  it('withholds one-click approve for autonomous or credential-class proposals', async () => {
    const fixture = setup([
      makeApproval({
        proposedGrant: {
          mode: 'autonomous',
          allowedOrigins: [],
          allowedActionClasses: ['credential'],
          allowExternalNavigation: false,
          autonomous: true,
        },
      }),
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.banner-btn.primary')).toBeNull();
    const review = Array.from(element.querySelectorAll<HTMLButtonElement>('.banner-btn'))
      .find((btn) => btn.textContent?.trim() === 'Review');
    expect(review).toBeDefined();

    review?.click();
    expect(router.navigateByUrl).toHaveBeenCalledWith('/browser');
  });
});
