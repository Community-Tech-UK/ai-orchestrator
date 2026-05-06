import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { OverlayShellComponent } from '../overlay/overlay-shell.component';
import type { OverlayItem } from '../overlay/overlay.types';
import type { PromptHistoryEntry } from '../../../../shared/types/prompt-history.types';
import { PromptHistorySearchController } from './prompt-history-search.controller';

@Component({
  selector: 'app-prompt-history-search-host',
  standalone: true,
  imports: [OverlayShellComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ng-template #scopeControls>
      <div class="prompt-recall-scope" role="group" aria-label="Prompt recall scope">
        @for (option of controller.scopeOptions; track option.id) {
          <button
            type="button"
            class="scope-option"
            [class.active]="controller.scope() === option.id"
            [attr.aria-pressed]="controller.scope() === option.id"
            (click)="controller.setScope(option.id)"
          >
            {{ option.label }}
          </button>
        }
      </div>
    </ng-template>

    <ng-template #promptFooter let-item>
      @if (controller.attachmentRecallNote(item.value); as note) {
        <span class="recall-note">{{ note }}</span>
      }
    </ng-template>

    <app-overlay-shell
      [controller]="controller"
      [headerAccessory]="scopeControls"
      [itemFooter]="promptFooter"
      (closeRequested)="closeRequested.emit()"
      (selected)="onSelect($event)"
    />
  `,
  styles: [`
    .prompt-recall-scope {
      display: flex;
      gap: 4px;
      padding: 8px 16px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.07);
    }

    .scope-option {
      min-height: 28px;
      padding: 0 10px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 5px;
      background: transparent;
      color: var(--text-secondary);
      font: 12px var(--font-mono);
      cursor: pointer;
    }

    .scope-option:hover,
    .scope-option.active {
      border-color: rgba(var(--primary-rgb), 0.42);
      background: rgba(var(--primary-rgb), 0.12);
      color: var(--text-primary);
    }

    .recall-note {
      color: var(--warning-color, #ffb74d);
      font-size: 12px;
    }
  `],
})
export class PromptHistorySearchHostComponent {
  protected readonly controller = inject(PromptHistorySearchController);
  closeRequested = output<void>();

  onSelect(item: OverlayItem): void {
    if (this.controller.run(item as OverlayItem<PromptHistoryEntry>)) {
      this.closeRequested.emit();
    }
  }
}
