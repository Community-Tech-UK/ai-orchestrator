import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

/**
 * Thin wrapper over the Capacitor haptics plugin. Every method is fire-and-
 * forget and no-ops on the web/dev build, so callers never need to await or
 * guard. Kept deliberately small: light for taps, medium for destructive-ish
 * actions, notification buzzes for outcomes.
 */
@Injectable({ providedIn: 'root' })
export class HapticsService {
  private get enabled(): boolean {
    return Capacitor.isNativePlatform();
  }

  /** Light tick for ordinary taps (copy, send, toggle). */
  tap(): void {
    if (!this.enabled) return;
    void Haptics.impact({ style: ImpactStyle.Light }).catch(() => undefined);
  }

  /** Firmer knock for consequential actions (interrupt, terminate). */
  heavyTap(): void {
    if (!this.enabled) return;
    void Haptics.impact({ style: ImpactStyle.Medium }).catch(() => undefined);
  }

  /** Positive outcome (approved, sent, unlocked). */
  success(): void {
    if (!this.enabled) return;
    void Haptics.notification({ type: NotificationType.Success }).catch(() => undefined);
  }

  /** Attention needed (new approval prompt surfaced). */
  warning(): void {
    if (!this.enabled) return;
    void Haptics.notification({ type: NotificationType.Warning }).catch(() => undefined);
  }

  /** Something failed (send error, denied, auth failure). */
  error(): void {
    if (!this.enabled) return;
    void Haptics.notification({ type: NotificationType.Error }).catch(() => undefined);
  }
}
