/**
 * Computer Use Permission Store
 *
 * One shared macOS permission lifecycle for the root banner, title-bar chip,
 * and the Computer Use settings tab. Active only while settings are
 * initialized, the platform is macOS, and `computerUseEnabled` is true —
 * otherwise it holds no health, makes no IPC calls, and shows no UI.
 *
 * Refresh triggers: enable transition, after a permission action, window
 * focus, and visibility returning to `visible`. There is no polling timer.
 * Banner dismissal is in-memory for the current enabled period only.
 */

import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import type {
  DesktopHealthData,
  DesktopSystemPermission,
} from '../../../../shared/types/desktop-gateway.types';
import { DesktopGatewayIpcService } from '../services/ipc/desktop-gateway-ipc.service';
import { ElectronIpcService } from '../services/ipc/electron-ipc.service';
import { SettingsStore } from './settings.store';

export const MANUAL_SETTINGS_INSTRUCTION
  = 'Could not open System Settings. Open Privacy & Security manually.';

export const PERMISSION_LABELS: Record<DesktopSystemPermission, string> = {
  'screen-recording': 'Screen Recording',
  accessibility: 'Accessibility',
};

@Injectable({ providedIn: 'root' })
export class ComputerUsePermissionStore {
  private readonly settingsStore = inject(SettingsStore);
  private readonly desktop = inject(DesktopGatewayIpcService);
  private readonly ipc = inject(ElectronIpcService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly _health = signal<DesktopHealthData | null>(null);
  private readonly _loading = signal(false);
  private readonly _error = signal<string | null>(null);
  private readonly _dismissed = signal(false);
  private readonly _requesting = signal<DesktopSystemPermission | null>(null);
  private refreshInFlight: Promise<void> | null = null;

  readonly health = this._health.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();
  readonly requesting = this._requesting.asReadonly();

  /** The store is inert unless all three activation conditions hold. */
  readonly active = computed(() =>
    this.ipc.platform === 'darwin'
    && this.settingsStore.isInitialized()
    && this.settingsStore.settings().computerUseEnabled === true);

  /** Required permissions currently reported as user-fixable missing. */
  readonly missingPermissions = computed<DesktopSystemPermission[]>(() => {
    const health = this._health();
    if (!this.active() || !health) {
      return [];
    }
    const missing: DesktopSystemPermission[] = [];
    if (health.screenCapture === 'missing_permission') {
      missing.push('screen-recording');
    }
    if (health.accessibility === 'missing_permission') {
      missing.push('accessibility');
    }
    return missing;
  });

  /** True when either required permission cannot be fixed by the user (helper/runtime failure). */
  readonly unavailable = computed(() => {
    const health = this._health();
    if (!this.active() || !health) {
      return false;
    }
    return health.screenCapture === 'unavailable' || health.accessibility === 'unavailable';
  });

  /** True when loaded health shows any required permission is not ready. */
  readonly needsAttention = computed(() => {
    const health = this._health();
    if (!this.active() || !health) {
      return false;
    }
    return health.screenCapture !== 'available' || health.accessibility !== 'available';
  });

  /** Count of required permissions that are not ready (for the chip label). */
  readonly attentionCount = computed(() => {
    const health = this._health();
    if (!this.active() || !health) {
      return 0;
    }
    return [health.screenCapture, health.accessibility]
      .filter((state) => state !== 'available').length;
  });

  readonly bannerVisible = computed(() => this.needsAttention() && !this._dismissed());
  readonly chipVisible = computed(() => this.needsAttention() && this._dismissed());

  constructor() {
    // One refresh per enable transition; clearing on disable resets health,
    // errors, and the dismissal so re-enabling starts a fresh banner period.
    effect(() => {
      const active = this.active();
      untracked(() => {
        if (active) {
          void this.refresh();
        } else {
          this.clear();
        }
      });
    });

    const onFocus = (): void => {
      if (this.active()) {
        void this.refresh();
      }
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible' && this.active()) {
        void this.refresh();
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    });
  }

  /**
   * Coalesced health refresh. Retains the last good health value on a
   * transient failure and surfaces a safe error instead of flickering.
   */
  refresh(): Promise<void> {
    if (!this.active()) {
      return Promise.resolve();
    }
    if (this.refreshInFlight) {
      return this.refreshInFlight;
    }
    this.refreshInFlight = this.performRefresh()
      .finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }

  /**
   * Operator permission action: runs the real native request plus System
   * Settings fallback in the main process, surfaces the manual instruction
   * when navigation failed, then refreshes immediately.
   */
  async requestPermission(permission: DesktopSystemPermission): Promise<void> {
    if (!this.active() || this._requesting() !== null) {
      return;
    }
    this._requesting.set(permission);
    this._error.set(null);
    let actionError: string | null = null;
    try {
      const response = await this.desktop.requestSystemPermission(permission);
      if (!response.success || !response.data) {
        throw new Error(response.error?.message ?? 'Permission request failed');
      }
      const result = response.data;
      if (result.decision !== 'allowed') {
        throw new Error(result.reason ?? 'Permission request denied');
      }
      if (result.data && result.data.state !== 'available' && !result.data.settingsOpened) {
        actionError = MANUAL_SETTINGS_INSTRUCTION;
      }
    } catch (error) {
      actionError = error instanceof Error ? error.message : String(error);
    } finally {
      this._requesting.set(null);
    }
    // Refresh first so a successful health read cannot wipe the action error.
    await this.refresh();
    if (actionError) {
      this._error.set(actionError);
    }
  }

  /** Collapse the banner into the chip for the current enabled period. Not persisted. */
  dismissBanner(): void {
    this._dismissed.set(true);
  }

  private async performRefresh(): Promise<void> {
    this._loading.set(true);
    try {
      const response = await this.desktop.getHealth();
      if (!response.success || !response.data?.data) {
        throw new Error(response.error?.message ?? 'Failed to load Computer Use health');
      }
      this._health.set(response.data.data);
      this._error.set(null);
    } catch (error) {
      // Keep the last good health value; expose a transient error only.
      this._error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this._loading.set(false);
    }
  }

  private clear(): void {
    this._health.set(null);
    this._loading.set(false);
    this._error.set(null);
    this._dismissed.set(false);
    this._requesting.set(null);
  }
}
