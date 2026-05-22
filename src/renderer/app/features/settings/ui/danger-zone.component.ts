import { ChangeDetectionStrategy, Component, Input } from '@angular/core';

@Component({
  selector: 'app-danger-zone',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="danger-zone">
      <div class="danger-header">
        <div>
          <h4>{{ title }}</h4>
          @if (description) {
            <p>{{ description }}</p>
          }
        </div>
      </div>
      <div class="danger-body">
        <ng-content />
      </div>
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .danger-zone {
        padding: var(--density-card-padding);
        border: 1px solid var(--pill-error-border);
        border-radius: var(--radius-md);
        background: var(--error-bg);
      }

      .danger-header h4 {
        margin: 0;
        font-size: var(--text-md);
        color: var(--text-primary);
      }

      .danger-header p {
        margin: var(--spacing-xs) 0 0;
        font-size: var(--text-sm);
        color: var(--text-secondary);
        line-height: var(--leading-snug);
      }

      .danger-body {
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
        margin-top: var(--spacing-md);
      }
    `,
  ],
})
export class DangerZoneComponent {
  @Input() title = 'Danger Zone';
  @Input() description = '';
}
