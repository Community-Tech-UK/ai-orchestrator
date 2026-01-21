/**
 * Instance List Component - Hierarchical tree view with collapsible children
 * Supports drag-and-drop reordering of root instance groups
 */

import {
  Component,
  inject,
  signal,
  computed,
  ChangeDetectionStrategy,
} from '@angular/core';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { CdkDragDrop, DragDropModule, moveItemInArray } from '@angular/cdk/drag-drop';
import { InstanceStore, Instance } from '../../core/state/instance.store';
import { InstanceRowComponent } from './instance-row.component';

/** Instance with hierarchy metadata for display */
export interface HierarchicalInstance {
  instance: Instance;
  depth: number;
  hasChildren: boolean;
  isExpanded: boolean;
  isLastChild: boolean;
  parentChain: boolean[]; // Track which ancestor levels need connecting lines
}

@Component({
  selector: 'app-instance-list',
  standalone: true,
  imports: [ScrollingModule, InstanceRowComponent, DragDropModule],
  template: `
    <div class="instance-list-container">
      <!-- Filter bar -->
      <div class="filter-bar">
        <input
          type="text"
          class="filter-input"
          placeholder="Filter instances..."
          [value]="filterText()"
          (input)="onFilterChange($event)"
        />
        <select
          class="status-filter"
          [value]="statusFilter()"
          (change)="onStatusFilterChange($event)"
        >
          <option value="all">All</option>
          <option value="idle">Idle</option>
          <option value="busy">Busy</option>
          <option value="waiting_for_input">Waiting</option>
          <option value="error">Error</option>
        </select>
      </div>

      <!-- Instance list with drag-drop reordering -->
      <div
        class="instance-viewport"
        cdkDropList
        [cdkDropListData]="hierarchicalInstances()"
        (cdkDropListDropped)="onDrop($event)"
      >
        @for (item of hierarchicalInstances(); track item.instance.id) {
          <div
            class="drag-wrapper"
            [class.is-root]="item.depth === 0"
            [cdkDragDisabled]="item.depth > 0 || isDragDisabled()"
            cdkDrag
            [cdkDragData]="item"
          >
            <!-- Custom drag preview -->
            <div class="drag-preview" *cdkDragPreview>
              <span class="drag-preview-name">{{ item.instance.displayName }}</span>
              @if (item.hasChildren) {
                <span class="drag-preview-children">+{{ item.instance.childrenIds.length }}</span>
              }
            </div>
            <!-- Placeholder shown while dragging -->
            <div class="drag-placeholder" *cdkDragPlaceholder></div>

            <app-instance-row
              [instance]="item.instance"
              [depth]="item.depth"
              [hasChildren]="item.hasChildren"
              [isExpanded]="item.isExpanded"
              [isLastChild]="item.isLastChild"
              [parentChain]="item.parentChain"
              [isSelected]="selectedId() === item.instance.id"
              [isDraggable]="item.depth === 0"
              (select)="onSelectInstance($event)"
              (terminate)="onTerminateInstance($event)"
              (restart)="onRestartInstance($event)"
              (toggleExpand)="onToggleExpand($event)"
              (rename)="onRenameInstance($event)"
            />
          </div>
        } @empty {
          <div class="empty-state">
            @if (filterText() || statusFilter() !== 'all') {
              <p>No instances match your filters</p>
            } @else {
              <p>No instances yet</p>
              <p class="hint">Create one to get started</p>
            }
          </div>
        }
      </div>
    </div>
  `,
  styles: [`
    :host {
      display: flex;
      flex: 1;
      min-height: 0;
    }

    .instance-list-container {
      display: flex;
      flex-direction: column;
      flex: 1;
      min-height: 0;
    }

    /* Filter Bar - Refined search interface */
    .filter-bar {
      display: flex;
      gap: var(--spacing-sm);
      padding: var(--spacing-sm) var(--spacing-md);
      border-bottom: 1px solid var(--border-color);
      background: var(--bg-tertiary);
    }

    .filter-input {
      flex: 1;
      min-width: 0;
      padding: var(--spacing-sm) var(--spacing-md);
      font-family: var(--font-mono);
      font-size: 12px;
      letter-spacing: 0.02em;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      color: var(--text-primary);
      transition: all var(--transition-fast);

      &::placeholder {
        color: var(--text-muted);
      }

      &:focus {
        outline: none;
        border-color: var(--primary-color);
        box-shadow: 0 0 0 3px rgba(var(--primary-rgb), 0.15);
      }
    }

    .status-filter {
      padding: var(--spacing-sm) var(--spacing-md);
      font-family: var(--font-mono);
      font-size: 12px;
      letter-spacing: 0.02em;
      min-width: 90px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-md);
      color: var(--text-primary);
      cursor: pointer;
      transition: all var(--transition-fast);

      &:focus {
        outline: none;
        border-color: var(--primary-color);
      }

      &:hover {
        border-color: var(--border-color);
      }
    }

    /* Instance Viewport - Scrollable area */
    .instance-viewport {
      flex: 1;
      width: 100%;
      min-height: 200px;
      overflow-y: auto;
      padding: var(--spacing-xs) 0;
    }

    /* Custom scrollbar */
    .instance-viewport::-webkit-scrollbar {
      width: 6px;
    }

    .instance-viewport::-webkit-scrollbar-track {
      background: transparent;
    }

    .instance-viewport::-webkit-scrollbar-thumb {
      background: var(--border-color);
      border-radius: 3px;

      &:hover {
        background: var(--border-strong);
      }
    }

    /* Empty State - Refined messaging */
    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 200px;
      color: var(--text-muted);
      text-align: center;
      padding: var(--spacing-xl);
      animation: fadeIn 0.3s ease-out;
    }

    .empty-state p {
      font-family: var(--font-display);
      font-size: 14px;
      margin: 0;
    }

    .empty-state .hint {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
      margin-top: var(--spacing-sm);
      opacity: 0.7;
      letter-spacing: 0.03em;
    }

    /* Drag-drop styling - Enhanced feedback */
    .drag-wrapper {
      transition: transform 250ms cubic-bezier(0, 0, 0.2, 1);
    }

    .drag-wrapper.is-root {
      cursor: grab;
    }

    .drag-wrapper.is-root:active {
      cursor: grabbing;
    }

    .drag-wrapper.cdk-drag-dragging {
      opacity: 0.4;
    }

    .drag-placeholder {
      background: rgba(var(--primary-rgb), 0.1);
      border: 2px dashed var(--primary-color);
      border-radius: var(--radius-md);
      height: 72px;
      margin: var(--spacing-xs) var(--spacing-sm);
      transition: transform 250ms cubic-bezier(0, 0, 0.2, 1);
      box-shadow: inset 0 0 20px rgba(var(--primary-rgb), 0.1);
    }

    .drag-preview {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 14px 18px;
      background: var(--bg-secondary);
      border: 1px solid var(--primary-color);
      border-radius: var(--radius-md);
      box-shadow:
        0 8px 24px rgba(0, 0, 0, 0.3),
        0 0 0 1px rgba(var(--primary-rgb), 0.3);
      font-family: var(--font-display);
      font-weight: 600;
      font-size: 13px;
      color: var(--text-primary);
    }

    .drag-preview-name {
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .drag-preview-children {
      background: linear-gradient(135deg, var(--primary-color) 0%, var(--primary-hover) 100%);
      color: var(--bg-primary);
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 700;
      padding: 3px 8px;
      border-radius: 10px;
      letter-spacing: 0.02em;
    }

    /* Animate items moving when dragging */
    .cdk-drop-list-dragging .drag-wrapper:not(.cdk-drag-placeholder) {
      transition: transform 250ms cubic-bezier(0, 0, 0.2, 1);
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InstanceListComponent {
  private store = inject(InstanceStore);
  private readonly ORDER_STORAGE_KEY = 'instance-list-order';

  // Local UI state
  filterText = signal('');
  statusFilter = signal<string>('all');

  // Track which parent instances are COLLAPSED (default: all expanded)
  // Using collapsed set means new parents are automatically expanded
  collapsedIds = signal<Set<string>>(new Set());

  // Track custom ordering of root instances (array of instance IDs)
  rootInstanceOrder = signal<string[]>(this.loadOrder());

  // Selected instance ID from store
  selectedId = this.store.selectedInstanceId;

  // Disable drag when filtering
  isDragDisabled = computed(() => {
    return this.filterText().length > 0 || this.statusFilter() !== 'all';
  });

  // Build hierarchical view of instances
  hierarchicalInstances = computed(() => {
    const instances = this.store.instances();
    const filter = this.filterText().toLowerCase();
    const status = this.statusFilter();
    const collapsed = this.collapsedIds();

    // Build instance map for quick lookup
    const instanceMap = new Map<string, Instance>();
    for (const instance of instances) {
      instanceMap.set(instance.id, instance);
    }

    // Build children map dynamically from parentId relationships
    // This is more reliable than using childrenIds which may be stale in the renderer
    const childrenByParent = new Map<string, string[]>();
    for (const instance of instances) {
      if (instance.parentId) {
        const siblings = childrenByParent.get(instance.parentId) || [];
        siblings.push(instance.id);
        childrenByParent.set(instance.parentId, siblings);
      }
    }

    // Helper to get children for an instance
    const getChildrenIds = (instanceId: string): string[] => {
      return childrenByParent.get(instanceId) || [];
    };

    // Filter instances
    const matchesFilter = (instance: Instance): boolean => {
      const matchesText =
        !filter ||
        instance.displayName.toLowerCase().includes(filter) ||
        instance.id.includes(filter);

      const matchesStatus =
        status === 'all' || instance.status === status;

      return matchesText && matchesStatus;
    };

    // Get root instances (no parent)
    const rootInstances = instances.filter(i => !i.parentId);

    // Recursively build flat list with hierarchy info
    const result: HierarchicalInstance[] = [];

    const addInstance = (
      instance: Instance,
      depth: number,
      parentChain: boolean[],
      isLastChild: boolean
    ) => {
      const childrenIds = getChildrenIds(instance.id);

      // Check if this instance or any of its descendants match the filter
      const selfMatches = matchesFilter(instance);
      const childrenMatch = childrenIds.some(childId => {
        const child = instanceMap.get(childId);
        return child && matchesFilter(child);
      });

      if (!selfMatches && !childrenMatch) return;

      const hasChildren = childrenIds.length > 0;
      const isExpanded = !collapsed.has(instance.id); // Not in collapsed set = expanded

      result.push({
        instance: {
          ...instance,
          childrenIds, // Use the dynamically computed childrenIds
        },
        depth,
        hasChildren,
        isExpanded,
        isLastChild,
        parentChain: [...parentChain],
      });

      // Add children if expanded
      if (hasChildren && isExpanded) {
        const children = childrenIds
          .map(id => instanceMap.get(id))
          .filter((c): c is Instance => c !== undefined)
          .sort((a, b) => a.createdAt - b.createdAt);

        children.forEach((child, index) => {
          const isLast = index === children.length - 1;
          addInstance(
            child,
            depth + 1,
            [...parentChain, !isLastChild],
            isLast
          );
        });
      }
    };

    // Sort root instances by custom order, then by creation time for new ones
    const customOrder = this.rootInstanceOrder();
    const sortedRoots = rootInstances.sort((a, b) => {
      const aIndex = customOrder.indexOf(a.id);
      const bIndex = customOrder.indexOf(b.id);

      // Both have custom order
      if (aIndex !== -1 && bIndex !== -1) {
        return aIndex - bIndex;
      }
      // Only a has custom order (a comes first)
      if (aIndex !== -1) return -1;
      // Only b has custom order (b comes first)
      if (bIndex !== -1) return 1;
      // Neither has custom order - sort by creation time
      return a.createdAt - b.createdAt;
    });

    sortedRoots.forEach((instance, index) => {
      addInstance(instance, 0, [], index === sortedRoots.length - 1);
    });

    return result;
  });

  onFilterChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.filterText.set(input.value);
  }

  onStatusFilterChange(event: Event): void {
    const select = event.target as HTMLSelectElement;
    this.statusFilter.set(select.value);
  }

  onSelectInstance(instanceId: string): void {
    this.store.setSelectedInstance(instanceId);
  }

  onTerminateInstance(instanceId: string): void {
    this.store.terminateInstance(instanceId);
  }

  onRestartInstance(instanceId: string): void {
    this.store.restartInstance(instanceId);
  }

  onToggleExpand(instanceId: string): void {
    this.collapsedIds.update(current => {
      const newSet = new Set(current);
      if (newSet.has(instanceId)) {
        // Was collapsed, now expand (remove from collapsed set)
        newSet.delete(instanceId);
      } else {
        // Was expanded, now collapse (add to collapsed set)
        newSet.add(instanceId);
      }
      return newSet;
    });
  }

  onRenameInstance(event: { id: string; newName: string }): void {
    this.store.renameInstance(event.id, event.newName);
  }

  trackInstance(index: number, item: HierarchicalInstance): string {
    return item.instance.id;
  }

  /**
   * Handle drag-drop reordering of root instances
   */
  onDrop(event: CdkDragDrop<HierarchicalInstance[]>): void {
    const draggedItem = event.item.data as HierarchicalInstance;

    // Only allow reordering root instances
    if (draggedItem.depth > 0) return;

    // Get current root instance IDs in display order
    const currentRoots = this.hierarchicalInstances()
      .filter(h => h.depth === 0)
      .map(h => h.instance.id);

    // Find source and target positions within root instances only
    const fromRootIndex = currentRoots.indexOf(draggedItem.instance.id);
    if (fromRootIndex === -1) return;

    // Calculate target root index from flat list positions
    // We need to map from flat list index to root index
    const flatList = this.hierarchicalInstances();
    let targetRootIndex = 0;

    // Find which root instance position we're dropping at
    for (let i = 0; i <= event.currentIndex && i < flatList.length; i++) {
      if (flatList[i].depth === 0 && flatList[i].instance.id !== draggedItem.instance.id) {
        if (i < event.currentIndex) {
          targetRootIndex++;
        }
      }
    }

    // If dropping after the dragged item's original position, adjust
    if (event.currentIndex > event.previousIndex) {
      targetRootIndex++;
    }

    // Clamp to valid range
    targetRootIndex = Math.min(targetRootIndex, currentRoots.length - 1);

    if (fromRootIndex === targetRootIndex) return;

    // Reorder the array
    const newOrder = [...currentRoots];
    moveItemInArray(newOrder, fromRootIndex, targetRootIndex);

    // Update and persist
    this.rootInstanceOrder.set(newOrder);
    this.saveOrder(newOrder);
  }

  /**
   * Load saved order from localStorage
   */
  private loadOrder(): string[] {
    try {
      const saved = localStorage.getItem(this.ORDER_STORAGE_KEY);
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  }

  /**
   * Save order to localStorage
   */
  private saveOrder(order: string[]): void {
    try {
      localStorage.setItem(this.ORDER_STORAGE_KEY, JSON.stringify(order));
    } catch {
      // Ignore storage errors
    }
  }
}
