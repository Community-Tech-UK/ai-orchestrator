import { Injectable, computed, signal } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import type { PairedHost } from './models';

const HOSTS_KEY = 'aio.hosts';
const ACTIVE_KEY = 'aio.activeHostId';

interface SecureHostStoragePlugin {
  get(options: { key: string }): Promise<{ value?: string | null }>;
  set(options: { key: string; value: string }): Promise<void>;
  remove(options: { key: string }): Promise<void>;
}

const SecureHostStorage = registerPlugin<SecureHostStoragePlugin>('SecureHostStorage');
const usesSecureHostStorage = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';

/**
 * Persisted list of paired hosts + the active selection.
 *
 * On native iOS, the host list (including bearer tokens) is kept in Keychain via
 * a local Capacitor plugin. Existing installs migrate once from Preferences.
 * Browser/dev builds continue to use Preferences so the app stays easy to run locally.
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
      this.loadHostsValue(),
      Preferences.get({ key: ACTIVE_KEY }),
    ]);
    if (hostsRaw) {
      try {
        const parsed = JSON.parse(hostsRaw) as PairedHost[];
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
    await this.saveHostsValue(JSON.stringify(this._hosts()));
    const active = this._activeId();
    if (active) {
      await Preferences.set({ key: ACTIVE_KEY, value: active });
    } else {
      await Preferences.remove({ key: ACTIVE_KEY });
    }
  }

  private async loadHostsValue(): Promise<string | null> {
    if (!usesSecureHostStorage) {
      const stored = await Preferences.get({ key: HOSTS_KEY });
      return stored.value;
    }

    const secure = await SecureHostStorage.get({ key: HOSTS_KEY });
    if (typeof secure.value === 'string') {
      return secure.value;
    }

    const legacy = await Preferences.get({ key: HOSTS_KEY });
    if (legacy.value !== null) {
      await SecureHostStorage.set({ key: HOSTS_KEY, value: legacy.value });
      await Preferences.remove({ key: HOSTS_KEY });
    }
    return legacy.value;
  }

  private async saveHostsValue(value: string): Promise<void> {
    if (!usesSecureHostStorage) {
      await Preferences.set({ key: HOSTS_KEY, value });
      return;
    }

    await SecureHostStorage.set({ key: HOSTS_KEY, value });
    await Preferences.remove({ key: HOSTS_KEY });
  }
}
