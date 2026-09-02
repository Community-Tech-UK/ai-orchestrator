import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { LoopIterationPayload } from '@contracts/schemas/loop';
import { evidenceForIteration } from './loop-issue-diagnosis.util';

/** Inspector evidence column — titles and messages, not `G:CRITICAL`. */
@Component({
  selector: 'app-loop-iteration-evidence',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (view(); as ev) {
      <div class="li-subtitle">Evidence</div>
      @if (ev.signals.length > 0) {
        <ul class="li-ev-signals">
          @for (sig of ev.signals; track sig.id) {
            <li [attr.data-verdict]="sig.verdict">
              <div class="li-ev-sig-head">
                <strong>{{ sig.title }}</strong>
                <span class="li-ev-verdict">{{ sig.verdictLabel }}</span>
              </div>
              <p>{{ sig.message }}</p>
              <p class="li-ev-meaning">{{ sig.meaning }}</p>
            </li>
          }
        </ul>
      } @else {
        <p>No progress warnings on this iteration.</p>
      }
      <p>{{ ev.completionText }}</p>
      <p>{{ ev.verifyText }}</p>
      <p>{{ ev.testsText }}</p>
      <p>{{ ev.filesText }}</p>
    }
  `,
  styles: `
    :host { display: block; }
    .li-subtitle { margin: 6px 0 3px; font-weight: 600; opacity: 0.76; }
    p { margin: 0 0 4px; line-height: 1.4; overflow-wrap: anywhere; }
    .li-ev-signals {
      margin: 0 0 8px; padding: 0; list-style: none;
      display: flex; flex-direction: column; gap: 6px;
    }
    .li-ev-signals li {
      padding: 6px 8px; border-radius: 4px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: rgba(0, 0, 0, 0.16);
    }
    .li-ev-signals li[data-verdict="CRITICAL"] { border-color: rgba(247, 140, 124, 0.35); }
    .li-ev-signals li[data-verdict="WARN"] { border-color: rgba(247, 192, 122, 0.35); }
    .li-ev-sig-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px; margin-bottom: 2px; }
    .li-ev-verdict { font-size: 10px; font-weight: 700; font-family: var(--font-mono, monospace); opacity: 0.8; }
    .li-ev-meaning { opacity: 0.72; font-size: 11px; }
  `,
})
export class LoopIterationEvidenceComponent {
  iteration = input.required<LoopIterationPayload>();
  protected view = computed(() => evidenceForIteration(this.iteration()));
}
