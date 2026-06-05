import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  ElementRef,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

/**
 * Generic single-field text-prompt modal.
 *
 * Exists because `window.prompt()` / `window.confirm()` are NO-OPS in a
 * sandboxed Electron renderer (`contextIsolation: true, sandbox: true`) —
 * they silently return null, so any UI built on them appears dead. This
 * component is the in-app replacement: an overlay with a text field plus
 * Cancel / Confirm, emitting `submitted` with the trimmed value or
 * `cancelled` on dismiss.
 *
 * Stateless from the parent's point of view: pass `isOpen` + seed values,
 * react to the outputs. The internal draft is seeded from `initialValue`
 * each time the modal opens.
 */
@Component({
  selector: 'app-prompt-modal',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FormsModule],
  template: `
    @if (isOpen()) {
      <div
        class="pm-overlay"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        (click)="onCancel()"
        (keydown.escape)="onCancel()"
      >
        <div class="pm-container" role="document" (click)="$event.stopPropagation()" (keydown)="$event.stopPropagation()">
          <div class="pm-header">
            <span class="pm-title">{{ title() }}</span>
            <button type="button" class="pm-close" aria-label="Cancel" (click)="onCancel()">✕</button>
          </div>

          @if (message()) {
            <p class="pm-message">{{ message() }}</p>
          }

          @if (multiline()) {
            <textarea
              #field
              class="pm-input pm-textarea"
              rows="4"
              [placeholder]="placeholder()"
              [ngModel]="draft()"
              (ngModelChange)="draft.set($event)"
              (keydown.escape)="onCancel()"
              (keydown.meta.enter)="onConfirm()"
              (keydown.control.enter)="onConfirm()"
            ></textarea>
          } @else {
            <input
              #field
              type="text"
              class="pm-input"
              [placeholder]="placeholder()"
              [ngModel]="draft()"
              (ngModelChange)="draft.set($event)"
              (keydown.escape)="onCancel()"
              (keydown.enter)="onConfirm()"
            />
          }

          <div class="pm-footer">
            <button type="button" class="pm-btn pm-secondary" (click)="onCancel()">{{ cancelLabel() }}</button>
            <button
              type="button"
              class="pm-btn pm-primary"
              [disabled]="!canConfirm()"
              (click)="onConfirm()"
            >{{ confirmLabel() }}</button>
          </div>
        </div>
      </div>
    }
  `,
  styles: [`
    .pm-overlay {
      position: fixed;
      inset: 0;
      z-index: 1100;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      -webkit-app-region: no-drag;
    }
    .pm-container {
      width: 460px;
      max-width: 90vw;
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px;
      background: var(--surface-bg, var(--bg-secondary, #1e1e2e));
      border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
      border-radius: 10px;
      box-shadow: 0 16px 48px rgba(0, 0, 0, 0.5);
    }
    .pm-header {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .pm-title {
      flex: 1;
      font-size: 14px;
      font-weight: 600;
      color: var(--text-primary, #cdd6f4);
    }
    .pm-close {
      width: 26px;
      height: 26px;
      display: flex;
      align-items: center;
      justify-content: center;
      border: none;
      background: transparent;
      color: var(--text-muted, #6c7086);
      font-size: 13px;
      cursor: pointer;
      border-radius: 4px;
    }
    .pm-close:hover {
      background: var(--hover-bg, rgba(255, 255, 255, 0.08));
      color: var(--text-primary, #cdd6f4);
    }
    .pm-message {
      margin: 0;
      font-size: 12px;
      line-height: 1.5;
      color: var(--text-secondary, #a6adc8);
    }
    .pm-input {
      width: 100%;
      box-sizing: border-box;
      padding: 8px 10px;
      background: var(--bg-tertiary, rgba(0, 0, 0, 0.25));
      border: 1px solid var(--border-color, rgba(255, 255, 255, 0.12));
      border-radius: 6px;
      color: var(--text-primary, #cdd6f4);
      font: inherit;
      font-size: 13px;
      outline: none;
    }
    .pm-input:focus {
      border-color: var(--accent-color, #89b4fa);
    }
    .pm-textarea {
      resize: vertical;
      min-height: 72px;
      line-height: 1.5;
    }
    .pm-footer {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
    }
    .pm-btn {
      padding: 6px 16px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.15s;
    }
    .pm-btn:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    .pm-secondary {
      background: transparent;
      border-color: var(--border-color, rgba(255, 255, 255, 0.12));
      color: var(--text-secondary, #a6adc8);
    }
    .pm-secondary:hover:not(:disabled) {
      background: var(--hover-bg, rgba(255, 255, 255, 0.08));
      color: var(--text-primary, #cdd6f4);
    }
    .pm-primary {
      background: var(--accent-color, #89b4fa);
      color: #1e1e2e;
    }
    .pm-primary:hover:not(:disabled) {
      filter: brightness(1.1);
    }
  `],
})
export class PromptModalComponent {
  isOpen = input(false);
  title = input('Enter a value');
  message = input('');
  placeholder = input('');
  initialValue = input('');
  confirmLabel = input('OK');
  cancelLabel = input('Cancel');
  multiline = input(false);
  /** When false, a blank/whitespace-only value can still be confirmed. */
  requireValue = input(true);

  submitted = output<string>();
  cancelled = output<void>();

  protected readonly draft = signal('');
  private readonly field = viewChild<ElementRef<HTMLInputElement | HTMLTextAreaElement>>('field');

  protected readonly canConfirm = computed(() => !this.requireValue() || this.draft().trim().length > 0);

  constructor() {
    // Seed the draft from initialValue and focus the field each time the
    // modal transitions to open, so a reopened modal never shows the prior
    // session's text or leaves focus elsewhere.
    effect(() => {
      const open = this.isOpen();
      if (!open) return;
      const seed = untracked(() => this.initialValue());
      this.draft.set(seed);
      // Defer focus/select until the field is rendered.
      queueMicrotask(() => {
        const el = this.field()?.nativeElement;
        if (el) {
          el.focus();
          el.select();
        }
      });
    });
  }

  protected onConfirm(): void {
    if (!this.canConfirm()) return;
    this.submitted.emit(this.draft().trim());
  }

  protected onCancel(): void {
    this.cancelled.emit();
  }
}
