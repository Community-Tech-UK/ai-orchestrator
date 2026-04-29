import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
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
    <ng-template #resumeFooter let-item>
      <span class="resume-actions">
        @for (action of item.value.availableActions; track action) {
          <button
            class="resume-action"
            type="button"
            (click)="onAction($event, item, action)"
          >
            {{ controller.actionLabel(action) }}
          </button>
        }
      </span>
    </ng-template>

    <app-overlay-shell
      [controller]="controller"
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
  `],
})
export class ResumePickerHostComponent {
  protected readonly controller = inject(ResumePickerController);
  closeRequested = output<void>();

  async onSelect(item: OverlayItem): Promise<void> {
    const handled = await this.controller.run(item as OverlayItem<ResumePickerItem>);
    if (handled) {
      this.closeRequested.emit();
    }
  }

  async onAction(event: MouseEvent, item: OverlayItem, action: ResumePickerAction): Promise<void> {
    event.stopPropagation();
    const handled = await this.controller.executeAction(
      (item as OverlayItem<ResumePickerItem>).value,
      action,
    );
    if (handled) {
      this.closeRequested.emit();
    }
  }
}
