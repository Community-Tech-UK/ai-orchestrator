import { Component, input, inject, ChangeDetectionStrategy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';

@Component({
  selector: 'app-page-header',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="page-header">
      <div class="header-left">
        @if (backRoute()) {
          <button
            class="back-btn"
            type="button"
            (click)="goBack()"
            aria-label="Back to dashboard"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
              <path d="M19 12H5M12 19l-7-7 7-7"/>
            </svg>
            <span>Back</span>
          </button>
        }
        <div class="header-titles">
          <h1 class="header-title">{{ title() }}</h1>
          @if (subtitle()) {
            <p class="header-subtitle">{{ subtitle() }}</p>
          }
        </div>
      </div>
      <div class="header-actions">
        <ng-content select="[actions]"></ng-content>
      </div>
    </header>
  `,
  styles: [`
    :host { display: block; }
    .page-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: var(--spacing-lg, 24px) var(--spacing-xl, 32px);
      border-bottom: 1px solid var(--border-color, #2a2a2e);
      background: var(--bg-primary, #09090b);
    }
    .header-left { display: flex; align-items: center; gap: var(--spacing-md, 16px); }
    .back-btn {
      padding: var(--spacing-xs, 4px) var(--spacing-sm, 8px); background: none; border: none;
      color: var(--text-muted, #9a9aa0); cursor: pointer; border-radius: var(--radius-sm, 4px);
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      transition: all var(--transition-fast, 0.1s);
      &:hover { color: var(--primary-color, #f59e0b); background: rgba(245,158,11,0.08); }
    }
    .header-titles { display: flex; flex-direction: column; }
    .header-title {
      font-size: 1.25rem; font-weight: 700; color: var(--text-primary, #fafaf9);
      margin: 0; line-height: 1.2;
    }
    .header-subtitle {
      font-size: 0.75rem; color: var(--text-muted, #9a9aa0); margin: 2px 0 0;
    }
    .header-actions { display: flex; align-items: center; gap: var(--spacing-sm, 8px); }
  `]
})
export class PageHeaderComponent {
  readonly title = input.required<string>();
  readonly subtitle = input<string | null>(null);
  readonly backRoute = input<string | null>(null);

  private router = inject(Router);

  goBack(): void {
    const route = this.backRoute();
    if (route) this.router.navigate([route]);
  }
}
