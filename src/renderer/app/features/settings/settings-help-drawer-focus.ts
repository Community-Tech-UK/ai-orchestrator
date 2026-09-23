/**
 * Settings Help-drawer focus management.
 *
 * Extracted from `SettingsComponent` to keep it under the repo's LOC ratchet
 * (same shape as `settings-viewport-media.ts`). While the transient Help
 * drawer is open, focus is trapped inside it via the shared `createFocusTrap`
 * contract: initial focus lands in the drawer, Tab cycles within it, and
 * closing restores focus to the control that opened it.
 */

import { createFocusTrap, type FocusTrapHandle } from '../../shared/utils/focus-trap';

export class SettingsHelpDrawerFocus {
  private trap: FocusTrapHandle | null = null;

  /**
   * Reconcile the trap with the rendered drawer state. Called from
   * `ngAfterViewChecked` so it also covers open/close paths that bypass
   * `closeHelpDrawer()` (viewport media changes, direct signal writes).
   */
  sync(open: boolean, drawer: HTMLElement | null): void {
    if (open) {
      if (this.trap || !drawer) return;
      this.trap = createFocusTrap(drawer);
      this.trap.activate();
      return;
    }
    if (!this.trap) return;
    this.trap.deactivate();
    this.trap.restore();
    this.trap = null;
  }

  /** Drop the trap without restoring focus — the component is going away. */
  destroy(): void {
    this.trap?.deactivate();
    this.trap = null;
  }
}
