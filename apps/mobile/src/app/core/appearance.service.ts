import { Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

export type AppearancePreference = 'system' | 'light' | 'dark';

const KEY = 'mobile.appearance';

@Injectable({ providedIn: 'root' })
export class AppearanceService {
  readonly preference = signal<AppearancePreference>('system');

  constructor() {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener('change', () => this.apply());
    void this.load();
  }

  async set(preference: AppearancePreference): Promise<void> {
    this.preference.set(preference);
    this.apply();
    try { await Preferences.set({ key: KEY, value: preference }); }
    catch { /* Preferences is unavailable in the browser preview. */ }
  }

  private async load(): Promise<void> {
    try {
      const stored = await Preferences.get({ key: KEY });
      if (stored.value === 'light' || stored.value === 'dark' || stored.value === 'system') {
        this.preference.set(stored.value);
      }
    } catch { /* keep the system default */ }
    this.apply();
  }

  private apply(): void {
    const preference = this.preference();
    document.documentElement.dataset['appearance'] = preference;
    const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true;
    const dark = preference === 'dark' || (preference === 'system' && systemDark);
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  }
}
