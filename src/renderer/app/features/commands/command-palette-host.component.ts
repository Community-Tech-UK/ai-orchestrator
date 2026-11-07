import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SettingsStore } from '../../core/state/settings.store';
import { CommandPaletteComponent } from './command-palette.component';
import { CommandHelpHostComponent } from './command-help-host.component';
import { PaletteOverlaysService } from './palette-overlays.service';

@Component({
  selector: 'app-command-palette-host',
  standalone: true,
  imports: [CommandPaletteComponent, CommandHelpHostComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (settings.harnessRole() === 'coordinator') {
      @if (overlays.commandPaletteOpen()) {
        <app-command-palette (closeRequested)="overlays.commandPaletteOpen.set(false)" />
      }
      @if (overlays.commandHelpOpen()) {
        <app-command-help-host (closeRequested)="overlays.commandHelpOpen.set(false)" />
      }
    }
  `,
})
export class CommandPaletteHostComponent {
  protected readonly settings = inject(SettingsStore);
  protected readonly overlays = inject(PaletteOverlaysService);
}
