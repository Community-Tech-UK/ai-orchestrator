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
  styleUrl: './settings-card.component.scss',
})
export class SettingsCardComponent {
  /** Optional section title. When omitted the header is not rendered. */
  readonly title = input<string>();
  /** Optional supporting description shown under the title. */
  readonly description = input<string>();
  /** Optional icon name (see SettingsNavIconComponent). */
  readonly icon = input<string>();
}
