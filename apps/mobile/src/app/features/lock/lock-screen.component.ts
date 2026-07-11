import {
  ChangeDetectionStrategy,
  Component,
  OnInit,
  inject,
  signal,
} from '@angular/core';
import { AppLockService } from '../../core/app-lock.service';
import { MobileIconComponent } from '../../shared/mobile-icon.component';

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
  imports: [MobileIconComponent],
  template: `
    <div class="lock" role="dialog" aria-modal="true" aria-label="App locked">
      <div class="brand">
        <span class="glyph"><app-mobile-icon name="lock" /></span>
        <h1>Harness</h1>
        <p class="muted">Locked</p>
      </div>

      @if (error()) {
        <p class="error">{{ error() }}</p>
      }

      <button class="mobile-primary-button unlock-button" type="button" (click)="attempt()" [disabled]="busy()">
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
        z-index: var(--z-lock);
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
        display: grid;
        width: 72px;
        height: 72px;
        place-items: center;
        border: 1px solid var(--separator);
        border-radius: var(--radius-pill);
        background: var(--surface-raised);
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
      .unlock-button {
        min-width: 220px;
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
