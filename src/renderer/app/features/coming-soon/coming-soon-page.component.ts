import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';

@Component({
  selector: 'app-coming-soon-page',
  standalone: true,
  template: `
    <div class="page">
      <div class="page-header">
        <button class="header-btn" type="button" (click)="goBack()">← Back</button>
        <div class="header-title">
          <span class="title">{{ title() }}</span>
          <span class="subtitle">{{ subtitle() }}</span>
        </div>
      </div>

      <div class="empty-card">
        <div class="badge">Coming soon</div>
        <p class="copy">
          {{ title() }} hasn't been built yet. The slot is wired up so it'll
          appear here once the feature lands.
        </p>
      </div>
    </div>
  `,
  styles: [`
    .page {
      display: flex;
      flex-direction: column;
      gap: 24px;
      padding: 32px;
      height: 100%;
      overflow: auto;
    }

    .page-header {
      display: flex;
      align-items: center;
      gap: 16px;
    }

    .header-btn {
      padding: 6px 12px;
      border-radius: 8px;
      background: var(--glass-light);
      border: 1px solid var(--glass-border);
      color: var(--text-secondary);
      cursor: pointer;
      font-size: 12px;

      &:hover {
        color: var(--text-primary);
        background: var(--glass-strong);
      }
    }

    .header-title {
      display: flex;
      flex-direction: column;
      gap: 2px;
    }

    .title {
      font-family: var(--font-display);
      font-size: 22px;
      font-weight: 600;
      color: var(--text-primary);
    }

    .subtitle {
      font-size: 12px;
      color: var(--text-muted);
    }

    .empty-card {
      max-width: 520px;
      padding: 32px;
      border-radius: 16px;
      background: var(--glass-light);
      border: 1px dashed var(--glass-border);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .badge {
      align-self: flex-start;
      padding: 4px 10px;
      border-radius: 999px;
      background: rgba(var(--primary-rgb), 0.16);
      border: 1px solid rgba(var(--primary-rgb), 0.32);
      color: var(--primary-color);
      font-family: var(--font-mono);
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    .copy {
      color: var(--text-secondary);
      font-size: 14px;
      line-height: 1.6;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComingSoonPageComponent {
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  private routeData = toSignal(this.route.data, { initialValue: {} as { title?: string; subtitle?: string } });

  title = computed(() => this.routeData()?.title ?? 'Feature');
  subtitle = computed(() => this.routeData()?.subtitle ?? '');

  goBack(): void {
    void this.router.navigate(['/']);
  }
}
