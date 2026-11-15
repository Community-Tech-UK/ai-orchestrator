import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { SessionNavigator } from '../../core/services/session-navigator.service';
import { BrowserApprovalsBannerComponent } from '../../core/state/browser-approvals-banner.component';
import { BrowserGatewayIpcService } from '../../core/services/ipc/browser-gateway-ipc.service';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserApprovalRequest } from '@contracts/types/browser';
import { presentBrowserApproval } from './browser-approval-request.rules';
import { bannerCanQuickApprove, bannerGrantModes } from '../../core/state/browser-approvals-banner.rules';

const approval: BrowserApprovalRequest = {
  id: 'approval-placeholder', requestId: 'approval-placeholder', instanceId: 'session-placeholder', provider: 'codex',
  profileId: 'browser-profile', targetId: 'target-placeholder', toolName: 'browser.fill_device_login', action: 'fill_device_login',
  actionClass: 'credential', status: 'pending', createdAt: 1_000, expiresAt: 61_000,
  proposedGrant: { mode: 'per_action', allowedOrigins: [{ scheme: 'https', hostPattern: 'auth.openai.com', includeSubdomains: false }],
    allowedActionClasses: ['credential'], allowExternalNavigation: false, autonomous: false },
  deviceLogin: {
    operationHandle: 'operation-placeholder', ownerSessionId: 'session-placeholder', ownerGeneration: 'generation-placeholder',
    nativeNodeId: 'native-node', nativeProfileId: 'native-profile', nativeComputerName: 'Test Mac',
    browserNodeId: 'browser-node', browserProfileId: 'browser-profile', browserComputerName: 'Test PC', targetId: 'target-placeholder',
    origin: 'https://auth.openai.com', expectedIdentity: 'account@example.test',
    extensionInstanceId: 'extension-placeholder', extensionGeneration: 'extension-generation', documentId: 'document-placeholder', expiresAt: 61_000,
  },
};
describe('Codex device sign-in consent presentation', () => {
  it('shows the exact account, computers, native profile and one-operation consequence', () => {
    const view = presentBrowserApproval(approval);
    expect(view.kind).toBe('device-login');
    expect(view.facts).toEqual(expect.arrayContaining([
      { label: 'Account', value: 'account@example.test' },
      { label: 'Codex computer', value: 'Test Mac' },
      { label: 'Codex profile', value: 'native-profile' },
      { label: 'Browser computer', value: 'Test PC' },
      { label: 'Website', value: 'auth.openai.com' },
    ]));
    expect(view.choices.map(choice => choice.id)).toEqual(['once']);
    expect(view.choices[0].label).toBe('Allow this sign-in');
    expect(view.note).toContain('Only this sign-in');
    expect(view.phrase).toBeNull();
  });
  it('prevents approval from generic cards that do not show the device context', () => {
    expect(bannerCanQuickApprove(approval)).toBe(false);
    expect(bannerGrantModes(approval)).toEqual([]);
  });
});

it('opens the owning session from the global banner so full sign-in details can be reviewed', () => {
  const openSession = vi.fn();
  TestBed.configureTestingModule({
    imports: [BrowserApprovalsBannerComponent],
    providers: [
      { provide: SessionNavigator, useValue: { openSession } },
      { provide: Router, useValue: { navigate: vi.fn() } },
      { provide: BrowserGatewayIpcService, useValue: { listApprovalRequests: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(BrowserApprovalsBannerComponent);
  fixture.componentInstance.review(approval);
  expect(openSession).toHaveBeenCalledExactlyOnceWith(approval.instanceId);
  fixture.destroy();
});
