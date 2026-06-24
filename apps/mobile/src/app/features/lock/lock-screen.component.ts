import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { AppLockService } from '../../core/app-lock.service';

/**
 * Full-screen biometric gate shown whenever {@link AppLockService} reports the
 * app is locked. It auto-prompts for Face ID / Touch ID on mount and after the
 * app returns from the background, and offers a manual retry if the user
 * cancels or authentication fails. The opaque background fully hides the
 * session content behind it, so a lost/unlocked phone can't reveal transcripts.
 */
@Component({
  standalone: true,
  selector: 'app-lock-screen',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="lock" role="dialog" aria-modal="true" aria-label="App locked">
      <div class="brand">
        <span class="glyph" aria-hidden="true">🔒</span>
        <h1>harness</h1>
        <p class="muted">Locked</p>
      </div>

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      <button class="cta" (click)="attempt()" [disabled]="busy()">
        @if (busy()) {
          Authenticating…
        } @else {
          Unlock with {{ lock.biometryLabel() }}
        }
      </button>
    </div>
  `,
  styles: [
    `
      .lock {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: var(--bg);
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 28px;
        padding: 24px;
        padding-top: calc(env(safe-area-inset-top) + 24px);
        padding-bottom: calc(env(safe-area-inset-bottom) + 24px);
      }
      .brand {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 8px;
        text-align: center;
      }
      .glyph {
        font-size: 48px;
        line-height: 1;
      }
      .muted {
        color: var(--text-secondary);
        margin: 0;
        font-size: 15px;
      }
      .error {
        color: var(--accent-error);
        font-size: 15px;
        text-align: center;
        margin: 0;
        max-width: 280px;
      }
      .cta {
        background: #fff;
        color: #000;
        border: none;
        border-radius: var(--radius-pill);
        padding: 14px 28px;
        font-size: 16px;
        font-weight: 600;
        min-width: 220px;
      }
      .cta:disabled {
        opacity: 0.6;
      }
    `,
  ],
})
export class LockScreenComponent implements OnInit {
  protected readonly lock = inject(AppLockService);

  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  ngOnInit(): void {
    // Auto-prompt as soon as the gate appears (cold start or resume).
    void this.attempt();
  }

  protected async attempt(): Promise<void> {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      const ok = await this.lock.unlock();
      if (!ok) {
        this.error.set('Authentication failed. Tap to try again.');
      }
    } finally {
      this.busy.set(false);
    }
  }
}
