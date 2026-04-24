/**
 * Child Instances Panel Component
 *
 * Displays child instances in a collapsible panel with:
 * - Status indicators per child
 * - Activity text when processing
 * - Click to select child instance
 */

import {
  Component,
  input,
  output,
  signal,
  computed,
  inject,
  ChangeDetectionStrategy,
} from '@angular/core';
import { InstanceStore, Instance } from '../../core/state/instance.store';
import { StatusIndicatorComponent } from '../instance-list/status-indicator.component';

interface ChildInfo {
  id: string;
  displayName: string;
  status: Instance['status'];
  statusLabel: string;
  isRunning: boolean;
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
            @if (runningChildCount() > 0) {
              <span class="status-badge running">{{ runningChildCount() }} running</span>
            }
            @if (waitingChildCount() > 0) {
              <span class="status-badge waiting">{{ waitingChildCount() }} waiting</span>
            }
            @if (doneChildCount() > 0) {
              <span class="status-badge done">{{ doneChildCount() }} done</span>
            }
            @if (errorChildCount() > 0) {
              <span class="status-badge error">{{ errorChildCount() }} error</span>
            }
          </div>
          @if (runningChildCount() > 0) {
            <span class="active-badge">{{ runningChildCount() }} active</span>
          }
        </button>

        @if (!isCollapsed()) {
          <div class="children-list">
            @for (child of childrenInfo(); track child.id) {
              <button
                class="child-item"
                [class.active]="child.isRunning"
                [class.waiting]="child.status === 'waiting_for_input'"
                [class.error]="child.status === 'error'"
                (click)="onSelectChild(child.id)"
              >
                <app-status-indicator [status]="child.status" />
                <span class="child-name">{{ child.displayName }}</span>
                <span class="child-status">{{ child.statusLabel }}</span>
                @if (child.activity) {
                  <span class="child-activity">{{ child.activity }}</span>
                }
              </button>
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
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm) var(--spacing-md);
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--text-primary);
      font-size: 13px;
      cursor: pointer;
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
    }

    .child-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
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
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChildInstancesPanelComponent {
  private store = inject(InstanceStore);
  private readonly runningStatuses = new Set<Instance['status']>([
    'busy',
    'initializing',
    'respawning',
    'interrupting',
    'cancelling',
    'interrupt-escalating',
  ]);

  /** IDs of child instances */
  childrenIds = input.required<string[]>();

  /** Event when a child is selected */
  selectChild = output<string>();

  /** Panel collapse state */
  isCollapsed = signal(false);

  /** Get activity map from store */
  private activities = this.store.instanceActivities;

  /** Build child info array with instance data and activity */
  childrenInfo = computed<ChildInfo[]>(() => {
    const ids = this.childrenIds();
    const activityMap = this.activities();

    return ids.map((id) => {
      const instance = this.store.getInstance(id);
      const status = instance?.status || 'terminated';
      return {
        id,
        displayName: instance?.displayName || id.slice(0, 8),
        status,
        statusLabel: this.getStatusLabel(status),
        isRunning: this.runningStatuses.has(status),
        activity: activityMap.get(id),
      };
    }).sort((a, b) => this.getStatusRank(a.status) - this.getStatusRank(b.status));
  });

  /** Count of actively processing children */
  runningChildCount = computed(() =>
    this.childrenInfo().filter((c) => c.isRunning).length
  );

  /** Children waiting on user/system input */
  waitingChildCount = computed(() =>
    this.childrenInfo().filter((c) => c.status === 'waiting_for_input').length
  );

  /** Children that have completed/paused work */
  doneChildCount = computed(() =>
    this.childrenInfo().filter((c) => c.status === 'idle' || c.status === 'terminated').length
  );

  /** Children in error state */
  errorChildCount = computed(() =>
    this.childrenInfo().filter((c) => c.status === 'error').length
  );

  private getStatusLabel(status: Instance['status']): string {
    switch (status) {
      case 'busy':
        return 'running';
      case 'initializing':
        return 'starting';
      case 'waiting_for_input':
        return 'waiting';
      case 'respawning':
        return 'recovering';
      case 'interrupting':
      case 'cancelling':
      case 'interrupt-escalating':
        return 'interrupting';
      case 'error':
        return 'error';
      case 'terminated':
        return 'stopped';
      case 'idle':
      default:
        return 'done';
    }
  }

  private getStatusRank(status: Instance['status']): number {
    if (this.runningStatuses.has(status)) return 0;
    if (status === 'waiting_for_input') return 1;
    if (status === 'error') return 2;
    if (status === 'idle') return 3;
    return 4;
  }

  toggleCollapse(): void {
    this.isCollapsed.update((v) => !v);
  }

  onSelectChild(childId: string): void {
    this.selectChild.emit(childId);
  }
}
