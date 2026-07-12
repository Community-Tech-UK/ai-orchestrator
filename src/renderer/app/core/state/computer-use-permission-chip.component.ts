/**
 * Computer Use Permission Chip
 *
 * Compact title-bar chip shown after the permission banner is dismissed while
 * Computer Use remains enabled and a required permission is still not ready.
 * Clicking it opens Settings → Computer Use. Warning tone for missing
 * permissions, error tone for helper/platform failures.
 */

import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { ComputerUsePermissionStore } from './computer-use-permission.store';

@Component({
  selector: 'app-computer-use-permission-chip',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.chipVisible()) {
      <button
        type="button"
        class="cu-permission-chip"
        [class.error]="store.unavailable()"
        [attr.aria-label]="'Computer Use permissions: open Computer Use settings'"
        [title]="text()"
        (click)="openSettings()"
      >
        {{ text() }}
      </button>
    }
  `,
  styles: [`
    .cu-permission-chip {
      -webkit-app-region: no-drag;
      height: 22px;
      padding: 0 0.6rem;
      border: 1px solid rgba(245, 158, 11, 0.42);
      border-radius: 999px;
      background: rgba(245, 158, 11, 0.14);
      color: #fbbf24;
      cursor: pointer;
      font-size: 0.72rem;
      font-weight: 600;
      white-space: nowrap;
    }

    .cu-permission-chip:hover {
      background: rgba(245, 158, 11, 0.22);
    }

    .cu-permission-chip.error {
      border-color: rgba(239, 68, 68, 0.42);
      background: rgba(239, 68, 68, 0.14);
      color: #fca5a5;
    }

    .cu-permission-chip.error:hover {
      background: rgba(239, 68, 68, 0.22);
    }
  `],
})
export class ComputerUsePermissionChipComponent {
  protected readonly store = inject(ComputerUsePermissionStore);
  private readonly router = inject(Router);

  protected readonly text = computed(() => {
    if (this.store.unavailable()) {
      return 'Computer Use unavailable';
    }
    const count = this.store.attentionCount();
    return `Computer Use: ${count} needed`;
  });

  protected openSettings(): void {
    void this.router.navigate(['/settings'], { queryParams: { tab: 'computer-use' } });
  }
}
