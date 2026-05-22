/**
 * Tracks whether the user has completed first-run setup.
 *
 * The flag is persisted in localStorage so the /setup route is only
 * auto-opened once per installation. The app title-bar chip always
 * provides a manual entry point regardless of the flag.
 */

import { Injectable, signal } from '@angular/core';

const FIRST_RUN_COMPLETE_KEY = 'aiorch.setup.completed';

@Injectable({ providedIn: 'root' })
export class FirstRunService {
  /** True once the user has explicitly dismissed setup (or on subsequent runs). */
  readonly isCompleted = signal(this.read());

  markCompleted(): void {
    this.isCompleted.set(true);
    this.write();
  }

  private read(): boolean {
    if (typeof window === 'undefined') {
      return false;
    }
    try {
      return window.localStorage.getItem(FIRST_RUN_COMPLETE_KEY) === '1';
    } catch {
      return false;
    }
  }

  private write(): void {
    if (typeof window === 'undefined') {
      return;
    }
    try {
      window.localStorage.setItem(FIRST_RUN_COMPLETE_KEY, '1');
    } catch {
      // In-memory signal already updated; ignore storage failures.
    }
  }
}
