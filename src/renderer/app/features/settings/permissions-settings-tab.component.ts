import { ChangeDetectionStrategy, Component, computed, inject, signal, effect } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SecurityIpcService, type ShadowedRuleFindingDto } from '../../core/services/ipc/security-ipc.service';
import { TaskIpcService } from '../../core/services/ipc/task-ipc.service';
import { TaskPreflightCardComponent } from '../../shared/components/task-preflight-card.component';
import type { TaskPreflightReport } from '../../../../shared/types/task-preflight.types';
import { SaveStateBannerComponent, type SaveState } from './ui/save-state-banner.component';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { SettingsSectionTabsComponent } from './ui/settings-section-tabs.component';
import type { SettingsSectionTab } from './settings-navigation';
import {
  getApi,
  type PermissionsSection,
  type PendingPermission,
  type LearnedPattern,
  type PermissionStats,
  type PermissionDecisionAuditRecord,
  type PermissionDenialAuditRecord,
  type PermissionAuditResponse,
} from './permissions-settings-tab.types';

export type { PermissionsSection };

@Component({
  selector: 'app-permissions-settings-tab',
  standalone: true,
  imports: [
    TaskPreflightCardComponent,
    SaveStateBannerComponent,
    AioTooltipDirective,
    SettingsSectionTabsComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './permissions-settings-tab.component.html',
  styleUrl: './permissions-settings-tab.component.scss',
})
export class PermissionsSettingsTabComponent {
  store = inject(SettingsStore);
  private readonly securityIpc = inject(SecurityIpcService);
  private readonly taskIpc = inject(TaskIpcService);

  loading = signal(false);
  presetLoading = signal(false);
  pendingPermissions = signal<PendingPermission[]>([]);
  learnedPatterns = signal<LearnedPattern[]>([]);
  batchScope = signal<'once' | 'session' | 'always'>('session');
  permissionPreset = signal<'allow' | 'ask' | 'deny'>('ask');
  draftPermissionPreset = signal<'allow' | 'ask' | 'deny'>('ask');
  defaultWorkspacePreflight = signal<TaskPreflightReport | null>(null);
  presetSaving = signal(false);
  permissionPresetDirty = computed(() => this.draftPermissionPreset() !== this.permissionPreset());
  permissionPresetSaveState = computed<SaveState>(() => {
    if (this.presetSaving()) {
      return 'saving';
    }
    return this.permissionPresetDirty() ? 'dirty' : 'saved';
  });

  stats = signal<PermissionStats>({
    totalPatterns: 0,
    approvedPatterns: 0,
    pendingPatterns: 0,
    suggestionsMade: 0,
    suggestionsAccepted: 0,
    accuracyRate: 0,
    ruleSetCount: 0,
    totalRules: 0,
    cacheSize: 0,
    cacheHitRate: 0,
  });
  permissionAuditInstanceId = signal('');
  permissionAuditDecisions = signal<PermissionDecisionAuditRecord[]>([]);
  permissionAuditDenials = signal<PermissionDenialAuditRecord[]>([]);

  shadowedRuleFindings = signal<ShadowedRuleFindingDto[]>([]);
  shadowedRulesLoading = signal(false);

  /** Active view. `chooseInitialSection()` sets this once after first load; later refreshes never move it. */
  readonly activeSection = signal<PermissionsSection>('rules');

  readonly sectionTabs = computed<SettingsSectionTab[]>(() => {
    const pendingCount = this.pendingPermissions().length;
    return [
      {
        id: 'requests',
        label: 'Requests',
        panelId: 'permissions-panel-requests',
        badge: pendingCount > 0 ? String(pendingCount) : undefined,
      },
      { id: 'rules', label: 'Rules', panelId: 'permissions-panel-rules' },
      { id: 'audit', label: 'Audit', panelId: 'permissions-panel-audit' },
      { id: 'insights', label: 'Insights', panelId: 'permissions-panel-insights' },
    ];
  });

  /** Current-request-only warning, replacing the always-on browser education cards (moved to Help). */
  readonly pendingBrowserWarning = computed(() => {
    const hasBrowserRequest = this.pendingPermissions().some((permission) =>
      /browser/i.test(permission.toolName ?? '')
    );
    return hasBrowserRequest
      ? 'One or more pending requests use a browser tool, which can navigate, click, and read page content. Only approve tools you recognise.'
      : null;
  });

  private initialized = false;
  private sectionChosen = false;

  constructor() {
    effect(() => {
      if (!this.initialized) {
        this.initialized = true;
        void this.loadAll();
      }
    });

    effect(() => {
      const workingDirectory = this.store.defaultWorkingDirectory();
      if (!this.initialized) {
        return;
      }

      if (!workingDirectory) {
        this.defaultWorkspacePreflight.set(null);
        return;
      }

      void this.refreshDefaultWorkspacePreflight();
    });
  }

  async loadAll(): Promise<void> {
    await Promise.all([
      this.loadPendingPermissions(),
      this.loadLearnedPatterns(),
      this.loadStats(),
      this.loadPermissionPreset(),
      this.loadPermissionAudit(),
      this.loadShadowedRuleFindings(),
    ]);
    this.chooseInitialSection();
  }

  /** Selects the initial section exactly once, giving Requests priority only if it was already non-empty. */
  private chooseInitialSection(): void {
    if (this.sectionChosen) {
      return;
    }
    this.sectionChosen = true;
    if (this.pendingPermissions().length > 0) {
      this.activeSection.set('requests');
    }
  }

  onSectionChange(id: string): void {
    this.activeSection.set(id as PermissionsSection);
  }

  async loadShadowedRuleFindings(): Promise<void> {
    this.shadowedRulesLoading.set(true);
    try {
      const response = await this.securityIpc.permissionAnalyzeShadowedRules();
      if (response.success) {
        this.shadowedRuleFindings.set(response.data?.findings ?? []);
      }
    } catch (error) {
      console.error('Failed to load rule analysis:', error);
    } finally {
      this.shadowedRulesLoading.set(false);
    }
  }

  async loadPermissionPreset(): Promise<void> {
    this.presetLoading.set(true);
    try {
      const response = await this.securityIpc.securityGetPermissionConfig();
      if (response.success && response.data?.config) {
        this.permissionPreset.set(response.data.config.defaultAction);
        this.draftPermissionPreset.set(response.data.config.defaultAction);
      }
      await this.refreshDefaultWorkspacePreflight();
    } finally {
      this.presetLoading.set(false);
    }
  }

  async loadPendingPermissions(): Promise<void> {
    const api = getApi();
    if (!api?.permissionGetPendingBatch) return;

    this.loading.set(true);
    try {
      const response = await api.permissionGetPendingBatch();
      if (response.success && response.data?.requests) {
        this.pendingPermissions.set(
          response.data.requests.map((r: unknown) => {
            const request = r as {
              id: string;
              scope: string;
              resource: string;
              context?: { toolName?: string };
              timestamp: number;
            };
            return {
              id: request.id,
              scope: request.scope,
              resource: request.resource,
              toolName: request.context?.toolName,
              timestamp: request.timestamp,
            };
          })
        );
      }
    } catch (error) {
      console.error('Failed to load pending permissions:', error);
    } finally {
      this.loading.set(false);
    }
  }

  async loadLearnedPatterns(): Promise<void> {
    const api = getApi();
    if (!api?.permissionGetLearnedPatterns) return;

    this.loading.set(true);
    try {
      const response = await api.permissionGetLearnedPatterns();
      if (response.success) {
        this.learnedPatterns.set(response.data || []);
      }
    } catch (error) {
      console.error('Failed to load learned patterns:', error);
    } finally {
      this.loading.set(false);
    }
  }

  async loadStats(): Promise<void> {
    const api = getApi();
    if (!api?.permissionGetStats) return;

    try {
      const response = await api.permissionGetStats();
      if (response.success) {
        this.stats.set({
          ...this.stats(),
          ...response.data,
        });
      }
    } catch (error) {
      console.error('Failed to load stats:', error);
    }
  }

  async loadPermissionAudit(): Promise<void> {
    const instanceId = this.permissionAuditInstanceId().trim() || undefined;
    try {
      const response = await this.securityIpc.permissionGetAuditLog(instanceId, 50);
      if (response.success) {
        const data = response.data as PermissionAuditResponse | undefined;
        this.permissionAuditDecisions.set(data?.decisions ?? []);
        this.permissionAuditDenials.set(data?.denials ?? []);
      }
    } catch (error) {
      console.error('Failed to load permission audit:', error);
    }
  }

  updatePermissionAuditInstanceId(value: string): void {
    this.permissionAuditInstanceId.set(value);
  }

  formatAuditTimestamp(value: string | number): string {
    const timestamp = typeof value === 'number' ? value : Date.parse(value);
    if (!Number.isFinite(timestamp)) {
      return String(value);
    }
    return new Date(timestamp).toLocaleString();
  }

  async handleBatchDecision(
    action: 'allow_all' | 'deny_all'
  ): Promise<void> {
    const api = getApi();
    if (!api?.permissionRecordBatchDecision) return;

    this.loading.set(true);
    try {
      const response = await api.permissionRecordBatchDecision({
        action,
        scope: this.batchScope(),
      });
      if (response.success) {
        await this.loadPendingPermissions();
        await this.loadStats();
      }
    } catch (error) {
      console.error('Failed to record batch decision:', error);
    } finally {
      this.loading.set(false);
    }
  }

  async handleSingleDecision(
    permission: PendingPermission,
    action: 'allow' | 'deny'
  ): Promise<void> {
    const api = getApi();
    if (!api?.permissionRecordDecision) return;

    this.loading.set(true);
    try {
      const response = await api.permissionRecordDecision({
        requestId: permission.id,
        action,
        scope: this.batchScope(),
      });
      if (response.success) {
        this.pendingPermissions.update((permissions) =>
          permissions.filter((p) => p.id !== permission.id)
        );
        await this.loadStats();
      }
    } catch (error) {
      console.error('Failed to record decision:', error);
    } finally {
      this.loading.set(false);
    }
  }

  async approvePattern(patternId: string): Promise<void> {
    const api = getApi();
    if (!api?.permissionApprovePattern) return;

    this.loading.set(true);
    try {
      const response = await api.permissionApprovePattern({ patternId });
      if (response.success) {
        await this.loadLearnedPatterns();
        await this.loadStats();
      }
    } catch (error) {
      console.error('Failed to approve pattern:', error);
    } finally {
      this.loading.set(false);
    }
  }

  async rejectPattern(patternId: string): Promise<void> {
    const api = getApi();
    if (!api?.permissionRejectPattern) return;

    this.loading.set(true);
    try {
      const response = await api.permissionRejectPattern({ patternId });
      if (response.success) {
        await this.loadLearnedPatterns();
        await this.loadStats();
      }
    } catch (error) {
      console.error('Failed to reject pattern:', error);
    } finally {
      this.loading.set(false);
    }
  }

  setDraftPermissionPreset(value: 'allow' | 'ask' | 'deny'): void {
    this.draftPermissionPreset.set(value);
  }

  async applyPermissionPreset(): Promise<void> {
    if (!this.permissionPresetDirty()) {
      return;
    }
    this.presetSaving.set(true);
    try {
      const response = await this.securityIpc.securitySetPermissionPreset(this.draftPermissionPreset());
      if (response.success && response.data?.config) {
        this.permissionPreset.set(response.data.config.defaultAction);
        this.draftPermissionPreset.set(response.data.config.defaultAction);
        await this.loadStats();
        await this.refreshDefaultWorkspacePreflight();
      }
    } finally {
      this.presetSaving.set(false);
    }
  }

  discardPermissionPreset(): void {
    this.draftPermissionPreset.set(this.permissionPreset());
  }

  private async refreshDefaultWorkspacePreflight(): Promise<void> {
    const workingDirectory = this.store.defaultWorkingDirectory()?.trim();
    if (!workingDirectory) {
      this.defaultWorkspacePreflight.set(null);
      this.presetLoading.set(false);
      return;
    }

    try {
      const response = await Promise.race([
        this.taskIpc.taskGetPreflight({
          workingDirectory,
          surface: 'repo-job',
          taskType: 'default-workspace',
          requiresWrite: true,
          requiresNetwork: true,
        }),
        new Promise<{ success: false; error: { message: string } }>((resolve) =>
          setTimeout(() => resolve({ success: false, error: { message: 'Preflight timed out' } }), 5000)
        ),
      ]);

      if (response.success && 'data' in response && response.data) {
        this.defaultWorkspacePreflight.set(response.data as TaskPreflightReport);
        return;
      }
    } catch (error) {
      console.warn('Preflight check failed:', error);
    }

    this.defaultWorkspacePreflight.set(null);
  }
}
