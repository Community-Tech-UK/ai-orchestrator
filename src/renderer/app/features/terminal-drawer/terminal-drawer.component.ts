import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { TERMINAL_SESSION } from '../../core/services/terminal-session.service';

@Component({
  selector: 'app-terminal-drawer',
  standalone: true,
  template: `
    <section class="terminal-drawer" [class.open]="isOpen()" aria-label="Terminal drawer">
      <header class="terminal-drawer__header">
        <h3 class="terminal-drawer__title">Terminal</h3>
        <button
          type="button"
          class="terminal-drawer__close"
          aria-label="Close terminal drawer"
          (click)="closeRequested.emit()"
        >
          ×
        </button>
      </header>

      <div class="terminal-drawer__body" role="status" aria-live="polite">
        @if (lastError(); as error) {
          <p class="terminal-drawer__empty">{{ error }}</p>
        } @else {
          <p class="terminal-drawer__empty">
            Terminal sessions land in Wave 4b after the typed service boundary is wired.
          </p>
        }
      </div>
    </section>
  `,
  styles: [`
    .terminal-drawer {
      position: fixed;
      right: 0;
      bottom: 0;
      left: 0;
      z-index: 80;
      display: flex;
      flex-direction: column;
      height: 240px;
      min-height: 180px;
      max-height: 45vh;
      background: var(--bg-primary);
      border-top: 1px solid var(--border-color);
      box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.22);
      transform: translateY(100%);
      transition: transform 160ms ease-out;
    }

    .terminal-drawer.open {
      transform: translateY(0);
    }

    .terminal-drawer__header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      min-height: 40px;
      padding: 0 var(--spacing-md);
      background: var(--bg-secondary);
      border-bottom: 1px solid var(--border-color);
    }

    .terminal-drawer__title {
      margin: 0;
      color: var(--text-primary);
      font-size: 13px;
      font-weight: 600;
    }

    .terminal-drawer__close {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      padding: 0;
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      color: var(--text-secondary);
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      transition: all var(--transition-fast);
    }

    .terminal-drawer__close:hover {
      background: var(--bg-hover);
      border-color: var(--border-color);
      color: var(--text-primary);
    }

    .terminal-drawer__body {
      flex: 1;
      min-height: 0;
      padding: var(--spacing-lg);
      overflow: auto;
      color: var(--text-secondary);
      font-family: var(--font-mono);
      font-size: 12px;
    }

    .terminal-drawer__empty {
      max-width: 720px;
      margin: 0;
      color: var(--text-muted);
      line-height: 1.5;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TerminalDrawerComponent {
  private readonly terminal = inject(TERMINAL_SESSION);
  private readonly destroyRef = inject(DestroyRef);

  readonly isOpen = input(false);
  readonly closeRequested = output<void>();
  protected readonly lastError = signal<string | null>(null);

  constructor() {
    const unsubscribe = this.terminal.subscribe((event) => {
      if (event.kind === 'error') {
        this.lastError.set(event.message);
      }
    });

    this.destroyRef.onDestroy(unsubscribe);
  }
}
