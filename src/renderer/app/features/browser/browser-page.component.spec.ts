import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources, signal } from '@angular/core';
import { Router } from '@angular/router';
import type { BrowserAuditEntry } from '@contracts/types/browser';
import type { WorkerNodeInfo } from '../../../../shared/types/worker-node.types';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPageComponent } from './browser-page.component';
import { BrowserGatewayIpcService } from '../../core/services/ipc/browser-gateway-ipc.service';
import { RemoteNodeStore } from '../../core/state/remote-node.store';

const now = 1_700_000_000_000;
const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './browser-page.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './browser-page.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('browser-page.component.html')) {
    return Promise.resolve(template);
  }
  if (url.endsWith('browser-page.component.scss')) {
    return Promise.resolve(styles);
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

const gatewayResult = <T>(data: T) => ({
  success: true,
  data: {
    decision: 'allowed',
    outcome: 'succeeded',
    auditId: 'audit-result',
    data,
  },
});

describe('BrowserPageComponent', () => {
  let fixture: ComponentFixture<BrowserPageComponent>;
  let service: {
    listProfiles: ReturnType<typeof vi.fn>;
    createProfile: ReturnType<typeof vi.fn>;
    updateProfile: ReturnType<typeof vi.fn>;
    openProfile: ReturnType<typeof vi.fn>;
    closeProfile: ReturnType<typeof vi.fn>;
    listTargets: ReturnType<typeof vi.fn>;
    selectTarget: ReturnType<typeof vi.fn>;
    navigate: ReturnType<typeof vi.fn>;
    snapshot: ReturnType<typeof vi.fn>;
    screenshot: ReturnType<typeof vi.fn>;
    requestUserLogin: ReturnType<typeof vi.fn>;
    pauseForManualStep: ReturnType<typeof vi.fn>;
    listApprovalRequests: ReturnType<typeof vi.fn>;
    approveRequest: ReturnType<typeof vi.fn>;
    denyRequest: ReturnType<typeof vi.fn>;
    listGrants: ReturnType<typeof vi.fn>;
    revokeGrant: ReturnType<typeof vi.fn>;
    createGrant: ReturnType<typeof vi.fn>;
    getAuditLog: ReturnType<typeof vi.fn>;
    getHealth: ReturnType<typeof vi.fn>;
  };
  let router: { navigate: ReturnType<typeof vi.fn> };
  let remoteNodeStore: {
    nodes: ReturnType<typeof signal<WorkerNodeInfo[]>>;
    initialize: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    nodeById: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);

    service = {
      listProfiles: vi.fn().mockResolvedValue(gatewayResult([
        {
          id: 'profile-1',
          label: 'Local App',
          mode: 'session',
          browser: 'chrome',
          allowedOrigins: [],
          status: 'running',
          createdAt: 1,
          updatedAt: 1,
          lastLoginCheckAt: 1_700_000_000_000,
        },
      ])),
      createProfile: vi.fn().mockResolvedValue(gatewayResult({ id: 'profile-2' })),
      updateProfile: vi.fn().mockResolvedValue(gatewayResult({
        id: 'profile-1',
        label: 'Local App',
        mode: 'session',
        browser: 'chrome',
        allowedOrigins: [],
        executionNodeId: 'node-ready',
        status: 'stopped',
        createdAt: 1,
        updatedAt: 2,
      })),
      openProfile: vi.fn().mockResolvedValue(gatewayResult([])),
      closeProfile: vi.fn().mockResolvedValue(gatewayResult(null)),
      listTargets: vi.fn().mockResolvedValue(gatewayResult([
        {
          id: 'target-1',
          profileId: 'profile-1',
          mode: 'session',
          title: 'Local',
          url: 'http://localhost:4567',
          driver: 'cdp',
          status: 'selected',
          lastSeenAt: 1,
        },
      ])),
      selectTarget: vi.fn().mockResolvedValue(gatewayResult({ id: 'target-1' })),
      navigate: vi.fn().mockResolvedValue(gatewayResult(null)),
      snapshot: vi.fn().mockResolvedValue(gatewayResult({
        title: 'Local',
        url: 'http://localhost:4567',
        text: 'Snapshot text',
      })),
      screenshot: vi.fn().mockResolvedValue(gatewayResult('abc123')),
      requestUserLogin: vi.fn().mockResolvedValue({
        success: true,
        data: {
          decision: 'requires_user',
          outcome: 'not_run',
          requestId: 'request-login',
          reason: 'manual_login_required',
          auditId: 'audit-login',
          data: null,
        },
      }),
      pauseForManualStep: vi.fn().mockResolvedValue({
        success: true,
        data: {
          decision: 'requires_user',
          outcome: 'not_run',
          requestId: 'request-manual',
          reason: 'manual_step_required',
          auditId: 'audit-manual',
          data: null,
        },
      }),
      listApprovalRequests: vi.fn().mockResolvedValue(gatewayResult([
        {
          id: 'request-1',
          requestId: 'request-1',
          instanceId: 'instance-1',
          provider: 'copilot',
          profileId: 'profile-1',
          targetId: 'target-1',
          toolName: 'browser.click',
          action: 'click',
          actionClass: 'input',
          origin: 'http://localhost:4567',
          url: 'http://localhost:4567',
          selector: 'button.publish',
          elementContext: {
            role: 'button',
            accessibleName: 'Publish release',
            visibleText: 'Publish',
            nearbyText: 'Manual login is required before continuing.',
          },
          proposedGrant: {
            mode: 'per_action',
            allowedOrigins: [
              {
                scheme: 'http',
                hostPattern: 'localhost',
                port: 4567,
                includeSubdomains: false,
              },
            ],
            allowedActionClasses: ['input'],
            allowExternalNavigation: false,
            autonomous: false,
          },
          status: 'pending',
          createdAt: 1,
          expiresAt: 999999,
        },
      ])),
      approveRequest: vi.fn().mockResolvedValue(gatewayResult({ id: 'grant-approved' })),
      denyRequest: vi.fn().mockResolvedValue(gatewayResult({ requestId: 'request-1', status: 'denied' })),
      listGrants: vi.fn().mockResolvedValue(gatewayResult([
        {
          id: 'grant-1',
          mode: 'autonomous',
          instanceId: 'instance-1',
          provider: 'copilot',
          profileId: 'profile-1',
          allowedOrigins: [
            {
              scheme: 'http',
              hostPattern: 'localhost',
              port: 4567,
              includeSubdomains: false,
            },
          ],
          allowedActionClasses: ['input', 'submit'],
          allowExternalNavigation: false,
          autonomous: true,
          requestedBy: 'instance-1',
          decidedBy: 'user',
          decision: 'allow',
          expiresAt: 999999,
          createdAt: 1,
        },
      ])),
      revokeGrant: vi.fn().mockResolvedValue(gatewayResult({ id: 'grant-1', revokedAt: 2 })),
      createGrant: vi.fn().mockResolvedValue(gatewayResult({ id: 'grant-created' })),
      getAuditLog: vi.fn().mockResolvedValue(gatewayResult([
        auditEntry({
          id: 'audit-1',
          action: 'navigate',
          toolName: 'browser.navigate',
          actionClass: 'navigate',
          summary: 'Navigated',
          createdAt: now - 60_000,
        }),
      ])),
      getHealth: vi.fn().mockResolvedValue(gatewayResult({
        status: 'ready',
        managedProfiles: { total: 1, running: 1 },
        providerCapabilityDetails: {
          claude: {
            available: true,
            status: 'available_via_mcp',
            message: 'Claude can use Browser Gateway MCP tools.',
          },
          copilot: {
            available: true,
            status: 'available_via_acp_mcp',
            message: 'Copilot can use Browser Gateway through ACP MCP config.',
          },
          codex: {
            available: false,
            status: 'unavailable_exec_mode',
            message: 'Codex exec-mode Browser Gateway is unavailable.',
          },
          gemini: {
            available: false,
            status: 'unconfigured_adapter_injection_missing',
            message: 'Gemini Browser Gateway is unavailable until adapter MCP injection is implemented.',
          },
        },
      })),
    };

    router = { navigate: vi.fn().mockResolvedValue(true) };
    const nodes = signal<WorkerNodeInfo[]>([
      makeNode('node-ready', {
        name: 'windows-pc',
        capabilities: makeCapabilities({
          platform: 'win32',
          hasBrowserRuntime: true,
          hasBrowserMcp: true,
        }),
      }),
      makeNode('node-chrome-only', {
        name: 'chrome-only',
        capabilities: makeCapabilities({
          hasBrowserRuntime: true,
          hasBrowserMcp: false,
        }),
      }),
    ]);
    remoteNodeStore = {
      nodes,
      initialize: vi.fn(async () => undefined),
      refresh: vi.fn(async () => undefined),
      nodeById: vi.fn((id: string) => nodes().find((node) => node.id === id)),
    };

    await TestBed.configureTestingModule({
      imports: [BrowserPageComponent],
      providers: [
        { provide: BrowserGatewayIpcService, useValue: service },
        { provide: RemoteNodeStore, useValue: remoteNodeStore },
        { provide: Router, useValue: router },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(BrowserPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders Browser Gateway profiles', () => {
    expect(fixture.nativeElement.textContent).toContain('Local App');
    expect(fixture.nativeElement.textContent).toContain('Login checked');
  });

  it('renders remote browser node status and saves the selected execution node', async () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('Run browser on');
    expect(text).toContain('windows-pc');
    expect(text).toContain('Ready');
    expect(text).toContain('Chrome only');

    const select = fixture.nativeElement.querySelector(
      '[data-testid="profile-node-select"]',
    ) as HTMLSelectElement;
    select.value = 'node-ready';
    select.dispatchEvent(new Event('change'));

    await (fixture.componentInstance as unknown as {
      updateProfileExecutionNode(): Promise<void>;
    }).updateProfileExecutionNode();

    expect(service.updateProfile).toHaveBeenCalledWith({
      profileId: 'profile-1',
      executionNodeId: 'node-ready',
    });
    expect(service.listProfiles).toHaveBeenCalled();
  });

  it('creates profiles with normalized allowed origins', async () => {
    const component = fixture.componentInstance;
    component.onCreateField('label', inputEvent('Docs'));
    component.onCreateField('defaultUrl', inputEvent('http://localhost:4567'));
    component.onCreateField('allowedOrigins', inputEvent('http://localhost:4567\nhttps://*.example.com'));

    await component.createProfile();

    expect(service.createProfile).toHaveBeenCalledWith({
      label: 'Docs',
      mode: 'session',
      browser: 'chrome',
      defaultUrl: 'http://localhost:4567',
      allowedOrigins: [
        {
          scheme: 'http',
          hostPattern: 'localhost',
          port: 4567,
          includeSubdomains: false,
        },
        {
          scheme: 'https',
          hostPattern: 'example.com',
          includeSubdomains: true,
        },
      ],
    });
  });

  it('shows a validation error instead of creating a profile for invalid allowed origins', async () => {
    const component = fixture.componentInstance;
    component.onCreateField('label', inputEvent('Broken'));
    component.onCreateField('allowedOrigins', inputEvent('http://[bad-host'));

    await component.createProfile();

    expect(service.createProfile).not.toHaveBeenCalled();
    expect(component.errorMessage()).toContain('Allowed origin is invalid');
  });

  it('disables navigation until a profile and target are selected', () => {
    fixture.componentInstance.selectedTargetId.set(null);
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('[data-testid="navigate-button"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('keeps navigation disabled for read-only extension targets', () => {
    fixture.componentInstance.targets.set([
      {
        id: 'existing-tab:7:42:target',
        profileId: 'existing-tab:7:42',
        mode: 'existing-tab',
        title: 'Google Play Console',
        url: 'https://play.google.com/console',
        driver: 'extension',
        status: 'selected',
        lastSeenAt: 1,
      },
    ]);
    fixture.componentInstance.selectedProfileId.set('existing-tab:7:42');
    fixture.componentInstance.selectedTargetId.set('existing-tab:7:42:target');
    fixture.componentInstance.navigateUrl.set('https://play.google.com/console');
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector('[data-testid="navigate-button"]') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  it('requests a user login handoff for the selected browser target', async () => {
    const button = fixture.nativeElement.querySelector('[data-testid="request-login-button"]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);

    await fixture.componentInstance.requestUserLogin();

    expect(service.requestUserLogin).toHaveBeenCalledWith({
      profileId: 'profile-1',
      targetId: 'target-1',
      reason: 'Login check requested from Browser Gateway page',
    });
    expect(service.listApprovalRequests).toHaveBeenCalled();
  });

  it('renders provider capability details from health output', () => {
    const text = fixture.nativeElement.textContent;

    expect(text).toContain('Claude can use Browser Gateway MCP tools.');
    expect(text).toContain('Codex exec-mode Browser Gateway is unavailable.');
    expect(text).toContain('Gemini Browser Gateway is unavailable until adapter MCP injection is implemented.');
  });

  it('renders existing-tab bridge setup guidance', () => {
    const text = fixture.nativeElement.textContent;

    expect(text).toContain('Browser Control & Diagnostics');
    expect(text).toContain('not the browser itself');
    expect(text).toContain('Live Chrome Extension Bridge');
    expect(text).toContain('browser.find_or_open');
    expect(text).toContain('Automatic tab inventory');
    expect(text).toContain('resources/browser-extension');
  });

  it('refreshes targets without the selected profile filter so extension tabs appear', async () => {
    service.listTargets.mockClear();

    await fixture.componentInstance.refreshTargets();

    expect(service.listTargets).toHaveBeenCalledWith({});
  });

  it('renders screenshot base64 with a data URL prefix', async () => {
    await fixture.componentInstance.captureScreenshot();
    fixture.detectChanges();

    const image = fixture.nativeElement.querySelector('[data-testid="screenshot-preview"]') as HTMLImageElement;
    expect(image.src).toContain('data:image/png;base64,abc123');
  });

  it('renders audit decisions and outcomes', () => {
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('allowed');
    expect(text).toContain('succeeded');
  });

  it('hides stale audit entries by default while keeping them available in history', () => {
    fixture.componentInstance.auditEntries.set([
      auditEntry({
        id: 'recent-audit',
        action: 'snapshot',
        toolName: 'browser.snapshot',
        actionClass: 'read',
        summary: 'Captured a fresh snapshot',
        createdAt: now - 60_000,
      }),
      auditEntry({
        id: 'old-audit',
        action: 'attach_existing_tab',
        toolName: 'browser.extension_attach_tab',
        actionClass: 'read',
        summary: 'Attached an old Chrome tab',
        createdAt: now - 3_600_000,
      }),
    ]);
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Captured a fresh snapshot');
    expect(fixture.nativeElement.textContent).not.toContain('Attached an old Chrome tab');

    const toggle = fixture.nativeElement.querySelector(
      '[data-testid="audit-history-toggle"]',
    ) as HTMLButtonElement;
    expect(toggle.textContent).toContain('Older events');
    expect(toggle.textContent).toContain('1');

    toggle.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Attached an old Chrome tab');
  });

  it('renders pending approvals and active autonomous grants', () => {
    const text = fixture.nativeElement.textContent;

    expect(text).toContain('Pending Approvals');
    expect(text).toContain('request-1');
    expect(text).toContain('Publish release');
    expect(text).toContain('Manual login is required before continuing.');
    expect(text).toContain('button.publish');
    expect(text).toContain('expires');
    expect(text).toContain('Active Grants');
    expect(text).toContain('autonomous');
  });

  it('renders upload approval file context and proposed upload roots', () => {
    fixture.componentInstance.approvalRequests.set([
      {
        id: 'request-upload',
        requestId: 'request-upload',
        instanceId: 'instance-1',
        provider: 'copilot',
        profileId: 'profile-1',
        targetId: 'target-1',
        toolName: 'browser.upload_file',
        action: 'upload_file',
        actionClass: 'file-upload',
        origin: 'http://localhost:4567',
        url: 'http://localhost:4567/upload',
        selector: 'input[type="file"]',
        filePath: '/workspace/dist/app.aab',
        detectedFileType: 'application/zip',
        proposedGrant: {
          mode: 'session',
          allowedOrigins: [],
          allowedActionClasses: ['file-upload'],
          allowExternalNavigation: false,
          uploadRoots: ['/workspace/dist'],
          autonomous: false,
        },
        status: 'pending',
        createdAt: 1,
        expiresAt: 999999,
      },
    ]);
    fixture.detectChanges();

    const text = fixture.nativeElement.textContent;
    expect(text).toContain('/workspace/dist/app.aab');
    expect(text).toContain('application/zip');
    expect(text).toContain('/workspace/dist');
  });

  it('requires typed confirmation before approving an autonomous request', async () => {
    const component = fixture.componentInstance;
    const approval = component.approvalRequests()[0]!;

    component.autonomousSubmitEnabled.set(true);
    component.autonomousDestructiveEnabled.set(true);
    await component.approveApprovalRequest(approval, 'autonomous');

    expect(service.approveRequest).not.toHaveBeenCalled();
    expect(component.errorMessage()).toContain('Type AUTONOMOUS');

    component.onAutonomousConfirmationInput(inputEvent('AUTONOMOUS'));
    await component.approveApprovalRequest(approval, 'autonomous');

    expect(service.approveRequest).toHaveBeenCalledWith({
      requestId: 'request-1',
      grant: expect.objectContaining({
        mode: 'autonomous',
        autonomous: true,
        allowedActionClasses: ['input', 'submit', 'destructive'],
      }),
      reason: 'Approved from Browser Gateway page',
    });
  });

  it('revokes grants from the Browser page', async () => {
    await fixture.componentInstance.revokeGrant('grant-1');

    expect(service.revokeGrant).toHaveBeenCalledWith({
      grantId: 'grant-1',
      reason: 'Revoked from Browser Gateway page',
    });
  });

  it('navigates back to the dashboard from the header back button', () => {
    const button = fixture.nativeElement.querySelector(
      '[data-testid="back-button"]',
    ) as HTMLButtonElement;
    expect(button).toBeTruthy();

    button.click();

    expect(router.navigate).toHaveBeenCalledWith(['/']);
  });
});

function inputEvent(value: string): Event {
  return { target: { value } } as unknown as Event;
}

function makeCapabilities(
  overrides: Partial<WorkerNodeInfo['capabilities']> = {},
): WorkerNodeInfo['capabilities'] {
  return {
    platform: 'linux',
    arch: 'x64',
    cpuCores: 4,
    totalMemoryMB: 8192,
    availableMemoryMB: 4096,
    supportedClis: ['claude'],
    hasBrowserRuntime: false,
    hasBrowserMcp: false,
    hasDocker: false,
    maxConcurrentInstances: 4,
    workingDirectories: ['/workspace'],
    browsableRoots: [],
    discoveredProjects: [],
    ...overrides,
  };
}

function makeNode(id: string, overrides: Partial<WorkerNodeInfo> = {}): WorkerNodeInfo {
  return {
    id,
    name: id,
    address: '127.0.0.1',
    capabilities: makeCapabilities(),
    status: 'connected',
    connectedAt: now,
    lastHeartbeat: now,
    activeInstances: 0,
    ...overrides,
  };
}

function auditEntry(overrides: Partial<BrowserAuditEntry>): BrowserAuditEntry {
  return {
    id: 'audit',
    provider: 'orchestrator',
    action: 'navigate',
    toolName: 'browser.navigate',
    actionClass: 'navigate',
    decision: 'allowed',
    outcome: 'succeeded',
    summary: 'Audit entry',
    redactionApplied: true,
    createdAt: now,
    ...overrides,
  };
}
