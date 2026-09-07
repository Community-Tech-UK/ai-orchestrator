/**
 * UX5 — "you have started a session" is a fact about the past, so it needs a
 * marker that outlives the session.
 *
 * The getting-started bar first derived this step from
 * `InstanceStore.instances().length > 0`, which is the count of sessions open
 * RIGHT NOW. Closing a session removes it from that store
 * (`instance-termination.ts` emits `instanceRemoved`), so a new user who
 * installed a CLI, set a directory, started their first session, used it, and
 * closed it — the ordinary next action — watched the count fall back to zero
 * and the whole bar reappear telling them to start a session.
 *
 * That contradicted the bar's own contract: it unmounts when done precisely
 * because completing the steps IS the dismissal. A step that can un-complete
 * makes that promise false.
 *
 * Persisted in `localStorage` beside `FirstRunService`'s own marker rather than
 * in `AppSettings`: it is per-device UI progress, not configuration, and it
 * must not sync or appear in a settings export.
 */
import { Injectable, signal } from '@angular/core';

const SESSION_STARTED_KEY = 'aio.getting-started.session-started';

@Injectable({ providedIn: 'root' })
export class SessionStartedMarkerService {
  /** True once a session has ever been started on this device. */
  readonly hasStarted = signal(this.read());

  /**
   * Record that a session exists. Idempotent, and never un-records: the step
   * asks whether one has ever been started, and closing it does not undo that.
   */
  markStarted(): void {
    if (this.hasStarted()) return;
    this.hasStarted.set(true);
    this.write();
  }

  private read(): boolean {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem(SESSION_STARTED_KEY) === '1';
    } catch {
      // A blocked or full store just means the bar reappears next launch —
      // annoying, not wrong. Never let it break the app shell.
      return false;
    }
  }

  private write(): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(SESSION_STARTED_KEY, '1');
    } catch {
      // The in-memory signal already carries this session; ignore.
    }
  }
}
