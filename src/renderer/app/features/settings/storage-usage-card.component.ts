import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, effect, inject, viewChild } from '@angular/core';
import { StorageUsageStore } from '../../core/state/storage-usage.store';
import { formatStorageBytes } from '../../../../shared/utils/storage-format';
import type { StorageCleanupTarget } from '../../../../shared/types/storage.types';
import { createFocusTrap, type FocusTrapHandle } from '../../shared/utils/focus-trap';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';
import { LeftoverWorktreesCardComponent } from './leftover-worktrees-card.component';

@Component({
  selector: 'app-storage-usage-card', standalone: true,
  imports: [AioTooltipDirective, LeftoverWorktreesCardComponent], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './storage-usage-card.component.html', styleUrl: './storage-usage-card.component.scss',
})
export class StorageUsageCardComponent implements OnInit, OnDestroy {
  readonly store = inject(StorageUsageStore);
  readonly bytes = formatStorageBytes;
  readonly reviewHint = copyFor('diskSpace.review');
  readonly refreshHint = copyFor('diskSpace.refresh');
  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');
  private readonly cancelButton = viewChild<ElementRef<HTMLElement>>('cancelButton');
  private trap: FocusTrapHandle | null = null;
  constructor() {
    effect(() => {
      const dialog = this.dialog()?.nativeElement;
      if (this.store.preview() && dialog && !this.trap) {
        this.trap = createFocusTrap(dialog, { initialFocus: this.cancelButton()?.nativeElement });
        this.trap.activate();
      } else if (!dialog || !this.store.preview()) this.releaseFocus();
    });
  }
  ngOnInit(): void { void this.store.refresh(); }
  ngOnDestroy(): void { this.store.stopPolling(); this.store.cancel(); this.releaseFocus(); }
  private releaseFocus(): void { this.trap?.deactivate(); this.trap?.restore(); this.trap = null; }
  date(timestamp: number | null): string { return timestamp === null ? 'unknown date' : new Date(timestamp).toLocaleString(); }
  heading(target: StorageCleanupTarget): string {
    return { 'event-record': 'Clear the debug record?', 'event-record-shrink': 'Shrink the conversation file?',
      'rlm-backups': 'Delete older learning database backups?', 'session-records': 'Remove old saved session records?',
      'activity-logs': 'Remove old session activity logs?' }[target];
  }
  confirmLabel(target: StorageCleanupTarget): string {
    return { 'event-record': 'Clear the debug record', 'event-record-shrink': 'Shrink the file', 'rlm-backups': 'Delete the older backups',
      'session-records': 'Remove old session records', 'activity-logs': 'Remove old logs' }[target];
  }
}
