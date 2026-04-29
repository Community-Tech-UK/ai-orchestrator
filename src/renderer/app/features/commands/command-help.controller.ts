import { Injectable } from '@angular/core';
import { CommandPaletteController } from './command-palette.controller';
import type { ExtendedCommand } from '../../core/state/command.store';
import type { OverlayItem } from '../overlay/overlay.types';

@Injectable({ providedIn: 'root' })
export class CommandHelpController extends CommandPaletteController {
  override readonly title = 'Command help';
  override readonly placeholder = 'Filter command help...';
  override readonly emptyLabel = 'No command help found';

  override async run(item: OverlayItem<ExtendedCommand>): Promise<boolean> {
    this.setQuery(item.value.usage ?? `/${item.value.name}`);
    return true;
  }
}
