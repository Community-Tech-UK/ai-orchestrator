import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { OverlayShellComponent } from '../overlay/overlay-shell.component';
import type { OverlayItem } from '../overlay/overlay.types';
import type { SessionPickerItem } from '../../../../shared/types/prompt-history.types';
import { SessionPickerController } from './session-picker.controller';

@Component({
  selector: 'app-session-picker-host',
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
export class SessionPickerHostComponent {
  protected readonly controller = inject(SessionPickerController);
  closeRequested = output<void>();

  async onSelect(item: OverlayItem): Promise<void> {
    const handled = await this.controller.run(item as OverlayItem<SessionPickerItem>);
    if (handled) {
      this.closeRequested.emit();
    }
  }
}
