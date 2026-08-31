import { Injectable, signal } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class SessionRecoveryDismissalStore {
  private readonly dismissedFingerprint = signal<string | null>(null);

  isDismissed(fingerprint: string): boolean {
    return fingerprint.length > 0 && this.dismissedFingerprint() === fingerprint;
  }

  dismiss(fingerprint: string): void {
    if (fingerprint) {
      this.dismissedFingerprint.set(fingerprint);
    }
  }
}
