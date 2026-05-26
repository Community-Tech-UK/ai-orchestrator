import {
  signal,
  ɵresolveComponentResources as resolveComponentResources,
  type WritableSignal,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserApprovalRequest } from '@contracts/types/browser';

import { BrowserGatewayIpcService } from '../../core/services/ipc/browser-gateway-ipc.service';
import { BrowserApprovalRequestComponent } from './browser-approval-request.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));

await resolveComponentResources((url) => {
  if (url.endsWith('browser-approval-request.component.html')) {
    return Promise.resolve(
      readFileSync(resolve(specDirectory, './browser-approval-request.component.html'), 'utf8'),
    );
  }
  if (url.endsWith('browser-approval-request.component.scss')) {
    return Promise.resolve(
      readFileSync(resolve(specDirectory, './browser-approval-request.component.scss'), 'utf8'),
    );
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('BrowserApprovalRequestComponent', () => {
  let fixture: ComponentFixture<BrowserApprovalRequestComponent>;
  let currentInstanceId: WritableSignal<string | null>;

  const fakeBrowserGateway = {
    listApprovalRequests: vi.fn(),
    approveRequest: vi.fn(),
    denyRequest: vi.fn(),
  };

  beforeEach(async () => {
    currentInstanceId = signal<string | null>('inst-1');
    fakeBrowserGateway.listApprovalRequests.mockResolvedValue({
      success: true,
      data: {
        decision: 'allowed',
        outcome: 'succeeded',
        auditId: 'audit-1',
        data: [makeBrowserApprovalRequest()],
      },
    });
    fakeBrowserGateway.approveRequest.mockResolvedValue({
      success: true,
      data: { decision: 'allowed', outcome: 'succeeded', auditId: 'audit-2' },
    });
    fakeBrowserGateway.denyRequest.mockResolvedValue({
      success: true,
      data: { decision: 'allowed', outcome: 'succeeded', auditId: 'audit-3' },
    });

    await TestBed.configureTestingModule({
      imports: [BrowserApprovalRequestComponent],
      providers: [
        { provide: BrowserGatewayIpcService, useValue: fakeBrowserGateway },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(BrowserApprovalRequestComponent);
    overrideInputs(fixture.componentInstance, currentInstanceId);
  });

  it('renders pending Browser Gateway approvals for the selected session', async () => {
    fixture.detectChanges();
    await settle(fixture);

    const text = fixture.nativeElement.textContent;

    expect(fakeBrowserGateway.listApprovalRequests).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      status: 'pending',
      limit: 25,
    });
    expect(text).toContain('Browser Request');
    expect(text).toContain('browser.request_grant');
    expect(text).toContain('http://localhost:4567');
  });

  it('approves a browser request from the session card', async () => {
    fixture.detectChanges();
    await settle(fixture);

    await fixture.componentInstance.approveRequest(makeBrowserApprovalRequest());

    expect(fakeBrowserGateway.approveRequest).toHaveBeenCalledWith({
      requestId: 'browser-request-1',
      grant: {
        mode: 'autonomous',
        allowedOrigins: [
          {
            scheme: 'http',
            hostPattern: 'localhost',
            port: 4567,
            includeSubdomains: false,
          },
        ],
        allowedActionClasses: ['read', 'navigate', 'input'],
        allowExternalNavigation: false,
        autonomous: true,
      },
      reason: 'Approved from session page',
    });
  });
});

function overrideInputs(
  component: BrowserApprovalRequestComponent,
  instanceId: () => string | null,
): void {
  (component as unknown as { instanceId: () => string | null }).instanceId = instanceId;
}

async function settle(fixture: ComponentFixture<BrowserApprovalRequestComponent>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await fixture.whenStable();
    await Promise.resolve();
    fixture.detectChanges();
  }
}

function makeBrowserApprovalRequest(): BrowserApprovalRequest {
  return {
    id: 'browser-request-1',
    requestId: 'browser-request-1',
    instanceId: 'inst-1',
    provider: 'copilot',
    profileId: 'profile-1',
    targetId: 'target-1',
    toolName: 'browser.request_grant',
    action: 'request_grant',
    actionClass: 'input',
    origin: 'http://localhost:4567',
    url: 'http://localhost:4567/form',
    proposedGrant: {
      mode: 'autonomous',
      allowedOrigins: [
        {
          scheme: 'http',
          hostPattern: 'localhost',
          port: 4567,
          includeSubdomains: false,
        },
      ],
      allowedActionClasses: ['read', 'navigate', 'input'],
      allowExternalNavigation: false,
      autonomous: true,
    },
    status: 'pending',
    createdAt: 1_900_000_000_000,
    expiresAt: 1_900_000_600_000,
  };
}
