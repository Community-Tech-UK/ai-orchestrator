import {
  signal,
  ɵresolveComponentResources as resolveComponentResources,
  type WritableSignal,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserApprovalRequest } from '@contracts/types/browser';

import { BrowserGatewayIpcService } from '../../core/services/ipc/browser-gateway-ipc.service';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
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

const shop = { scheme: 'https', hostPattern: 'shop.example.com', includeSubdomains: false } as const;

describe('BrowserApprovalRequestComponent', () => {
  let fixture: ComponentFixture<BrowserApprovalRequestComponent>;
  let currentInstanceId: WritableSignal<string | null>;
  let element: HTMLElement;

  const fakeBrowserGateway = {
    listApprovalRequests: vi.fn(),
    approveRequest: vi.fn(),
    denyRequest: vi.fn(),
  };
  const roster = signal([{ id: 'node-win', name: 'Windows PC', platform: 'win32' }]);

  function listOnce(...approvals: BrowserApprovalRequest[]): void {
    fakeBrowserGateway.listApprovalRequests.mockResolvedValue({
      success: true,
      data: { decision: 'allowed', outcome: 'succeeded', auditId: 'audit-1', data: approvals },
    });
  }

  async function show(...approvals: BrowserApprovalRequest[]): Promise<void> {
    listOnce(...approvals);
    fixture.detectChanges();
    await settle(fixture);
    element = fixture.nativeElement;
  }

  function buttons(): HTMLButtonElement[] {
    return Array.from(element.querySelectorAll<HTMLButtonElement>('button'));
  }

  function button(text: string): HTMLButtonElement {
    const match = buttons().find((candidate) => candidate.textContent?.trim() === text);
    if (!match) throw new Error(`No button "${text}". Buttons: ${buttons().map((b) => b.textContent?.trim()).join(' | ')}`);
    return match;
  }

  async function press(text: string): Promise<void> {
    button(text).click();
    await settle(fixture);
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    currentInstanceId = signal<string | null>('inst-1');
    roster.set([{ id: 'node-win', name: 'Windows PC', platform: 'win32' }]);
    listOnce(makeRequest());
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
        { provide: RemoteNodeStore, useValue: { nodes: roster.asReadonly() } },
        { provide: ElectronIpcService, useValue: { platform: 'darwin' } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(BrowserApprovalRequestComponent);
    overrideInputs(fixture.componentInstance, currentInstanceId);
  });

  describe('an ordinary browser action', () => {
    it('lists pending requests for the selected session', async () => {
      await show(makeRequest());
      expect(fakeBrowserGateway.listApprovalRequests).toHaveBeenCalledWith({
        instanceId: 'inst-1',
        status: 'pending',
        limit: 25,
      });
    });

    it('says what will happen in plain words, with the website and the computer', async () => {
      await show(makeRequest());
      expect(element.querySelector('.browser-approval-kicker')?.textContent?.trim()).toBe('Browser action');
      expect(element.querySelector('.browser-approval-title')?.textContent?.trim())
        .toBe("Click 'Add to basket' on shop.example.com (Windows PC)");
      const facts = element.querySelector('.browser-approval-facts')?.textContent ?? '';
      expect(facts).toContain('Why it needs your OK');
      expect(facts).toContain('It types or clicks on the page.');
      expect(facts).toContain('shop.example.com');
      expect(facts).toContain('Windows PC');
      expect(facts).toContain('Reply before');
    });

    it('keeps the raw tool, selector, scope and profile under Details only', async () => {
      await show(makeRequest());
      const details = element.querySelector('details.browser-approval-more');
      expect(details).not.toBeNull();
      expect(details?.hasAttribute('open')).toBe(false);
      expect(details?.querySelector('summary')?.textContent?.trim()).toBe('Details');
      const raw = details?.textContent ?? '';
      for (const technical of ['browser.click', 'button#add', 'per_action - input - https://shop.example.com', 'existing-tab:n.node-win:1:2']) {
        expect(raw).toContain(technical);
        expect(element.querySelector('.browser-approval-main')?.textContent).not.toContain(technical);
        expect(element.querySelector('.browser-approval-facts')?.textContent).not.toContain(technical);
      }
    });

    it('shows the three scope buttons in the shared words, with Deny first', async () => {
      await show(makeRequest());
      expect(buttons().map((candidate) => candidate.textContent?.trim())).toEqual([
        'Deny',
        'Allow this once',
        'Allow for this session',
        'Allow without asking (this session)',
      ]);
    });

    it.each([
      ['Allow this once', 'per_action', false, 'Allowed once from session page'],
      ['Allow for this session', 'session', false, 'Allowed for session from session page'],
      ['Allow without asking (this session)', 'autonomous', true, 'Allowed without asking from session page'],
    ] as const)('%s sends a %s grant', async (label, mode, autonomous, reason) => {
      await show(makeRequest());
      await press(label);
      expect(fakeBrowserGateway.approveRequest).toHaveBeenCalledTimes(1);
      expect(fakeBrowserGateway.approveRequest).toHaveBeenCalledWith({
        requestId: 'browser-request-1',
        grant: {
          mode,
          allowedOrigins: [shop],
          allowedActionClasses: ['input'],
          allowExternalNavigation: false,
          autonomous,
        },
        reason,
      });
    });

    it('removes the card once the approval is recorded', async () => {
      await show(makeRequest());
      listOnce();
      await press('Allow this once');
      expect(fixture.componentInstance.pendingRequests()).toEqual([]);
      expect(element.querySelector('.browser-approval-card')).toBeNull();
    });

    it('keeps the request and says why when the approval did not complete', async () => {
      await show(makeRequest());
      fakeBrowserGateway.approveRequest.mockResolvedValueOnce({
        success: true,
        data: { decision: 'denied', outcome: 'not_run', reason: 'approval_request_expired', auditId: 'audit-x' },
      });
      await press('Allow for this session');
      expect(fixture.componentInstance.pendingRequests()).toHaveLength(1);
      expect(element.querySelector('.browser-approval-error')?.textContent?.trim()).toBe('This request timed out.');
    });

    it('puts an IPC diagnostic under closed Details, never in the visible failure sentence', async () => {
      await show(makeRequest());
      fakeBrowserGateway.approveRequest.mockResolvedValueOnce({ success: false, error: { message: 'PRIVATE_DIAGNOSTIC_TEXT' } });
      await press('Allow this once');
      expect(element.querySelector('[role="alert"]')?.textContent).not.toContain('PRIVATE_DIAGNOSTIC_TEXT');
      const details = element.querySelector<HTMLDetailsElement>('details.browser-approval-error-details');
      expect(details?.open).toBe(false);
      expect(details?.textContent).toContain('PRIVATE_DIAGNOSTIC_TEXT');
    });

    it('keeps an unknown gateway failure code under Details', async () => {
      await show(makeRequest());
      fakeBrowserGateway.denyRequest.mockResolvedValueOnce({
        success: true, data: { decision: 'denied', outcome: 'failed', reason: 'PRIVATE_DIAGNOSTIC_TEXT' },
      });
      await press('Deny');
      expect(element.querySelector('[role="alert"]')?.textContent).not.toContain('PRIVATE');
      expect(element.querySelector('details.browser-approval-error-details')?.textContent).toContain('PRIVATE_DIAGNOSTIC_TEXT');
    });

    it('handles a failed background refresh without an unhandled rejection', async () => {
      await show(makeRequest());
      fakeBrowserGateway.listApprovalRequests.mockRejectedValueOnce(new Error('PRIVATE_DIAGNOSTIC_TEXT'));
      await expect(fixture.componentInstance.refreshPendingRequests()).resolves.toBeUndefined();
      await settle(fixture);
      expect(element.querySelector('[role="alert"]')?.textContent).not.toContain('PRIVATE_DIAGNOSTIC_TEXT');
      expect(element.querySelector('details.browser-approval-error-details')?.textContent).toContain('PRIVATE_DIAGNOSTIC_TEXT');
    });

    it('does not send a second approval while one is in flight', async () => {
      await show(makeRequest());
      let finish: (value: unknown) => void = () => undefined;
      fakeBrowserGateway.approveRequest.mockReturnValueOnce(new Promise((done) => { finish = done; }));
      button('Allow this once').click();
      button('Allow for this session').click();
      await settle(fixture);
      expect(fakeBrowserGateway.approveRequest).toHaveBeenCalledTimes(1);
      expect(button('Allowing…').disabled).toBe(true);
      finish({ success: true, data: { decision: 'allowed', outcome: 'succeeded', auditId: 'audit-4' } });
      await settle(fixture);
    });

    it('denies from the card and clears it', async () => {
      await show(makeRequest());
      listOnce();
      await press('Deny');
      expect(fakeBrowserGateway.denyRequest).toHaveBeenCalledWith({
        requestId: 'browser-request-1',
        reason: 'Denied from session page',
      });
      expect(fakeBrowserGateway.approveRequest).not.toHaveBeenCalled();
      expect(element.querySelector('.browser-approval-card')).toBeNull();
    });

    it('numbers the cards when several requests are waiting', async () => {
      await show(makeRequest(), makeRequest({ id: 'browser-request-2', requestId: 'browser-request-2' }));
      const positions = Array.from(element.querySelectorAll('.browser-approval-position')).map((node) => node.textContent?.trim());
      expect(positions).toEqual(['1 of 2', '2 of 2']);
    });

    it('names the computer from the roster, and says so plainly when it is not known', async () => {
      await show(makeRequest({ computerId: 'node-elsewhere' }));
      expect(element.querySelector('.browser-approval-title')?.textContent).toContain('(another computer)');
      roster.set([{ id: 'node-elsewhere', name: 'Studio PC', platform: 'darwin' }]);
      fixture.detectChanges();
      expect(element.querySelector('.browser-approval-title')?.textContent).toContain('(Studio PC)');
    });

    it('calls the computer Harness runs on this Mac, and leaves the computer out when the gateway did not say', async () => {
      await show(makeRequest({ computerId: 'local' }));
      expect(element.querySelector('.browser-approval-title')?.textContent).toContain('(this Mac)');
      listOnce(makeRequest({ computerId: undefined }));
      await fixture.componentInstance.refreshPendingRequests();
      await settle(fixture);
      expect(element.querySelector('.browser-approval-title')?.textContent).not.toContain('(');
      expect(element.querySelector('.browser-approval-facts')?.textContent).not.toContain('Computer');
    });

    it('shows the reason the agent gave ahead of why the action needs a decision', async () => {
      await show(makeRequest({ requestReason: 'Adding it to your basket' }));
      const labels = Array.from(element.querySelectorAll('.browser-approval-facts dt')).map((node) => node.textContent?.trim());
      expect(labels).toEqual(['Reason', 'Why it needs your OK', 'Website', 'Computer', 'Reply before']);
      expect(element.querySelector('.browser-approval-facts dd')?.textContent?.trim()).toBe('Adding it to your basket');
    });

    it('shows no reason row when the agent gave none', async () => {
      await show(makeRequest());
      const labels = Array.from(element.querySelectorAll('.browser-approval-facts dt')).map((node) => node.textContent?.trim());
      expect(labels).not.toContain('Reason');
    });

    it('tells the person under Details that a shared tab’s element is only the agent’s description', async () => {
      await show(makeRequest());
      expect(element.querySelector('details.browser-approval-more')?.textContent).toContain('Element (as the agent described it)');
    });

    it('explains each button in a tooltip and never uses a native title', async () => {
      await show(makeRequest());
      const tips = fixture.debugElement.queryAll(By.directive(AioTooltipDirective))
        .map((node) => node.injector.get(AioTooltipDirective).appTooltip());
      expect(tips).toEqual([
        'Covers just this one action on shop.example.com. The next one asks again.',
        'Covers typing and clicking on shop.example.com until this session ends.',
        "Covers typing and clicking on shop.example.com until this session ends, without asking again. Meant for runs you're not watching.",
      ]);
      expect(element.querySelector('[title]')).toBeNull();
    });
  });

  describe('publishing and deleting', () => {
    const submit = () => makeRequest({
      toolName: 'browser.click',
      actionClass: 'submit',
      elementContext: { accessibleName: 'Submit order' },
      proposedGrant: grant(['submit']),
    });

    it('asks for the website name and holds every allow button until it is typed', async () => {
      await show(submit());
      expect(element.querySelector('.browser-approval-confirmation')?.textContent)
        .toContain('Type shop.example.com to allow publishing or deleting without another prompt.');
      for (const label of ['Allow this once', 'Allow for this session', 'Allow without asking (this session)']) {
        fakeBrowserGateway.approveRequest.mockClear();
        await press(label);
        expect(fakeBrowserGateway.approveRequest).not.toHaveBeenCalled();
        expect(fixture.componentInstance.errorMessage())
          .toBe('Type shop.example.com to allow publishing or deleting without another prompt.');
      }
    });

    it('sends the approval once the website name is typed', async () => {
      await show(submit());
      type(element.querySelector<HTMLInputElement>('.browser-approval-confirmation input')!, 'shop.example.com');
      await press('Allow for this session');
      expect(fakeBrowserGateway.approveRequest).toHaveBeenCalledTimes(1);
      expect(fakeBrowserGateway.approveRequest.mock.calls[0]![0].grant).toMatchObject({
        mode: 'session',
        allowedActionClasses: ['submit'],
      });
    });

    it('does not accept a different website name', async () => {
      await show(submit());
      type(element.querySelector<HTMLInputElement>('.browser-approval-confirmation input')!, 'example.com');
      await press('Allow this once');
      expect(fakeBrowserGateway.approveRequest).not.toHaveBeenCalled();
    });

    it('lets a plain click through without the phrase when only the wider buttons cover submitting', async () => {
      await show(makeRequest({ proposedGrant: grant(['input', 'submit']) }));
      await press('Allow this once');
      expect(fakeBrowserGateway.approveRequest).toHaveBeenCalledTimes(1);
      fakeBrowserGateway.approveRequest.mockClear();
      await press('Allow for this session');
      expect(fakeBrowserGateway.approveRequest).not.toHaveBeenCalled();
    });

    it('sends no phrase box for ordinary typing and clicking', async () => {
      await show(makeRequest());
      expect(element.querySelector('.browser-approval-confirmation')).toBeNull();
    });
  });

  describe('requests that cannot take all three buttons', () => {
    it('allows an action Harness could not classify one action at a time', async () => {
      await show(makeRequest({ actionClass: 'unknown', proposedGrant: grant(['unknown']) }));
      expect(buttons().map((candidate) => candidate.textContent?.trim())).toEqual(['Deny', 'Allow this once']);
      expect(element.querySelector('.browser-approval-note')?.textContent?.trim())
        .toBe('You can only allow this one action at a time.');
    });

    it('sends payment and identity requests to review instead of offering to allow them', async () => {
      await show(makeRequest({ actionClass: 'payment', proposedGrant: grant(['payment']) }));
      expect(buttons().map((candidate) => candidate.textContent?.trim())).toEqual(['Deny']);
      expect(element.querySelector('.browser-approval-note')?.textContent)
        .toContain("You can't allow this one from here.");
    });

    it('offers one honest button for a hand-off, because approving only tells the agent to carry on', async () => {
      await show(makeRequest({
        toolName: 'browser.request_user_login',
        action: 'request_user_login',
        actionClass: 'credential',
        selector: undefined,
        requestReason: 'Please sign in, then tell me.',
        elementContext: { nearbyText: 'Please sign in, then tell me.' },
        proposedGrant: grant(['read']),
      }));
      expect(element.querySelector('.browser-approval-title')?.textContent)
        .toContain('Wait while you sign in yourself');
      expect(element.querySelector('.browser-approval-facts')?.textContent).toContain('Please sign in, then tell me.');
      expect(buttons().map((candidate) => candidate.textContent?.trim())).toEqual(['Deny', 'Done, carry on']);
      await press('Done, carry on');
      expect(fakeBrowserGateway.approveRequest.mock.calls[0]![0].grant).toMatchObject({ mode: 'per_action' });
    });
  });

  describe('a saved login', () => {
    const login = (access: Partial<NonNullable<BrowserApprovalRequest['credentialAccess']>> = {}) => makeRequest({
      toolName: 'browser.request_credential_access',
      actionClass: 'credential',
      origin: 'https://login.example.com',
      profileId: 'existing-tab:n.node-win:3:4',
      credentialAccess: {
        taskScope: 'conversation:placeholder-task',
        sessionName: '12steps',
        reason: 'Finish the requested sign-in',
        origin: 'https://login.example.com',
        computerName: 'windows-pc',
        computerId: 'placeholder-computer',
        scope: 'placeholder-scope',
        vaultItemRef: 'placeholder-item',
        itemTitle: 'Example login',
        vaultFolder: 'AgentVault',
        moveIntoFolder: true,
        purposes: ['login', 'totp'],
        permission: 'task',
        ...access,
      },
    });

    it('shows the session, reason, website, computer and where the login will move', async () => {
      await show(login());
      expect(element.querySelector('.browser-approval-kicker')?.textContent?.trim()).toBe('Saved login');
      const text = element.textContent ?? '';
      for (const expected of [
        '12steps',
        'Example login',
        'windows-pc',
        'login.example.com',
        'Finish the requested sign-in',
        'use a one-time sign-in code',
        'Approval will move this login into the AgentVault agent vault folder.',
        'Until this session ends.',
      ]) {
        expect(text).toContain(expected);
      }
    });

    it('never calls the permission a task', async () => {
      await show(login());
      expect(element.textContent?.toLowerCase()).not.toContain('task');
    });

    it('defaults to this session, with the longer choices worded the same way as the other cards', async () => {
      await show(login());
      const length = element.querySelector<HTMLSelectElement>('.credential-access-duration')!;
      expect(length.value).toBe('task');
      expect(Array.from(length.options).map((option) => [option.value, option.text.trim()])).toEqual([
        ['task', 'This session'],
        ['1h', 'For 1 hour'],
        ['24h', 'For 24 hours'],
        ['7d', 'For 7 days'],
        ['30d', 'For 30 days'],
        ['90d', 'For 90 days'],
        ['365d', 'For 1 year'],
      ]);
      expect(buttons().map((candidate) => candidate.textContent?.trim())).toEqual(['Deny', 'Allow for this session']);
    });

    it('allows for this session by default and sends the proposed grant unchanged', async () => {
      const approval = login();
      await show(approval);
      await press('Allow for this session');
      expect(fakeBrowserGateway.approveRequest).toHaveBeenCalledWith({
        requestId: 'browser-request-1',
        grant: approval.proposedGrant,
        credentialAccess: { permission: 'task' },
        reason: 'Approved from session page',
      });
    });

    it('names the longer choice on the button and warns that any session can then sign in', async () => {
      await show(login());
      const length = element.querySelector<HTMLSelectElement>('.credential-access-duration')!;
      length.value = '7d';
      length.dispatchEvent(new Event('change'));
      await settle(fixture);
      expect(buttons().map((candidate) => candidate.textContent?.trim())).toEqual(['Deny', 'Allow for 7 days']);
      expect(element.textContent).toContain(
        'For 7 days. Any session can use this saved login on login.example.com without asking again.',
      );
      await press('Allow for 7 days');
      expect(fakeBrowserGateway.approveRequest).toHaveBeenCalledWith(expect.objectContaining({
        credentialAccess: { permission: 'remember', rememberForMs: 604_800_000 },
      }));
    });

    it('shows a failure once, in plain language', async () => {
      await show(login({ operationError: 'vault_locked' }));
      const message = 'The password vault is locked. Unlock it, then approve again.';
      const count = () => element.textContent?.split(message).length ?? 0;
      expect(count() - 1).toBe(1);
      fakeBrowserGateway.approveRequest.mockResolvedValueOnce({
        success: true,
        data: { decision: 'denied', outcome: 'not_run', reason: 'vault_locked', auditId: 'placeholder-audit' },
      });
      await press('Allow for this session');
      expect(fixture.componentInstance.errorMessage()).toBe(message);
      expect(count() - 1).toBe(1);
      expect(element.querySelector('[role="alert"]')?.textContent).not.toContain('vault_locked');
      const diagnostics = element.querySelector<HTMLDetailsElement>('details.browser-approval-error-details');
      expect(diagnostics?.open).toBe(false);
      expect(diagnostics?.textContent).toContain('vault_locked');
    });

    it('retains the request when approval reached the gateway but did not complete', async () => {
      await show(login());
      fakeBrowserGateway.approveRequest.mockResolvedValueOnce({
        success: true,
        data: { decision: 'allowed', outcome: 'failed', reason: 'vault_locked', auditId: 'placeholder-audit' },
      });
      await press('Allow for this session');
      expect(fixture.componentInstance.pendingRequests()).toHaveLength(1);
      expect(fixture.componentInstance.errorMessage()).toBe('The password vault is locked. Unlock it, then approve again.');
    });
  });
});

function overrideInputs(
  component: BrowserApprovalRequestComponent,
  instanceId: () => string | null,
): void {
  (component as unknown as { instanceId: () => string | null }).instanceId = instanceId;
}

function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

async function settle(fixture: ComponentFixture<BrowserApprovalRequestComponent>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await fixture.whenStable();
    await Promise.resolve();
    fixture.detectChanges();
  }
}

function grant(classes: BrowserApprovalRequest['proposedGrant']['allowedActionClasses']): BrowserApprovalRequest['proposedGrant'] {
  return {
    mode: 'per_action',
    allowedOrigins: [shop],
    allowedActionClasses: classes,
    allowExternalNavigation: false,
    autonomous: false,
  };
}

function makeRequest(overrides: Partial<BrowserApprovalRequest> = {}): BrowserApprovalRequest {
  return {
    id: 'browser-request-1',
    requestId: 'browser-request-1',
    instanceId: 'inst-1',
    provider: 'copilot',
    profileId: 'existing-tab:n.node-win:1:2',
    targetId: 'existing-tab:n.node-win:1:2:target',
    computerId: 'node-win',
    toolName: 'browser.click',
    action: 'click',
    actionClass: 'input',
    origin: 'https://shop.example.com',
    url: 'https://shop.example.com/basket',
    selector: 'button#add',
    elementContext: { accessibleName: 'Add to basket', role: 'button' },
    proposedGrant: grant(['input']),
    status: 'pending',
    createdAt: 1_900_000_000_000,
    expiresAt: 1_900_000_600_000,
    ...overrides,
  };
}
