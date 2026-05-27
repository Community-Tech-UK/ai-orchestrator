/**
 * Advanced Settings Tab Component - Advanced options, hook approvals, setup guides
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
  effect,
} from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SettingsIpcService } from '../../core/services/ipc/settings-ipc.service';
import { SettingRowComponent } from './setting-row.component';
import { SettingsNavIconComponent } from './ui/settings-nav-icon.component';
import type { AppSettings } from '../../../../shared/types/settings.types';
import type { SettingMetadata } from '../../../../shared/types/settings-metadata.types';

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

interface AdvancedSectionDefinition {
  id: string;
  title: string;
  description: string;
  keys: readonly (keyof AppSettings)[];
}

interface AdvancedSection {
  id: string;
  title: string;
  description: string;
  settings: SettingMetadata[];
}

@Component({
  selector: 'app-advanced-settings-tab',
  changeDetection: ChangeDetectionStrategy.OnPush,
  standalone: true,
  imports: [SettingRowComponent, SettingsNavIconComponent],
  template: `
    @for (section of advancedSections(); track section.id) {
      <section
        class="advanced-section"
        [attr.aria-labelledby]="section.id"
      >
        <div class="section-heading">
          <h3 [id]="section.id" class="subsection-title">
            {{ section.title }}
          </h3>
          <p class="section-description">{{ section.description }}</p>
        </div>
        <div class="settings-list-card">
          @for (setting of section.settings; track setting.key) {
            <app-setting-row
              class="settings-list-item"
              [setting]="setting"
              [value]="store.get(setting.key)"
              (valueChange)="onSettingChange($event)"
            />
          }
        </div>
      </section>
    }

    <section
      class="advanced-section"
      aria-labelledby="mcp-safety-heading"
      data-test="settings-section-mcp"
    >
      <div class="section-heading">
        <h3 id="mcp-safety-heading" class="subsection-title">MCP safety</h3>
        <p class="section-description">
          Controls for provider config backups and filesystem write guards.
        </p>
      </div>
      <div class="settings-list-card">
        @for (setting of store.mcpSettings(); track setting.key) {
          <app-setting-row
            class="settings-list-item"
            [setting]="setting"
            [value]="store.get(setting.key)"
            (valueChange)="onSettingChange($event)"
          />
        }
      </div>
    </section>

    <section class="advanced-section" aria-labelledby="hook-approvals-heading">
      <div class="section-heading-row">
        <div class="section-heading">
          <h3 id="hook-approvals-heading" class="subsection-title">
            Hook approvals
          </h3>
          <p class="section-description">
            Review hooks that require approval before they run and manage
            remembered approvals.
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
            <div class="hook-approvals-empty">Loading approvals...</div>
          } @else if (hookApprovalsError()) {
            <div class="hook-approvals-empty error">
              {{ hookApprovalsError() }}
            </div>
          } @else if (hookApprovals().length === 0) {
            <div class="hook-approvals-empty">No hook approvals to review.</div>
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

    <section class="advanced-section" aria-labelledby="setup-guides-heading">
      <div class="section-heading">
        <h3 id="setup-guides-heading" class="subsection-title">Setup guides</h3>
        <p class="section-description">
          Open setup docs for advanced integrations and local tooling.
        </p>
      </div>
      <div class="settings-list-card guide-card">
        <button
          class="guide-link"
          (click)="openDocsFile('BROWSER_AUTOMATION_SETUP.md')"
          title="Learn how to enable browser automation for child instances"
        >
          <span class="guide-icon">
            <app-settings-nav-icon name="network" />
          </span>
          <span class="guide-text">
            <span class="guide-title">Browser automation</span>
            <span class="guide-desc"
              >Enable Chrome DevTools MCP for child instances</span
            >
          </span>
        </button>
      </div>
    </section>

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
              Back up your settings, channel credentials, paired senders, and remote
              node identities to a JSON file. Restore them after reinstalling.
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
        >
          {{ exportImportMessage() }}
        </div>
      }
    </section>

    <section class="advanced-section" aria-labelledby="planned-settings-heading">
      <div class="future-settings-note">
        <h3 id="planned-settings-heading" class="subsection-title">
          Planned settings
        </h3>
        <ul>
          <li>Session auto-save/restore</li>
          <li>Notification preferences</li>
          <li>Per-project settings</li>
        </ul>
      </div>
    </section>
  `,
  styleUrl: './advanced-settings-tab.component.scss',
})
export class AdvancedSettingsTabComponent {
  store = inject(SettingsStore);
  private settingsIpc = inject(SettingsIpcService);

  private readonly advancedSectionDefinitions: readonly AdvancedSectionDefinition[] = [
    {
      id: 'runtime-controls-heading',
      title: 'Runtime controls',
      description: 'Low-level model, parser, diagnostics, and instruction-scan limits.',
      keys: [
        'customModelOverride',
        'parserBufferMaxKB',
        'commandDiagnosticsAvailable',
        'broadRootFileThreshold',
      ],
    },
    {
      id: 'codemem-indexing-heading',
      title: 'Codemem indexing',
      description: 'Persistent code memory and workspace warm-up behavior.',
      keys: [
        'codememEnabled',
        'codememIndexingEnabled',
        'codememLspWorkerEnabled',
        'codememPrewarmEnabled',
        'codememPrewarmMaxConcurrent',
        'codememPrewarmDebounceMs',
        'codememPrewarmStartupHint',
      ],
    },
    {
      id: 'legacy-codebase-index-heading',
      title: 'Legacy codebase auto-index',
      description: 'Heavier BM25 and embedding indexing controls for the legacy search path.',
      keys: [
        'codebaseAutoIndexEnabled',
        'codebaseAutoIndexMaxFiles',
        'codebaseAutoIndexMaxBytes',
        'codebaseAutoIndexConcurrent',
        'codebaseAutoIndexDebounceMs',
        'codebaseAutoIndexStartupHint',
      ],
    },
    {
      id: 'project-knowledge-mirror-heading',
      title: 'Project knowledge mirror',
      description: 'Automatic mirroring from codemem into the project-knowledge graph.',
      keys: [
        'projectKnowledgeAutoMirrorEnabled',
        'projectKnowledgeAutoMirrorDebounceMs',
        'projectKnowledgeAutoMirrorMaxConcurrent',
        'projectKnowledgeAutoMirrorSkipWithinMs',
        'projectKnowledgeAutoMirrorStartupHint',
      ],
    },
  ];

  readonly advancedSections = computed<AdvancedSection[]>(() => {
    const settings = this.store.advancedSettings();
    const byKey = new Map(settings.map((setting) => [setting.key, setting]));
    const groupedKeys = new Set<keyof AppSettings>();

    const sections = this.advancedSectionDefinitions
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
        };
      })
      .filter((section) => section.settings.length > 0);

    const uncategorized = settings.filter((setting) => !groupedKeys.has(setting.key));
    if (uncategorized.length === 0) {
      return sections;
    }

    return [
      ...sections,
      {
        id: 'advanced-other-heading',
        title: 'Other advanced controls',
        description: 'New advanced settings that have not been assigned to a subsection yet.',
        settings: uncategorized,
      },
    ];
  });

  hookApprovals = signal<HookApprovalSummary[]>([]);
  hookApprovalsLoading = signal(false);
  hookApprovalsError = signal<string | null>(null);

  // Export / Import state
  exportImportWorking = signal(false);
  exportImportMessage = signal<string | null>(null);
  exportImportSuccess = signal(false);

  private initialized = false;

  constructor() {
    // Load hook approvals on first render
    effect(() => {
      if (!this.initialized) {
        this.initialized = true;
        void this.loadHookApprovals();
      }
    });
  }

  onSettingChange(event: { key: string; value: unknown }): void {
    this.store.set(event.key as keyof AppSettings, event.value as AppSettings[keyof AppSettings]);
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
          this.exportImportMessage.set(`Settings exported to ${data?.filePath}`);
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
          credentialsRestored?: number;
          policiesRestored?: number;
          remoteNodesRestored?: boolean;
        };
        if (data?.cancelled) {
          // User cancelled the dialog — no message needed
        } else {
          this.exportImportSuccess.set(true);
          const parts: string[] = [];
          if (data?.settingsRestored) parts.push('app settings');
          if (data?.credentialsRestored) parts.push(`${data.credentialsRestored} channel credential(s)`);
          if (data?.policiesRestored) parts.push(`${data.policiesRestored} access policy/ies`);
          if (data?.remoteNodesRestored) parts.push('remote node identities');
          this.exportImportMessage.set(
            parts.length > 0
              ? `Imported: ${parts.join(', ')}. Restart the app to fully apply channel changes.`
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
}
