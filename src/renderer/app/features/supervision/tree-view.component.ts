/**
 * Supervision Tree View Component
 *
 * Hierarchical display of supervisor/worker nodes:
 * - Node status (running, completed, failed, restarting)
 * - Restart count per node
 * - Strategy visualization
 * - Failure propagation indicator
 * - Action buttons (restart, escalate)
 */

import {
  Component,
  input,
  output,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type {
  SupervisionTree,
  SupervisorNode,
  WorkerNode,
  SupervisionStrategy,
  NodeStatus,
  WorkerStatus,
} from '../../../../shared/types/supervision.types';
import { isWorkerNode, isSupervisorNode } from '../../../../shared/types/supervision.types';

interface NodeAction {
  nodeId: string;
  action: 'restart' | 'stop' | 'escalate';
}

type UnifiedNode = SupervisorNode | WorkerNode;

@Component({
  selector: 'app-supervision-tree-view',
  standalone: true,
  imports: [NgTemplateOutlet],
  template: `
    <div class="tree-container">
      <!-- Header -->
      <div class="tree-header">
        <div class="header-left">
          <span class="tree-icon">🌲</span>
          <span class="tree-title">Supervision Tree</span>
          @if (tree(); as t) {
            <span class="strategy-badge" [class]="'strategy-' + getStrategy(t)">
              {{ getStrategy(t) }}
            </span>
          }
        </div>
        <div class="header-stats">
          <span class="stat">
            <span class="stat-value">{{ runningCount() }}</span>
            <span class="stat-label">running</span>
          </span>
          <span class="stat failed">
            <span class="stat-value">{{ failedCount() }}</span>
            <span class="stat-label">failed</span>
          </span>
        </div>
      </div>

      <!-- Tree View -->
      @if (tree(); as t) {
        <div class="tree-view">
          <!-- Root Node -->
          <div class="tree-root">
            @if (t.root) {
              <ng-container
                [ngTemplateOutlet]="nodeTemplate"
                [ngTemplateOutletContext]="{ node: t.root, depth: 0 }"
              />
            }
          </div>
        </div>

        <!-- Strategy Legend -->
        <div class="strategy-legend">
          <span class="legend-title">Strategy: {{ getStrategy(t) }}</span>
          <span class="legend-description">
            {{ getStrategyDescription(getStrategy(t)) }}
          </span>
        </div>
      } @else {
        <div class="empty-state">
          <span class="empty-icon">🌲</span>
          <span class="empty-text">No supervision tree active</span>
        </div>
      }
    </div>

    <!-- Node Template (recursive) -->
    <ng-template #nodeTemplate let-node="node" let-depth="depth">
      <div
        class="tree-node"
        [class]="'status-' + node.status"
        [class.expanded]="expandedNodes().has(node.id)"
        [style.--depth]="depth"
      >
        <!-- Node Header -->
        <div class="node-header" (click)="toggleNode(node.id)">
          <!-- Expand/Collapse -->
          @if (hasChildren(node)) {
            <span class="expand-icon">
              {{ expandedNodes().has(node.id) ? '▾' : '▸' }}
            </span>
          } @else {
            <span class="expand-icon empty">○</span>
          }

          <!-- Status Icon -->
          <span class="status-icon" [title]="node.status">
            {{ getStatusIcon(node.status) }}
          </span>

          <!-- Node Info -->
          <div class="node-info">
            <span class="node-name">{{ node.name }}</span>
            <span class="node-type">{{ getNodeType(node) }}</span>
          </div>

          <!-- Restart Count (only for workers) -->
          @if (isWorker(node) && node.restartCount > 0) {
            <span class="restart-badge" title="Restart count">
              ↻ {{ node.restartCount }}
            </span>
          }

          <!-- Node Actions -->
          <div class="node-actions" (click)="$event.stopPropagation()">
            @if (node.status === 'failed' || node.status === 'stopped') {
              <button
                class="action-btn"
                title="Restart"
                (click)="onAction(node.id, 'restart')"
              >
                ↻
              </button>
            }
            @if (node.status === 'running') {
              <button
                class="action-btn"
                title="Stop"
                (click)="onAction(node.id, 'stop')"
              >
                ⏹
              </button>
            }
            @if (node.status === 'failed' && isWorker(node)) {
              <button
                class="action-btn danger"
                title="Escalate"
                (click)="onAction(node.id, 'escalate')"
              >
                ⬆
              </button>
            }
          </div>
        </div>

        <!-- Node Details (when expanded) -->
        @if (expandedNodes().has(node.id)) {
          <div class="node-details">
            @if (isWorker(node) && node.lastError) {
              <div class="error-message">
                <span class="error-icon">⚠</span>
                <span class="error-text">{{ node.lastError }}</span>
              </div>
            }

            @if (isWorker(node) && node.startedAt) {
              <div class="activity-info">
                Started: {{ formatTime(node.startedAt) }}
              </div>
            }

            @if (isSupervisor(node) && node.healthStatus) {
              <div class="health-info" [class.unhealthy]="!node.healthStatus.isHealthy">
                Health: {{ node.healthStatus.isHealthy ? 'Healthy' : 'Unhealthy' }}
                @if (node.healthStatus.issues.length > 0) {
                  <ul class="health-issues">
                    @for (issue of node.healthStatus.issues; track issue) {
                      <li>{{ issue }}</li>
                    }
                  </ul>
                }
              </div>
            }

            <!-- Children -->
            @if (isSupervisor(node) && node.children && node.children.length > 0) {
              <div class="node-children">
                @for (child of node.children; track child.id) {
                  <ng-container
                    [ngTemplateOutlet]="nodeTemplate"
                    [ngTemplateOutletContext]="{ node: child, depth: depth + 1 }"
                  />
                }
              </div>
            }
          </div>
        }
      </div>
    </ng-template>
  `,
  styles: [`
    .tree-container {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      display: flex;
      flex-direction: column;
    }

    .tree-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
    }

    .header-left {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .tree-icon {
      font-size: 18px;
    }

    .tree-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .strategy-badge {
      padding: 2px 8px;
      border-radius: var(--radius-sm);
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;

      &.strategy-one-for-one {
        background: var(--primary-color);
        color: white;
      }

      &.strategy-one-for-all {
        background: var(--warning-color);
        color: black;
      }

      &.strategy-rest-for-one {
        background: var(--success-color);
        color: white;
      }

      &.strategy-simple-one {
        background: var(--bg-tertiary);
        color: var(--text-secondary);
      }
    }

    .header-stats {
      display: flex;
      gap: var(--spacing-md);
    }

    .stat {
      display: flex;
      align-items: baseline;
      gap: 4px;

      &.failed .stat-value {
        color: var(--error-color);
      }
    }

    .stat-value {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .stat-label {
      font-size: 11px;
      color: var(--text-muted);
    }

    .tree-view {
      padding: var(--spacing-md);
      overflow-x: auto;
    }

    .tree-root {
      min-width: max-content;
    }

    .tree-node {
      margin-left: calc(var(--depth, 0) * 24px);

      &.status-running .status-icon {
        color: var(--success-color);
      }

      &.status-failed .status-icon {
        color: var(--error-color);
      }

      &.status-restarting .status-icon {
        color: var(--warning-color);
        animation: pulse 1s ease-in-out infinite;
      }

      &.status-stopped .status-icon {
        color: var(--text-muted);
      }

      &.status-degraded .status-icon {
        color: var(--warning-color);
      }

      &.status-completed .status-icon {
        color: var(--success-color);
      }
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .node-header {
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-xs) var(--spacing-sm);
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: background var(--transition-fast);

      &:hover {
        background: var(--bg-hover);
      }
    }

    .expand-icon {
      width: 16px;
      font-size: 10px;
      color: var(--text-muted);

      &.empty {
        font-size: 8px;
      }
    }

    .status-icon {
      font-size: 16px;
    }

    .node-info {
      flex: 1;
      display: flex;
      align-items: center;
      gap: var(--spacing-sm);
    }

    .node-name {
      font-size: 13px;
      font-weight: 500;
      color: var(--text-primary);
    }

    .node-type {
      padding: 2px 6px;
      background: var(--bg-tertiary);
      border-radius: var(--radius-sm);
      font-size: 10px;
      color: var(--text-secondary);
    }

    .restart-badge {
      padding: 2px 6px;
      background: var(--warning-color);
      color: black;
      border-radius: var(--radius-sm);
      font-size: 10px;
      font-weight: 600;
    }

    .node-actions {
      display: flex;
      gap: 4px;
      opacity: 0;
      transition: opacity var(--transition-fast);
    }

    .node-header:hover .node-actions {
      opacity: 1;
    }

    .action-btn {
      width: 24px;
      height: 24px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-tertiary);
      border: none;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 12px;
      cursor: pointer;
      transition: all var(--transition-fast);

      &:hover {
        background: var(--primary-color);
        color: white;
      }

      &.danger:hover {
        background: var(--error-color);
      }
    }

    .node-details {
      margin-left: 32px;
      padding: var(--spacing-xs) 0;
    }

    .error-message {
      display: flex;
      align-items: flex-start;
      gap: var(--spacing-xs);
      padding: var(--spacing-xs) var(--spacing-sm);
      background: rgba(220, 38, 38, 0.1);
      border-radius: var(--radius-sm);
      margin-bottom: var(--spacing-xs);
    }

    .error-icon {
      color: var(--error-color);
      flex-shrink: 0;
    }

    .error-text {
      font-size: 11px;
      color: var(--error-color);
      line-height: 1.4;
    }

    .activity-info {
      font-size: 11px;
      color: var(--text-muted);
      padding: var(--spacing-xs) var(--spacing-sm);
    }

    .health-info {
      font-size: 11px;
      color: var(--success-color);
      padding: var(--spacing-xs) var(--spacing-sm);

      &.unhealthy {
        color: var(--warning-color);
      }
    }

    .health-issues {
      margin: var(--spacing-xs) 0 0;
      padding-left: var(--spacing-md);
      font-size: 10px;
      color: var(--text-muted);

      li {
        margin: 2px 0;
      }
    }

    .node-children {
      padding-top: var(--spacing-xs);
    }

    .strategy-legend {
      padding: var(--spacing-sm) var(--spacing-md);
      background: var(--bg-tertiary);
      border-top: 1px solid var(--border-color);
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .legend-title {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-secondary);
    }

    .legend-description {
      font-size: 11px;
      color: var(--text-muted);
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--spacing-sm);
      padding: var(--spacing-xl);
      color: var(--text-muted);
    }

    .empty-icon {
      font-size: 32px;
      opacity: 0.5;
    }

    .empty-text {
      font-size: 13px;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SupervisionTreeViewComponent {
  /** Supervision tree data */
  tree = input<SupervisionTree | null>(null);

  /** Node action event */
  nodeAction = output<NodeAction>();

  /** Expanded node IDs */
  expandedNodes = signal(new Set<string>(['root']));

  /** Running count */
  runningCount = computed(() => {
    const t = this.tree();
    if (!t?.root) return 0;
    return this.countByStatus(t.root, 'running');
  });

  /** Failed count */
  failedCount = computed(() => {
    const t = this.tree();
    if (!t?.root) return 0;
    return this.countByStatus(t.root, 'failed');
  });

  private countByStatus(node: UnifiedNode, status: NodeStatus | WorkerStatus): number {
    let count = node.status === status ? 1 : 0;
    if (isSupervisorNode(node) && node.children) {
      for (const child of node.children) {
        count += this.countByStatus(child, status);
      }
    }
    return count;
  }

  getStrategy(tree: SupervisionTree): SupervisionStrategy {
    return tree.root?.config?.strategy || 'one-for-one';
  }

  hasChildren(node: UnifiedNode): boolean {
    return isSupervisorNode(node) && node.children && node.children.length > 0;
  }

  isWorker(node: UnifiedNode): node is WorkerNode {
    return isWorkerNode(node);
  }

  isSupervisor(node: UnifiedNode): node is SupervisorNode {
    return isSupervisorNode(node);
  }

  getNodeType(node: UnifiedNode): string {
    return isWorkerNode(node) ? 'worker' : 'supervisor';
  }

  getStatusIcon(status: NodeStatus | WorkerStatus): string {
    switch (status) {
      case 'running':
        return '🟢';
      case 'completed':
        return '✅';
      case 'failed':
        return '🔴';
      case 'restarting':
        return '🔄';
      case 'stopped':
        return '⏹';
      case 'degraded':
        return '⚠️';
      default:
        return '○';
    }
  }

  getStrategyDescription(strategy: SupervisionStrategy): string {
    switch (strategy) {
      case 'one-for-one':
        return 'If a child fails, only that child is restarted';
      case 'one-for-all':
        return 'If a child fails, all children are restarted';
      case 'rest-for-one':
        return 'If a child fails, it and all children started after it are restarted';
      case 'simple-one':
        return 'Simple supervision, no automatic restart';
      default:
        return '';
    }
  }

  formatTime(timestamp: number): string {
    const diff = Date.now() - timestamp;
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    return `${Math.floor(minutes / 60)}h ago`;
  }

  toggleNode(nodeId: string): void {
    this.expandedNodes.update((set) => {
      const newSet = new Set(set);
      if (newSet.has(nodeId)) {
        newSet.delete(nodeId);
      } else {
        newSet.add(nodeId);
      }
      return newSet;
    });
  }

  onAction(nodeId: string, action: NodeAction['action']): void {
    this.nodeAction.emit({ nodeId, action });
  }
}
