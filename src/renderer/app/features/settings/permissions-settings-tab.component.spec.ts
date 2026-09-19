import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PermissionsSettingsTabComponent } from './permissions-settings-tab.component';
import { SettingsStore } from '../../core/state/settings.store';
import { SecurityIpcService } from '../../core/services/ipc/security-ipc.service';
import { TaskIpcService } from '../../core/services/ipc/task-ipc.service';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(
  resolve(specDirectory, './permissions-settings-tab.component.html'),
  'utf8',
);
const permissionsScss = readFileSync(
  resolve(specDirectory, './permissions-settings-tab.permissions.scss'),
  'utf8',
);
const layoutScss = readFileSync(resolve(specDirectory, './permissions-settings-tab.layout.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('permissions-settings-tab.component.html')) {
    return Promise.resolve(template);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

interface PendingRequestFixture {
  id: string;
  scope: string;
  resource: string;
  context?: { toolName?: string };
  timestamp: number;
}

function makeApi(pending: PendingRequestFixture[] = []) {
  return {
    permissionGetPendingBatch: vi.fn(async () => ({ success: true, data: { requests: pending } })),
    permissionGetLearnedPatterns: vi.fn(async () => ({
      success: true,
      data: [
        {
          id: 'pattern-1',
          scope: 'file_read',
          pattern: '/tmp/**',
          recommendedAction: 'allow' as const,
          confidence: 0.9,
          sampleCount: 12,
          lastUpdated: Date.now(),
          approved: false,
        },
      ],
    })),
    permissionGetStats: vi.fn(async () => ({
      success: true,
      data: { totalRules: 3, cacheSize: 5, approvedPatterns: 2, accuracyRate: 0.8 },
    })),
    permissionRecordBatchDecision: vi.fn(async () => ({ success: true })),
    permissionRecordDecision: vi.fn(async () => ({ success: true })),
    permissionApprovePattern: vi.fn(async () => ({ success: true })),
    permissionRejectPattern: vi.fn(async () => ({ success: true })),
  };
}

describe('PermissionsSettingsTabComponent', () => {
  let fixture: ComponentFixture<PermissionsSettingsTabComponent>;
  let api: ReturnType<typeof makeApi>;

  const store = { defaultWorkingDirectory: () => '' };

  const securityIpc = {
    securityGetPermissionConfig: vi.fn(async () => ({
      success: true,
      data: { config: { defaultAction: 'ask' } },
    })),
    securitySetPermissionPreset: vi.fn(async () => ({
      success: true,
      data: { config: { defaultAction: 'ask' } },
    })),
    permissionGetAuditLog: vi.fn(async () => ({
      success: true,
      data: { decisions: [], denials: [] },
    })),
    permissionAnalyzeShadowedRules: vi.fn(async () => ({ success: true, data: { findings: [] } })),
  };

  const taskIpc = { taskGetPreflight: vi.fn() };

  async function createFixture(pending: PendingRequestFixture[] = []): Promise<void> {
    api = makeApi(pending);
    (window as unknown as { electronAPI?: unknown }).electronAPI = api;

    await TestBed.configureTestingModule({
      imports: [PermissionsSettingsTabComponent],
      providers: [
        { provide: SettingsStore, useValue: store },
        { provide: SecurityIpcService, useValue: securityIpc },
        { provide: TaskIpcService, useValue: taskIpc },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(PermissionsSettingsTabComponent);
    // The initial data load is fired from a constructor `effect()` (fire-and-forget,
    // not an awaited lifecycle hook), so `whenStable()` timing is not reliable here.
    // Await the same `loadAll()` the component runs internally — idempotent once the
    // effect's own call has settled, and guarantees the data (and `chooseInitialSection`)
    // are in before the test inspects the rendered DOM.
    fixture.detectChanges();
    await fixture.componentInstance.loadAll();
    fixture.detectChanges();
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
  });

  it('renders four section tabs and starts on Rules when the queue is empty', async () => {
    await createFixture([]);

    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
    expect(Array.from(tabs).map((t) => (t as HTMLElement).textContent?.trim().split('\n')[0].trim())).toEqual(
      expect.arrayContaining(['Requests', 'Rules', 'Audit', 'Insights']),
    );
    expect(tabs).toHaveLength(4);

    expect(fixture.nativeElement.querySelector('#permissions-panel-rules')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('#permissions-panel-requests')).toBeNull();
  });

  it('starts on Requests, with a badge, when requests already exist at load', async () => {
    await createFixture([
      { id: 'req-1', scope: 'file_write', resource: '/tmp/a', timestamp: Date.now() },
    ]);

    expect(fixture.nativeElement.querySelector('#permissions-panel-requests')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('#permissions-panel-rules')).toBeNull();

    const requestsTab = fixture.nativeElement.querySelector('#requests');
    expect(requestsTab.textContent).toContain('1');
  });

  it('never moves the active section after a later refresh adds a request (Rule 3)', async () => {
    await createFixture([]);
    expect(fixture.nativeElement.querySelector('#permissions-panel-rules')).not.toBeNull();

    // User deliberately switches to Insights.
    const component = fixture.componentInstance;
    component.onSectionChange('insights');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('#permissions-panel-insights')).not.toBeNull();

    // A permission request arrives later (simulated as another load, e.g. a
    // background refresh) — this must only update the badge, never the view.
    api.permissionGetPendingBatch.mockResolvedValueOnce({
      success: true,
      data: { requests: [{ id: 'late-1', scope: 'network_access', resource: 'https://x', timestamp: Date.now() }] },
    });
    await component.loadPendingPermissions();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('#permissions-panel-insights')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('#permissions-panel-requests')).toBeNull();
    const requestsTab = fixture.nativeElement.querySelector('#requests');
    expect(requestsTab.textContent).toContain('1');
  });

  it('keeps the Allow/Deny single-decision handlers wired with accessible, 44px-target buttons', async () => {
    await createFixture([
      { id: 'req-1', scope: 'file_write', resource: '/tmp/a', timestamp: Date.now() },
    ]);

    const allowBtn = fixture.nativeElement.querySelector('.btn-allow-sm') as HTMLButtonElement;
    const denyBtn = fixture.nativeElement.querySelector('.btn-deny-sm') as HTMLButtonElement;
    expect(allowBtn.getAttribute('aria-label')).toBe('Allow');
    expect(denyBtn.getAttribute('aria-label')).toBe('Deny');
    expect(permissionsScss).toContain('width: 44px');
    expect(permissionsScss).toContain('height: 44px');

    allowBtn.click();
    await fixture.whenStable();

    expect(api.permissionRecordDecision).toHaveBeenCalledWith({
      requestId: 'req-1',
      action: 'allow',
      scope: 'session',
    });
  });

  it('keeps the batch Allow all/Block all controls wired, sized for their hit target', async () => {
    await createFixture([
      { id: 'req-1', scope: 'file_write', resource: '/tmp/a', timestamp: Date.now() },
    ]);

    expect(layoutScss).toContain('min-height: 44px');

    const allowAllBtn = fixture.nativeElement.querySelector('.btn-allow') as HTMLButtonElement;
    allowAllBtn.click();
    await fixture.whenStable();

    expect(api.permissionRecordBatchDecision).toHaveBeenCalledWith({ action: 'allow_all', scope: 'session' });
  });

  it('keeps the Suggested automatic rules Approve handler wired in the Rules view', async () => {
    await createFixture([]);
    // Already on Rules by default (empty queue).
    const approveBtn = fixture.nativeElement.querySelector('.btn-approve') as HTMLButtonElement;
    expect(approveBtn).not.toBeNull();

    approveBtn.click();
    await fixture.whenStable();

    expect(api.permissionApprovePattern).toHaveBeenCalledWith({ patternId: 'pattern-1' });
  });

  it('keeps the Permission audit filter and refresh wired in the Audit view', async () => {
    await createFixture([]);
    const component = fixture.componentInstance;
    component.onSectionChange('audit');
    fixture.detectChanges();

    const filterInput = fixture.nativeElement.querySelector(
      '#permissions-panel-audit input[type="text"]',
    ) as HTMLInputElement;
    filterInput.value = 'instance-123';
    filterInput.dispatchEvent(new Event('input'));
    expect(component.permissionAuditInstanceId()).toBe('instance-123');

    securityIpc.permissionGetAuditLog.mockClear();
    const refreshBtn = fixture.nativeElement.querySelector(
      '#permissions-panel-audit .btn-secondary',
    ) as HTMLButtonElement;
    refreshBtn.click();
    await fixture.whenStable();

    expect(securityIpc.permissionGetAuditLog).toHaveBeenCalledWith('instance-123', 50);
  });

  it('keeps the Activity summary stats wired in the Insights view', async () => {
    await createFixture([]);
    const component = fixture.componentInstance;
    component.onSectionChange('insights');
    fixture.detectChanges();

    const insightsPanel = fixture.nativeElement.querySelector('#permissions-panel-insights');
    expect(insightsPanel.textContent).toContain('3'); // totalRules
    expect(insightsPanel.textContent).toContain('80%'); // accuracyRate
  });

  it('shows a browser-specific warning only when a pending request uses a browser tool', async () => {
    await createFixture([
      {
        id: 'req-1',
        scope: 'tool_use',
        resource: 'navigate',
        context: { toolName: 'browser_navigate' },
        timestamp: Date.now(),
      },
    ]);

    const warning = fixture.nativeElement.querySelector('.pending-browser-note');
    expect(warning).not.toBeNull();
    expect(warning.textContent).toContain('browser tool');
  });

  it('does not show the browser warning for a non-browser pending request', async () => {
    await createFixture([
      { id: 'req-1', scope: 'file_write', resource: '/tmp/a', timestamp: Date.now() },
    ]);

    expect(fixture.nativeElement.querySelector('.pending-browser-note')).toBeNull();
  });

  it('removed the always-on browser education cards from the template', async () => {
    await createFixture([]);
    expect(fixture.nativeElement.querySelector('.guidance-card')).toBeNull();
  });
});
