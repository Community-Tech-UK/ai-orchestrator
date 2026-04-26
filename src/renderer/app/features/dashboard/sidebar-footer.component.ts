/**
 * Sidebar Footer Component
 * Compact stats row + a Close All control when sessions exist.
 */

import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { InstanceStore } from '../../core/state/instance.store';

@Component({
  selector: 'app-sidebar-footer',
  standalone: true,
  imports: [DecimalPipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (hasContent()) {
      <div class="sidebar-footer">
        @if (hasStats()) {
          <div class="stats">
            @if (store.instanceCount() > 0) {
              <span class="stat">
                {{ store.instanceCount() }} session{{ store.instanceCount() === 1 ? '' : 's' }}
              </span>
            }
            @if (store.totalContextUsage().total > 0) {
              <span class="stat">
                {{ store.totalContextUsage().percentage | number: '1.0-0' }}% ctx
              </span>
            }
            @if (store.totalContextUsage().costEstimate) {
              <span class="stat cost-stat">
                ~\${{ store.totalContextUsage().costEstimate | number: '1.2-2' }}
              </span>
            }
          </div>
        }
        @if (store.instanceCount() > 0) {
          <button
            type="button"
            class="btn-close-all"
            (click)="closeAllClicked.emit()"
            title="Close all sessions"
          >
            Close All
          </button>
        }
      </div>
    }
  `,
  styleUrl: './sidebar-footer.component.scss'
})
export class SidebarFooterComponent {
  store = inject(InstanceStore);

  readonly hasStats = computed(() =>
    this.store.instanceCount() > 0
      || this.store.totalContextUsage().total > 0
      || !!this.store.totalContextUsage().costEstimate
  );

  readonly hasContent = computed(() => this.hasStats() || this.store.instanceCount() > 0);

  closeAllClicked = output<void>();
}
