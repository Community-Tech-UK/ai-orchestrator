import { Injectable, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';

const KEY = 'mobile.pinned-projects';

/** Project pins are per paired host and survive restarts in Preferences. */
@Injectable({ providedIn: 'root' })
export class PinnedProjectsService {
  private readonly pins = signal<Record<string, string[]>>({});

  constructor() { void this.load(); }

  keysFor(hostId: string): readonly string[] {
    return this.pins()[hostId] ?? [];
  }

  has(hostId: string, projectKey: string): boolean {
    return this.keysFor(hostId).includes(projectKey);
  }

  async toggle(hostId: string, projectKey: string): Promise<void> {
    if (!hostId || !projectKey) return;
    const current = this.keysFor(hostId);
    const next = current.includes(projectKey)
      ? current.filter((key) => key !== projectKey)
      : [projectKey, ...current];
    this.pins.update((all) => ({ ...all, [hostId]: [...next] }));
    try { await Preferences.set({ key: KEY, value: JSON.stringify(this.pins()) }); }
    catch { /* Preferences is unavailable in the browser preview. */ }
  }

  private async load(): Promise<void> {
    try {
      const stored = await Preferences.get({ key: KEY });
      if (!stored.value) return;
      const parsed = JSON.parse(stored.value) as Record<string, string[]>;
      if (parsed && typeof parsed === 'object') this.pins.set(parsed);
    } catch { /* ignore a missing or unreadable pin list */ }
  }
}
