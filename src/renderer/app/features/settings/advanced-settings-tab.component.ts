/**
 * Advanced Settings Tab Component - Runtime, Security, and Data sections.
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  effect,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingsIpcService } from '../../core/services/ipc/settings-ipc.service';
import { BrowserGatewayIpcService } from '../../core/services/ipc/browser-gateway-ipc.service';
import { SettingRowComponent } from './setting-row.component';
import { SettingsTieredRowListComponent } from './settings-tiered-row-list.component';
import { SettingsNavIconComponent } from './ui/settings-nav-icon.component';
import { SettingsSectionTabsComponent } from './ui/settings-section-tabs.component';
import { DangerZoneComponent } from './ui/danger-zone.component';
import {
  ADVANCED_SECTION_DEFINITIONS,
  ADVANCED_SECTION_TABS,
  type AdvancedSection,
} from './advanced-settings-sections';
import type { AppSettings } from '../../../../shared/types/settings.types';
import type { SettingMetadata } from '../../../../shared/types/settings-metadata.types';
import type { BrowserProfile } from '@contracts/types/browser';

// Helper to access API from preload
const getApi = (): {
  hooksApprovalsList?: (params: { pendingOnly: boolean }) => Promise<{ success: boolean; data?: unknown; error?: { message: string } }>;
  hooksApprovalsUpdate?: (params: { hookId: string; approved: boolean }) => Promise<{ success: boolean; error?: { message: string } }>;
  hooksApprovalsClear?: () => Promise<{ success: boolean; error?: { message: string } }>;
  openDocsFile?: (filename: string) => Promise<{ success: boolean; error?: { message: string } }>;
} => (window as unknown as Record<string, unknown>)['electronAPI'] as ReturnType<typeof getApi>;

interface HookApprovalSummary {
  id: string;
  name: string;
  event: string;
  enabled: boolean;
  approvalRequired: boolean;
  approved: boolean;
  handlerType: string;
  handlerSummary?: string;
}

/** One rendered card: a definition's static copy plus its resolved live settings. */
interface AdvancedSectionView {
  id: string;
  title: string;
  description: string;
  settings: SettingMetadata[];
  group: AdvancedSection;
  dangerous?: boolean;
}

@Component({
  selector: 'app-advanced-settings-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [
    SettingRowComponent,
    SettingsNavIconComponent,
    SettingsTieredRowListComponent,
    SettingsSectionTabsComponent,
    DangerZoneComponent,
    NgTemplateOutlet,
  ],
  template: `
    <app-settings-section-tabs
      [tabs]="sectionTabs"
      [activeId]="activeSection()"
      ariaLabel="Advanced sections"
      (activeIdChange)="onSectionChange($event)"
    />

    <ng-template #sectionCard let-section>
      <section class="advanced-section" [attr.aria-labelledby]="section.id">
        @if (section.id === chromeDevtoolsSectionId) {
          <div class="section-heading-row">
            <div class="section-heading">
              <h3 [id]="section.id" class="subsection-title">{{ section.title }}</h3>
              <p class="section-description">{{ section.description }}</p>
            </div>
            <div class="button-group section-actions">
              <button
                class="btn-secondary"
                (click)="loadBrowserProfiles()"
                [disabled]="browserProfilesLoading()"
              >
                Refresh profiles
              </button>
            </div>
          </div>
        } @else {
          <div class="section-heading">
            <h3 [id]="section.id" class="subsection-title">{{ section.title }}</h3>
            <p class="section-description">{{ section.description }}</p>
          </div>
        }
        <div class="settings-list-card">
          @for (setting of section.settings; track setting.key) {
            <app-setting-row
              class="settings-list-item"
              [setting]="setting"
              [value]="store.get(setting.key)"
              [dynamicOptions]="dynamicOptionsFor(setting.key)"
              (valueChange)="onSettingChange($event)"
            />
          }
        </div>
        @if (section.id === chromeDevtoolsSectionId) {
          @if (browserProfilesError(); as profilesError) {
            <p class="section-hint error" role="alert">{{ profilesError }}</p>
          } @else if (browserProfiles().length === 0 && !browserProfilesLoading()) {
            <p class="section-hint">
              No managed browser profiles yet. Create one on the Browser screen,
              then choose it here.
            </p>
          }
          <button
            class="guide-link-inline"
            (click)="openDocsFile('BROWSER_AUTOMATION_SETUP.md')"
            title="How to let agents control a real web browser"
          >
            <app-settings-nav-icon name="network" />
            <span>Open the browser automation setup guide</span>
          </button>
        }
      </section>
    </ng-template>

    @if (activeSection() === 'runtime') {
      <div id="advanced-panel-runtime" class="section-panel" role="tabpanel" aria-labelledby="runtime" tabindex="0">
        @for (section of runtimeSections(); track section.id) {
          <ng-container [ngTemplateOutlet]="sectionCard" [ngTemplateOutletContext]="{ $implicit: section }" />
        }
      </div>
    }

    @if (activeSection() === 'security') {
      <div id="advanced-panel-security" class="section-panel" role="tabpanel" aria-labelledby="security" tabindex="0">
        <section
          class="advanced-section"
          aria-labelledby="mcp-safety-heading"
          data-test="settings-section-mcp"
        >
          <div class="section-heading">
            <h3 id="mcp-safety-heading" class="subsection-title">MCP safety</h3>
            <p class="section-description">
              Safeguards for MCP (Model Context Protocol) tool use — config backups and filesystem write guards. Leave these on unless you have a reason to change them.
            </p>
          </div>
          <div class="settings-list-card">
            <app-settings-tiered-row-list
              [settings]="store.mcpSettings()"
              [valueFor]="readSetting"
              (valueChange)="onSettingChange($event)"
            />
          </div>
        </section>

        <section class="advanced-section" aria-labelledby="hook-approvals-heading">
          <div class="section-heading-row">
            <div class="section-heading">
              <h3 id="hook-approvals-heading" class="subsection-title">
                Hook approvals
              </h3>
              <p class="section-description">
                Hooks are actions the app runs automatically at certain points (for example, running a script after a task finishes). Some hooks ask for one-time approval before they run. Review and manage those approvals here.
              </p>
            </div>
            <div class="button-group section-actions">
              <button
                class="btn-secondary"
                (click)="loadHookApprovals()"
                [disabled]="hookApprovalsLoading()"
              >
                Refresh
              </button>
              <button
                class="btn-secondary"
                (click)="clearHookApprovals()"
                [disabled]="hookApprovalsLoading()"
              >
                Clear all
              </button>
            </div>
          </div>
          <div class="settings-list-card hook-approvals-card">
            <div class="hook-approvals-list">
              @if (hookApprovalsLoading()) {
                <div class="hook-approvals-empty" role="status" aria-live="polite">Loading...</div>
              } @else if (hookApprovalsError()) {
                <div class="hook-approvals-empty error" role="alert">
                  {{ hookApprovalsError() }}
                </div>
              } @else if (hookApprovals().length === 0) {
                <div class="hook-approvals-empty">No hooks are waiting for approval.</div>
              } @else {
                @for (hook of hookApprovals(); track hook.id) {
                  <div class="hook-approval-row">
                    <div class="hook-approval-info">
                      <div class="hook-approval-title">
                        <span class="hook-name">{{ hook.name }}</span>
                        <span class="hook-event">{{ hook.event }}</span>
                      </div>
                      <div class="hook-approval-meta">
                        <span class="hook-status" [class.approved]="hook.approved">
                          {{ hook.approved ? 'Approved' : 'Pending' }}
                        </span>
                        <span class="hook-type">{{ hook.handlerType }}</span>
                        @if (hook.handlerSummary) {
                          <span class="hook-summary">{{ hook.handlerSummary }}</span>
                        }
                      </div>
                    </div>
                    <div class="hook-approval-actions">
                      @if (hook.approved) {
                        <button
                          class="btn-secondary"
                          (click)="updateHookApproval(hook.id, false)"
                          [disabled]="hookApprovalsLoading()"
                        >
                          Revoke
                        </button>
                      } @else {
                        <button
                          class="btn-primary"
                          (click)="updateHookApproval(hook.id, true)"
                          [disabled]="hookApprovalsLoading()"
                        >
                          Approve
                        </button>
                      }
                    </div>
                  </div>
                }
              }
            </div>
          </div>
        </section>

        @for (section of securitySections(); track section.id) {
          <ng-container [ngTemplateOutlet]="sectionCard" [ngTemplateOutletContext]="{ $implicit: section }" />
        }

        @if (securityDangerousSections().length > 0) {
          <app-danger-zone
            title="Credentials &amp; secrets"
            description="These controls affect real passwords and credential auto-fill on your own browser tabs. Review before changing."
          >
            @for (section of securityDangerousSections(); track section.id) {
              <ng-container [ngTemplateOutlet]="sectionCard" [ngTemplateOutletContext]="{ $implicit: section }" />
            }
          </app-danger-zone>
        }
      </div>
    }

    @if (activeSection() === 'data') {
      <div id="advanced-panel-data" class="section-panel" role="tabpanel" aria-labelledby="data" tabindex="0">
        <section class="advanced-section" aria-labelledby="backup-restore-heading">
          <div class="section-heading">
            <h3 id="backup-restore-heading" class="subsection-title">
              Backup &amp; restore
            </h3>
          </div>
          <div class="settings-list-card backup-card">
            <div class="setting-row export-import-section">
              <div class="setting-info">
                <h3 class="setting-label">Export or import settings</h3>
                <p class="setting-description">
                  Save portable settings to a file. Credentials, paired devices,
                  local paths, and machine identities are excluded.
                </p>
              </div>
              <div class="setting-control button-group">
                <button
                  class="btn-secondary"
                  (click)="doExport()"
                  [disabled]="exportImportWorking()"
                >
                  Export
                </button>
                <button
                  class="btn-primary"
                  (click)="doImport()"
                  [disabled]="exportImportWorking()"
                >
                  Import
                </button>
              </div>
            </div>
          </div>
          @if (exportImportMessage()) {
            <div
              class="export-import-result"
              [class.success]="exportImportSuccess()"
              [class.error]="!exportImportSuccess()"
              [attr.role]="exportImportSuccess() ? 'status' : 'alert'"
              [attr.aria-live]="exportImportSuccess() ? 'polite' : null"
            >
              {{ exportImportMessage() }}
            </div>
          }
        </section>

        <app-danger-zone
          title="Reset all settings"
          description="Restore app settings to their defaults on this machine. This does not delete conversation history or workspace files."
        >
          <div class="setting-row reset-section">
            <div class="setting-control button-group">
              <button
                class="btn-danger"
                type="button"
                (click)="doResetAll()"
                [disabled]="exportImportWorking()"
              >
                Reset all
              </button>
            </div>
          </div>
        </app-danger-zone>
      </div>
    }
  `,
  styleUrl: './advanced-settings-tab.component.scss',
})
export class AdvancedSettingsTabComponent {
  store = inject(SettingsStore);

  /** Read a value by key. A bound arrow so the template can pass it as a value. */
  protected readonly readSetting = (key: string): unknown =>
    this.store.get(key as keyof AppSettings);
  private settingsIpc = inject(SettingsIpcService);
  private browserGatewayIpc = inject(BrowserGatewayIpcService);

  readonly sectionTabs = ADVANCED_SECTION_TABS;
  readonly activeSection = signal<AdvancedSection>('runtime');

  onSectionChange(id: string): void {
    if (id === 'runtime' || id === 'security' || id === 'data') {
      this.activeSection.set(id);
    }
  }

  /** Section id whose chrome-devtools profile row gets the managed-profile dropdown. */
  readonly chromeDevtoolsSectionId = 'chrome-devtools-attach-heading';
  private static readonly CHROME_DEVTOOLS_PROFILE_KEY: keyof AppSettings =
    'chromeDevtoolsAttachProfileId';

  private readonly advancedSectionViews = computed<AdvancedSectionView[]>(() => {
    const settings = this.store.advancedSettings();
    const byKey = new Map(settings.map((setting) => [setting.key, setting]));
    const groupedKeys = new Set<keyof AppSettings>();

    const sections = ADVANCED_SECTION_DEFINITIONS
      .map((section) => {
        const sectionSettings = section.keys
          .map((key) => {
            groupedKeys.add(key);
            return byKey.get(key);
          })
          .filter((setting): setting is SettingMetadata => setting !== undefined);

        return {
          id: section.id,
          title: section.title,
          description: section.description,
          settings: sectionSettings,
          group: section.group,
          dangerous: section.dangerous,
        };
      })
      .filter((section) => section.settings.length > 0);

    const uncategorized = settings.filter((setting) => !groupedKeys.has(setting.key));
    if (uncategorized.length === 0) {
      return sections;
    }

    // Safety net: a newly-added advanced-category setting that hasn't been
    // filed into a card yet still surfaces here (in Runtime) instead of
    // silently vanishing from the UI.
    return [
      ...sections,
      {
        id: 'advanced-other-heading',
        title: 'Other advanced controls',
        description: 'Advanced settings not yet grouped into a section above.',
        settings: uncategorized,
        group: 'runtime' as const,
        dangerous: false,
      },
    ];
  });

  readonly runtimeSections = computed(() =>
    this.advancedSectionViews().filter((section) => section.group === 'runtime'),
  );
  readonly securitySections = computed(() =>
    this.advancedSectionViews().filter((section) => section.group === 'security' && !section.dangerous),
  );
  readonly securityDangerousSections = computed(() =>
    this.advancedSectionViews().filter((section) => section.group === 'security' && section.dangerous),
  );

  hookApprovals = signal<HookApprovalSummary[]>([]);
  hookApprovalsLoading = signal(false);
  hookApprovalsError = signal<string | null>(null);

  // Managed browser profiles for the chrome-devtools attach dropdown
  browserProfiles = signal<BrowserProfile[]>([]);
  browserProfilesLoading = signal(false);
  browserProfilesError = signal<string | null>(null);

  /** Options for the chrome-devtools managed-profile dropdown. */
  readonly profileOptions = computed<{ value: string; label: string }[]>(() => {
    const options: { value: string; label: string }[] = [
      { value: '', label: 'None — attach disabled' },
    ];
    for (const profile of this.browserProfiles()) {
      options.push({
        value: profile.id,
        label:
          profile.status === 'running'
            ? `${profile.label} · running`
            : profile.label,
      });
    }
    return options;
  });

  // Export / Import state
  exportImportWorking = signal(false);
  exportImportMessage = signal<string | null>(null);
  exportImportSuccess = signal(false);

  private initialized = false;

  constructor() {
    // Load hook approvals + managed browser profiles on first render
    effect(() => {
      if (!this.initialized) {
        this.initialized = true;
        void this.loadHookApprovals();
        void this.loadBrowserProfiles();
      }
    });
  }

  onSettingChange(event: { key: string; value: unknown }): void {
    this.store.set(event.key as keyof AppSettings, event.value as AppSettings[keyof AppSettings]);
  }

  /** Runtime-loaded dropdown options for settings whose choices aren't static. */
  dynamicOptionsFor(key: keyof AppSettings): { value: string; label: string }[] | null {
    return key === AdvancedSettingsTabComponent.CHROME_DEVTOOLS_PROFILE_KEY
      ? this.profileOptions()
      : null;
  }

  async loadBrowserProfiles(): Promise<void> {
    this.browserProfilesLoading.set(true);
    this.browserProfilesError.set(null);
    try {
      const response = await this.browserGatewayIpc.listProfiles();
      if (response.success) {
        const profiles = response.data?.data;
        this.browserProfiles.set(Array.isArray(profiles) ? profiles : []);
      } else {
        this.browserProfilesError.set(
          response.error?.message || 'Failed to load browser profiles',
        );
      }
    } catch (error) {
      this.browserProfilesError.set((error as Error).message);
    } finally {
      this.browserProfilesLoading.set(false);
    }
  }

  async loadHookApprovals(): Promise<void> {
    const api = getApi();
    if (!api?.hooksApprovalsList) return;

    this.hookApprovalsLoading.set(true);
    this.hookApprovalsError.set(null);
    try {
      const response = await api.hooksApprovalsList({ pendingOnly: false });
      if (response.success) {
        this.hookApprovals.set((response.data || []) as HookApprovalSummary[]);
      } else {
        this.hookApprovalsError.set(
          response.error?.message || 'Failed to load approvals'
        );
      }
    } catch (error) {
      this.hookApprovalsError.set((error as Error).message);
    } finally {
      this.hookApprovalsLoading.set(false);
    }
  }

  async updateHookApproval(hookId: string, approved: boolean): Promise<void> {
    const api = getApi();
    if (!api?.hooksApprovalsUpdate) return;

    this.hookApprovalsLoading.set(true);
    this.hookApprovalsError.set(null);
    try {
      const response = await api.hooksApprovalsUpdate({ hookId, approved });
      if (response.success) {
        await this.loadHookApprovals();
      } else {
        this.hookApprovalsError.set(
          response.error?.message || 'Failed to update approval'
        );
      }
    } catch (error) {
      this.hookApprovalsError.set((error as Error).message);
    } finally {
      this.hookApprovalsLoading.set(false);
    }
  }

  async clearHookApprovals(): Promise<void> {
    const api = getApi();
    if (!api?.hooksApprovalsClear) return;

    this.hookApprovalsLoading.set(true);
    this.hookApprovalsError.set(null);
    try {
      const response = await api.hooksApprovalsClear();
      if (response.success) {
        await this.loadHookApprovals();
      } else {
        this.hookApprovalsError.set(
          response.error?.message || 'Failed to clear approvals'
        );
      }
    } catch (error) {
      this.hookApprovalsError.set((error as Error).message);
    } finally {
      this.hookApprovalsLoading.set(false);
    }
  }

  async openDocsFile(filename: string): Promise<void> {
    const api = getApi();
    if (!api?.openDocsFile) {
      console.warn('API not available for opening docs');
      return;
    }

    try {
      const result = await api.openDocsFile(filename);
      if (!result.success) {
        console.error('Failed to open docs file:', result.error?.message);
      }
    } catch (error) {
      console.error('Failed to open docs file:', error);
    }
  }

  async doExport(): Promise<void> {
    this.exportImportWorking.set(true);
    this.exportImportMessage.set(null);
    try {
      const res = await this.settingsIpc.exportSettings();
      if (res.success) {
        const data = res.data as { cancelled?: boolean; filePath?: string };
        if (data?.cancelled) {
          // User cancelled the dialog — no message needed
        } else {
          this.exportImportSuccess.set(true);
          this.exportImportMessage.set(`Portable settings exported to ${data?.filePath}`);
        }
      } else {
        this.exportImportSuccess.set(false);
        this.exportImportMessage.set(res.error?.message ?? 'Export failed');
      }
    } catch (err) {
      this.exportImportSuccess.set(false);
      this.exportImportMessage.set((err as Error).message);
    } finally {
      this.exportImportWorking.set(false);
    }
  }

  async doImport(): Promise<void> {
    this.exportImportWorking.set(true);
    this.exportImportMessage.set(null);
    try {
      const res = await this.settingsIpc.importSettings();
      if (res.success) {
        const data = res.data as {
          cancelled?: boolean;
          settingsRestored?: boolean;
          settingsImported?: number;
          settingsSkipped?: number;
        };
        if (data?.cancelled) {
          // User cancelled the dialog — no message needed
        } else {
          this.exportImportSuccess.set(true);
          const parts: string[] = [];
          if (data?.settingsRestored) parts.push(`${data.settingsImported ?? 0} setting(s)`);
          if (data?.settingsSkipped) parts.push(`${data.settingsSkipped} skipped`);
          this.exportImportMessage.set(
            parts.length > 0
              ? `Imported: ${parts.join(', ')}.`
              : 'Import completed (no data found in file).'
          );
          // Reload settings in the store so UI reflects new values
          void this.store.reload();
        }
      } else {
        this.exportImportSuccess.set(false);
        this.exportImportMessage.set(res.error?.message ?? 'Import failed');
      }
    } catch (err) {
      this.exportImportSuccess.set(false);
      this.exportImportMessage.set((err as Error).message);
    } finally {
      this.exportImportWorking.set(false);
    }
  }

  async doResetAll(): Promise<void> {
    if (!confirm('Reset all settings to their defaults on this machine?')) {
      return;
    }

    this.exportImportWorking.set(true);
    this.exportImportMessage.set(null);
    try {
      await this.store.reset();
      this.exportImportSuccess.set(true);
      this.exportImportMessage.set('Settings reset to defaults.');
    } catch (error) {
      this.exportImportSuccess.set(false);
      this.exportImportMessage.set((error as Error).message);
    } finally {
      this.exportImportWorking.set(false);
    }
  }
}
