/**
 * Settings Card - reusable section container for the settings workspace.
 *
 * Part of the settings UI kit (copilot_todo.md item 4): replaces the
 * one-off card styling re-implemented inline across settings tabs.
 *
 * Slots:
 *  - default content      → the card body
 *  - `[card-actions]`     → header-right actions (buttons, links)
 *  - `[card-footer]`      → full-width footer (e.g. a save-state banner)
 */

import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { SettingsNavIconComponent } from './settings-nav-icon.component';

@Component({
  selector: 'app-settings-card',
  standalone: true,
  imports: [SettingsNavIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="settings-card">
      @if (title()) {
        <header class="card-header">
          @if (icon()) {
            <span class="card-icon">
              <app-settings-nav-icon [name]="icon()!" />
            </span>
          }
          <div class="card-heading">
            <h3 class="card-title">{{ title() }}</h3>
            @if (description()) {
              <p class="card-description">{{ description() }}</p>
            }
          </div>
          <div class="card-actions">
            <ng-content select="[card-actions]" />
          </div>
        </header>
      }
      <div class="card-body">
        <ng-content />
      </div>
      <ng-content select="[card-footer]" />
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }

      .settings-card {
        background: var(--card-bg);
        border: 1px solid var(--card-border);
        border-radius: var(--card-radius);
        box-shadow: var(--card-shadow);
        overflow: hidden;
        transition:
          box-shadow var(--transition-fast),
          border-color var(--transition-fast);
      }

      .settings-card:focus-within {
        border-color: var(--primary-color);
        box-shadow: var(--card-shadow), 0 0 0 2px color-mix(in srgb, var(--primary-color) 20%, transparent);
      }

      @media (prefers-reduced-motion: reduce) {
        .settings-card {
          transition: none;
        }
      }

      .card-header {
        display: flex;
        align-items: flex-start;
        gap: var(--spacing-md);
        padding: var(--spacing-lg);
        border-bottom: 1px solid var(--border-subtle);
      }

      .card-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 34px;
        height: 34px;
        flex-shrink: 0;
        border-radius: var(--radius-md);
        background: var(--section-icon-bg);
        color: var(--section-icon-fg);
        font-size: 18px;
      }

      .card-heading {
        flex: 1;
        min-width: 0;
      }

      .card-title {
        margin: 0;
        font-size: var(--text-md);
        font-weight: 600;
        color: var(--text-primary);
      }

      .card-description {
        margin: 2px 0 0;
        font-size: var(--text-sm);
        line-height: var(--leading-snug);
        color: var(--text-secondary);
      }

      .card-actions {
        display: flex;
        align-items: center;
        gap: var(--spacing-sm);
        flex-shrink: 0;
      }

      .card-actions:empty {
        display: none;
      }

      .card-body {
        padding: var(--spacing-lg);
        display: flex;
        flex-direction: column;
        gap: var(--spacing-md);
      }

      .card-body:empty {
        display: none;
      }
    `,
  ],
})
export class SettingsCardComponent {
  /** Optional section title. When omitted the header is not rendered. */
  readonly title = input<string>();
  /** Optional supporting description shown under the title. */
  readonly description = input<string>();
  /** Optional icon name (see SettingsNavIconComponent). */
  readonly icon = input<string>();
}
