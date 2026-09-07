/**
 * N12 — "while you were away".
 *
 * The `awaySince` boundary is tracked entirely in the renderer: it starts at
 * construction (effectively app boot), advances on `window:blur`, and on
 * `window:focus` asks main for a recap of runs that ended after it. That needs
 * no main-process state, no push channel and no window-manager changes — main
 * only filters `loop_runs` through a caller-supplied timestamp.
 *
 * **Known limitation, stated rather than hidden:** the boundary lives in
 * renderer memory. A renderer crash-and-reload resets it to "now", so runs that
 * ended during the missed window are not shown late — they are never shown.
 * Persisting it would need a settings write on every blur, which is a worse
 * trade for a recap banner; recorded so the cost is visible.
 *
 * Because the boundary advances every time a recap is shown, a run reported once
 * can never be returned by a later query. A second recap arriving while the
 * first is still on screen is therefore MERGED into it, never substituted for
 * it: overwriting silently destroyed the earlier card, and two ordinary
 * alt-tabs without a dismissal in between were enough to replace an unread
 * "needs you" with a less urgent "finished".
 */
import {
  ChangeDetectionStrategy,
  Component,
  HostListener,
  inject,
  signal,
} from '@angular/core';

import { LoopIpcService } from '../../core/services/ipc/loop-ipc.service';
import { mergeAwayRecaps } from '../../../../shared/types/away-recap-summary';
import type { AwayRecapPayload } from '@contracts/schemas/loop';

@Component({
  selector: 'app-away-recap-banner',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (recap(); as summary) {
      <aside class="away-recap" role="status" aria-live="polite">
        <div class="away-recap__text">
          <strong class="away-recap__headline">{{ summary.headline }}</strong>
          <ul class="away-recap__list">
            @for (card of summary.cards; track card.runId) {
              <li class="away-recap__card" [attr.data-outcome]="card.outcome">
                <span class="away-recap__outcome">{{ outcomeLabel(card.outcome) }}</span>
                <span class="away-recap__goal">{{ card.goal }}</span>
                <span class="away-recap__meta">
                  {{ card.iterations }} iterations
                  @if (card.outstandingCount > 0) {
                    · {{ card.outstandingCount }} open question{{ card.outstandingCount === 1 ? '' : 's' }}
                  }
                </span>
              </li>
            }
          </ul>
        </div>
        <button
          type="button"
          class="away-recap__dismiss"
          aria-label="Dismiss the while-you-were-away recap"
          (click)="dismiss()"
        >Dismiss</button>
      </aside>
    }
  `,
  styleUrl: './away-recap-banner.component.scss',
})
export class AwayRecapBannerComponent {
  private readonly ipc = inject(LoopIpcService);

  /** Boundary for "ended while you were away". */
  private awaySince = Date.now();
  protected readonly recap = signal<AwayRecapPayload | null>(null);

  @HostListener('window:blur')
  protected onBlur(): void {
    // Only move the boundary when nothing is being shown, or a recap the user
    // has not read yet would be silently replaced by an empty one.
    if (this.recap() === null) this.awaySince = Date.now();
  }

  @HostListener('window:focus')
  protected async onFocus(): Promise<void> {
    const response = await this.ipc.getAwayRecap(this.awaySince);
    if (!response.success) return;
    const next = response.data?.recap ?? null;
    // A null recap means "nothing ended" — it must not clear a banner the user
    // has not dismissed yet.
    if (!next) return;
    // Fold into whatever is still on screen. Replacing it would drop the earlier
    // cards for good, since the boundary has already moved past their end times.
    this.recap.set(mergeAwayRecaps(this.recap(), next));
    this.awaySince = Date.now();
  }

  protected outcomeLabel(outcome: string): string {
    if (outcome === 'needs-you') return 'Needs you';
    if (outcome === 'stopped-short') return 'Stopped short';
    return 'Finished';
  }

  protected dismiss(): void {
    this.recap.set(null);
    // Advance past what was just shown, so the same runs never reappear.
    this.awaySince = Date.now();
  }
}
