/**
 * CLI Error Component - Shows when no AI CLI is installed
 */

import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

export interface CliInstallInfo {
  name: string;
  installUrl: string;
  command: string;
}

export interface NoCliError {
  title: string;
  message: string;
  clis: CliInstallInfo[];
}

@Component({
  selector: 'app-cli-error',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="cli-error-container">
      <div class="cli-error-content">
        <svg class="error-icon" width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
          <line x1="12" y1="9" x2="12" y2="13"></line>
          <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
        <h1 class="error-title">{{ error().title }}</h1>
        <p class="error-message">{{ error().message }}</p>

        <div class="cli-options">
          @for (cli of error().clis; track cli.name) {
            <div class="cli-option">
              <div class="cli-name">{{ cli.name }}</div>
              <code class="cli-command">{{ cli.command }}</code>
              <a
                class="cli-link"
                [href]="cli.installUrl"
                target="_blank"
                rel="noopener noreferrer"
              >
                Learn more →
              </a>
            </div>
          }
        </div>

        <div class="actions">
          <button class="btn-retry" (click)="retry.emit()" title="Try detecting AI CLIs again">
            ↻ Retry Detection
          </button>
        </div>
      </div>
    </div>
  `,
  styles: [`
    .cli-error-container {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      width: 100%;
      padding: var(--spacing-xl);
      background: var(--bg-primary);
    }

    .cli-error-content {
      max-width: 600px;
      text-align: center;
    }

    .error-icon {
      margin-bottom: var(--spacing-lg);
      color: var(--warning-color);
    }

    .error-title {
      font-size: 28px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: var(--spacing-sm);
    }

    .error-message {
      font-size: 16px;
      color: var(--text-secondary);
      margin-bottom: var(--spacing-xl);
    }

    .cli-options {
      display: flex;
      flex-direction: column;
      gap: var(--spacing-md);
      margin-bottom: var(--spacing-xl);
    }

    .cli-option {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
      text-align: left;
    }

    .cli-name {
      font-weight: 600;
      font-size: 16px;
      color: var(--text-primary);
      margin-bottom: var(--spacing-xs);
    }

    .cli-command {
      display: block;
      background: var(--bg-tertiary);
      padding: var(--spacing-sm);
      border-radius: var(--radius-sm);
      font-family: var(--font-mono);
      font-size: 13px;
      color: var(--primary-color);
      margin-bottom: var(--spacing-sm);
      user-select: all;
    }

    .cli-link {
      font-size: 13px;
      color: var(--primary-color);
      text-decoration: none;

      &:hover {
        text-decoration: underline;
      }
    }

    .actions {
      display: flex;
      justify-content: center;
      gap: var(--spacing-md);
    }

    .btn-retry {
      padding: var(--spacing-sm) var(--spacing-lg);
      background: var(--primary-color);
      color: white;
      border-radius: var(--radius-md);
      font-size: 14px;
      font-weight: 500;
      cursor: pointer;
      transition: background var(--transition-fast);

      &:hover {
        background: var(--primary-hover);
      }
    }
  `],
})
export class CliErrorComponent {
  error = input.required<NoCliError>();
  retry = output<void>();
}
