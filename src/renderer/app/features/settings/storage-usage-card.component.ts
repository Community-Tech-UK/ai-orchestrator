import { SETTINGS_TOOLTIP_COPY } from './settings-tooltip-copy';
import { ChangeDetectionStrategy, Component, ElementRef, OnDestroy, OnInit, afterRenderEffect, inject, viewChild } from '@angular/core';
import { StorageUsageStore } from '../../core/state/storage-usage.store';
import { SettingsStore } from '../../core/state/settings.store';
import { formatStorageBytes } from '../../../../shared/utils/storage-format';
import type { StorageCleanupTarget } from '../../../../shared/types/storage.types';
import { createFocusTrap, type FocusTrapHandle } from '../../shared/utils/focus-trap';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../shared/tooltip/tooltip-copy';

@Component({
  selector: 'app-storage-usage-card', standalone: true,
  imports: [AioTooltipDirective], changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './storage-usage-card.component.html', styleUrl: './storage-usage-card.component.scss',
})
export class StorageUsageCardComponent implements OnInit, OnDestroy {
  protected readonly tooltipCopy = SETTINGS_TOOLTIP_COPY;
  readonly store = inject(StorageUsageStore);
  readonly settings = inject(SettingsStore);
  readonly bytes = formatStorageBytes;
  readonly reviewHint = copyFor('diskSpace.review');
  readonly refreshHint = copyFor('diskSpace.refresh');
  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');
  private readonly cancelButton = viewChild<ElementRef<HTMLElement>>('cancelButton');
  private trap: FocusTrapHandle | null = null;
  private reviewControl: HTMLElement | null = null;
  private backdropPointerDown = false;
  private backdropPointerUp = false;
  constructor() {
    afterRenderEffect(() => {
      const dialog = this.dialog()?.nativeElement;
      if (this.store.preview() && dialog && !this.trap) {
        this.trap = createFocusTrap(dialog, { initialFocus: this.cancelButton()?.nativeElement });
        this.trap.activate();
      } else if (!dialog || !this.store.preview()) this.releaseFocus();
    });
  }
  ngOnInit(): void { void this.store.refresh(); }
  ngOnDestroy(): void { this.store.stopPolling(); this.store.cancel(); this.trap?.deactivate(); this.trap = null; this.reviewControl = null; }
  protected onBackdropPointerDown(event: PointerEvent): void {
    this.backdropPointerDown = event.target === event.currentTarget;
    this.backdropPointerUp = false;
    if (this.backdropPointerDown) event.preventDefault();
  }
  protected onBackdropPointerUp(event: PointerEvent): void {
    this.backdropPointerUp = event.target === event.currentTarget;
  }
  protected onBackdropClick(event: MouseEvent): void {
    const dismiss = this.backdropPointerDown && this.backdropPointerUp && event.target === event.currentTarget;
    this.backdropPointerDown = false; this.backdropPointerUp = false;
    if (dismiss) this.store.cancel();
  }
  rememberReviewControl(event: Event): void {
    this.reviewControl = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  }
  private releaseFocus(): void {
    this.trap?.deactivate(); this.trap?.restore(); this.trap = null;
    if (this.store.busy() || this.store.preview()) return;
    // A failed initial request has no trap. Keep a later deliberate focus elsewhere.
    if (this.reviewControl?.isConnected && (document.activeElement === document.body || document.activeElement === this.reviewControl)) this.reviewControl.focus();
    this.reviewControl = null;
  }
  protected countLabel(target: StorageCleanupTarget, count: number): string {
    const amount = count.toLocaleString();
    if (target === 'event-record') return `${amount} ${count === 1 ? 'entry' : 'entries'}`;
    if (target === 'session-records' || target === 'activity-logs') return `${amount} ${count === 1 ? 'file' : 'files'}`;
    return `${amount} ${count === 1 ? 'item' : 'items'}`;
  }
  date(timestamp: number | null): string { return timestamp === null ? 'unknown date' : new Date(timestamp).toLocaleString(); }
  heading(target: StorageCleanupTarget): string {
    return { 'event-record': 'Clear the debug record?', 'event-record-shrink': 'Shrink the conversation file?',
      'rlm-backups': 'Delete older learning database backups?', 'session-records': 'Remove old saved session records?',
      'activity-logs': 'Remove old session activity logs?', 'legacy-app-data': 'Move the older Harness data folder to the Bin?',
      'claude-attachments': 'Clear old pasted attachments?', 'codex-state-backups': 'Delete older Codex safety copies?',
      'rtk-history': "Trim RTK's command history?" }[target];
  }
  confirmLabel(target: StorageCleanupTarget): string {
    return { 'event-record': 'Clear the debug record', 'event-record-shrink': 'Shrink the file', 'rlm-backups': 'Delete the older backups',
      'session-records': 'Remove old session records', 'activity-logs': 'Remove old logs',
      'legacy-app-data': 'Move to the Bin', 'claude-attachments': 'Clear the old copies',
      'codex-state-backups': 'Delete the older copies', 'rtk-history': 'Trim the history' }[target];
  }
  cancelLabel(target: StorageCleanupTarget): string {
    if (target === 'event-record-shrink') return 'Not now';
    return target === 'legacy-app-data' || target === 'rtk-history' ? 'Keep it' : 'Keep them';
  }
}
