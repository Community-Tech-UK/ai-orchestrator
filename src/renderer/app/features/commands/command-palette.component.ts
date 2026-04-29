import { ChangeDetectionStrategy, Component, inject, output } from '@angular/core';
import { OverlayShellComponent } from '../overlay/overlay-shell.component';
import { CommandPaletteController } from './command-palette.controller';
import type { ExtendedCommand } from '../../core/state/command.store';
import type { OverlayItem } from '../overlay/overlay.types';

@Component({
  selector: 'app-command-palette',
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
export class CommandPaletteComponent {
  protected readonly controller = inject(CommandPaletteController);

  closeRequested = output<void>();
  commandExecuted = output<{ commandId: string; args: string[] }>();

  async onSelected(item: OverlayItem): Promise<void> {
    const commandItem = item as OverlayItem<ExtendedCommand>;
    const ran = await this.controller.run(commandItem);
    if (ran) {
      this.commandExecuted.emit({ commandId: commandItem.value.id, args: [] });
      this.closeRequested.emit();
    }
  }
}
