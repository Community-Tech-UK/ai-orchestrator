import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserApprovalRequest } from '@contracts/types/browser';
import { BrowserApprovalsBannerComponent } from './browser-approvals-banner.component';
import { BrowserApprovalsStore } from './browser-approvals.store';
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
  const router = { navigate: vi.fn(async () => true) };

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
    expect(banner?.textContent).toContain('2 browser permissions requested');
    // Oldest first: the request that has been blocking its agent longest.
    expect(banner?.textContent).toContain('session instance-1');
    expect(banner?.textContent).toContain('Request 1 of 2');
    expect(banner?.textContent).toContain('#older');
    // The global poll must not be scoped to one instance.
    expect(gateway.listApprovalRequests).toHaveBeenCalledWith({ status: 'pending', limit: 25 });

    const select = element.querySelector<HTMLSelectElement>('.banner-scope');
    expect(Array.from(select?.options ?? []).map((option) => option.textContent?.trim())).toEqual([
      'Approve once',
      'Allow for session',
    ]);

    element.querySelector<HTMLButtonElement>('.banner-btn.primary')?.click();
    await fixture.whenStable();
    expect(gateway.approveRequest).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'older',
    }));
  });

  it('minimizes to a compact reminder and expands when the pending set changes', async () => {
    const fixture = setup([makeApproval()]);
    await fixture.whenStable();
    fixture.detectChanges();
    const store = TestBed.inject(BrowserApprovalsStore);

    (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[aria-label="Minimize browser approval banner"]')
      ?.click();
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.approvals-banner.compact')).not.toBeNull();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('1 browser approval waiting');

    store.pendingRequests.set([makeApproval(), makeApproval({ requestId: 'request-2' })]);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.approvals-banner.compact')).toBeNull();
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('2 browser permissions requested');
  });

  it('opens the exact approval on the Permissions view when the banner is clicked', async () => {
    const fixture = setup([makeApproval({ requestId: 'request-focus' })]);
    await fixture.whenStable();
    fixture.detectChanges();

    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.banner-main')?.click();

    expect(router.navigate).toHaveBeenCalledWith(['/browser'], {
      queryParams: { view: 'permissions', requestId: 'request-focus' },
    });
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

  it('offers narrow in-place choices for a low-risk autonomous proposal', async () => {
    const fixture = setup([
      makeApproval({
        toolName: 'browser.type',
        action: 'type',
        actionClass: 'input',
        proposedGrant: {
          mode: 'autonomous',
          allowedOrigins: [
            { scheme: 'https', hostPattern: 'instagram.com', includeSubdomains: false },
          ],
          allowedActionClasses: ['read', 'navigate', 'input'],
          allowExternalNavigation: false,
          autonomous: true,
        },
      }),
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    expect(element.textContent).toContain('type on instagram.com');
    const select = element.querySelector<HTMLSelectElement>('.banner-scope');
    expect(Array.from(select?.options ?? []).map((option) => option.textContent?.trim())).toEqual([
      'Approve once',
      'Allow for session',
      'Always allow',
    ]);
    const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>('.banner-btn'));
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'Approve',
      'Deny',
      'More options',
    ]);

    select!.value = 'session';
    select!.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    buttons.find((button) => button.textContent?.trim() === 'Approve')?.click();
    await fixture.whenStable();
    expect(gateway.approveRequest).toHaveBeenCalledWith({
      requestId: 'request-1',
      grant: {
        mode: 'session',
        allowedOrigins: [
          { scheme: 'https', hostPattern: 'instagram.com', includeSubdomains: false },
        ],
        allowedActionClasses: ['read', 'navigate', 'input'],
        allowExternalNavigation: false,
        autonomous: false,
      },
      reason: 'Allowed for session from browser permission bar',
    });
  });

  it('narrows Allow once to the current classified action', async () => {
    const fixture = setup([
      makeApproval({
        toolName: 'browser.type',
        action: 'type',
        actionClass: 'input',
        proposedGrant: {
          mode: 'autonomous',
          allowedOrigins: [],
          allowedActionClasses: ['read', 'navigate', 'input'],
          allowExternalNavigation: false,
          autonomous: true,
        },
      }),
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    const button = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.banner-btn'),
    ).find((candidate) => candidate.textContent?.trim() === 'Approve');
    button?.click();
    await fixture.whenStable();

    expect(gateway.approveRequest).toHaveBeenCalledWith(expect.objectContaining({
      grant: expect.objectContaining({
        mode: 'per_action',
        allowedActionClasses: ['input'],
        autonomous: false,
      }),
    }));
  });

  it('shows the duration dropdown for a request_grant that includes submit', async () => {
    const fixture = setup([
      makeApproval({
        toolName: 'browser.request_grant',
        action: 'request_grant',
        actionClass: 'submit',
        origin: 'https://education.app.jaggaer.com',
        proposedGrant: {
          mode: 'session',
          allowedOrigins: [
            { scheme: 'https', hostPattern: 'education.app.jaggaer.com', includeSubdomains: false },
          ],
          allowedActionClasses: ['read', 'navigate', 'input', 'submit'],
          allowExternalNavigation: false,
          autonomous: false,
        },
      }),
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    const select = element.querySelector<HTMLSelectElement>('.banner-scope');
    expect(Array.from(select?.options ?? []).map((option) => option.textContent?.trim())).toEqual([
      'Approve once',
      'Allow for session',
    ]);
    expect(element.querySelector('.banner-btn.primary')?.textContent?.trim()).toBe('Approve');
    expect(element.textContent).toContain('Type education.app.jaggaer.com to allow publishing or deleting');

    select!.value = 'session';
    select!.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    element.querySelector<HTMLButtonElement>('.banner-btn.primary')?.click();
    await fixture.whenStable();
    expect(gateway.approveRequest).not.toHaveBeenCalled();
    expect(element.textContent).toContain('Type education.app.jaggaer.com');

    const confirm = element.querySelector<HTMLInputElement>('.banner-confirm input');
    confirm!.value = 'education.app.jaggaer.com';
    confirm!.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    element.querySelector<HTMLButtonElement>('.banner-btn.primary')?.click();
    await fixture.whenStable();

    expect(gateway.approveRequest).toHaveBeenCalledWith(expect.objectContaining({
      grant: expect.objectContaining({
        mode: 'session',
        allowedActionClasses: ['read', 'navigate', 'input', 'submit'],
        autonomous: false,
      }),
    }));
  });

  it('keeps the chosen duration and typed host across a pending-request poll', async () => {
    const pending = makeApproval({
      toolName: 'browser.request_grant',
      action: 'request_grant',
      actionClass: 'submit',
      origin: 'https://education.app.jaggaer.com',
      proposedGrant: {
        mode: 'session',
        allowedOrigins: [
          { scheme: 'https', hostPattern: 'education.app.jaggaer.com', includeSubdomains: false },
        ],
        allowedActionClasses: ['read', 'navigate', 'input', 'submit'],
        allowExternalNavigation: false,
        autonomous: false,
      },
    });
    const fixture = setup([pending]);
    await fixture.whenStable();
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    const select = element.querySelector<HTMLSelectElement>('.banner-scope');
    select!.value = 'session';
    select!.dispatchEvent(new Event('change'));
    const confirm = element.querySelector<HTMLInputElement>('.banner-confirm input');
    confirm!.value = 'education.app.jaggaer.com';
    confirm!.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    TestBed.inject(BrowserApprovalsStore).pendingRequests.set([{ ...pending }]);
    fixture.detectChanges();

    expect(element.querySelector<HTMLSelectElement>('.banner-scope')?.value).toBe('session');
    expect(element.querySelector<HTMLInputElement>('.banner-confirm input')?.value)
      .toBe('education.app.jaggaer.com');

    element.querySelector<HTMLButtonElement>('.banner-btn.primary')?.click();
    await fixture.whenStable();
    expect(gateway.approveRequest).toHaveBeenCalledWith(expect.objectContaining({
      grant: expect.objectContaining({ mode: 'session' }),
    }));
  });

  it('requires the host phrase for a destructive proposal too', async () => {
    const fixture = setup([
      makeApproval({
        toolName: 'browser.request_grant',
        action: 'request_grant',
        actionClass: 'destructive',
        origin: 'https://education.app.jaggaer.com',
        proposedGrant: {
          mode: 'session',
          allowedOrigins: [],
          allowedActionClasses: ['read', 'destructive'],
          allowExternalNavigation: false,
          autonomous: false,
        },
      }),
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    expect(Array.from(element.querySelectorAll<HTMLOptionElement>('.banner-scope option'))
      .map((option) => option.textContent?.trim())).toEqual([
      'Approve once',
      'Allow for session',
    ]);
    element.querySelector<HTMLButtonElement>('.banner-btn.primary')?.click();
    await fixture.whenStable();
    expect(gateway.approveRequest).not.toHaveBeenCalled();

    const confirm = element.querySelector<HTMLInputElement>('.banner-confirm input');
    confirm!.value = 'education.app.jaggaer.com';
    confirm!.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    element.querySelector<HTMLButtonElement>('.banner-btn.primary')?.click();
    await fixture.whenStable();
    expect(gateway.approveRequest).toHaveBeenCalledTimes(1);
  });

  it.each(['credential', 'unknown'] as const)(
    'exposes Approve once and Deny for %s hard stops',
    async (actionClass) => {
      const fixture = setup([
        makeApproval({
          actionClass,
          proposedGrant: {
            mode: 'autonomous',
            allowedOrigins: [],
            allowedActionClasses: [actionClass],
            allowExternalNavigation: false,
            autonomous: true,
          },
        }),
      ]);
      await fixture.whenStable();
      fixture.detectChanges();

      const element: HTMLElement = fixture.nativeElement;
      expect(element.querySelector('.banner-scope')).toBeNull();
      const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>('.banner-btn'));
      expect(buttons.map((button) => button.textContent?.trim())).toEqual([
        'Approve once',
        'Deny',
        'More options',
      ]);
    },
  );

  it.each(['payment', 'financial_identity', 'sensitive_identity'] as const)(
    'keeps Deny available while withholding quick approval for %s proposals',
    async (actionClass) => {
    const fixture = setup([
      makeApproval({
        actionClass,
        proposedGrant: {
          mode: 'autonomous',
          allowedOrigins: [],
          allowedActionClasses: [actionClass],
          allowExternalNavigation: false,
          autonomous: true,
        },
      }),
    ]);
    await fixture.whenStable();
    fixture.detectChanges();

    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('.banner-btn.primary')).toBeNull();
    const buttons = Array.from(element.querySelectorAll<HTMLButtonElement>('.banner-btn'));
    expect(buttons.map((button) => button.textContent?.trim())).toEqual(['Deny', 'More options']);
    const review = buttons.find((btn) => btn.textContent?.trim() === 'More options');
    expect(review).toBeDefined();

    review?.click();
    expect(router.navigate).toHaveBeenCalledWith(['/browser'], {
      queryParams: { view: 'permissions', requestId: 'request-1' },
    });
    },
  );
});
