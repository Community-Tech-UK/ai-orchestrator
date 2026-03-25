/**
 * Permissions Settings Tab Component - Batch permissions and permission learning
 *
 * Phase 7 UI/UX Improvements:
 * - Batch permission handling (allow/deny multiple at once)
 * - Permission learning system (view learned patterns, approve/reject)
 * - Statistics on permission decisions
 */

import { ChangeDetectionStrategy, Component, inject, signal, effect } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { SecurityIpcService } from '../../core/services/ipc/security-ipc.service';
import { TaskIpcService } from '../../core/services/ipc/task-ipc.service';
import { TaskPreflightCardComponent } from '../../shared/components/task-preflight-card.component';
import type { TaskPreflightReport } from '../../../../shared/types/task-preflight.types';

interface PermissionsApi {
  permissionGetPendingBatch?: () => Promise<{ success: boolean; data?: { requests?: unknown[] } }>;
  permissionGetLearnedPatterns?: () => Promise<{ success: boolean; data?: LearnedPattern[] }>;
  permissionGetStats?: () => Promise<{ success: boolean; data?: Partial<PermissionStats> }>;
  permissionRecordBatchDecision?: (params: { action: string; scope: string }) => Promise<{ success: boolean }>;
  permissionRecordDecision?: (params: { requestId: string; action: string; scope: string }) => Promise<{ success: boolean }>;
  permissionApprovePattern?: (params: { patternId: string }) => Promise<{ success: boolean }>;
  permissionRejectPattern?: (params: { patternId: string }) => Promise<{ success: boolean }>;
}

// Helper to access API from preload
const getApi = () => (window as unknown as { electronAPI?: PermissionsApi }).electronAPI;

interface PendingPermission {
  id: string;
  scope: string;
  resource: string;
  toolName?: string;
  timestamp: number;
}

interface LearnedPattern {
  id: string;
  scope: string;
  pattern: string;
  recommendedAction: 'allow' | 'deny';
  confidence: number;
  sampleCount: number;
  lastUpdated: number;
  approved: boolean;
}

interface PermissionStats {
  totalPatterns: number;
  approvedPatterns: number;
  pendingPatterns: number;
  suggestionsMade: number;
  suggestionsAccepted: number;
  accuracyRate: number;
  ruleSetCount: number;
  totalRules: number;
  cacheSize: number;
  cacheHitRate: number;
}

@Component({
  selector: 'app-permissions-settings-tab',
  standalone: true,
  imports: [TaskPreflightCardComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="section">
      <div class="section-header">
        <h4>Permission Preset</h4>
        <div class="header-actions">
          <button class="btn-secondary" (click)="loadPermissionPreset()" [disabled]="loading()">
            Refresh
          </button>
        </div>
      </div>

      <p class="section-description">
        Choose how unmatched filesystem and network actions are handled before a rule or user decision applies.
      </p>

      <div class="preset-row">
        <label class="preset-field">
          <span>Default preset</span>
          <select
            class="scope-select"
            [value]="permissionPreset()"
            (change)="updatePermissionPreset($any($event.target).value)"
          >
            <option value="allow">Allow by default</option>
            <option value="ask">Ask before action</option>
            <option value="deny">Deny by default</option>
          </select>
        </label>

        <div class="preset-meta">
          <span class="stat-label">Current mode</span>
          <strong>{{ permissionPreset() }}</strong>
        </div>
      </div>

      @if (defaultWorkspacePreflight()) {
        <div class="preflight-wrapper">
          <app-task-preflight-card
            [report]="defaultWorkspacePreflight()"
            [loading]="presetLoading()"
            title="Default Workspace Preflight"
            subtitle="How the current preset and workspace defaults will affect a typical repo-backed task."
            emptyMessage="Set a default working directory to inspect workspace readiness here."
          />
        </div>
      } @else if (store.defaultWorkingDirectory()) {
        <div class="preflight-wrapper">
          <app-task-preflight-card
            [report]="defaultWorkspacePreflight()"
            [loading]="presetLoading()"
            title="Default Workspace Preflight"
            subtitle="How the current preset and workspace defaults will affect a typical repo-backed task."
            emptyMessage="Checking the configured default workspace."
          />
        </div>
      } @else {
        <p class="section-description">Set a default working directory in general settings to preview policy impact here.</p>
      }
    </div>

    <div class="section">
      <div class="section-header">
        <h4>Browser Automation Permissions</h4>
      </div>

      <p class="section-description">
        Browser automation uses an MCP server plus a local browser runtime. Expect broader filesystem
        and network access than a normal read-only tool flow, especially when the browser is launched
        with a reusable profile or remote debugging enabled.
      </p>

      <div class="permission-guidance">
        <div class="guidance-card">
          <strong>Use a separate browser profile</strong>
          <span>Keep authenticated sessions isolated from your personal Chrome profile.</span>
        </div>
        <div class="guidance-card">
          <strong>Prefer scoped MCP approvals</strong>
          <span>Grant session-level approval first, then promote to a persistent rule only after review.</span>
        </div>
        <div class="guidance-card">
          <strong>Verify the MCP source</strong>
          <span>Only approve browser servers you recognize, since they can navigate, click, and inspect page content.</span>
        </div>
      </div>
    </div>

    <!-- Pending Batch Permissions Section -->
    <div class="section">
      <div class="section-header">
        <h4>Pending Permissions</h4>
        <div class="header-actions">
          <button
            class="btn-secondary"
            (click)="loadPendingPermissions()"
            [disabled]="loading()"
          >
            Refresh
          </button>
        </div>
      </div>

      @if (loading()) {
        <div class="loading-state">Loading...</div>
      } @else if (pendingPermissions().length === 0) {
        <div class="empty-state">
          <span class="empty-icon">&#10003;</span>
          <span>No pending permissions</span>
        </div>
      } @else {
        <div class="batch-actions">
          <button
            class="btn-allow"
            (click)="handleBatchDecision('allow_all')"
            [disabled]="loading()"
          >
            Allow All ({{ pendingPermissions().length }})
          </button>
          <button
            class="btn-deny"
            (click)="handleBatchDecision('deny_all')"
            [disabled]="loading()"
          >
            Deny All
          </button>
          <select
            class="scope-select"
            [value]="batchScope()"
            (change)="batchScope.set($any($event.target).value)"
          >
            <option value="once">This time only</option>
            <option value="session">This session</option>
            <option value="always">Always</option>
          </select>
        </div>

        <div class="permissions-list">
          @for (permission of pendingPermissions(); track permission.id) {
            <div class="permission-row">
              <div class="permission-info">
                <span class="permission-scope">{{ permission.scope }}</span>
                <span class="permission-resource">{{ permission.resource }}</span>
                @if (permission.toolName) {
                  <span class="permission-tool">via {{ permission.toolName }}</span>
                }
              </div>
              <div class="permission-actions">
                <button
                  class="btn-allow-sm"
                  (click)="handleSingleDecision(permission, 'allow')"
                  [disabled]="loading()"
                  title="Allow"
                >
                  &#10003;
                </button>
                <button
                  class="btn-deny-sm"
                  (click)="handleSingleDecision(permission, 'deny')"
                  [disabled]="loading()"
                  title="Deny"
                >
                  &#10005;
                </button>
              </div>
            </div>
          }
        </div>
      }
    </div>

    <!-- Learned Patterns Section -->
    <div class="section">
      <div class="section-header">
        <h4>Learned Patterns</h4>
        <div class="header-actions">
          <button
            class="btn-secondary"
            (click)="loadLearnedPatterns()"
            [disabled]="loading()"
          >
            Refresh
          </button>
        </div>
      </div>

      <p class="section-description">
        The system learns from your permission decisions to suggest automatic
        rules. Review and approve patterns to reduce future prompts.
      </p>

      @if (loading()) {
        <div class="loading-state">Loading...</div>
      } @else if (learnedPatterns().length === 0) {
        <div class="empty-state">
          <span class="empty-icon">&#128218;</span>
          <span>No patterns learned yet</span>
        </div>
      } @else {
        <div class="patterns-list">
          @for (pattern of learnedPatterns(); track pattern.id) {
            <div class="pattern-row" [class.approved]="pattern.approved">
              <div class="pattern-info">
                <div class="pattern-header">
                  <span class="pattern-scope">{{ pattern.scope }}</span>
                  <span
                    class="pattern-action"
                    [class.allow]="pattern.recommendedAction === 'allow'"
                    [class.deny]="pattern.recommendedAction === 'deny'"
                  >
                    {{ pattern.recommendedAction }}
                  </span>
                  @if (pattern.approved) {
                    <span class="pattern-approved-badge">Approved</span>
                  }
                </div>
                <div class="pattern-details">
                  <code class="pattern-value">{{ pattern.pattern }}</code>
                </div>
                <div class="pattern-meta">
                  <span class="confidence">
                    {{ (pattern.confidence * 100).toFixed(0) }}% confidence
                  </span>
                  <span class="samples">{{ pattern.sampleCount }} decisions</span>
                </div>
              </div>
              <div class="pattern-actions">
                @if (!pattern.approved) {
                  <button
                    class="btn-approve"
                    (click)="approvePattern(pattern.id)"
                    [disabled]="loading()"
                    title="Approve and create rule"
                  >
                    Approve
                  </button>
                  <button
                    class="btn-reject"
                    (click)="rejectPattern(pattern.id)"
                    [disabled]="loading()"
                    title="Reject pattern"
                  >
                    Reject
                  </button>
                } @else {
                  <span class="approved-text">Active as rule</span>
                }
              </div>
            </div>
          }
        </div>
      }
    </div>

    <!-- Statistics Section -->
    <div class="section">
      <div class="section-header">
        <h4>Permission Statistics</h4>
      </div>

      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-value">{{ stats().totalRules }}</div>
          <div class="stat-label">Active Rules</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ stats().cacheSize }}</div>
          <div class="stat-label">Cached Decisions</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">{{ stats().approvedPatterns }}</div>
          <div class="stat-label">Learned Patterns</div>
        </div>
        <div class="stat-card">
          <div class="stat-value">
            {{ (stats().accuracyRate * 100).toFixed(0) }}%
          </div>
          <div class="stat-label">Suggestion Accuracy</div>
        </div>
      </div>

      <div class="learning-progress">
        <div class="progress-header">
          <span>Learning Progress</span>
          <span>
            {{ stats().suggestionsAccepted }} / {{ stats().suggestionsMade }}
            suggestions accepted
          </span>
        </div>
        <div class="progress-bar">
          <div
            class="progress-fill"
            [style.width.%]="stats().accuracyRate * 100"
          ></div>
        </div>
      </div>
    </div>
  `,
  styles: [
    `
      :host {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-lg);
      }

      .section {
        background: var(--bg-secondary);
        border-radius: var(--radius-md);
        padding: var(--spacing-md);
        border: 1px solid var(--border-color);
      }

      .section-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: var(--spacing-md);

        h4 {
          margin: 0;
          font-size: 14px;
          font-weight: 600;
          color: var(--text-primary);
        }
      }

      .header-actions {
        display: flex;
        gap: var(--spacing-xs);
      }

      .section-description {
        font-size: 12px;
        color: var(--text-secondary);
        margin: 0 0 var(--spacing-md);
        line-height: 1.4;
      }

      .preset-row {
        display: flex;
        gap: var(--spacing-md);
        align-items: end;
        margin-bottom: var(--spacing-md);
      }

      .preset-field,
      .preset-meta {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .preset-field {
        min-width: 220px;
      }

      .preset-field span {
        font-size: 12px;
        color: var(--text-muted);
      }

      .preset-meta strong {
        color: var(--text-primary);
        text-transform: uppercase;
      }

      .preflight-wrapper {
        margin-top: var(--spacing-sm);
      }

      .permission-guidance {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: var(--spacing-sm);
      }

      .guidance-card {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: var(--spacing-sm);
        background: var(--bg-tertiary);
        border: 1px solid var(--border-color);
        border-radius: var(--radius-sm);
        font-size: 12px;
        color: var(--text-secondary);
      }

      .guidance-card strong {
        color: var(--text-primary);
      }

      .loading-state,
      .empty-state {
        padding: var(--spacing-lg);
        text-align: center;
        color: var(--text-muted);
        font-size: 13px;
      }

      .empty-state {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .empty-icon {
        font-size: 24px;
        opacity: 0.5;
      }

      .batch-actions {
        display: flex;
        gap: var(--spacing-sm);
        margin-bottom: var(--spacing-md);
        padding: var(--spacing-sm);
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
      }

      .btn-allow,
      .btn-deny,
      .btn-secondary {
        padding: var(--spacing-xs) var(--spacing-md);
        border-radius: var(--radius-sm);
        font-size: 12px;
        font-weight: 500;
        cursor: pointer;
        transition: all var(--transition-fast);
        border: 1px solid transparent;
      }

      .btn-allow {
        background: var(--success-color);
        color: white;

        &:hover:not(:disabled) {
          filter: brightness(1.1);
        }
      }

      .btn-deny {
        background: var(--error-color);
        color: white;

        &:hover:not(:disabled) {
          filter: brightness(1.1);
        }
      }

      .btn-secondary {
        background: var(--bg-tertiary);
        border-color: var(--border-color);
        color: var(--text-primary);

        &:hover:not(:disabled) {
          background: var(--bg-primary);
        }
      }

      .scope-select {
        padding: var(--spacing-xs) var(--spacing-sm);
        border-radius: var(--radius-sm);
        background: var(--bg-primary);
        border: 1px solid var(--border-color);
        color: var(--text-primary);
        font-size: 12px;
        cursor: pointer;
      }

      .permissions-list,
      .patterns-list {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-xs);
      }

      .permission-row,
      .pattern-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: var(--spacing-sm) var(--spacing-md);
        background: var(--bg-primary);
        border-radius: var(--radius-sm);
        border: 1px solid var(--border-color);
      }

      .pattern-row.approved {
        border-color: var(--success-color);
        background: rgba(46, 204, 113, 0.05);
      }

      .permission-info {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        flex-wrap: wrap;
        min-width: 0;
      }

      .permission-scope {
        padding: 2px 6px;
        background: var(--bg-tertiary);
        border-radius: 999px;
        font-size: 10px;
        font-weight: 500;
        text-transform: uppercase;
        letter-spacing: 0.03em;
      }

      .permission-resource {
        font-family: monospace;
        font-size: 12px;
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        max-width: 300px;
      }

      .permission-tool {
        font-size: 11px;
        color: var(--text-muted);
      }

      .permission-actions {
        display: flex;
        gap: var(--spacing-xs);
      }

      .btn-allow-sm,
      .btn-deny-sm {
        width: 28px;
        height: 28px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: var(--radius-sm);
        border: none;
        cursor: pointer;
        font-size: 14px;
        transition: all var(--transition-fast);
      }

      .btn-allow-sm {
        background: rgba(46, 204, 113, 0.2);
        color: var(--success-color);

        &:hover:not(:disabled) {
          background: var(--success-color);
          color: white;
        }
      }

      .btn-deny-sm {
        background: rgba(231, 76, 60, 0.2);
        color: var(--error-color);

        &:hover:not(:disabled) {
          background: var(--error-color);
          color: white;
        }
      }

      .pattern-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
        flex: 1;
      }

      .pattern-header {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
      }

      .pattern-scope {
        padding: 2px 6px;
        background: var(--bg-tertiary);
        border-radius: 999px;
        font-size: 10px;
        font-weight: 500;
        text-transform: uppercase;
      }

      .pattern-action {
        padding: 2px 6px;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 600;
        text-transform: uppercase;

        &.allow {
          background: rgba(46, 204, 113, 0.2);
          color: var(--success-color);
        }

        &.deny {
          background: rgba(231, 76, 60, 0.2);
          color: var(--error-color);
        }
      }

      .pattern-approved-badge {
        padding: 2px 6px;
        background: var(--success-color);
        color: white;
        border-radius: 999px;
        font-size: 10px;
        font-weight: 500;
      }

      .pattern-details {
        margin-top: 2px;
      }

      .pattern-value {
        font-size: 12px;
        color: var(--text-primary);
        background: var(--bg-tertiary);
        padding: 2px 6px;
        border-radius: var(--radius-sm);
      }

      .pattern-meta {
        display: flex;
        gap: var(--spacing-sm);
        font-size: 11px;
        color: var(--text-muted);
      }

      .pattern-actions {
        display: flex;
        gap: var(--spacing-xs);
        flex-shrink: 0;
      }

      .btn-approve,
      .btn-reject {
        padding: var(--spacing-xs) var(--spacing-sm);
        border-radius: var(--radius-sm);
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        border: 1px solid transparent;
        transition: all var(--transition-fast);
      }

      .btn-approve {
        background: var(--success-color);
        color: white;

        &:hover:not(:disabled) {
          filter: brightness(1.1);
        }
      }

      .btn-reject {
        background: transparent;
        border-color: var(--border-color);
        color: var(--text-secondary);

        &:hover:not(:disabled) {
          border-color: var(--error-color);
          color: var(--error-color);
        }
      }

      .approved-text {
        font-size: 11px;
        color: var(--success-color);
        font-style: italic;
      }

      .stats-grid {
        display: grid;
        grid-template-columns: repeat(4, 1fr);
        gap: var(--spacing-sm);
        margin-bottom: var(--spacing-md);
      }

      .stat-card {
        text-align: center;
        padding: var(--spacing-sm);
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
      }

      .stat-value {
        font-size: 20px;
        font-weight: 600;
        color: var(--text-primary);
      }

      .stat-label {
        font-size: 11px;
        color: var(--text-muted);
        margin-top: 2px;
      }

      .learning-progress {
        padding: var(--spacing-sm);
        background: var(--bg-tertiary);
        border-radius: var(--radius-sm);
      }

      .progress-header {
        display: flex;
        justify-content: space-between;
        font-size: 12px;
        color: var(--text-secondary);
        margin-bottom: var(--spacing-xs);
      }

      .progress-bar {
        height: 6px;
        background: var(--bg-primary);
        border-radius: 3px;
        overflow: hidden;
      }

      .progress-fill {
        height: 100%;
        background: var(--primary-color);
        border-radius: 3px;
        transition: width 0.3s ease;
      }

      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      @media (max-width: 900px) {
        .permission-guidance,
        .stats-grid {
          grid-template-columns: 1fr;
        }

        .preset-row {
          display: grid;
          grid-template-columns: 1fr;
        }
      }
    `,
  ],
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
  defaultWorkspacePreflight = signal<TaskPreflightReport | null>(null);

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

  private initialized = false;

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
    ]);
  }

  async loadPermissionPreset(): Promise<void> {
    this.presetLoading.set(true);
    try {
      const response = await this.securityIpc.securityGetPermissionConfig();
      if (response.success && response.data?.config) {
        this.permissionPreset.set(response.data.config.defaultAction);
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

  async updatePermissionPreset(value: 'allow' | 'ask' | 'deny'): Promise<void> {
    this.presetLoading.set(true);
    try {
      const response = await this.securityIpc.securitySetPermissionPreset(value);
      if (response.success && response.data?.config) {
        this.permissionPreset.set(response.data.config.defaultAction);
        await this.loadStats();
        await this.refreshDefaultWorkspacePreflight();
      }
    } finally {
      this.presetLoading.set(false);
    }
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
