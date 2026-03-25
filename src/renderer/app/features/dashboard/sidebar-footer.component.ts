/**
 * Sidebar Footer Component
 * Footer section of the dashboard sidebar with stats and close all button
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, output, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { InstanceStore } from '../../core/state/instance.store';
import { HistoryStore } from '../../core/state/history.store';
import { RecentDirectoriesIpcService } from '../../core/services/ipc/recent-directories-ipc.service';

@Component({
  selector: 'app-sidebar-footer',
  standalone: true,
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="sidebar-footer">
      <div class="stats">
        <span class="stat">
          {{ projectCount() }} projects
        </span>
        <span class="stat">
          {{ store.instanceCount() }} sessions
        </span>
        @if (store.totalContextUsage().total > 0) {
          <span class="stat">
            {{
              store.totalContextUsage().percentage | number: '1.0-0'
            }}% context
          </span>
        }
        @if (store.totalContextUsage().costEstimate) {
          <span class="stat cost-stat">
            ~\${{
              store.totalContextUsage().costEstimate | number: '1.2-2'
            }}
          </span>
        }
      </div>
      <div class="footer-actions">
        <button
          class="btn-control-plane"
          [class.open]="controlPlaneOpen()"
          (click)="controlPlaneClicked.emit()"
        >
          {{ controlPlaneOpen() ? 'Hide Tools' : 'Tools & Views' }}
        </button>
        @if (store.instanceCount() > 0) {
          <button
            class="btn-close-all"
            (click)="closeAllClicked.emit()"
            title="Close all instances"
          >
            Close All
          </button>
        }
      </div>
    </div>
  `,
  styleUrl: './sidebar-footer.component.scss'
})
export class SidebarFooterComponent {
  store = inject(InstanceStore);
  private historyStore = inject(HistoryStore);
  private recentDirectoriesService = inject(RecentDirectoriesIpcService);
  controlPlaneOpen = input(false);
  private recentProjectKeys = signal<string[]>([]);
  readonly projectCount = computed(() =>
    new Set(
      [
        ...this.store
          .instances()
          .filter((instance) => !instance.parentId)
          .map((instance) => ((instance.workingDirectory || '').trim().toLowerCase()) || '__no_workspace__'),
        ...this.historyStore
          .entries()
          .map((entry) => ((entry.workingDirectory || '').trim().toLowerCase()) || '__no_workspace__'),
        ...this.recentProjectKeys(),
      ]
    ).size
  );

  // Output events
  closeAllClicked = output<void>();
  controlPlaneClicked = output<void>();

  private recentProjectsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    void this.loadRecentProjects();

    // Debounce: when instance or history counts change rapidly (e.g. batch
    // updates), we only fire one IPC call after 500ms of quiet.
    effect(() => {
      this.store.instanceCount();
      this.historyStore.entryCount();
      this.scheduleRecentProjectsRefresh();
    });
  }

  private scheduleRecentProjectsRefresh(): void {
    if (this.recentProjectsTimer) {
      clearTimeout(this.recentProjectsTimer);
    }
    this.recentProjectsTimer = setTimeout(() => {
      this.recentProjectsTimer = null;
      void this.loadRecentProjects();
    }, 500);
  }

  private async loadRecentProjects(): Promise<void> {
    const directories = await this.recentDirectoriesService.getDirectories({
      sortBy: 'lastAccessed',
    });
    this.recentProjectKeys.set(
      directories.map((entry) => ((entry.path || '').trim().toLowerCase()) || '__no_workspace__')
    );
  }
}
