import {
  Component,
  EventEmitter,
  Input,
  Output,
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { NgTemplateOutlet } from '@angular/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, SETTINGS_METADATA } from '../../../../shared/types/settings.types';
import type { SettingMetadata } from '../../../../shared/types/settings-metadata.types';
import { AdvancedSettingsTabComponent } from './advanced-settings-tab.component';
import { ADVANCED_SECTION_DEFINITIONS } from './advanced-settings-sections';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingsIpcService } from '../../core/services/ipc/settings-ipc.service';
import { BrowserGatewayIpcService } from '../../core/services/ipc/browser-gateway-ipc.service';
import { SettingsNavIconComponent } from './ui/settings-nav-icon.component';
import { SettingsSectionTabsComponent } from './ui/settings-section-tabs.component';
import { DangerZoneComponent } from './ui/danger-zone.component';

await resolveComponentResources((url) => {
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

@Component({
  selector: 'app-setting-row',
  standalone: true,
  template: `<button
    type="button"
    class="stub-setting-row"
    [attr.data-setting-key]="setting?.key"
    (click)="valueChange.emit({ key: setting?.key, value: 'changed' })"
  >setting row</button>`,
})
class SettingRowStubComponent {
  @Input() setting: SettingMetadata | null = null;
  @Input() value: unknown;
  @Input() dynamicOptions: unknown;
  @Output() valueChange = new EventEmitter<{ key: string; value: unknown }>();
}

@Component({
  selector: 'app-settings-tiered-row-list',
  standalone: true,
  template: `@for (setting of settings; track setting.key) {
    <button
      type="button"
      class="stub-tiered-row"
      [attr.data-setting-key]="setting.key"
      (click)="valueChange.emit({ key: setting.key, value: 'changed' })"
    >tiered row</button>
  }`,
})
class SettingsTieredRowListStubComponent {
  @Input() settings: SettingMetadata[] = [];
  @Input() valueFor: ((key: string) => unknown) | null = null;
  @Output() valueChange = new EventEmitter<{ key: string; value: unknown }>();
}

class FakeSettingsStore {
  readonly settings = { ...DEFAULT_SETTINGS };
  readonly advancedSettings = () =>
    SETTINGS_METADATA.filter((m) => m.category === 'advanced' && !m.hidden);
  readonly mcpSettings = () =>
    SETTINGS_METADATA.filter((m) => m.category === 'mcp' && !m.hidden);
  readonly get = vi.fn((key: string) => (this.settings as Record<string, unknown>)[key]);
  readonly set = vi.fn(async () => undefined);
  readonly reset = vi.fn(async () => undefined);
  readonly reload = vi.fn(async () => undefined);
}

class FakeSettingsIpc {
  readonly exportSettings = vi.fn();
  readonly importSettings = vi.fn();
}

class FakeBrowserGatewayIpc {
  readonly listProfiles = vi.fn(async () => ({ success: true, data: { data: [] } }));
}

describe('AdvancedSettingsTabComponent', () => {
  let fixture: ComponentFixture<AdvancedSettingsTabComponent>;
  let store: FakeSettingsStore;
  let settingsIpc: FakeSettingsIpc;
  let browserGatewayIpc: FakeBrowserGatewayIpc;
  let api: {
    hooksApprovalsList: ReturnType<typeof vi.fn>;
    hooksApprovalsUpdate: ReturnType<typeof vi.fn>;
    hooksApprovalsClear: ReturnType<typeof vi.fn>;
    openDocsFile: ReturnType<typeof vi.fn>;
  };

  async function mount(): Promise<void> {
    store = new FakeSettingsStore();
    settingsIpc = new FakeSettingsIpc();
    browserGatewayIpc = new FakeBrowserGatewayIpc();
    api = {
      hooksApprovalsList: vi.fn(async () => ({ success: true, data: [] })),
      hooksApprovalsUpdate: vi.fn(async () => ({ success: true })),
      hooksApprovalsClear: vi.fn(async () => ({ success: true })),
      openDocsFile: vi.fn(async () => ({ success: true })),
    };
    (window as unknown as Record<string, unknown>)['electronAPI'] = api;

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [AdvancedSettingsTabComponent],
      providers: [
        { provide: SettingsStore, useValue: store },
        { provide: SettingsIpcService, useValue: settingsIpc },
        { provide: BrowserGatewayIpcService, useValue: browserGatewayIpc },
      ],
    });
    TestBed.overrideComponent(AdvancedSettingsTabComponent, {
      set: {
        imports: [
          SettingRowStubComponent,
          SettingsTieredRowListStubComponent,
          SettingsNavIconComponent,
          SettingsSectionTabsComponent,
          DangerZoneComponent,
          NgTemplateOutlet,
        ],
        styles: [''],
        styleUrl: undefined,
        styleUrls: [],
      },
    });
    await TestBed.compileComponents();
    fixture = TestBed.createComponent(AdvancedSettingsTabComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  }

  function panelIds(): string[] {
    return Array.from(fixture.nativeElement.querySelectorAll('[role="tabpanel"]')).map(
      (el) => (el as HTMLElement).id,
    );
  }

  beforeEach(async () => {
    await mount();
  });

  it('renders Runtime, Security, and Data section tabs with only the active panel visible', () => {
    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
    expect(Array.from(tabs).map((t) => (t as HTMLElement).textContent?.trim())).toEqual([
      'Runtime',
      'Security',
      'Data',
    ]);
    expect(panelIds()).toEqual(['advanced-panel-runtime']);
  });

  it('switches the visible panel on tab click without losing loaded state', async () => {
    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
    (tabs[1] as HTMLElement).click();
    fixture.detectChanges();
    expect(panelIds()).toEqual(['advanced-panel-security']);
    // MCP safety and hook approvals live in Security, unchanged from before the reorg.
    expect(fixture.nativeElement.querySelector('#mcp-safety-heading')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('#hook-approvals-heading')).not.toBeNull();

    (tabs[2] as HTMLElement).click();
    fixture.detectChanges();
    expect(panelIds()).toEqual(['advanced-panel-data']);
    expect(fixture.nativeElement.querySelector('#backup-restore-heading')).not.toBeNull();

    (tabs[0] as HTMLElement).click();
    fixture.detectChanges();
    expect(panelIds()).toEqual(['advanced-panel-runtime']);
  });

  it('renders every non-hidden advanced-category setting exactly once across the three panels', () => {
    const expectedKeys = SETTINGS_METADATA.filter(
      (m) => m.category === 'advanced' && !m.hidden,
    ).map((m) => m.key);

    const seen: string[] = [];
    for (const tabIndex of [0, 1, 2]) {
      const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
      (tabs[tabIndex] as HTMLElement).click();
      fixture.detectChanges();
      fixture.nativeElement
        .querySelectorAll('[role="tabpanel"] .stub-setting-row')
        .forEach((el: HTMLElement) => seen.push(el.getAttribute('data-setting-key')!));
    }

    expect(new Set(seen)).toEqual(new Set(expectedKeys));
    expect(seen).toHaveLength(expectedKeys.length);
    // No leftover catch-all: every key in this run resolved to a named card.
    const definedKeys = new Set(ADVANCED_SECTION_DEFINITIONS.flatMap((d) => d.keys));
    expect(expectedKeys.every((key) => definedKeys.has(key))).toBe(true);
  });

  it('wires a Runtime setting-row change through onSettingChange to store.set', () => {
    const row = fixture.nativeElement.querySelector(
      '.stub-setting-row[data-setting-key="parserBufferMaxKB"]',
    ) as HTMLButtonElement;
    row.click();
    expect(store.set).toHaveBeenCalledWith('parserBufferMaxKB', 'changed');
  });

  it('wires the MCP safety tiered list in Security through the same handler', () => {
    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
    (tabs[1] as HTMLElement).click();
    fixture.detectChanges();
    const row = fixture.nativeElement.querySelector('.stub-tiered-row') as HTMLButtonElement;
    expect(row).not.toBeNull();
    row.click();
    expect(store.set).toHaveBeenCalled();
  });

  it('separates credential-sensitive Security cards inside the danger zone, after the plain cards', () => {
    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
    (tabs[1] as HTMLElement).click();
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('#advanced-panel-security') as HTMLElement;
    const dangerZoneHost = panel.lastElementChild;
    // …and the danger zone is the last child of the panel (bottom of the view).
    expect(dangerZoneHost?.tagName.toLowerCase()).toBe('app-danger-zone');
    const dangerZone = dangerZoneHost?.querySelector('.danger-zone');
    expect(dangerZone).not.toBeNull();
    expect(dangerZone?.textContent).toContain('Credentials');
    // The credential heading lives inside the danger zone…
    expect(dangerZone?.querySelector('#credential-vault-heading')).not.toBeNull();
  });

  it('loads hook approvals and managed browser profiles once on init', () => {
    expect(api.hooksApprovalsList).toHaveBeenCalledWith({ pendingOnly: false });
    expect(browserGatewayIpc.listProfiles).toHaveBeenCalledTimes(1);
  });

  it('approves and clears hook approvals through the preload API and reloads the list', async () => {
    api.hooksApprovalsList.mockResolvedValue({
      success: true,
      data: [
        {
          id: 'hook-1',
          name: 'Test hook',
          event: 'PostToolUse',
          enabled: true,
          approvalRequired: true,
          approved: false,
          handlerType: 'script',
        },
      ],
    });
    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
    (tabs[1] as HTMLElement).click();
    fixture.detectChanges();

    // The initial load (constructor effect) ran against the default empty
    // mock before this test updated it — Refresh to pick up the new data.
    const refreshButton = Array.from(
      fixture.nativeElement.querySelectorAll('.section-actions button'),
    ).find((b) => (b as HTMLElement).textContent?.trim() === 'Refresh') as HTMLButtonElement;
    refreshButton.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const approveButton = Array.from(
      fixture.nativeElement.querySelectorAll('.hook-approval-actions button'),
    ).find((b) => (b as HTMLElement).textContent?.trim() === 'Approve') as HTMLButtonElement;
    expect(approveButton).toBeTruthy();
    approveButton.click();
    await fixture.whenStable();
    expect(api.hooksApprovalsUpdate).toHaveBeenCalledWith({ hookId: 'hook-1', approved: true });
    expect(api.hooksApprovalsList).toHaveBeenCalledTimes(3);

    const clearButton = Array.from(
      fixture.nativeElement.querySelectorAll('.section-actions button'),
    ).find((b) => (b as HTMLElement).textContent?.trim() === 'Clear all') as HTMLButtonElement;
    clearButton.click();
    await fixture.whenStable();
    expect(api.hooksApprovalsClear).toHaveBeenCalled();
  });

  it('announces a hook-approvals load failure with role="alert"', async () => {
    api.hooksApprovalsList.mockResolvedValue({ success: false, error: { message: 'boom' } });
    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
    (tabs[1] as HTMLElement).click();
    fixture.detectChanges();
    (fixture.nativeElement.querySelectorAll('.section-actions button')[0] as HTMLButtonElement).click();
    await fixture.whenStable();
    fixture.detectChanges();

    const errorEl = fixture.nativeElement.querySelector('.hook-approvals-empty.error');
    expect(errorEl?.getAttribute('role')).toBe('alert');
    expect(errorEl?.textContent).toContain('boom');
  });

  it('opens the browser automation setup guide from Browser DevTools attach', () => {
    const guideButton = fixture.nativeElement.querySelector(
      '.guide-link-inline',
    ) as HTMLButtonElement;
    expect(guideButton).not.toBeNull();
    guideButton.click();
    expect(api.openDocsFile).toHaveBeenCalledWith('BROWSER_AUTOMATION_SETUP.md');
  });

  it('exports settings and announces success with role="status" aria-live="polite"', async () => {
    settingsIpc.exportSettings.mockResolvedValue({
      success: true,
      data: { filePath: '/tmp/settings.json' },
    });
    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
    (tabs[2] as HTMLElement).click();
    fixture.detectChanges();

    const exportButton = Array.from(fixture.nativeElement.querySelectorAll('button')).find(
      (b) => (b as HTMLElement).textContent?.trim() === 'Export',
    ) as HTMLButtonElement;
    exportButton.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const banner = fixture.nativeElement.querySelector('.export-import-result');
    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.getAttribute('aria-live')).toBe('polite');
    expect(banner?.textContent).toContain('/tmp/settings.json');
  });

  it('announces an import failure with role="alert" adjacent to the control', async () => {
    settingsIpc.importSettings.mockResolvedValue({
      success: false,
      error: { message: 'Import failed: bad file' },
    });
    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
    (tabs[2] as HTMLElement).click();
    fixture.detectChanges();

    const importButton = Array.from(fixture.nativeElement.querySelectorAll('button')).find(
      (b) => (b as HTMLElement).textContent?.trim() === 'Import',
    ) as HTMLButtonElement;
    importButton.click();
    await fixture.whenStable();
    fixture.detectChanges();

    const banner = fixture.nativeElement.querySelector('.export-import-result');
    expect(banner?.getAttribute('role')).toBe('alert');
    expect(banner?.textContent).toContain('Import failed: bad file');
  });

  it('gates reset behind confirm(), stays inside the danger zone, and skips store.reset on cancel', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
    (tabs[2] as HTMLElement).click();
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('#advanced-panel-data') as HTMLElement;
    const resetButton = panel.querySelector('.danger-zone .btn-danger') as HTMLButtonElement;
    expect(resetButton).not.toBeNull();
    expect(resetButton.textContent?.trim()).toBe('Reset all');

    resetButton.click();
    await fixture.whenStable();
    expect(confirmSpy).toHaveBeenCalled();
    expect(store.reset).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('resets settings after an explicit confirmation, from the bottom-of-panel danger zone', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const tabs = fixture.nativeElement.querySelectorAll('[role="tab"]');
    (tabs[2] as HTMLElement).click();
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('#advanced-panel-data') as HTMLElement;
    // The danger zone (containing Reset) is the last child of the Data panel.
    expect(panel.lastElementChild?.tagName.toLowerCase()).toBe('app-danger-zone');

    const resetButton = panel.querySelector('.danger-zone .btn-danger') as HTMLButtonElement;
    resetButton.click();
    await fixture.whenStable();
    expect(store.reset).toHaveBeenCalledTimes(1);
  });
});
