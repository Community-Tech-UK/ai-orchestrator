/**
 * UX5 — the getting-started bar.
 *
 * Renders the checklist while there is something left to do and nothing once
 * there is not: no dismissal, because completing the steps IS the dismissal.
 * See `getting-started.ts` for why every step is derived from state the app
 * already has rather than a signal invented for this bar.
 *
 * Each pending step carries the action that completes it, so the bar is a way
 * through setup rather than a list of things you are failing at.
 */
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
} from '@angular/core';
import { Router } from '@angular/router';

import { InstanceStore } from '../../core/state/instance.store';
import { SettingsStore } from '../../core/state/settings.store';
import { SessionStartedMarkerService } from './session-started-marker.service';
import {
  buildGettingStarted,
  gettingStartedCounter,
  type GettingStartedStepId,
} from '../../../../shared/types/getting-started';
import type { StartupCapabilityReport } from '../../../../shared/types/startup-capability.types';

@Component({
  selector: 'app-getting-started-bar',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (state(); as s) {
      @if (s.visible) {
        <aside class="getting-started" role="status" aria-label="Getting started">
          <span class="getting-started__counter">{{ counter() }}</span>
          <ul class="getting-started__steps">
            @for (step of s.steps; track step.id) {
              <li class="getting-started__step" [attr.data-done]="step.done">
                <!-- State in words, not a tick glyph alone. -->
                <span class="getting-started__state">{{ step.done ? 'Done' : 'To do' }}</span>
                <span class="getting-started__label">{{ step.label }}</span>
                <span class="getting-started__detail">{{ step.detail }}</span>
                @if (!step.done) {
                  <button
                    type="button"
                    class="getting-started__go"
                    [attr.data-step-id]="step.id"
                    (click)="go(step.id)"
                  >{{ actionLabel(step.id) }}</button>
                }
              </li>
            }
          </ul>
        </aside>
      }
    }
  `,
  styleUrl: './getting-started-bar.component.scss',
})
export class GettingStartedBarComponent {
  private readonly instances = inject(InstanceStore);
  private readonly settings = inject(SettingsStore);
  private readonly router = inject(Router);
  private readonly sessionMarker = inject(SessionStartedMarkerService);

  constructor() {
    // Record the fact the moment a session exists, so closing it later does not
    // un-complete the step. Idempotent; see the marker service for why this is
    // not derived from the live instance count.
    effect(() => {
      if (this.instances.instances().length > 0) this.sessionMarker.markStarted();
    });
  }

  /** Owned by the app shell, which is what receives the startup report. */
  readonly report = input<StartupCapabilityReport | null>(null);

  protected readonly state = computed(() => buildGettingStarted({
    // The aggregate check, not the per-provider ones — see `getting-started.ts`
    // for why reading the individual statuses made this step always "done".
    providerAnyStatus:
      (this.report()?.checks ?? []).find((check) => check.id === 'provider.any')?.status ?? null,
    defaultWorkingDirectory: this.settings.settings().defaultWorkingDirectory ?? '',
    hasEverStartedSession: this.sessionMarker.hasStarted(),
  }));

  protected readonly counter = computed(() => gettingStartedCounter(this.state()));

  protected actionLabel(id: GettingStartedStepId): string {
    if (id === 'provider-available') return 'Check CLI health';
    if (id === 'working-directory') return 'Open settings';
    return 'New session';
  }

  protected go(id: GettingStartedStepId): void {
    // Routes only — the bar points at the surface that does the job rather than
    // reimplementing it, so there is one place each of these actually happens.
    if (id === 'provider-available') void this.router.navigate(['/settings'], { fragment: 'cli-health' });
    else if (id === 'working-directory') void this.router.navigate(['/settings'], { fragment: 'general' });
    else void this.router.navigate(['/']);
  }
}
