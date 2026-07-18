/**
 * Plan Page
 * Container for plan mode control and review for agent instances.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { PlanModeIpcService } from '../../core/services/ipc/plan-mode-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import { RendererPollSchedulerService } from '../../core/services/renderer-poll-scheduler.service';

interface PlanHistoryEntry {
  version: number;
  content: string;
  timestamp: number;
  action: 'created' | 'updated' | 'approved';
}

interface PlanState {
  instanceId: string;
  mode: 'idle' | 'planning' | 'awaiting_approval' | 'implementing';
  planContent?: string;
  enteredAt?: number;
  version?: number;
  history?: PlanHistoryEntry[];
}

@Component({
  selector: 'app-plan-page',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="page">
      <!-- Page header -->
      <div class="page-header">
        <div class="header-title">
          <span class="title">Plan Mode</span>
          <span class="subtitle">Plan mode control and review for agent instances</span>
        </div>
        <div class="header-actions">
          <button class="btn" type="button" [disabled]="busy()" (click)="refreshState()">
            Refresh
          </button>
        </div>
      </div>

      <!-- Instance selector bar -->
      <div class="selector-bar">
        <label class="selector-field">
          <span class="label">Instance ID</span>
          <input
            class="input"
            type="text"
            [value]="instanceIdInput()"
            placeholder="Enter instance ID"
            (input)="onInstanceIdInput($event)"
            (keydown.enter)="loadState()"
          />
        </label>
        <button class="btn primary" type="button" [disabled]="busy() || !instanceIdInput().trim()" (click)="loadState()">
          Load State
        </button>
      </div>

      @if (errorMessage()) {
        <div class="error-banner">{{ errorMessage() }}</div>
      }

      @if (infoMessage()) {
        <div class="info-banner">{{ infoMessage() }}</div>
      }

      <!-- State indicator bar -->
      @if (planState()) {
        <div class="state-bar">
          <span class="state-label">Current State</span>
          <span class="state-badge" [class]="stateBadgeClass()">
            {{ stateBadgeLabel() }}
          </span>
          <span class="state-instance">{{ planState()!.instanceId }}</span>
        </div>
      }

      <!-- Two-column layout -->
      @if (planState()) {
        <div class="content">
          <!-- Left: Plan Content -->
          <div class="plan-panel">
            <div class="panel-card full-height">
              <div class="panel-title">Plan Content</div>

              @if (planState()!.mode === 'planning') {
                <div class="plan-edit-area">
                  <textarea
                    class="plan-textarea"
                    [value]="editablePlanContent()"
                    placeholder="Plan content will appear here. Edit and update as needed."
                    (input)="onPlanContentInput($event)"
                  ></textarea>
                  <div class="panel-actions">
                    <button
                      class="btn primary"
                      type="button"
                      [disabled]="busy()"
                      (click)="updatePlan()"
                    >
                      {{ busy() ? 'Updating...' : 'Update Plan' }}
                    </button>
                  </div>
                </div>
              }

              @if (planState()!.mode === 'awaiting_approval') {
                <div class="plan-readonly-area">
                  <pre class="plan-display">{{ planState()!.planContent || '(no plan content)' }}</pre>
                  <div class="panel-actions">
                    <button
                      class="btn success"
                      type="button"
                      [disabled]="busy()"
                      (click)="approvePlan()"
                    >
                      {{ busy() ? 'Approving...' : 'Approve Plan' }}
                    </button>
                  </div>
                </div>
              }

              @if (planState()!.mode === 'idle') {
                <div class="plan-idle-area">
                  <div class="idle-description">
                    <p>This instance is not currently in plan mode.</p>
                    <p>Enter plan mode to allow the agent to explore and draft a plan before implementing changes.</p>
                  </div>
                  <div class="panel-actions">
                    <button
                      class="btn primary"
                      type="button"
                      [disabled]="busy()"
                      (click)="enterPlanMode()"
                    >
                      {{ busy() ? 'Entering...' : 'Enter Plan Mode' }}
                    </button>
                  </div>
                </div>
              }

              @if (planState()!.mode === 'implementing') {
                <div class="plan-readonly-area">
                  <pre class="plan-display">{{ planState()!.planContent || '(no plan content)' }}</pre>
                  <div class="panel-actions">
                    <button
                      class="btn danger"
                      type="button"
                      [disabled]="busy()"
                      (click)="exitPlanMode()"
                    >
                      {{ busy() ? 'Exiting...' : 'Exit Plan Mode' }}
                    </button>
                  </div>
                </div>
              }
            </div>
          </div>

          <!-- Right: Controls & History -->
          <div class="side-panel">
            <!-- Action buttons panel -->
            <div class="panel-card">
              <div class="panel-title">Actions</div>

              <div class="action-list">
                <button
                  class="btn full-width"
                  type="button"
                  [disabled]="busy() || planState()!.mode !== 'idle'"
                  (click)="enterPlanMode()"
                >
                  Enter Plan Mode
                </button>
                <button
                  class="btn full-width"
                  type="button"
                  [disabled]="busy() || planState()!.mode !== 'planning'"
                  (click)="updatePlan()"
                >
                  Update Plan
                </button>
                <button
                  class="btn success full-width"
                  type="button"
                  [disabled]="busy() || planState()!.mode !== 'awaiting_approval'"
                  (click)="approvePlan()"
                >
                  Approve Plan
                </button>
                <button
                  class="btn danger full-width"
                  type="button"
                  [disabled]="busy() || planState()!.mode === 'idle'"
                  (click)="exitPlanMode()"
                >
                  Exit Plan Mode
                </button>
              </div>

              <label class="checkbox-row">
                <input
                  type="checkbox"
                  [checked]="forceExit()"
                  (change)="onForceExitChange($event)"
                />
                Force exit (discard plan)
              </label>
            </div>

            <!-- State metadata -->
            <div class="panel-card">
              <div class="panel-title">Metadata</div>
              <div class="meta-list">
                <div class="meta-row">
                  <span class="meta-key">Instance</span>
                  <span class="meta-value">{{ planState()!.instanceId }}</span>
                </div>
                @if (planState()!.enteredAt) {
                  <div class="meta-row">
                    <span class="meta-key">Entered At</span>
                    <span class="meta-value">{{ formatTimestamp(planState()!.enteredAt!) }}</span>
                  </div>
                }
                @if (planState()!.version !== undefined) {
                  <div class="meta-row">
                    <span class="meta-key">Plan Version</span>
                    <span class="meta-value">v{{ planState()!.version }}</span>
                  </div>
                }
              </div>
            </div>

            <!-- Plan history -->
            @if (planHistory().length > 0) {
              <div class="panel-card">
                <div class="panel-title">Plan History</div>
                <div class="history-list">
                  @for (entry of planHistory(); track entry.version) {
                    <div class="history-card">
                      <div class="history-header">
                        <span class="history-version">v{{ entry.version }}</span>
                        <span class="history-action" [class]="'action-' + entry.action">
                          {{ entry.action }}
                        </span>
                        <span class="history-time">{{ formatTimestamp(entry.timestamp) }}</span>
                      </div>
                      <div class="history-preview">{{ truncate(entry.content, 120) }}</div>
                    </div>
                  }
                </div>
              </div>
            }
          </div>
        </div>
      }

      @if (!planState()) {
        <div class="empty-state">
          <div class="empty-title">No instance loaded</div>
          <div class="empty-desc">Enter an instance ID above and click "Load State" to begin.</div>
        </div>
      }

      <!-- Bottom action bar -->
      @if (planState()) {
        <div class="action-bar">
          @if (planState()!.mode === 'idle') {
            <button class="btn primary" type="button" [disabled]="busy()" (click)="enterPlanMode()">
              Enter Plan Mode
            </button>
          }
          @if (planState()!.mode === 'planning') {
            <button class="btn primary" type="button" [disabled]="busy()" (click)="updatePlan()">
              Update Plan
            </button>
          }
          @if (planState()!.mode === 'awaiting_approval') {
            <button class="btn success" type="button" [disabled]="busy()" (click)="approvePlan()">
              Approve Plan
            </button>
          }
          @if (planState()!.mode === 'implementing') {
            <button class="btn danger" type="button" [disabled]="busy()" (click)="exitPlanMode()">
              Exit Plan Mode
            </button>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      width: 100%;
      height: 100%;
    }

    .page {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      padding: var(--spacing-lg);
      background: var(--bg-primary);
      color: var(--text-primary);
      overflow: auto;
    }

    /* Page header */
    .page-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      flex-shrink: 0;
    }

    .header-title {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-width: 0;
    }

    .title {
      font-size: 18px;
      font-weight: 700;
    }

    .subtitle {
      font-size: 12px;
      color: var(--text-muted);
    }

    .header-actions {
      display: flex;
      gap: var(--spacing-sm);
    }

    /* Selector bar */
    .selector-bar {
      display: flex;
      align-items: flex-end;
      gap: var(--spacing-sm);
      padding: var(--spacing-md);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      flex-shrink: 0;
    }

    .selector-field {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      flex: 1;
      min-width: 0;
    }

    /* Banners */
    .error-banner,
    .info-banner {
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-sm);
      font-size: 12px;
      flex-shrink: 0;
    }

    .error-banner {
      border: 1px solid color-mix(in srgb, var(--error-color) 60%, transparent);
      background: color-mix(in srgb, var(--error-color) 14%, transparent);
      color: var(--error-color);
    }

    .info-banner {
      border: 1px solid color-mix(in srgb, var(--primary-color) 60%, transparent);
      background: color-mix(in srgb, var(--primary-color) 12%, transparent);
      color: var(--text-primary);
    }

    /* State indicator bar */
    .state-bar {
      display: flex;
      align-items: center;
      gap: var(--spacing-md);
      padding: var(--spacing-sm) var(--spacing-md);
      border-radius: var(--radius-md);
      border: 1px solid var(--border-color);
      background: var(--bg-secondary);
      flex-shrink: 0;
    }

    .state-label {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
    }

    .state-badge {
      display: inline-flex;
      align-items: center;
      padding: 3px 12px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
    }

    .state-badge.badge-idle {
      background: color-mix(in srgb, var(--text-muted) 14%, transparent);
      color: var(--text-muted);
      border: 1px solid color-mix(in srgb, var(--text-muted) 30%, transparent);
    }

    .state-badge.badge-planning {
      background: color-mix(in srgb, var(--warning-color) 18%, transparent);
      color: var(--warning-color);
      border: 1px solid color-mix(in srgb, var(--warning-color) 40%, transparent);
    }

    .state-badge.badge-awaiting_approval {
      background: color-mix(in srgb, #22d3ee 18%, transparent);
      color: #22d3ee;
      border: 1px solid color-mix(in srgb, #22d3ee 40%, transparent);
    }

    .state-badge.badge-implementing {
      background: color-mix(in srgb, var(--success-color) 18%, transparent);
      color: var(--success-color);
      border: 1px solid color-mix(in srgb, var(--success-color) 40%, transparent);
    }

    .state-instance {
      font-size: 12px;
      color: var(--text-muted);
      font-family: var(--font-family-mono);
      margin-left: auto;
    }

    /* Two-column content grid */
    .content {
      flex: 1;
      min-height: 0;
      display: grid;
      grid-template-columns: 1fr 300px;
      gap: var(--spacing-md);
    }

    .plan-panel {
      min-height: 0;
      display: flex;
      flex-direction: column;
    }

    .side-panel {
      min-height: 0;
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      overflow: auto;
    }

    /* Panel cards */
    .panel-card {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
    }

    .panel-card.full-height {
      flex: 1;
      min-height: 0;
    }

    .panel-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
      flex-shrink: 0;
    }

    /* Plan content areas */
    .plan-edit-area,
    .plan-readonly-area,
    .plan-idle-area {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      flex: 1;
      min-height: 0;
    }

    .plan-textarea {
      flex: 1;
      min-height: 200px;
      resize: none;
      width: 100%;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: var(--spacing-sm);
      font-size: 12px;
      font-family: var(--font-family-mono);
      line-height: 1.6;
    }

    .plan-display {
      flex: 1;
      min-height: 0;
      margin: 0;
      padding: var(--spacing-sm);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-primary);
      color: var(--text-primary);
      font-size: 12px;
      font-family: var(--font-family-mono);
      line-height: 1.6;
      white-space: pre-wrap;
      overflow: auto;
    }

    .plan-idle-area {
      justify-content: center;
      align-items: center;
      text-align: center;
    }

    .idle-description {
      max-width: 400px;
      color: var(--text-muted);
      font-size: 13px;
      line-height: 1.6;
    }

    .idle-description p {
      margin: 0 0 var(--spacing-xs);
    }

    .panel-actions {
      display: flex;
      gap: var(--spacing-sm);
      justify-content: flex-end;
      flex-shrink: 0;
    }

    /* Actions side panel */
    .action-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .full-width {
      width: 100%;
      justify-content: center;
    }

    .checkbox-row {
      display: inline-flex;
      align-items: center;
      gap: var(--spacing-xs);
      font-size: 12px;
      color: var(--text-secondary);
    }

    /* Metadata */
    .meta-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
    }

    .meta-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--spacing-sm);
      font-size: 12px;
    }

    .meta-key {
      color: var(--text-muted);
      flex-shrink: 0;
    }

    .meta-value {
      color: var(--text-primary);
      font-family: var(--font-family-mono);
      text-align: right;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Plan history */
    .history-list {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-xs);
      max-height: 240px;
      overflow: auto;
    }

    .history-card {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-tertiary);
      padding: var(--spacing-xs) var(--spacing-sm);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .history-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .history-version {
      font-size: 11px;
      font-weight: 700;
      font-family: var(--font-family-mono);
      color: var(--text-primary);
    }

    .history-action {
      font-size: 10px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 999px;
    }

    .history-action.action-created {
      color: var(--primary-color);
      background: color-mix(in srgb, var(--primary-color) 16%, transparent);
    }

    .history-action.action-updated {
      color: var(--warning-color);
      background: color-mix(in srgb, var(--warning-color) 16%, transparent);
    }

    .history-action.action-approved {
      color: var(--success-color);
      background: color-mix(in srgb, var(--success-color) 16%, transparent);
    }

    .history-time {
      font-size: 10px;
      color: var(--text-muted);
      margin-left: auto;
    }

    .history-preview {
      font-size: 11px;
      color: var(--text-muted);
      font-family: var(--font-family-mono);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* Empty state */
    .empty-state {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--spacing-sm);
      color: var(--text-muted);
    }

    .empty-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-secondary);
    }

    .empty-desc {
      font-size: 13px;
    }

    /* Bottom action bar */
    .action-bar {
      display: flex;
      gap: var(--spacing-sm);
      justify-content: flex-end;
      padding: var(--spacing-sm) var(--spacing-md);
      border-top: 1px solid var(--border-color);
      background: var(--bg-secondary);
      border-radius: var(--radius-md);
      flex-shrink: 0;
    }

    /* Shared controls */
    .btn {
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
      cursor: pointer;
      white-space: nowrap;
    }

    .btn.primary {
      background: var(--primary-color);
      border-color: var(--primary-color);
      color: #fff;
    }

    .btn.success {
      background: var(--success-color);
      border-color: var(--success-color);
      color: #fff;
    }

    .btn.danger {
      background: var(--error-color);
      border-color: var(--error-color);
      color: #fff;
    }

    .btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }

    .input {
      width: 100%;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-primary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
    }

    .label {
      font-size: 11px;
      color: var(--text-muted);
    }

    @media (max-width: 900px) {
      .content {
        grid-template-columns: 1fr;
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanPageComponent implements OnDestroy {
  private readonly planModeIpc = inject(PlanModeIpcService);
  private readonly pollScheduler = inject(RendererPollSchedulerService);

  readonly instanceIdInput = signal('');
  readonly planState = signal<PlanState | null>(null);
  readonly editablePlanContent = signal('');
  readonly forceExit = signal(false);
  readonly busy = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly infoMessage = signal<string | null>(null);

  readonly planHistory = computed<PlanHistoryEntry[]>(() => {
    return this.planState()?.history ?? [];
  });

  readonly stateBadgeClass = computed(() => {
    const mode = this.planState()?.mode ?? 'idle';
    return `state-badge badge-${mode}`;
  });

  readonly stateBadgeLabel = computed(() => {
    const mode = this.planState()?.mode ?? 'idle';
    const labels: Record<PlanState['mode'], string> = {
      idle: 'Idle',
      planning: 'Planning',
      awaiting_approval: 'Awaiting Approval',
      implementing: 'Implementing',
    };
    return labels[mode];
  });

  private stopScheduledPoll: (() => void) | null = null;
  private refreshInFlight = false;

  ngOnDestroy(): void {
    this.stopPolling();
  }

  onInstanceIdInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.instanceIdInput.set(target.value);
  }

  onPlanContentInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.editablePlanContent.set(target.value);
  }

  onForceExitChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.forceExit.set(target.checked);
  }

  async loadState(): Promise<void> {
    const instanceId = this.instanceIdInput().trim();
    if (!instanceId) {
      return;
    }

    this.clearMessages();
    this.busy.set(true);
    try {
      const response = await this.planModeIpc.getPlanModeState(instanceId);
      this.applyStateResponse(instanceId, response);
    } finally {
      this.busy.set(false);
    }

    this.startPolling();
  }

  async refreshState(): Promise<void> {
    const instanceId = this.planState()?.instanceId;
    if (!instanceId || this.refreshInFlight) {
      return;
    }

    this.refreshInFlight = true;
    try {
      const response = await this.planModeIpc.getPlanModeState(instanceId);
      this.applyStateResponse(instanceId, response);
    } finally {
      this.refreshInFlight = false;
    }
  }

  async enterPlanMode(): Promise<void> {
    const instanceId = this.planState()?.instanceId;
    if (!instanceId || this.busy()) {
      return;
    }

    this.clearMessages();
    this.busy.set(true);
    try {
      const response = await this.planModeIpc.enterPlanMode(instanceId);
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to enter plan mode.');
        return;
      }
      this.infoMessage.set('Entered plan mode.');
      await this.refreshState();
    } finally {
      this.busy.set(false);
    }
  }

  async exitPlanMode(): Promise<void> {
    const instanceId = this.planState()?.instanceId;
    if (!instanceId || this.busy()) {
      return;
    }

    this.clearMessages();
    this.busy.set(true);
    try {
      const response = await this.planModeIpc.exitPlanMode(instanceId, this.forceExit());
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to exit plan mode.');
        return;
      }
      this.infoMessage.set('Exited plan mode.');
      await this.refreshState();
    } finally {
      this.busy.set(false);
    }
  }

  async approvePlan(): Promise<void> {
    const instanceId = this.planState()?.instanceId;
    if (!instanceId || this.busy()) {
      return;
    }

    this.clearMessages();
    this.busy.set(true);
    try {
      const planContent = this.planState()?.planContent;
      const response = await this.planModeIpc.approvePlan(instanceId, planContent);
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to approve plan.');
        return;
      }
      this.infoMessage.set('Plan approved.');
      await this.refreshState();
    } finally {
      this.busy.set(false);
    }
  }

  async updatePlan(): Promise<void> {
    const instanceId = this.planState()?.instanceId;
    const content = this.editablePlanContent();
    if (!instanceId || this.busy()) {
      return;
    }

    this.clearMessages();
    this.busy.set(true);
    try {
      const response = await this.planModeIpc.updatePlanContent(instanceId, content);
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to update plan.');
        return;
      }
      this.infoMessage.set('Plan content updated.');
      await this.refreshState();
    } finally {
      this.busy.set(false);
    }
  }

  formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  truncate(text: string, maxLen: number): string {
    if (text.length <= maxLen) {
      return text;
    }
    return text.slice(0, maxLen) + '...';
  }

  private applyStateResponse(instanceId: string, response: IpcResponse): void {
    if (!response.success) {
      this.errorMessage.set(response.error?.message ?? 'Failed to load plan state.');
      return;
    }

    const raw = response.data as Record<string, unknown> | null | undefined;
    if (!raw) {
      this.errorMessage.set('No plan state returned from server.');
      return;
    }

    const mode = (raw['mode'] as PlanState['mode']) ?? 'idle';
    const planContent = typeof raw['planContent'] === 'string' ? raw['planContent'] : undefined;

    const state: PlanState = {
      instanceId,
      mode,
      planContent,
      enteredAt: typeof raw['enteredAt'] === 'number' ? raw['enteredAt'] : undefined,
      version: typeof raw['version'] === 'number' ? raw['version'] : undefined,
      history: Array.isArray(raw['history']) ? (raw['history'] as PlanHistoryEntry[]) : undefined,
    };

    this.planState.set(state);

    // Seed editable content when entering planning mode
    if (mode === 'planning' && planContent !== undefined) {
      this.editablePlanContent.set(planContent);
    }
  }

  private clearMessages(): void {
    this.errorMessage.set(null);
    this.infoMessage.set(null);
  }

  private startPolling(): void {
    this.stopPolling();
    this.stopScheduledPoll = this.pollScheduler.register(() => {
      if (!this.planState()) {
        return;
      }
      return this.refreshState();
    }, 5000);
  }

  private stopPolling(): void {
    this.stopScheduledPoll?.();
    this.stopScheduledPoll = null;
  }
}
