import { Injectable, computed, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const ENABLED_KEY = 'aio.appLock.enabled';

/**
 * Biometric (Face ID / Touch ID) app lock.
 *
 * Security model: this is a remote control surface for a shell-capable machine,
 * so a lost or unlocked phone must not reveal transcripts or let someone
 * approve commands. We therefore:
 *  - require biometric auth on cold start (when enabled + available), and
 *  - re-lock whenever the app goes to the background, so resuming re-prompts
 *    and the iOS app-switcher snapshot shows the lock screen, not the session.
 *
 * No-ops on the web/dev build (Capacitor.isNativePlatform() === false) so the
 * app stays usable in a browser without a device. Defaults to enabled; the user
 * can turn it off from the Hosts screen. `allowDeviceCredential` lets the device
 * passcode act as a fallback when biometrics fail or aren't enrolled.
 */
@Injectable({ providedIn: 'root' })
export class AppLockService {
  private readonly _enabled = signal(true);
  private readonly _available = signal(false);
  private readonly _locked = signal(false);
  private readonly _biometryLabel = signal('Face ID');
  private initialized = false;

  /** Whether the user has the lock turned on (persisted). */
  readonly enabled = this._enabled.asReadonly();
  /** Whether the device actually has biometrics available. */
  readonly available = this._available.asReadonly();
  /** Whether the lock screen should currently be shown. */
  readonly locked = this._locked.asReadonly();
  /** Friendly name for the CTA: "Face ID", "Touch ID", or "biometrics". */
  readonly biometryLabel = this._biometryLabel.asReadonly();

  /** True only when a real biometric gate should be enforced. */
  readonly active = computed(
    () => Capacitor.isNativePlatform() && this._enabled() && this._available(),
  );

  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    const stored = await Preferences.get({ key: ENABLED_KEY });
    if (stored.value !== null) {
      this._enabled.set(stored.value === 'true');
    }

    if (!Capacitor.isNativePlatform()) {
      // Web/dev: never trap the user behind a gate we can't satisfy.
      this._available.set(false);
      this._locked.set(false);
      return;
    }

    try {
      const mod = await import('@aparajita/capacitor-biometric-auth');
      const info = await mod.BiometricAuth.checkBiometry();
      this._available.set(info.isAvailable);
      const T = mod.BiometryType;
      this._biometryLabel.set(
        info.biometryType === T.faceId
          ? 'Face ID'
          : info.biometryType === T.touchId
            ? 'Touch ID'
            : 'biometrics',
      );

      // Re-lock on backgrounding so resume re-prompts and the app-switcher
      // snapshot is the lock screen, not a transcript.
      const { App } = await import('@capacitor/app');
      void App.addListener('appStateChange', ({ isActive }) => {
        if (!isActive && this.shouldEnforce()) {
          this._locked.set(true);
        }
      });
    } catch {
      // Plugin unavailable — fail open rather than lock the user out.
      this._available.set(false);
    }

    // Cold-start lock.
    this._locked.set(this.shouldEnforce());
  }

  /**
   * Attempt to unlock. Returns true if the app is now unlocked, false if
   * authentication was cancelled or failed (the gate stays up).
   */
  async unlock(): Promise<boolean> {
    if (!this._locked()) {
      return true;
    }
    if (!this.shouldEnforce()) {
      this._locked.set(false);
      return true;
    }
    try {
      const mod = await import('@aparajita/capacitor-biometric-auth');
      await mod.BiometricAuth.authenticate({
        reason: 'Unlock AI Orchestrator',
        cancelTitle: 'Cancel',
        allowDeviceCredential: true,
        iosFallbackTitle: 'Use Passcode',
      });
      this._locked.set(false);
      return true;
    } catch {
      return false;
    }
  }

  /** Turn the lock on/off (persisted). Turning it off clears any active gate. */
  async setEnabled(enabled: boolean): Promise<void> {
    this._enabled.set(enabled);
    await Preferences.set({ key: ENABLED_KEY, value: String(enabled) });
    if (!enabled) {
      this._locked.set(false);
    }
  }

  private shouldEnforce(): boolean {
    return Capacitor.isNativePlatform() && this._enabled() && this._available();
  }
}
