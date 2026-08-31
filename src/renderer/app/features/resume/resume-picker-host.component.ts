import { ChangeDetectionStrategy, Component, inject, output, signal } from '@angular/core';
import { OverlayShellComponent } from '../overlay/overlay-shell.component';
import type { OverlayItem } from '../overlay/overlay.types';
import { ResumePickerController } from './resume-picker.controller';
import type { ResumePickerAction, ResumePickerItem } from './resume-picker.types';

@Component({
  selector: 'app-resume-picker-host',
  standalone: true,
  imports: [OverlayShellComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #resumeHeader>
      @if (controller.lastError(); as error) {
        <div class="resume-error" role="alert" aria-live="assertive">
          {{ error }}
        </div>
      }
    </ng-template>

    <ng-template #resumeFooter let-item>
      <span class="resume-actions">
        @for (action of item.value.availableActions; track action) {
          <button
            class="resume-action"
            type="button"
            [disabled]="isActionDisabled(item, action)"
            [attr.aria-busy]="isActionBusy(item, action) ? 'true' : null"
            [attr.aria-label]="controller.actionAriaLabel(item.value, action)"
            (keydown.enter)="$event.stopPropagation()"
            (keydown.space)="$event.stopPropagation()"
            (click)="onAction($event, item, action)"
          >
            {{ isActionBusy(item, action) ? controller.actionProgressLabel(action) : controller.actionLabel(action) }}
          </button>
        }
      </span>
    </ng-template>

    <app-overlay-shell
      [controller]="controller"
      [headerAccessory]="resumeHeader"
      [itemFooter]="resumeFooter"
      (closeRequested)="closeRequested.emit()"
      (selected)="onSelect($event)"
    />
  `,
  styles: [`
    .resume-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      padding-top: 4px;
    }

    .resume-action {
      min-height: 24px;
      border: 1px solid rgba(var(--primary-rgb), 0.28);
      border-radius: 5px;
      background: rgba(var(--primary-rgb), 0.09);
      color: var(--text-primary);
      font: 11px var(--font-mono);
      cursor: pointer;
    }

    .resume-action:hover {
      background: rgba(var(--primary-rgb), 0.16);
    }

    .resume-action:focus-visible {
      outline: 2px solid var(--focus-ring);
      outline-offset: 2px;
    }

    .resume-action:disabled {
      cursor: wait;
      opacity: 0.65;
    }

    .resume-error {
      margin: 8px 0 0;
      padding: 8px 10px;
      border: 1px solid var(--error-color);
      border-radius: 6px;
      background: var(--error-bg);
      color: var(--text-primary);
      font-size: 12px;
      line-height: 1.4;
    }
  `],
})
export class ResumePickerHostComponent {
  protected readonly controller = inject(ResumePickerController);
  private readonly activeActionKey = signal<string | null>(null);

  closeRequested = output<void>();

  async onSelect(item: OverlayItem): Promise<void> {
    const typedItem = item as OverlayItem<ResumePickerItem>;
    const key = this.actionKey(typedItem, typedItem.value.availableActions[0] ?? 'resumeLatest');
    if (this.activeActionKey()) {
      return;
    }

    this.activeActionKey.set(key);
    try {
      const handled = await this.controller.run(typedItem);
      if (handled) {
        this.closeRequested.emit();
      }
    } finally {
      if (this.activeActionKey() === key) {
        this.activeActionKey.set(null);
      }
    }
  }

  async onAction(event: MouseEvent, item: OverlayItem, action: ResumePickerAction): Promise<void> {
    event.stopPropagation();
    const typedItem = item as OverlayItem<ResumePickerItem>;
    const key = this.actionKey(typedItem, action);
    if (this.activeActionKey()) {
      return;
    }

    this.activeActionKey.set(key);
    try {
      const handled = await this.controller.executeAction(typedItem.value, action);
      if (handled) {
        this.closeRequested.emit();
      }
    } finally {
      if (this.activeActionKey() === key) {
        this.activeActionKey.set(null);
      }
    }
  }

  protected isActionBusy(item: OverlayItem, action: ResumePickerAction): boolean {
    const typedItem = item as OverlayItem<ResumePickerItem>;
    return this.activeActionKey() === this.actionKey(typedItem, action);
  }

  protected isActionDisabled(item: OverlayItem, action: ResumePickerAction): boolean {
    const typedItem = item as OverlayItem<ResumePickerItem>;
    return typedItem.disabled === true
      || this.activeActionKey() !== null
      || this.controller.isActionLoading(typedItem.value, action);
  }

  private actionKey(item: OverlayItem<ResumePickerItem>, action: ResumePickerAction): string {
    return `${item.id}:${action}`;
  }
}
