/**
 * Child Instances Panel Component
 *
 * Displays child instances in a collapsible panel with:
 * - Status indicators per child
 * - Activity text when processing
 * - Click to select child instance
 */

import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { InstanceStore, Instance } from '../../core/state/instance.store';
import { StatusIndicatorComponent } from '../instance-list/status-indicator.component';
import { deriveChildState, type ChildDerivedState } from '../../../../shared/utils/child-state-deriver';
import type { HudQuickAction } from '../../../../shared/types/orchestration-hud.types';
import { toHudChildInput } from '../orchestration/orchestration-instance-adapter';
import type { HudChildInput } from '../../../../shared/utils/orchestration-hud-builder';

interface ChildInfo {
  id: string;
  displayName: string;
  status: Instance['status'];
  statusLabel: string;
  isRunning: boolean;
  role?: string;
  spawnPromptHash?: string;
  derived: ChildDerivedState;
  heartbeatLabel: string;
  ageLabel: string;
  activity?: string;
}

@Component({
  selector: 'app-child-instances-panel',
  standalone: true,
  imports: [StatusIndicatorComponent],
  template: `
    @if (childrenInfo().length > 0) {
      <div class="children-panel" [class.collapsed]="isCollapsed()">
        <button class="panel-header" (click)="toggleCollapse()">
          <span class="expand-icon">{{ isCollapsed() ? '▸' : '▾' }}</span>
          <span class="panel-title">
            Agents ({{ childrenInfo().length }})
          </span>
          <div class="header-badges">
            @if (activeChildCount() > 0) {
              <span class="status-badge running">{{ activeChildCount() }} active</span>
            }
            @if (waitingChildCount() > 0) {
              <span class="status-badge waiting">{{ waitingChildCount() }} waiting</span>
            }
            @if (staleChildCount() > 0) {
              <span class="status-badge stale">{{ staleChildCount() }} stale</span>
            }
            @if (doneChildCount() > 0) {
              <span class="status-badge done">{{ doneChildCount() }} done</span>
            }
            @if (errorChildCount() > 0) {
              <span class="status-badge error">{{ errorChildCount() }} error</span>
            }
          </div>
          @if (churningChildCount() > 0) {
            <span class="active-badge">{{ churningChildCount() }} churn</span>
          }
        </button>

        @if (!isCollapsed()) {
          <div class="children-list">
            @for (child of childrenInfo(); track child.id) {
              <article
                class="child-item"
                [class.active]="child.isRunning"
                [class.waiting]="child.derived.isWaiting"
                [class.error]="child.derived.isFailed"
                [class.stale]="child.derived.isStale"
              >
                <div class="child-main">
                  <app-status-indicator [status]="child.status" />
                  <div class="child-name-block">
                    <span class="child-name">{{ child.displayName }}</span>
                    <span class="child-meta">
                      {{ child.role || 'worker' }} · {{ child.derived.turnCount }} turns · {{ child.heartbeatLabel }}
                    </span>
                  </div>
                  <span class="child-status">{{ child.statusLabel }}</span>
                  @if (child.derived.isChurning) {
                    <span class="child-activity warning">churn ×{{ child.derived.churnCount }}</span>
                  }
                  @if (child.derived.isStale) {
                    <span class="child-activity warning">stale {{ child.ageLabel }}</span>
                  }
                  @if (child.activity) {
                    <span class="child-activity">{{ child.activity }}</span>
                  }
                </div>
                <div class="child-actions">
                  <button type="button" class="text-action" (click)="onSelectChild(child.id)">Focus</button>
                  @if (child.spawnPromptHash) {
                    <button
                      type="button"
                      class="text-action"
                      (click)="onQuickAction({ kind: 'copy-prompt-hash', childInstanceId: child.id, spawnPromptHash: child.spawnPromptHash })"
                    >
                      Copy hash
                    </button>
                  }
                  <button
                    type="button"
                    class="text-action"
                    (click)="onQuickAction({ kind: 'open-diagnostic-bundle', childInstanceId: child.id })"
                  >
                    Diagnostics
                  </button>
                </div>
              </article>
            }
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .children-panel {
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      background: var(--bg-secondary);
      overflow: hidden;
    }

    .panel-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      width: 100%;
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--bg-tertiary);
      border: none;
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
      }
    }

    .expand-icon {
      font-size: 10px;
      width: 12px;
      color: var(--text-secondary);
    }

    .panel-title {
      flex: 1;
      text-align: left;
    }

    .header-badges {
      display: inline-flex;
      align-items: center;
      gap: var(--spacing-xs);
      margin-right: var(--spacing-xs);
    }

    .status-badge {
      padding: 2px 6px;
      border-radius: var(--radius-sm);
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
      background: var(--bg-secondary);

      &.running {
        color: var(--status-busy, #3b82f6);
      }

      &.waiting {
        color: var(--status-initializing, #f59e0b);
      }

      &.stale {
        color: var(--text-secondary);
      }

      &.done {
        color: var(--status-idle, #10b981);
      }

      &.error {
        color: var(--status-error, #ef4444);
      }
    }

    .active-badge {
      padding: 2px 6px;
      background: var(--primary-color);
      color: white;
      font-size: 11px;
      font-weight: 600;
      border-radius: var(--radius-sm);
    }

    .children-list {
      display: flex;
      flex-direction: column;
      padding: var(--spacing-xs);
      gap: var(--spacing-xs);
    }

    .child-item {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm) var(--spacing-md);
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 13px;
      transition: all var(--transition-fast);
      text-align: left;

      &:hover {
        background: var(--bg-hover);
        border-color: var(--border-color);
      }

      &.active {
        background: var(--bg-tertiary);
        border-color: var(--primary-color);
      }

      &.waiting {
        border-color: rgba(245, 158, 11, 0.35);
      }

      &.error {
        border-color: rgba(239, 68, 68, 0.35);
      }

      &.stale {
        border-color: rgba(148, 163, 184, 0.35);
      }
    }

    .child-main {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      min-width: 0;
      flex: 1;
    }

    .child-name-block {
      display: flex;
      flex-direction: column;
      min-width: 0;
      flex: 1;
    }

    .child-name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .child-meta {
      margin-top: 2px;
      overflow: hidden;
      text-overflow: ellipsis;
      color: var(--text-secondary);
      font-size: 11px;
      white-space: nowrap;
    }

    .child-status {
      font-size: 11px;
      color: var(--text-secondary);
      text-transform: lowercase;
      white-space: nowrap;
    }

    .child-activity {
      font-size: 11px;
      color: var(--text-secondary);
      padding: 2px 6px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      white-space: nowrap;

      &.warning {
        color: var(--status-initializing, #f59e0b);
      }
    }

    .child-actions {
      display: flex;
      align-items: center;
      gap: var(--spacing-xs);
      flex-wrap: wrap;
      justify-content: flex-end;
    }

    .text-action {
      padding: 3px 7px;
      border: 1px solid var(--border-color);
      border-radius: var(--radius-sm);
      background: var(--bg-tertiary);
      color: var(--text-secondary);
      font-size: 11px;
      font-weight: 500;
      cursor: pointer;

      &:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChildInstancesPanelComponent {
  private store = inject(InstanceStore);
  private destroyRef = inject(DestroyRef);
  private now = signal(Date.now());

  /** IDs of child instances */
  childrenIds = input.required<string[]>();

  /** Event when a child is selected */
  selectChild = output<string>();

  /** Event when a child quick action should be dispatched by the parent. */
  quickAction = output<HudQuickAction>();

  /** Panel collapse state */
  isCollapsed = signal(false);

  /** Get activity map from store */
  private activities = this.store.instanceActivities;

  /** Build child info array with instance data and activity */
  childrenInfo = computed<ChildInfo[]>(() => {
    const now = this.now();
    const ids = this.childrenIds();
    const activityMap = this.activities();

    return ids.map((id) => {
      const instance = this.store.getInstance(id);
      const status = instance?.status ?? 'terminated';
      const hudInput: HudChildInput = instance
        ? toHudChildInput(instance, activityMap.get(id))
        : {
            instanceId: id,
            displayName: id.slice(0, 8),
            status,
            statusTimeline: [{ status, timestamp: now }],
            lastActivityAt: now,
            createdAt: now,
            activity: activityMap.get(id),
          };
      const derived = deriveChildState(hudInput, { now });
      return {
        id,
        displayName: instance?.displayName || id.slice(0, 8),
        status,
        statusLabel: this.getStatusLabel(status),
        isRunning: derived.isActive,
        role: hudInput.role,
        spawnPromptHash: hudInput.spawnPromptHash,
        derived,
        heartbeatLabel: this.getHeartbeatLabel(hudInput.heartbeatAt, now),
        ageLabel: this.formatAge(derived.ageMs),
        activity: activityMap.get(id),
      };
    }).sort((a, b) => this.getStateRank(a.derived.category) - this.getStateRank(b.derived.category));
  });

  constructor() {
    const interval = setInterval(() => this.now.set(Date.now()), 5_000);
    this.destroyRef.onDestroy(() => clearInterval(interval));
  }

  /** Count of actively processing children */
  activeChildCount = computed(() =>
    this.childrenInfo().filter((c) => c.derived.isActive).length
  );

  /** Children waiting on user/system input */
  waitingChildCount = computed(() =>
    this.childrenInfo().filter((c) => c.derived.isWaiting).length
  );

  /** Children that have not reported activity recently. */
  staleChildCount = computed(() =>
    this.childrenInfo().filter((c) => c.derived.isStale).length
  );

  /** Children that have completed/paused work */
  doneChildCount = computed(() =>
    this.childrenInfo().filter((c) => c.derived.category === 'idle').length
  );

  /** Children in error state */
  errorChildCount = computed(() =>
    this.childrenInfo().filter((c) => c.derived.isFailed).length
  );

  /** Children with high state churn. */
  churningChildCount = computed(() =>
    this.childrenInfo().filter((c) => c.derived.isChurning).length
  );

  private getStatusLabel(status: Instance['status']): string {
    switch (status) {
      case 'busy':
      case 'processing':
      case 'thinking_deeply':
        return 'running';
      case 'initializing':
      case 'waking':
        return 'starting';
      case 'waiting_for_input':
      case 'waiting_for_permission':
        return 'waiting';
      case 'respawning':
        return 'recovering';
      case 'interrupting':
      case 'cancelling':
      case 'interrupt-escalating':
        return 'interrupting';
      case 'error':
      case 'failed':
      case 'degraded':
        return 'error';
      case 'terminated':
        return 'stopped';
      case 'hibernating':
        return 'hibernating';
      case 'ready':
      case 'hibernated':
      case 'cancelled':
      case 'superseded':
      default:
        return 'done';
    }
  }

  private getStateRank(category: ChildDerivedState['category']): number {
    switch (category) {
      case 'failed':
        return 0;
      case 'waiting':
        return 1;
      case 'active':
        return 2;
      case 'stale':
        return 3;
      case 'idle':
        return 4;
    }
  }

  private getHeartbeatLabel(heartbeatAt: number | undefined, now: number): string {
    if (!heartbeatAt) {
      return 'no heartbeat';
    }
    return `heartbeat ${this.formatAge(Math.max(0, now - heartbeatAt))} ago`;
  }

  private formatAge(ms: number): string {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) {
      return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
      return `${minutes}m`;
    }
    const hours = Math.floor(minutes / 60);
    return `${hours}h`;
  }

  toggleCollapse(): void {
    this.isCollapsed.update((v) => !v);
  }

  onSelectChild(childId: string): void {
    this.selectChild.emit(childId);
  }

  onQuickAction(action: HudQuickAction): void {
    this.quickAction.emit(action);
  }
}
