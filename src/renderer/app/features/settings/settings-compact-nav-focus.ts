import { createFocusTrap, type FocusTrapHandle } from '../../shared/utils/focus-trap';

/** Keeps keyboard focus in the temporary Settings navigation overlay. */
export class SettingsCompactNavFocus {
  private trap: FocusTrapHandle | null = null;

  sync(open: boolean, nav: HTMLElement | null): void {
    if (open) {
      if (this.trap || !nav) return;
      this.trap = createFocusTrap(nav);
      this.trap.activate();
      return;
    }
    if (!this.trap) return;
    this.trap.deactivate();
    this.trap.restore();
    this.trap = null;
  }

  destroy(): void {
    this.trap?.deactivate();
    this.trap = null;
  }
}
