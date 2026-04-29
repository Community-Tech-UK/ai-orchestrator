import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { OverlayShellComponent } from '../overlay/overlay-shell.component';
import type { OverlayItem } from '../overlay/overlay.types';
import type { ModelPickerItem } from '../../../../shared/types/prompt-history.types';
import { ModelPickerController } from './model-picker.controller';

@Component({
  selector: 'app-model-picker-host',
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
export class ModelPickerHostComponent {
  protected readonly controller = inject(ModelPickerController);
  closeRequested = output<void>();

  async onSelect(item: OverlayItem): Promise<void> {
    const handled = await this.controller.run(item as OverlayItem<ModelPickerItem>);
    if (handled) {
      this.closeRequested.emit();
    }
  }
}
