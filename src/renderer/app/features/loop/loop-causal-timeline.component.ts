/**
 * B5 — the four-step timeline, rendered.
 *
 * Takes an already-reduced `LoopTimeline` rather than a loop run: the reducer
 * is the thing worth testing, and keeping this presentational means the seeded
 * states in `loop-causal-timeline.spec.ts` are the same data this renders.
 *
 * The announcement is deliberately in its own `aria-live` region holding one
 * sentence, rather than making the whole timeline live. A live region covering
 * the step list would re-read all four steps and the spend meter on every tick;
 * this says "Blocked at Verify. …" once, when the state actually changes.
 */
import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import type { LoopTimeline, LoopTimelineStepState } from './loop-causal-timeline';

@Component({
  selector: 'app-loop-causal-timeline',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (timeline(); as t) {
      <section class="loop-timeline" aria-label="Loop progress">
        <ol class="loop-timeline__steps">
          @for (step of t.steps; track step.id) {
            <li
              class="loop-timeline__step"
              [attr.data-state]="step.state"
              [attr.data-step-id]="step.id"
            >
              <span class="loop-timeline__step-label">{{ step.label }}</span>
              <!-- State in words as well as colour: four states styled only by
                   tint would be unreadable to anyone who cannot see the tint. -->
              <span class="loop-timeline__step-state">{{ stateLabel(step.state) }}</span>
              @if (step.detail) {
                <span class="loop-timeline__step-detail">{{ step.detail }}</span>
              }
            </li>
          }
        </ol>

        <p class="loop-timeline__next">
          <span class="loop-timeline__next-label">Next without you:</span>
          {{ t.nextAutomaticAction }}
        </p>

        @if (t.recovery.id !== 'none') {
          <div class="loop-timeline__recovery">
            <button
              type="button"
              class="loop-timeline__recovery-btn"
              [attr.data-recovery-id]="t.recovery.id"
              (click)="recoveryChosen.emit(t.recovery.id)"
            >{{ t.recovery.label }}</button>
            <span class="loop-timeline__recovery-desc">{{ t.recovery.description }}</span>
          </div>
        }

        <p class="loop-timeline__spend">
          <span class="loop-timeline__spend-amount">{{ dollars(t.spend.spentCents) }}</span>
          @if (t.spend.maxCostCents !== null) {
            <span class="loop-timeline__spend-cap">of {{ dollars(t.spend.maxCostCents) }}</span>
          }
          <!-- Always stated. An estimate shown as a measurement is how a cost
               display stops being believed. -->
          <span class="loop-timeline__spend-source">{{ t.spend.sourceLabel }}</span>
        </p>

        <p class="loop-timeline__announcement" aria-live="polite">{{ t.announcement }}</p>
      </section>
    }
  `,
  styleUrl: './loop-causal-timeline.component.scss',
})
export class LoopCausalTimelineComponent {
  readonly timeline = input<LoopTimeline | null>(null);
  readonly recoveryChosen = output<string>();

  protected stateLabel(state: LoopTimelineStepState): string {
    switch (state) {
      case 'done': return 'done';
      case 'active': return 'in progress';
      case 'blocked': return 'blocked';
      case 'skipped': return 'not used';
      default: return 'not started';
    }
  }

  protected dollars(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }
}
