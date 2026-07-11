import { ChangeDetectionStrategy, Component, input } from '@angular/core';

@Component({
  standalone: true,
  selector: 'app-mobile-header',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <header class="mobile-header">
      <div class="mobile-header__action"><ng-content select="[mobileHeaderLeading]" /></div>
      <div class="mobile-header__identity">
        <span class="mobile-header__title">{{ title() }}</span>
        @if (subtitle()) {
          <span class="mobile-header__subtitle">
            @if (statusColor()) {
              <span class="mobile-header__status" [style.background]="statusColor()"></span>
            }
            {{ subtitle() }}
          </span>
        }
      </div>
      <div class="mobile-header__action mobile-header__action--trailing">
        <ng-content select="[mobileHeaderTrailing]" />
      </div>
    </header>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .mobile-header {
        display: grid;
        grid-template-columns: var(--control-size, 44px) minmax(0, 1fr) var(--control-size, 44px);
        align-items: center;
        min-height: 56px;
        gap: var(--space-3, 12px);
      }

      .mobile-header__action {
        display: grid;
        place-items: center;
        min-width: var(--control-size, 44px);
        min-height: var(--control-size, 44px);
      }

      .mobile-header__identity {
        display: flex;
        min-width: 0;
        flex-direction: column;
        align-items: center;
        gap: 1px;
        text-align: center;
      }

      .mobile-header__title {
        max-width: 100%;
        overflow: hidden;
        color: var(--text);
        font-size: var(--font-size-lg, 17px);
        font-weight: 650;
        line-height: 1.2;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .mobile-header__subtitle {
        display: flex;
        max-width: 100%;
        align-items: center;
        gap: var(--space-2, 8px);
        overflow: hidden;
        color: var(--text-secondary);
        font-size: var(--font-size-sm, 13px);
        line-height: 1.25;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .mobile-header__status {
        width: 7px;
        height: 7px;
        flex: none;
        border-radius: var(--radius-pill);
      }
    `,
  ],
})
export class MobileHeaderComponent {
  readonly title = input.required<string>();
  readonly subtitle = input('');
  readonly statusColor = input('');
}
