import { ɵresolveComponentResources as resolveComponentResources, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { BehaviorSubject } from 'rxjs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserApprovalRequest } from '@contracts/types/browser';
import { BrowserGatewayIpcService } from '../../core/services/ipc/browser-gateway-ipc.service';
import { AuxiliaryLlmIpcService } from '../../core/services/ipc/auxiliary-llm-ipc.service';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { BrowserPageComponent } from './browser-page.component';

const directory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(directory, './browser-page.component.html'), 'utf8');
const styles = readFileSync(resolve(directory, './browser-page.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('browser-page.component.html')) return Promise.resolve(template);
  if (url.endsWith('browser-page.component.scss')) return Promise.resolve(styles);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function result<T>(data: T) {
  return Promise.resolve({
    success: true as const,
    data: {
      decision: 'allowed' as const,
      outcome: 'succeeded' as const,
      auditId: 'audit-1',
      data,
    },
  });
}

describe('BrowserPageComponent approval deep link', () => {
  it('opens Permissions, focuses the requested card, and keeps credential choices exact-only', async () => {
    const requestId = 'request-credential-1234';
    const queryParams = new BehaviorSubject(convertToParamMap({
      view: 'permissions',
      requestId,
    }));
    const approval: BrowserApprovalRequest = {
      id: requestId,
      requestId,
      instanceId: 'instance-1',
      provider: 'codex' as const,
      profileId: 'profile-1',
      targetId: 'target-1',
      toolName: 'browser.click',
      action: 'click',
      actionClass: 'credential' as const,
      origin: 'https://auth.example.gov.uk',
      url: 'https://auth.example.gov.uk/login',
      selector: 'button[name="action"]',
      proposedGrant: {
        mode: 'per_action' as const,
        allowedOrigins: [],
        allowedActionClasses: ['credential' as const],
        allowExternalNavigation: false,
        autonomous: false,
      },
      status: 'pending' as const,
      createdAt: 1_700_000_000_000,
      expiresAt: 4_102_444_800_000,
    };
    let approvalResponses: BrowserApprovalRequest[] = [approval];
    const gateway = {
      listProfiles: vi.fn(() => result([])),
      listTargets: vi.fn(() => result([])),
      getAuditLog: vi.fn(() => result([])),
      listApprovalRequests: vi.fn(() => result(approvalResponses)),
      listGrants: vi.fn(() => result([])),
      getHealth: vi.fn(() => result({ status: 'ready' })),
    };
    await TestBed.configureTestingModule({
      imports: [BrowserPageComponent],
      providers: [
        { provide: BrowserGatewayIpcService, useValue: gateway },
        { provide: AuxiliaryLlmIpcService, useValue: { extractWeb: vi.fn() } },
        {
          provide: RemoteNodeStore,
          useValue: {
            nodes: signal([]),
            initialize: vi.fn(async () => undefined),
            nodeById: vi.fn(),
          },
        },
        { provide: ActivatedRoute, useValue: { queryParamMap: queryParams.asObservable() } },
      ],
    }).compileComponents();

    const focus = vi.spyOn(HTMLElement.prototype, 'focus');
    const fixture = TestBed.createComponent(BrowserPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    await Promise.resolve();

    expect(fixture.componentInstance.activeView()).toBe('permissions');
    const card = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
      `#browser-approval-${requestId}`,
    );
    expect(card).not.toBeNull();
    expect(card?.getAttribute('tabindex')).toBe('-1');
    fixture.componentInstance.ngAfterViewChecked();
    expect(focus).toHaveBeenCalled();
    expect(card?.textContent).toContain('Request 1 of 1');
    expect(card?.textContent).toContain('#request-');
    expect(card?.querySelector('.autonomous-controls')).toBeNull();
    const labels = Array.from(card?.querySelectorAll('button') ?? [])
      .map((button) => button.textContent?.trim());
    expect(labels).toEqual(['Allow once', 'Deny']);

    const nextRequestId = 'request-unknown-5678';
    approvalResponses = [
      approval,
      {
        ...approval,
        id: nextRequestId,
        requestId: nextRequestId,
        actionClass: 'unknown',
        proposedGrant: {
          ...approval.proposedGrant,
          allowedActionClasses: ['unknown'],
        },
      },
    ];
    queryParams.next(convertToParamMap({ view: 'permissions', requestId: nextRequestId }));
    await fixture.whenStable();
    fixture.detectChanges();
    fixture.componentInstance.ngAfterViewChecked();

    expect(fixture.componentInstance.focusedApprovalRequestId()).toBe(nextRequestId);
    const nextCard = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
      `#browser-approval-${nextRequestId}`,
    );
    expect(nextCard).not.toBeNull();
    expect(nextCard?.style.outline).toContain('2px solid');
    expect(focus).toHaveBeenCalledTimes(2);
  });
});
