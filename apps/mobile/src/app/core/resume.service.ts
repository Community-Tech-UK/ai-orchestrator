import { Injectable, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';
import { Preferences } from '@capacitor/preferences';
import { HostStore } from './host-store';
import { isRestorableUrl, parseSavedRoute } from './resume-route';

const KEY = 'aio.lastRoute';

/**
 * Returns the user to where they were when the app process didn't survive —
 * iOS routinely evicts the backgrounded app (memory pressure, long locks), and
 * without this every relaunch lands on the Hosts screen.
 *
 * The Face ID gate is only an overlay, so this composes cleanly with App Lock:
 * restoration happens behind the lock screen and unlocking reveals the
 * restored session.
 */
@Injectable({ providedIn: 'root' })
export class ResumeService {
  private readonly router = inject(Router);
  private readonly hostStore = inject(HostStore);

  constructor() {
    // Track every meaningful navigation; the newest one wins.
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd && isRestorableUrl(event.urlAfterRedirects)) {
        void Preferences.set({
          key: KEY,
          value: JSON.stringify({ url: event.urlAfterRedirects, at: Date.now() }),
        });
      }
    });
  }

  /**
   * Jump back to the last saved screen on cold start. Skipped when there's no
   * paired active host, or when something else (push-notification deep link,
   * a fast user tap) has already navigated away from the launch route.
   */
  async restore(): Promise<void> {
    if (!this.hostStore.activeHost()) return;
    const { value } = await Preferences.get({ key: KEY });
    const saved = parseSavedRoute(value, Date.now());
    if (!saved) return;
    if (this.router.url !== '/' && this.router.url !== '') return;
    await this.router.navigateByUrl(saved.url);
  }
}
