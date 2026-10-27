import { computed, inject, Injectable, signal } from '@angular/core';
import { RemoteNodeStore } from './remote-node.store';

/**
 * C2: remote-terminal drawer visibility (xterm.js ⇄ node-pty on a worker).
 * The drawer is mounted by the root shell; the workspace rail owns the toggle.
 */
@Injectable({ providedIn: 'root' })
export class TerminalDrawerStore {
  private readonly remoteNodeStore = inject(RemoteNodeStore);
  private readonly _isOpen = signal(false);

  readonly isOpen = this._isOpen.asReadonly();

  /**
   * The remote terminal is useless without a connected worker node: the drawer
   * auto-picks the only connected node and refuses to open otherwise. An
   * already-open drawer keeps its toggle so it can always be closed again.
   */
  readonly isAvailable = computed(
    () => this.remoteNodeStore.connectedNodes().length > 0 || this._isOpen(),
  );

  toggle(): void {
    this._isOpen.update((open) => !open);
  }

  close(): void {
    this._isOpen.set(false);
  }
}
