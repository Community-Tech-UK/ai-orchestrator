import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import type { LoopIssueAction, LoopIssueView } from './loop-issue-diagnosis.util';

/**
 * Always-visible diagnosis for a WARN/CRITICAL loop iteration.
 * Presentational — the parent owns store actions and inspector expand.
 */
@Component({
  selector: 'app-loop-issue-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (issue(); as issue) {
      <section class="loop-issue" [attr.data-severity]="issue.severity">
        <!--
          The live region covers the diagnosis prose only. Putting it on the
          whole card would make every disclosure toggle and button press
          re-announce the panel, and the role attribute already implies the
          matching aria-live politeness, so it is not repeated here.
        -->
        <div [attr.role]="issue.severity === 'CRITICAL' ? 'alert' : 'status'" aria-atomic="true">
          <div class="li-issue-head">
            <span class="li-issue-chip" [attr.data-severity]="issue.severity">{{ issue.chipLabel }}</span>
            <strong class="li-issue-headline">{{ issue.headline }}</strong>
            <span class="li-issue-fix" [attr.data-fix]="issue.fixability">{{ issue.fixabilityLabel }}</span>
          </div>
          <p class="li-issue-problem">{{ issue.problem }}</p>
          <p class="li-issue-implication">{{ issue.implication }}</p>
          <p class="li-issue-next"><span class="li-issue-next-label">What you can do</span> {{ issue.nextStep }}</p>
        </div>
        @if (issue.signals.length > 0) {
          <details class="li-issue-signals">
            <summary>
              {{ issue.signals.length === 1 ? 'Why the loop thinks this' : issue.signals.length + ' reasons the loop thinks this' }}
            </summary>
            <ul>
              @for (signal of issue.signals; track signal.id) {
                <li [attr.data-verdict]="signal.verdict">
                  <span class="li-issue-sig-title">{{ signal.title }}</span>
                  <span class="li-issue-sig-verdict">{{ signal.verdictLabel }}</span>
                  <span class="li-issue-sig-msg">{{ signal.message }}</span>
                </li>
              }
            </ul>
          </details>
        }
        <div class="li-issue-actions">
          @for (action of issue.actions; track action.kind) {
            <button
              type="button"
              [class.primary]="action.primary"
              [class.danger]="action.kind === 'stop'"
              (click)="onAction(action)"
            >{{ action.label }}</button>
          }
        </div>
      </section>
    }
  `,
  styleUrl: './loop-issue-card.component.scss',
})
export class LoopIssueCardComponent {
  issue = input<LoopIssueView | null>(null);
  hint = output<void>();
  inspect = output<void>();
  stopLoop = output<void>();
  resumeLoop = output<void>();

  protected onAction(action: LoopIssueAction): void {
    switch (action.kind) {
      case 'hint': this.hint.emit(); break;
      case 'inspect': this.inspect.emit(); break;
      case 'stop': this.stopLoop.emit(); break;
      case 'resume': this.resumeLoop.emit(); break;
    }
  }
}
