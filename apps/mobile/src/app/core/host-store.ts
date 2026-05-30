import { Injectable, computed, signal } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import type { PairedHost } from './models';

const HOSTS_KEY = 'aio.hosts';
const ACTIVE_KEY = 'aio.activeHostId';

/**
 * Persisted list of paired hosts + the active selection. Tokens live here
 * (via Capacitor Preferences / UserDefaults). Keychain hardening is a later phase.
 */
@Injectable({ providedIn: 'root' })
export class HostStore {
  private readonly _hosts = signal<PairedHost[]>([]);
  private readonly _activeId = signal<string | null>(null);
  private loaded = false;

  readonly hosts = this._hosts.asReadonly();
  readonly activeId = this._activeId.asReadonly();
  readonly activeHost = computed(
    () => this._hosts().find((h) => h.id === this._activeId()) ?? null,
  );

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    this.loaded = true;
    const [hostsRaw, active] = await Promise.all([
      Preferences.get({ key: HOSTS_KEY }),
      Preferences.get({ key: ACTIVE_KEY }),
    ]);
    if (hostsRaw.value) {
      try {
        const parsed = JSON.parse(hostsRaw.value) as PairedHost[];
        if (Array.isArray(parsed)) {
          this._hosts.set(parsed);
        }
      } catch {
        /* ignore corrupt storage */
      }
    }
    this._activeId.set(active.value ?? this._hosts()[0]?.id ?? null);
  }

  async addHost(host: PairedHost): Promise<void> {
    this._hosts.set([...this._hosts().filter((h) => h.id !== host.id), host]);
    if (!this._activeId()) {
      this._activeId.set(host.id);
    }
    await this.persist();
  }

  async removeHost(id: string): Promise<void> {
    this._hosts.set(this._hosts().filter((h) => h.id !== id));
    if (this._activeId() === id) {
      this._activeId.set(this._hosts()[0]?.id ?? null);
    }
    await this.persist();
  }

  async setActive(id: string): Promise<void> {
    this._activeId.set(id);
    await this.persist();
  }

  private async persist(): Promise<void> {
    await Preferences.set({ key: HOSTS_KEY, value: JSON.stringify(this._hosts()) });
    const active = this._activeId();
    if (active) {
      await Preferences.set({ key: ACTIVE_KEY, value: active });
    } else {
      await Preferences.remove({ key: ACTIVE_KEY });
    }
  }
}
