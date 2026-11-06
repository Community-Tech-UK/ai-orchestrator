import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserApprovalRequest } from '@contracts/types/browser';
import { BrowserGatewayIpcService } from '../services/ipc/browser-gateway-ipc.service';
import { BrowserApprovalsBannerComponent } from './browser-approvals-banner.component';
import { BrowserApprovalsStore } from './browser-approvals.store';

describe('ordinary browser permission failure details', () => {
  afterEach(() => TestBed.resetTestingModule());

  async function mount() {
    const request: BrowserApprovalRequest = {
      id: 'row', requestId: 'request', instanceId: 'session', provider: 'claude',
      profileId: 'existing-tab:1:2', targetId: 'target', toolName: 'browser.click',
      action: 'click', actionClass: 'input', origin: 'https://example.com',
      proposedGrant: {
        mode: 'per_action', allowedOrigins: [{ scheme: 'https', hostPattern: 'example.com', includeSubdomains: false }],
        allowedActionClasses: ['input'], allowExternalNavigation: false, autonomous: false,
      },
      status: 'pending', createdAt: 1000, expiresAt: 2000,
    };
    const pending = signal([request]);
    const gateway = { approveRequest: vi.fn(), denyRequest: vi.fn() };
    const removeRequest = vi.fn();
    await TestBed.configureTestingModule({ imports: [BrowserApprovalsBannerComponent], providers: [
      { provide: BrowserGatewayIpcService, useValue: gateway },
      { provide: Router, useValue: { navigate: vi.fn() } },
      { provide: BrowserApprovalsStore, useValue: {
        pendingRequests: pending, oldestPending: computed(() => pending()[0]), isMinimized: signal(false),
        startPolling: vi.fn(), stopPolling: vi.fn(), removeRequest, refresh: vi.fn(),
      } },
    ] }).compileComponents();
    const fixture = TestBed.createComponent(BrowserApprovalsBannerComponent);
    fixture.detectChanges();
    return { fixture, gateway, request, removeRequest };
  }

  it.each(['approve', 'deny'] as const)('keeps a raw IPC failure from %s under closed Details', async action => {
    const { fixture, gateway, request, removeRequest } = await mount();
    gateway[action === 'approve' ? 'approveRequest' : 'denyRequest'].mockResolvedValue({
      success: false, error: { message: 'PRIVATE_DIAGNOSTIC_TEXT' },
    });
    await fixture.componentInstance[action](request);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.banner-error')?.textContent).not.toContain('PRIVATE_DIAGNOSTIC_TEXT');
    const details = element.querySelector<HTMLDetailsElement>('.banner-actions details');
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain('PRIVATE_DIAGNOSTIC_TEXT');
    expect(removeRequest).not.toHaveBeenCalled();
  });

  it('uses the closed error vocabulary for an ordinary gateway reason code', async () => {
    const { fixture, gateway, request } = await mount();
    gateway.denyRequest.mockResolvedValue({ success: true, data: {
      decision: 'denied', outcome: 'not_run', reason: 'approval_request_expired',
    } });
    await fixture.componentInstance.deny(request);
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.banner-error')?.textContent).toBe('This request timed out.');
  });

  it('keeps a thrown transport diagnostic available without making it the sentence', async () => {
    const { fixture, gateway, request } = await mount();
    gateway.approveRequest.mockRejectedValue(new Error('PRIVATE_DIAGNOSTIC_TEXT'));
    await fixture.componentInstance.approve(request);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.banner-error')?.textContent).not.toContain('PRIVATE_DIAGNOSTIC_TEXT');
    expect(element.querySelector('.banner-details')?.textContent).toContain('PRIVATE_DIAGNOSTIC_TEXT');
  });
});
