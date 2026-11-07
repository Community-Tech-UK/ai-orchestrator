import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { ActionDispatchService } from '../../core/services/action-dispatch.service';
import { KeybindingService } from '../../core/services/keybinding.service';

/** Own global actions for the app lifetime, independent of routed dashboards. */
@Injectable({ providedIn: 'root' })
export class PaletteOverlaysService {
  private readonly router = inject(Router);
  private readonly actions = inject(ActionDispatchService);
  readonly commandPaletteOpen = signal(false);
  readonly commandHelpOpen = signal(false);

  constructor() {
    // Register the actual document listener even when boot opens a secondary page.
    inject(KeybindingService);
    const cleanup = [
      this.actions.register({ id: 'toggle-command-palette', run: () => {
        this.commandHelpOpen.set(false);
        this.commandPaletteOpen.update(open => !open);
      } }),
      this.actions.register({ id: 'app.open-command-help', run: () => {
        this.commandPaletteOpen.set(false);
        this.commandHelpOpen.set(true);
      } }),
      ...[
        ['toggle-settings', '/settings', undefined],
        ['app.open-rlm', '/rlm', undefined],
        ['app.open-browser', '/browser', undefined],
        ['app.open-doctor', '/settings', 'doctor'],
      ].map(([id, path, fragment]) => this.actions.register({ id: id!, run: async () => {
        this.commandPaletteOpen.set(false);
        this.commandHelpOpen.set(false);
        await this.router.navigate([path!], { fragment });
      } })),
    ];
    inject(DestroyRef).onDestroy(() => cleanup.forEach(unregister => unregister()));
  }
}
