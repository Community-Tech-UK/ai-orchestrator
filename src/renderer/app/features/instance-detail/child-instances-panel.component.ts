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
            Child Instances ({{ childrenInfo().length }})
          </span>
          @if (activeChildCount() > 0) {
            <span class="active-badge">{{ activeChildCount() }} active</span>
          }
        </button>

        @if (!isCollapsed()) {
          <div class="children-list">
            @for (child of childrenInfo(); track child.id) {
              <button
                class="child-item"
                [class.active]="child.status === 'busy'"
                (click)="onSelectChild(child.id)"
              >
                <app-status-indicator [status]="child.status" />
                <span class="child-name">{{ child.displayName }}</span>
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
    }

    .child-name {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
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
      return {
        id,
        displayName: instance?.displayName || id.slice(0, 8),
        status: instance?.status || 'terminated',
        activity: activityMap.get(id),
      };
    });
  });

  /** Count of actively processing children */
  activeChildCount = computed(() =>
    this.childrenInfo().filter((c) => c.status === 'busy').length
  );

  toggleCollapse(): void {
    this.isCollapsed.update((v) => !v);
  }

  onSelectChild(childId: string): void {
    this.selectChild.emit(childId);
  }
}
