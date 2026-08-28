import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources, signal } from '@angular/core';
import type {
  BrowserApprovalRequest,
  BrowserAuditEntry,
  BrowserTarget,
} from '@contracts/types/browser';
import type { WorkerNodeInfo } from '../../../../shared/types/worker-node.types';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserPageComponent } from './browser-page.component';
import { BrowserGatewayIpcService } from '../../core/services/ipc/browser-gateway-ipc.service';
import { AuxiliaryLlmIpcService } from '../../core/services/ipc/auxiliary-llm-ipc.service';
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
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
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
  let remoteNodeStore: {
    nodes: ReturnType<typeof signal<WorkerNodeInfo[]>>;
    initialize: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    nodeById: ReturnType<typeof vi.fn>;
  };
  let auxService: { extractWeb: ReturnType<typeof vi.fn> };

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
        mcpBridge: { available: true },
        localExtension: {
          state: 'ready',
          summary: 'Local extension is polling.',
        },
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
            available: true,
            status: 'available_via_mcp',
            message: 'Codex can use Browser Gateway through injected MCP config in local AIO sessions.',
          },
          gemini: {
            available: false,
            status: 'unconfigured_adapter_injection_missing',
            message: 'Gemini Browser Gateway is unavailable until adapter MCP injection is implemented.',
          },
        },
      })),
    };

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
    auxService = {
      extractWeb: vi.fn().mockResolvedValue({ success: true, data: { text: 'Extracted text' } }),
    };

    await TestBed.configureTestingModule({
      imports: [BrowserPageComponent],
      providers: [
        { provide: BrowserGatewayIpcService, useValue: service },
        { provide: AuxiliaryLlmIpcService, useValue: auxService },
        { provide: RemoteNodeStore, useValue: remoteNodeStore },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(BrowserPageComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    await fixture.componentInstance.refresh();
    fixture.detectChanges();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders Browser Gateway profiles', () => {
    expect(fixture.nativeElement.textContent).toContain('Local App');
    expect(fixture.nativeElement.textContent).toContain('Login checked');
  });

  it('opens on the browser workspace and switches control modes accessibly', () => {
    const browserTab = fixture.nativeElement.querySelector(
      '[data-testid="browser-view-tab"]',
    ) as HTMLButtonElement;
    const permissionsTab = fixture.nativeElement.querySelector(
      '[data-testid="permissions-view-tab"]',
    ) as HTMLButtonElement;

    expect(browserTab.getAttribute('aria-selected')).toBe('true');
    expect(browserTab.getAttribute('aria-controls')).toBe('browser-view-panel');
    expect(permissionsTab.getAttribute('aria-selected')).toBe('false');
    expect(permissionsTab.hasAttribute('aria-controls')).toBe(false);
    expect(fixture.nativeElement.querySelector('[data-testid="browser-view-panel"]')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="permissions-view-panel"]')).toBeNull();

    permissionsTab.click();
    fixture.detectChanges();

    expect(browserTab.getAttribute('aria-selected')).toBe('false');
    expect(browserTab.hasAttribute('aria-controls')).toBe(false);
    expect(permissionsTab.getAttribute('aria-selected')).toBe('true');
    expect(permissionsTab.getAttribute('aria-controls')).toBe('permissions-view-panel');
    expect(fixture.nativeElement.querySelector('[data-testid="browser-view-panel"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="permissions-view-panel"]')).not.toBeNull();
  });

  it('moves between control modes with arrow keys and a roving tab stop', async () => {
    const browserTab = fixture.nativeElement.querySelector(
      '[data-testid="browser-view-tab"]',
    ) as HTMLButtonElement;
    const permissionsTab = fixture.nativeElement.querySelector(
      '[data-testid="permissions-view-tab"]',
    ) as HTMLButtonElement;

    expect(browserTab.tabIndex).toBe(0);
    expect(permissionsTab.tabIndex).toBe(-1);

    browserTab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    fixture.detectChanges();
    await Promise.resolve();

    expect(permissionsTab.getAttribute('aria-selected')).toBe('true');
    expect(permissionsTab.tabIndex).toBe(0);
    expect(document.activeElement).toBe(permissionsTab);
  });

  it('filters the target workspace by title or URL', () => {
    fixture.componentInstance.targets.set([
      ...fixture.componentInstance.targets(),
      {
        id: 'target-2',
        profileId: 'profile-1',
        mode: 'session',
        title: 'Release dashboard',
        url: 'https://release.example.com',
        driver: 'cdp',
        status: 'available',
        lastSeenAt: 2,
      },
    ]);
    fixture.detectChanges();

    const search = fixture.nativeElement.querySelector(
      '[data-testid="target-filter"]',
    ) as HTMLInputElement;
    search.value = 'release.example';
    search.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    const targetRows = Array.from(
      fixture.nativeElement.querySelectorAll('[data-testid="target-row"]'),
    ) as HTMLElement[];
    expect(targetRows).toHaveLength(1);
    expect(targetRows[0]?.textContent).toContain('Release dashboard');
    expect(targetRows[0]?.textContent).not.toContain('Local');
  });

  it('excludes closed targets from open counts and the target list', () => {
    fixture.componentInstance.targets.set([
      ...fixture.componentInstance.targets(),
      {
        id: 'target-closed',
        profileId: 'profile-1',
        mode: 'session',
        title: 'Closed tab',
        url: 'https://closed.example.com',
        driver: 'cdp',
        status: 'closed',
        lastSeenAt: 2,
      },
    ]);
    fixture.detectChanges();

    expect(fixture.componentInstance.openTargets()).toHaveLength(1);
    expect(fixture.nativeElement.querySelectorAll('[data-testid="target-row"]')).toHaveLength(1);
    const targetMetric = fixture.nativeElement.querySelectorAll('.status-item')[1] as HTMLElement;
    expect(targetMetric.querySelector('.metric')?.textContent?.trim()).toBe('1');
    expect(targetMetric.querySelector('.label')?.textContent?.trim()).toBe('Open targets');
    expect(fixture.nativeElement.textContent).not.toContain('Closed tab');
  });

  it('synchronizes the profile context when refresh selects a target from another profile', async () => {
    service.listTargets.mockResolvedValueOnce(gatewayResult([
      {
        id: 'managed-target',
        profileId: 'profile-1',
        mode: 'session',
        title: 'Managed',
        driver: 'cdp',
        status: 'available',
        lastSeenAt: 1,
      },
      {
        id: 'remote-selected',
        profileId: 'existing-tab:remote',
        mode: 'existing-tab',
        title: 'Remote selected',
        driver: 'extension',
        status: 'selected',
        lastSeenAt: 2,
      },
    ]));

    await fixture.componentInstance.refreshTargets();
    await fixture.componentInstance.loadSnapshot();

    expect(fixture.componentInstance.selectedProfileId()).toBe('existing-tab:remote');
    expect(service.snapshot).toHaveBeenCalledWith({
      profileId: 'existing-tab:remote',
      targetId: 'remote-selected',
    });
  });

  it('keeps the chosen profile selected when global inventory selects another profile', async () => {
    service.listTargets.mockResolvedValueOnce(gatewayResult([
      {
        id: 'remote-selected',
        profileId: 'existing-tab:remote',
        mode: 'existing-tab',
        title: 'Remote selected',
        driver: 'extension',
        status: 'selected',
        lastSeenAt: 2,
      },
    ]));

    await fixture.componentInstance.selectProfile('profile-1');

    expect(fixture.componentInstance.selectedProfileId()).toBe('profile-1');
    expect(fixture.componentInstance.selectedTargetId()).toBeNull();
  });

  it('keeps a targetless profile selected during a manual global target refresh', async () => {
    fixture.componentInstance.selectedProfileId.set('profile-1');
    fixture.componentInstance.selectedTargetId.set(null);
    service.listTargets.mockResolvedValueOnce(gatewayResult([
      {
        id: 'remote-selected',
        profileId: 'existing-tab:remote',
        mode: 'existing-tab',
        title: 'Remote selected',
        driver: 'extension',
        status: 'selected',
        lastSeenAt: 2,
      },
    ]));

    await fixture.componentInstance.refreshTargets('profile-1');

    expect(fixture.componentInstance.selectedProfileId()).toBe('profile-1');
    expect(fixture.componentInstance.selectedTargetId()).toBeNull();
  });

  it('keeps extension target context when profiles resolve after targets during refresh', async () => {
    const profileResponse = gatewayResult([
      {
        id: 'profile-1',
        label: 'Local App',
        mode: 'session',
        browser: 'chrome',
        allowedOrigins: [],
        status: 'stopped',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    const targetResponse = gatewayResult([
      {
        id: 'remote-selected',
        profileId: 'existing-tab:remote',
        mode: 'existing-tab',
        title: 'Remote selected',
        driver: 'extension',
        status: 'selected',
        lastSeenAt: 2,
      },
    ]);
    const profilesDeferred = deferred<typeof profileResponse>();
    const targetsDeferred = deferred<typeof targetResponse>();
    service.listProfiles.mockReturnValueOnce(profilesDeferred.promise);
    service.listTargets.mockReturnValueOnce(targetsDeferred.promise);

    const refreshPromise = fixture.componentInstance.refresh();
    targetsDeferred.resolve(targetResponse);
    await Promise.resolve();
    profilesDeferred.resolve(profileResponse);
    await refreshPromise;
    await fixture.componentInstance.requestUserLogin();

    expect(fixture.componentInstance.selectedProfileId()).toBe('existing-tab:remote');
    expect(fixture.componentInstance.selectedTargetId()).toBe('remote-selected');
    expect(service.requestUserLogin).toHaveBeenLastCalledWith({
      profileId: 'existing-tab:remote',
      targetId: 'remote-selected',
      reason: 'Login check requested from Browser Gateway page',
    });
  });

  it('reconciles a vanished extension target when profiles resolve before targets', async () => {
    fixture.componentInstance.targets.set([{
      id: 'old-extension-target',
      profileId: 'existing-tab:old',
      mode: 'existing-tab',
      title: 'Old extension tab',
      driver: 'extension',
      status: 'selected',
      lastSeenAt: 1,
    }]);
    fixture.componentInstance.selectedTargetId.set('old-extension-target');
    fixture.componentInstance.selectedProfileId.set('existing-tab:old');
    const profileResponse = gatewayResult([
      {
        id: 'profile-1',
        label: 'Local App',
        mode: 'session',
        browser: 'chrome',
        allowedOrigins: [],
        status: 'stopped',
        createdAt: 1,
        updatedAt: 1,
      },
    ]);
    const targetResponse = gatewayResult([]);
    const profilesDeferred = deferred<typeof profileResponse>();
    const targetsDeferred = deferred<typeof targetResponse>();
    service.listProfiles.mockReturnValueOnce(profilesDeferred.promise);
    service.listTargets.mockReturnValueOnce(targetsDeferred.promise);

    const refreshPromise = fixture.componentInstance.refresh();
    profilesDeferred.resolve(profileResponse);
    await Promise.resolve();
    targetsDeferred.resolve(targetResponse);
    await refreshPromise;
    await fixture.componentInstance.requestUserLogin();

    expect(fixture.componentInstance.selectedProfileId()).toBe('profile-1');
    expect(fixture.componentInstance.selectedTargetId()).toBeNull();
    expect(service.requestUserLogin).toHaveBeenLastCalledWith({
      profileId: 'profile-1',
      reason: 'Login check requested from Browser Gateway page',
    });
  });

  it('keeps the latest profile selection when target refresh responses arrive out of order', async () => {
    fixture.componentInstance.profiles.update((profiles) => [
      ...profiles,
      {
        id: 'profile-2',
        label: 'Second profile',
        mode: 'session',
        browser: 'chrome',
        allowedOrigins: [],
        status: 'stopped',
        createdAt: 2,
        updatedAt: 2,
      },
    ]);
    const firstResponse = gatewayResult([{
      id: 'target-1',
      profileId: 'profile-1',
      mode: 'session',
      title: 'First target',
      driver: 'cdp',
      status: 'selected',
      lastSeenAt: 1,
    }]);
    const secondResponse = gatewayResult([{
      id: 'target-2',
      profileId: 'profile-2',
      mode: 'session',
      title: 'Second target',
      driver: 'cdp',
      status: 'selected',
      lastSeenAt: 2,
    }]);
    const firstDeferred = deferred<typeof firstResponse>();
    const secondDeferred = deferred<typeof secondResponse>();
    service.listTargets
      .mockReturnValueOnce(firstDeferred.promise)
      .mockReturnValueOnce(secondDeferred.promise);

    const firstSelection = fixture.componentInstance.selectProfile('profile-1');
    const secondSelection = fixture.componentInstance.selectProfile('profile-2');
    secondDeferred.resolve(secondResponse);
    await secondSelection;
    firstDeferred.resolve(firstResponse);
    await firstSelection;

    expect(fixture.componentInstance.selectedProfileId()).toBe('profile-2');
    expect(fixture.componentInstance.selectedTargetId()).toBe('target-2');
  });

  it('keeps the newest profile inventory when profile refreshes resolve out of order', async () => {
    fixture.componentInstance.targets.set([]);
    fixture.componentInstance.selectedTargetId.set(null);
    const oldResponse = gatewayResult([{
      id: 'profile-old',
      label: 'Old profile',
      mode: 'session',
      browser: 'chrome',
      allowedOrigins: [],
      status: 'stopped',
      createdAt: 1,
      updatedAt: 1,
    }]);
    const newResponse = gatewayResult([{
      id: 'profile-new',
      label: 'New profile',
      mode: 'session',
      browser: 'chrome',
      allowedOrigins: [],
      status: 'running',
      createdAt: 2,
      updatedAt: 2,
    }]);
    const oldDeferred = deferred<typeof oldResponse>();
    const newDeferred = deferred<typeof newResponse>();
    service.listProfiles
      .mockReturnValueOnce(oldDeferred.promise)
      .mockReturnValueOnce(newDeferred.promise);

    const oldPromise = fixture.componentInstance.refreshProfiles();
    const newPromise = fixture.componentInstance.refreshProfiles();
    newDeferred.resolve(newResponse);
    await newPromise;
    oldDeferred.resolve(oldResponse);
    await oldPromise;

    expect(fixture.componentInstance.profiles()[0]?.id).toBe('profile-new');
    expect(fixture.componentInstance.selectedProfileId()).toBe('profile-new');
  });

  it('ignores stale aggregate resource responses after a newer refresh completes', async () => {
    const staleProfiles = deferred<ReturnType<typeof gatewayResult<unknown[]>>>();
    const staleTargets = deferred<ReturnType<typeof gatewayResult<unknown[]>>>();
    const staleAudit = deferred<{ success: false; error: { message: string } }>();
    const staleApprovals = deferred<{ success: false; error: { message: string } }>();
    const staleGrants = deferred<{ success: false; error: { message: string } }>();
    const staleHealth = deferred<{ success: false; error: { message: string } }>();
    const newProfile = {
      id: 'profile-new', label: 'New profile', mode: 'session', browser: 'chrome',
      allowedOrigins: [], status: 'running', createdAt: 2, updatedAt: 2,
    };
    const newTarget = {
      id: 'target-new', profileId: 'profile-new', mode: 'session', title: 'New target',
      driver: 'cdp', status: 'selected', lastSeenAt: 2,
    };
    service.listProfiles
      .mockReturnValueOnce(staleProfiles.promise)
      .mockResolvedValueOnce(gatewayResult([newProfile]));
    service.listTargets
      .mockReturnValueOnce(staleTargets.promise)
      .mockResolvedValueOnce(gatewayResult([newTarget]));
    service.getAuditLog
      .mockReturnValueOnce(staleAudit.promise)
      .mockResolvedValueOnce(gatewayResult([]));
    service.listApprovalRequests
      .mockReturnValueOnce(staleApprovals.promise)
      .mockResolvedValueOnce(gatewayResult([]));
    service.listGrants
      .mockReturnValueOnce(staleGrants.promise)
      .mockResolvedValueOnce(gatewayResult([]));
    service.getHealth
      .mockReturnValueOnce(staleHealth.promise)
      .mockResolvedValueOnce(gatewayResult({ status: 'ready' }));

    const staleRefresh = fixture.componentInstance.refresh();
    const newestRefresh = fixture.componentInstance.refresh();
    await newestRefresh;
    const staleFailure = { success: false as const, error: { message: 'Stale failure' } };
    staleProfiles.reject(new Error('Stale profile transport failure'));
    staleTargets.resolve(gatewayResult([{ ...newTarget, id: 'target-old' }]));
    staleAudit.resolve(staleFailure);
    staleApprovals.resolve(staleFailure);
    staleGrants.resolve(staleFailure);
    staleHealth.resolve(staleFailure);
    await staleRefresh;

    expect(fixture.componentInstance.profiles()[0]?.id).toBe('profile-new');
    expect(fixture.componentInstance.selectedProfileId()).toBe('profile-new');
    expect(fixture.componentInstance.selectedTargetId()).toBe('target-new');
    expect(fixture.componentInstance.errorMessage()).toBeNull();
    expect(fixture.componentInstance.loading()).toBe(false);
  });

  it('keeps aggregate loading active when an older refresh finishes first', async () => {
    const oldDeferred = deferred<void>();
    const newDeferred = deferred<void>();
    const refreshMethods = [
      'refreshProfiles', 'refreshTargets', 'refreshAudit',
      'refreshApprovals', 'refreshGrants', 'refreshHealth',
    ] as const;
    for (const method of refreshMethods) {
      vi.spyOn(fixture.componentInstance, method)
        .mockReturnValueOnce(oldDeferred.promise)
        .mockReturnValueOnce(newDeferred.promise);
    }

    const oldRefresh = fixture.componentInstance.refresh();
    const newRefresh = fixture.componentInstance.refresh();
    oldDeferred.resolve();
    await oldRefresh;
    expect(fixture.componentInstance.loading()).toBe(true);
    newDeferred.resolve();
    await newRefresh;
    expect(fixture.componentInstance.loading()).toBe(false);
  });

  it('keeps a direct target selection made after an inventory refresh starts', async () => {
    const targetB = {
      id: 'target-2',
      profileId: 'profile-1',
      mode: 'session',
      title: 'Second target',
      url: 'https://second.example.com',
      driver: 'cdp',
      status: 'available',
      lastSeenAt: 2,
    } satisfies BrowserTarget;
    fixture.componentInstance.targets.update((targets) => [...targets, targetB]);
    const staleResponse = gatewayResult([fixture.componentInstance.targets()[0]]);
    const staleDeferred = deferred<typeof staleResponse>();
    service.listTargets.mockReturnValueOnce(staleDeferred.promise);

    const refreshPromise = fixture.componentInstance.refreshTargets();
    await fixture.componentInstance.selectTarget(targetB);
    staleDeferred.resolve(staleResponse);
    await refreshPromise;

    expect(fixture.componentInstance.selectedTargetId()).toBe('target-2');
    expect(fixture.componentInstance.targets()).toContain(targetB);
    expect(fixture.componentInstance.navigateUrl()).toBe('https://second.example.com');
  });

  it('clears target details and ignores stale detail responses when the target changes', async () => {
    const targetB = {
      id: 'target-2',
      profileId: 'profile-1',
      mode: 'session',
      title: 'URL-less target',
      driver: 'cdp',
      status: 'available',
      lastSeenAt: 2,
    } satisfies BrowserTarget;
    fixture.componentInstance.targets.update((targets) => [...targets, targetB]);
    fixture.componentInstance.snapshot.set({
      title: 'First target',
      url: 'http://localhost:4567',
      text: 'Old snapshot',
    });
    fixture.componentInstance.extractedText.set('Old extracted text');
    fixture.componentInstance.screenshotDataUrl.set('data:image/png;base64,old');
    const snapshotResponse = gatewayResult({
      title: 'First target',
      url: 'http://localhost:4567',
      text: 'Late snapshot',
    });
    const screenshotResponse = gatewayResult('late-image');
    const snapshotDeferred = deferred<typeof snapshotResponse>();
    const screenshotDeferred = deferred<typeof screenshotResponse>();
    service.snapshot.mockReturnValueOnce(snapshotDeferred.promise);
    service.screenshot.mockReturnValueOnce(screenshotDeferred.promise);

    const snapshotPromise = fixture.componentInstance.loadSnapshot();
    const screenshotPromise = fixture.componentInstance.captureScreenshot();
    await fixture.componentInstance.selectTarget(targetB);

    expect(fixture.componentInstance.snapshot()).toBeNull();
    expect(fixture.componentInstance.extractedText()).toBeNull();
    expect(fixture.componentInstance.screenshotDataUrl()).toBeNull();
    expect(fixture.componentInstance.navigateUrl()).toBe('');

    snapshotDeferred.resolve(snapshotResponse);
    screenshotDeferred.resolve(screenshotResponse);
    await Promise.all([snapshotPromise, screenshotPromise]);

    expect(fixture.componentInstance.snapshot()).toBeNull();
    expect(fixture.componentInstance.extractedText()).toBeNull();
    expect(fixture.componentInstance.screenshotDataUrl()).toBeNull();
  });

  it('keeps the newest same-target snapshot when responses arrive in reverse order', async () => {
    const oldResponse = gatewayResult({
      title: 'Old snapshot',
      url: 'http://localhost:4567',
      text: 'Old content',
    });
    const newResponse = gatewayResult({
      title: 'New snapshot',
      url: 'http://localhost:4567',
      text: 'New content',
    });
    const oldDeferred = deferred<typeof oldResponse>();
    const newDeferred = deferred<typeof newResponse>();
    service.snapshot
      .mockReturnValueOnce(oldDeferred.promise)
      .mockReturnValueOnce(newDeferred.promise);

    const oldPromise = fixture.componentInstance.loadSnapshot();
    const newPromise = fixture.componentInstance.loadSnapshot();
    newDeferred.resolve(newResponse);
    await newPromise;
    oldDeferred.resolve(oldResponse);
    await oldPromise;

    expect(fixture.componentInstance.snapshot()?.title).toBe('New snapshot');
  });

  it('keeps the newest same-target screenshot when responses arrive in reverse order', async () => {
    const oldResponse = gatewayResult('old-image');
    const newResponse = gatewayResult('new-image');
    const oldDeferred = deferred<typeof oldResponse>();
    const newDeferred = deferred<typeof newResponse>();
    service.screenshot
      .mockReturnValueOnce(oldDeferred.promise)
      .mockReturnValueOnce(newDeferred.promise);

    const oldPromise = fixture.componentInstance.captureScreenshot();
    const newPromise = fixture.componentInstance.captureScreenshot();
    newDeferred.resolve(newResponse);
    await newPromise;
    oldDeferred.resolve(oldResponse);
    await oldPromise;

    expect(fixture.componentInstance.screenshotDataUrl()).toBe(
      'data:image/png;base64,new-image',
    );
  });

  it('suppresses rejected stale snapshot and screenshot requests', async () => {
    const staleSnapshot = deferred<ReturnType<typeof gatewayResult<unknown>>>();
    const staleScreenshot = deferred<ReturnType<typeof gatewayResult<string>>>();
    service.snapshot
      .mockReturnValueOnce(staleSnapshot.promise)
      .mockResolvedValueOnce(gatewayResult({
        title: 'Newest snapshot', url: 'http://localhost:4567', text: 'Newest content',
      }));
    service.screenshot
      .mockReturnValueOnce(staleScreenshot.promise)
      .mockResolvedValueOnce(gatewayResult('newest-image'));

    const staleSnapshotPromise = fixture.componentInstance.loadSnapshot();
    const staleScreenshotPromise = fixture.componentInstance.captureScreenshot();
    await fixture.componentInstance.loadSnapshot();
    await fixture.componentInstance.captureScreenshot();
    staleSnapshot.reject(new Error('Stale snapshot transport failure'));
    staleScreenshot.reject(new Error('Stale screenshot transport failure'));

    await expect(staleSnapshotPromise).resolves.toBeUndefined();
    await expect(staleScreenshotPromise).resolves.toBeUndefined();
    expect(fixture.componentInstance.snapshot()?.title).toBe('Newest snapshot');
    expect(fixture.componentInstance.screenshotDataUrl()).toBe(
      'data:image/png;base64,newest-image',
    );
    expect(fixture.componentInstance.errorMessage()).toBeNull();
  });

  it('does not publish extraction from a snapshot replaced on the same target', async () => {
    fixture.componentInstance.snapshot.set({
      title: 'Old snapshot',
      url: 'http://localhost:4567',
      text: 'Old content',
    });
    const extractionResponse = { success: true, data: { text: 'Extracted old content' } };
    const extractionDeferred = deferred<typeof extractionResponse>();
    auxService.extractWeb.mockReturnValueOnce(extractionDeferred.promise);
    service.snapshot.mockResolvedValueOnce(gatewayResult({
      title: 'New snapshot',
      url: 'http://localhost:4567',
      text: 'New content',
    }));

    const extractionPromise = fixture.componentInstance.extractMainContent();
    await fixture.componentInstance.loadSnapshot();
    extractionDeferred.resolve(extractionResponse);
    await extractionPromise;

    expect(fixture.componentInstance.snapshot()?.title).toBe('New snapshot');
    expect(fixture.componentInstance.extractedText()).toBeNull();
    expect(fixture.componentInstance.extracting()).toBe(false);
  });

  it('suppresses a rejected extraction after its snapshot is replaced', async () => {
    fixture.componentInstance.snapshot.set({
      title: 'Old snapshot', url: 'http://localhost:4567', text: 'Old content',
    });
    const staleExtraction = deferred<{ success: true; data: { text: string } }>();
    auxService.extractWeb.mockReturnValueOnce(staleExtraction.promise);

    const extractionPromise = fixture.componentInstance.extractMainContent();
    fixture.componentInstance.snapshot.set({
      title: 'New snapshot', url: 'http://localhost:4567', text: 'New content',
    });
    staleExtraction.reject(new Error('Stale extraction transport failure'));

    await expect(extractionPromise).resolves.toBeUndefined();
    expect(fixture.componentInstance.extractedText()).toBeNull();
    expect(fixture.componentInstance.errorMessage()).toBeNull();
  });

  it('surfaces rejected current refresh and detail requests', async () => {
    service.getHealth.mockRejectedValueOnce(new Error('Health transport failed'));
    await fixture.componentInstance.refreshHealth();
    expect(fixture.componentInstance.errorMessage()).toBe('Health transport failed');

    fixture.componentInstance.errorMessage.set(null);
    service.snapshot.mockRejectedValueOnce(new Error('Snapshot transport failed'));
    await fixture.componentInstance.loadSnapshot();
    expect(fixture.componentInstance.errorMessage()).toBe('Snapshot transport failed');
  });

  it('invalidates in-flight target details when navigating the selected target', async () => {
    const snapshotResponse = gatewayResult({
      title: 'Old page', url: 'http://localhost:4567', text: 'Late old content',
    });
    const screenshotResponse = gatewayResult('late-old-image');
    const snapshotDeferred = deferred<typeof snapshotResponse>();
    const screenshotDeferred = deferred<typeof screenshotResponse>();
    service.snapshot.mockReturnValueOnce(snapshotDeferred.promise);
    service.screenshot.mockReturnValueOnce(screenshotDeferred.promise);
    fixture.componentInstance.snapshot.set({
      title: 'Old page', url: 'http://localhost:4567', text: 'Old content',
    });
    fixture.componentInstance.extractedText.set('Old extraction');
    fixture.componentInstance.screenshotDataUrl.set('data:image/png;base64,old');

    const snapshotPromise = fixture.componentInstance.loadSnapshot();
    const screenshotPromise = fixture.componentInstance.captureScreenshot();
    fixture.componentInstance.navigateUrl.set('https://new.example.com');
    await fixture.componentInstance.navigate();
    snapshotDeferred.resolve(snapshotResponse);
    screenshotDeferred.resolve(screenshotResponse);
    await Promise.all([snapshotPromise, screenshotPromise]);

    expect(service.navigate).toHaveBeenLastCalledWith({
      profileId: 'profile-1', targetId: 'target-1', url: 'https://new.example.com',
    });
    expect(fixture.componentInstance.snapshot()).toBeNull();
    expect(fixture.componentInstance.extractedText()).toBeNull();
    expect(fixture.componentInstance.screenshotDataUrl()).toBeNull();
  });

  it('clears target details when inventory reports a new URL for the same target', async () => {
    fixture.componentInstance.snapshot.set({
      title: 'Old page', url: 'http://localhost:4567', text: 'Old content',
    });
    fixture.componentInstance.extractedText.set('Old extraction');
    fixture.componentInstance.screenshotDataUrl.set('data:image/png;base64,old');
    service.listTargets.mockResolvedValueOnce(gatewayResult([{
      ...fixture.componentInstance.targets()[0],
      url: 'https://new.example.com',
    }]));

    await fixture.componentInstance.refreshTargets();

    expect(fixture.componentInstance.selectedTargetId()).toBe('target-1');
    expect(fixture.componentInstance.navigateUrl()).toBe('https://new.example.com');
    expect(fixture.componentInstance.snapshot()).toBeNull();
    expect(fixture.componentInstance.extractedText()).toBeNull();
    expect(fixture.componentInstance.screenshotDataUrl()).toBeNull();
  });

  it('exposes profile and target selection without redundant container tab stops', () => {
    const profileList = fixture.nativeElement.querySelector('.profile-list') as HTMLElement;
    const targetList = fixture.nativeElement.querySelector('.target-list') as HTMLElement;
    const profileButton = fixture.nativeElement.querySelector('.profile-main') as HTMLButtonElement;
    const targetButton = fixture.nativeElement.querySelector('[data-testid="target-row"]') as HTMLButtonElement;

    expect(profileList.getAttribute('role')).toBe('list');
    expect(profileList.hasAttribute('tabindex')).toBe(false);
    expect(targetList.getAttribute('role')).toBe('list');
    expect(targetList.hasAttribute('tabindex')).toBe(false);
    expect(profileButton.getAttribute('aria-pressed')).toBe('true');
    expect(targetButton.getAttribute('aria-pressed')).toBe('true');
  });

  it('keeps setup and raw diagnostics collapsed until requested', () => {
    const profileSetup = fixture.nativeElement.querySelector(
      '[data-testid="new-profile-disclosure"]',
    ) as HTMLDetailsElement;
    expect(profileSetup.open).toBe(false);

    const diagnosticsTab = fixture.nativeElement.querySelector(
      '[data-testid="diagnostics-view-tab"]',
    ) as HTMLButtonElement;
    diagnosticsTab.click();
    fixture.detectChanges();

    const rawHealth = fixture.nativeElement.querySelector(
      '[data-testid="raw-health-disclosure"]',
    ) as HTMLDetailsElement;
    expect(rawHealth.open).toBe(false);
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

  it('hides target actions until a profile and target are selected', () => {
    fixture.componentInstance.selectedTargetId.set(null);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="navigate-button"]')).toBeNull();
    expect(fixture.nativeElement.textContent).toContain('Select a browser target');
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

  it('keeps a profile-only login check available when no target is open', async () => {
    fixture.componentInstance.targets.set([]);
    fixture.componentInstance.selectedTargetId.set(null);
    fixture.componentInstance.selectedProfileId.set('profile-1');
    fixture.detectChanges();

    const button = fixture.nativeElement.querySelector(
      '[data-testid="request-login-button"]',
    ) as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toContain('Check profile login');

    await fixture.componentInstance.requestUserLogin();
    expect(service.requestUserLogin).toHaveBeenLastCalledWith({
      profileId: 'profile-1',
      reason: 'Login check requested from Browser Gateway page',
    });
  });

  it('renders provider capability details from health output', () => {
    openView('diagnostics');
    const text = fixture.nativeElement.textContent;

    expect(text).toContain('Claude can use Browser Gateway MCP tools.');
    expect(text).toContain('Codex can use Browser Gateway through injected MCP config in local AIO sessions.');
    expect(text).toContain('Gemini Browser Gateway is unavailable until adapter MCP injection is implemented.');
  });

  it('shows degraded gateway, provider, and bridge states without false ready badges', () => {
    fixture.componentInstance.health.set({
      status: 'partial',
      mcpBridge: { available: false },
      localExtension: {
        state: 'silent',
        summary: 'Local extension has stopped polling.',
      },
      providerCapabilityDetails: {
        claude: { available: true, message: 'Available' },
        gemini: { available: false, message: 'Unavailable' },
      },
    });
    openView('diagnostics');

    const gatewayPill = fixture.nativeElement.querySelector('.live-pill') as HTMLElement;
    const providerBadge = fixture.nativeElement.querySelector(
      '[data-testid="provider-health-summary"]',
    ) as HTMLElement;
    const channelBadge = fixture.nativeElement.querySelector(
      '[data-testid="channel-health-summary"]',
    ) as HTMLElement;

    expect(gatewayPill.textContent).toContain('Gateway degraded');
    expect(gatewayPill.classList.contains('ready')).toBe(false);
    expect(gatewayPill.classList.contains('warning')).toBe(true);
    expect(providerBadge.textContent).toContain('1 of 2 available');
    expect(providerBadge.classList.contains('running')).toBe(false);
    expect(providerBadge.classList.contains('warning')).toBe(true);
    expect(channelBadge.textContent).toContain('Limited');
    expect(fixture.nativeElement.textContent).toContain('MCP bridge unavailable');
    expect(fixture.nativeElement.textContent).toContain('Silent');
    expect(fixture.nativeElement.textContent).toContain('Local extension has stopped polling.');
  });

  it('shows an unavailable gateway when health reports missing', () => {
    fixture.componentInstance.health.set({ status: 'missing' });
    fixture.detectChanges();

    const gatewayPill = fixture.nativeElement.querySelector('.live-pill') as HTMLElement;
    expect(gatewayPill.textContent).toContain('Gateway unavailable');
    expect(gatewayPill.classList.contains('ready')).toBe(false);
    expect(gatewayPill.classList.contains('error')).toBe(true);
  });

  it('does not show a ready channel badge when the gateway is ready but the extension is silent', () => {
    fixture.componentInstance.health.set({
      status: 'ready',
      mcpBridge: { available: true },
      localExtension: {
        state: 'silent',
        summary: 'Local extension has stopped polling.',
      },
    });
    openView('diagnostics');

    const channelBadge = fixture.nativeElement.querySelector(
      '[data-testid="channel-health-summary"]',
    ) as HTMLElement;
    expect(channelBadge.textContent).toContain('Extension issue');
    expect(channelBadge.classList.contains('ready')).toBe(false);
    expect(channelBadge.classList.contains('warning')).toBe(true);
  });

  it('clears stale health and reports an unsuccessful health refresh', async () => {
    fixture.componentInstance.health.set({ status: 'ready' });
    service.getHealth.mockResolvedValueOnce({
      success: false,
      error: { message: 'Gateway probe failed' },
    });

    await fixture.componentInstance.refreshHealth();

    expect(fixture.componentInstance.health()).toBeNull();
    expect(fixture.componentInstance.errorMessage()).toBe('Gateway probe failed');
  });

  it('renders existing-tab bridge setup guidance', () => {
    openView('diagnostics');
    const text = fixture.nativeElement.textContent;

    expect(text).toContain('Browser Gateway');
    expect(text).toContain('live browser sessions');
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
    openView('diagnostics');
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('allowed');
    expect(text).toContain('succeeded');
  });

  it('hides stale audit entries by default while keeping them available in history', () => {
    openView('diagnostics');
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
    openView('permissions');
    const text = fixture.nativeElement.textContent;

    expect(text).toContain('Pending approvals');
    expect(text).toContain('request-1');
    expect(text).toContain('Publish release');
    expect(text).toContain('Manual login is required before continuing.');
    expect(text).toContain('button.publish');
    expect(text).toContain('Expires');
    expect(text).toContain('Active grants');
    expect(text).toContain('autonomous');
  });

  it('renders upload approval file context and proposed upload roots', () => {
    openView('permissions');
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

  it('approves ordinary unattended input without typed confirmation', async () => {
    const component = fixture.componentInstance;
    const approval = component.approvalRequests()[0]!;

    await component.approveApprovalRequest(approval, 'autonomous');

    expect(service.approveRequest).toHaveBeenCalledWith({
      requestId: 'request-1',
      grant: expect.objectContaining({
        mode: 'autonomous',
        autonomous: true,
        allowedActionClasses: ['input'],
      }),
      reason: 'Approved from Browser Gateway page',
    });
  });

  it('scopes typed confirmation to unattended submit or destructive access', async () => {
    const component = fixture.componentInstance;
    const approval = component.approvalRequests()[0]!;
    service.approveRequest.mockClear();

    component.toggleAutonomousSubmit(approval);
    component.toggleAutonomousDestructive(approval);
    await component.approveApprovalRequest(approval, 'autonomous');

    expect(service.approveRequest).not.toHaveBeenCalled();
    expect(component.errorMessage()).toContain('Type Local App');

    component.onAutonomousConfirmationInput(approval, inputEvent('Local App'));
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

  it('does not bypass confirmation by choosing a narrower label for a submit proposal', async () => {
    const component = fixture.componentInstance;
    const baseApproval = component.approvalRequests()[0]!;
    const approval: BrowserApprovalRequest = {
      ...baseApproval,
      proposedGrant: {
        ...baseApproval.proposedGrant,
        allowedActionClasses: ['input', 'submit'],
      },
    };
    service.approveRequest.mockClear();

    await component.approveApprovalRequest(approval, 'session');

    expect(service.approveRequest).not.toHaveBeenCalled();
    expect(component.errorMessage()).toContain('Type Local App');
  });

  it('does not render a generic AUTONOMOUS confirmation field', () => {
    openView('permissions');
    expect(fixture.nativeElement.textContent).not.toContain('Type AUTONOMOUS');
    expect(
      fixture.nativeElement.querySelector('input[placeholder="AUTONOMOUS"]'),
    ).toBeNull();
  });

  it('revokes grants from the Browser page', async () => {
    await fixture.componentInstance.revokeGrant('grant-1');

    expect(service.revokeGrant).toHaveBeenCalledWith({
      grantId: 'grant-1',
      reason: 'Revoked from Browser Gateway page',
    });
  });

  function openView(view: 'browser' | 'permissions' | 'diagnostics' | 'unattended'): void {
    const tab = fixture.nativeElement.querySelector(
      `[data-testid="${view}-view-tab"]`,
    ) as HTMLButtonElement;
    tab.click();
    fixture.detectChanges();
  }

});

function inputEvent(value: string): Event {
  return { target: { value } } as unknown as Event;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolver, rejecter) => {
    resolve = resolver;
    reject = rejecter;
  });
  return { promise, resolve, reject };
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
    hasAndroidMcp: false,
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
