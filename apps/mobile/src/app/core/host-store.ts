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
const prefersSecureHostStorage = Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios';

/**
 * True when the failure indicates the native plugin simply isn't registered in
 * the running binary — e.g. the JS bundle was updated (cap copy/sync) but the
 * app wasn't recompiled in Xcode, so `SecureHostStoragePlugin` isn't present.
 * Capacitor throws `"SecureHostStorage" plugin is not implemented on ios` in
 * that case. We deliberately do NOT treat genuine Keychain errors (read/write
 * failed, encoding failed) as "unavailable": those are real device faults and
 * silently downgrading bearer-token storage to Preferences would be worse than
 * surfacing the error.
 */
function isSecureStorageUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /not implemented|not available|unimplemented|unavailable/i.test(message);
}

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
  // Starts true on iOS; flips to false (for the session) if the native Keychain
  // plugin turns out to be missing, so reads and writes stay on the same backend.
  private secureStorageUsable = prefersSecureHostStorage;
  private secureFallbackWarned = false;

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
    if (!this.secureStorageUsable) {
      const stored = await Preferences.get({ key: HOSTS_KEY });
      return stored.value;
    }

    try {
      const secure = await SecureHostStorage.get({ key: HOSTS_KEY });
      if (typeof secure.value === 'string') {
        return secure.value;
      }

      // First launch on a build with secure storage: migrate any legacy value.
      const legacy = await Preferences.get({ key: HOSTS_KEY });
      if (legacy.value !== null) {
        await SecureHostStorage.set({ key: HOSTS_KEY, value: legacy.value });
        await Preferences.remove({ key: HOSTS_KEY });
      }
      return legacy.value;
    } catch (err) {
      if (isSecureStorageUnavailable(err)) {
        this.disableSecureStorage(err);
        const stored = await Preferences.get({ key: HOSTS_KEY });
        return stored.value;
      }
      throw err;
    }
  }

  private async saveHostsValue(value: string): Promise<void> {
    if (!this.secureStorageUsable) {
      await Preferences.set({ key: HOSTS_KEY, value });
      return;
    }

    try {
      await SecureHostStorage.set({ key: HOSTS_KEY, value });
      await Preferences.remove({ key: HOSTS_KEY });
    } catch (err) {
      if (isSecureStorageUnavailable(err)) {
        this.disableSecureStorage(err);
        await Preferences.set({ key: HOSTS_KEY, value });
        return;
      }
      throw err;
    }
  }

  /**
   * Permanently (for this session) route host storage through Preferences after
   * the native Keychain plugin is found to be missing. Warns once so the
   * security downgrade is visible in logs but doesn't spam.
   */
  private disableSecureStorage(err: unknown): void {
    this.secureStorageUsable = false;
    if (!this.secureFallbackWarned) {
      this.secureFallbackWarned = true;
      console.warn(
        '[HostStore] Native SecureHostStorage plugin is unavailable; falling back to ' +
          'Preferences. Paired host tokens will NOT be stored in the iOS Keychain until ' +
          'the app is rebuilt and reinstalled natively (npm run ios).',
        err,
      );
    }
  }
}
