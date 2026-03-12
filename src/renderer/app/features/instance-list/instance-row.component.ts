/**
 * Instance Row Component - Single instance in the hierarchical tree list
 */

import {
  Component,
  input,
  output,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { Instance } from '../../core/state/instance.store';
import { StatusIndicatorComponent } from './status-indicator.component';
import { getAgentById, getDefaultAgent } from '../../../../shared/types/agent.types';

@Component({
  selector: 'app-instance-row',
  standalone: true,
  imports: [StatusIndicatorComponent],
  template: `
    <div
      class="instance-row"
      [class.selected]="isSelected()"
      [class.error]="instance().status === 'error'"
      [class.yolo]="instance().yoloMode"
      [class.is-child]="depth() > 0"
      [class.draggable]="isDraggable()"
      [style.padding-left.px]="8 + depth() * 18"
      (click)="instanceSelect.emit(instance().id)"
      (keydown.enter)="instanceSelect.emit(instance().id)"
      (keydown.space)="instanceSelect.emit(instance().id)"
      tabindex="0"
      role="button"
      [attr.aria-label]="'Select instance ' + resolvedDisplayTitle()"
    >
      <!-- Expand/collapse button for parents, child indicator, or placeholder -->
      @if (hasChildren()) {
        <button
          class="expand-btn"
          [class.expanded]="isExpanded()"
          (click)="onToggleExpand($event)"
          title="{{ isExpanded() ? 'Collapse' : 'Expand' }} children"
        >
          <span class="chevron">›</span>
        </button>
      } @else if (depth() > 0) {
        <span class="child-connector">└</span>
      } @else {
        <!-- Placeholder to reserve space for expand button on root instances -->
        <span class="expand-placeholder"></span>
      }

      <app-status-indicator [status]="instance().status" />

      <div class="instance-info">
        <div class="instance-name-row">
          <span class="agent-badge" [style.background-color]="agent().color" [title]="agent().description">
            {{ agent().name.charAt(0) }}
          </span>
          <span class="instance-name">{{ resolvedDisplayTitle() }}</span>
          @if (hasChildren() && !isExpanded()) {
            <span class="collapsed-badge" title="Child instances (click arrow to expand)">+{{ instance().childrenIds.length }}</span>
          }
        </div>
      </div>

      <div class="instance-actions">
        <button
          class="action-btn restart"
          title="Restart instance"
          (click)="onRestart($event)"
          [disabled]="instance().status === 'initializing'"
        >
          ↻
        </button>
        <button
          class="action-btn terminate"
          title="Terminate instance"
          (click)="onTerminate($event)"
        >
          ×
        </button>
      </div>
    </div>
  `,
  styles: [`
    /* Instance Row - Clean list item with refined interactions */
    .instance-row {
      display: flex;
      align-items: center;
      padding: 6px 10px;
      gap: 6px;
      cursor: pointer;
      transition: all var(--transition-fast);
      min-height: 40px;
      position: relative;
      background: transparent;
      border-radius: 10px;
    }

    .instance-row:hover {
      background-color: rgba(255, 255, 255, 0.025);
    }

    .instance-row.selected {
      background: rgba(var(--primary-rgb), 0.08);
      box-shadow: inset 0 0 0 1px rgba(var(--primary-rgb), 0.12);
    }

    .instance-row.error {
      background: rgba(var(--error-rgb), 0.08);
    }

    .instance-row.yolo {
      box-shadow: inset 0 0 0 1px rgba(var(--primary-rgb), 0.14);

      &.selected {
        box-shadow: inset 0 0 0 1px rgba(var(--primary-rgb), 0.2);
      }
    }

    /* Child instance styling - subtle hierarchy indication */
    .instance-row.is-child {
      background-color: transparent;
    }

    .instance-row.is-child:hover {
      background-color: rgba(255, 255, 255, 0.02);
    }

    .instance-row.is-child.selected {
      background: rgba(var(--secondary-rgb), 0.08);
      box-shadow: inset 0 0 0 1px rgba(var(--secondary-rgb), 0.12);
    }

    /* Draggable root instance */
    .instance-row.draggable {
      cursor: grab;
    }

    .instance-row.draggable:active {
      cursor: grabbing;
    }

    /* Child connector - Refined tree line */
    .child-connector {
      color: var(--border-color);
      font-size: 12px;
      width: 14px;
      text-align: center;
      flex-shrink: 0;
      opacity: 0.6;
    }

    /* Placeholder for consistent alignment */
    .expand-placeholder {
      width: 14px;
      height: 14px;
      flex-shrink: 0;
    }

    /* Expand/collapse button - Refined interaction */
    .expand-btn {
      width: 16px;
      height: 16px;
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.05);
      cursor: pointer;
      transition: all var(--transition-fast);
      flex-shrink: 0;
      color: var(--text-muted);
    }

    .expand-btn:hover {
      background: rgba(var(--primary-rgb), 0.08);
      border-color: rgba(var(--primary-rgb), 0.24);
      color: var(--primary-color);
      transform: scale(1.03);
    }

    .expand-btn .chevron {
      font-size: 10px;
      font-weight: bold;
      line-height: 1;
      transition: transform var(--transition-fast);
    }

    .expand-btn.expanded .chevron {
      transform: rotate(90deg);
    }

    /* Instance Info Section */
    .instance-info {
      flex: 1;
      min-width: 0;
      overflow: hidden;
    }

    .instance-name-row {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }

    .agent-badge {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 18px;
      height: 18px;
      border-radius: 6px;
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 700;
      color: white;
      flex-shrink: 0;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.14);
    }

    .instance-name {
      flex: 1;
      min-width: 0;
      font-family: var(--font-display);
      font-weight: 600;
      font-size: 12px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 180px;
      color: var(--text-primary);
      letter-spacing: -0.01em;
    }

    .collapsed-badge {
      background: rgba(var(--primary-rgb), 0.14);
      color: var(--primary-color);
      font-family: var(--font-mono);
      font-size: 8px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 999px;
      flex-shrink: 0;
      letter-spacing: 0.02em;
    }

    /* Instance Actions - Action buttons */
    .instance-actions {
      display: flex;
      gap: 3px;
      opacity: 0;
      transition: opacity var(--transition-fast);
      flex-shrink: 0;
    }

    .instance-row:hover .instance-actions {
      opacity: 1;
    }

    .action-btn {
      width: 20px;
      height: 20px;
      border-radius: var(--radius-sm);
      border: none;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      cursor: pointer;
      transition: all var(--transition-fast);
    }

    .action-btn.restart {
      background: rgba(255, 255, 255, 0.03);
      color: var(--text-secondary);
      border: 1px solid rgba(255, 255, 255, 0.05);

      &:hover:not(:disabled) {
        background: rgba(255, 255, 255, 0.06);
        color: var(--secondary-color);
        border-color: rgba(var(--secondary-rgb), 0.3);
        transform: rotate(180deg);
      }
    }

    .action-btn.terminate {
      background: rgba(var(--error-rgb), 0.1);
      color: var(--error-color);
      border: 1px solid rgba(var(--error-rgb), 0.2);

      &:hover:not(:disabled) {
        background: var(--error-color);
        border-color: var(--error-color);
        color: white;
        box-shadow: 0 0 12px rgba(var(--error-rgb), 0.4);
      }
    }

    .action-btn:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InstanceRowComponent {
  // Required inputs
  instance = input.required<Instance>();
  displayTitle = input<string | null>(null);

  // Hierarchy inputs
  depth = input<number>(0);
  hasChildren = input<boolean>(false);
  isExpanded = input<boolean>(false);
  isLastChild = input<boolean>(false);
  parentChain = input<boolean[]>([]);

  // Selection state
  isSelected = input<boolean>(false);

  // Drag state
  isDraggable = input<boolean>(false);

  // Outputs
  instanceSelect = output<string>();
  terminate = output<string>();
  restart = output<string>();
  toggleExpand = output<string>();
  // Computed agent profile from instance's agentId
  agent = computed(() => {
    const agentId = this.instance().agentId;
    return agentId ? getAgentById(agentId) || getDefaultAgent() : getDefaultAgent();
  });

  readonly resolvedDisplayTitle = computed(() => this.displayTitle()?.trim() || this.instance().displayName);

  onTerminate(event: Event): void {
    event.stopPropagation();
    this.terminate.emit(this.instance().id);
  }

  onRestart(event: Event): void {
    event.stopPropagation();
    this.restart.emit(this.instance().id);
  }

  onToggleExpand(event: Event): void {
    event.stopPropagation();
    this.toggleExpand.emit(this.instance().id);
  }

}
