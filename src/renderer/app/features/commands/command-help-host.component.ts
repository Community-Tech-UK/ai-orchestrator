import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { OverlayShellComponent } from '../overlay/overlay-shell.component';
import { CommandHelpController } from './command-help.controller';
import type { OverlayItem } from '../overlay/overlay.types';
import type { ExtendedCommand } from '../../core/state/command.store';

@Component({
  selector: 'app-command-help-host',
  standalone: true,
  imports: [OverlayShellComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-overlay-shell
      [controller]="controller"
      (closeRequested)="closeRequested.emit()"
      (selected)="onSelected($event)"
    />
  `,
})
export class CommandHelpHostComponent {
  protected readonly controller = inject(CommandHelpController);
  closeRequested = output<void>();

  onSelected(item: OverlayItem): void {
    void this.controller.run(item as OverlayItem<ExtendedCommand>);
  }
}
