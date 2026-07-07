import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  signal,
} from '@angular/core';
import { ClipboardService } from '../core/clipboard.service';
import { HapticsService } from '../core/haptics.service';

/**
 * Small ghost "Copy" button rendered under a transcript message, mirroring the
 * desktop app's per-message copy affordance. Shows a "Copied" tick for a couple
 * of seconds after a successful copy.
 */
@Component({
  standalone: true,
  selector: 'app-copy-button',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="copy-btn"
      [class.copied]="copied()"
      (click)="copy()"
      [attr.aria-label]="copied() ? 'Copied' : 'Copy message'"
    >
      @if (copied()) {
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <span>Copied</span>
      } @else {
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="9" y="9" width="11" height="11" rx="2"></rect>
          <path d="M5 15V5a2 2 0 0 1 2-2h10"></path>
        </svg>
        <span>Copy</span>
      }
    </button>
  `,
  styles: [
    `
      :host { display: inline-flex; }
      .copy-btn {
        display: inline-flex; align-items: center; gap: 4px;
        background: none; border: none; padding: 4px 6px; margin: 0;
        color: var(--text-secondary); font-size: 12px; line-height: 1;
        border-radius: 8px;
      }
      .copy-btn:active { background: rgba(255, 255, 255, 0.08); }
      .copy-btn.copied { color: var(--accent-online); }
      .copy-btn svg {
        width: 14px; height: 14px; display: block;
        fill: none; stroke: currentColor; stroke-width: 2;
        stroke-linecap: round; stroke-linejoin: round;
      }
    `,
  ],
})
export class CopyButtonComponent {
  private readonly clipboard = inject(ClipboardService);
  private readonly haptics = inject(HapticsService);

  /** Raw text placed on the clipboard (message markdown, verbatim). */
  readonly text = input.required<string>();

  protected readonly copied = signal(false);
  private resetTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.resetTimer));
  }

  protected async copy(): Promise<void> {
    const ok = await this.clipboard.copy(this.text());
    if (!ok) return;
    this.haptics.tap();
    this.copied.set(true);
    clearTimeout(this.resetTimer);
    this.resetTimer = setTimeout(() => this.copied.set(false), 2000);
  }
}
