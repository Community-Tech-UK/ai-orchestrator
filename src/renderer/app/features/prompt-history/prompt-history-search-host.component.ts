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
    <app-overlay-shell
      [controller]="controller"
      (closeRequested)="closeRequested.emit()"
      (selected)="onSelect($event)"
    />
  `,
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
