/**
 * N3 — what a branch-and-select round did, and what it cost.
 *
 * Self-contained: it takes only the run id and iteration and reads its own data
 * from the store, so the inspector row can mount one per iteration without
 * threading episode data through. Renders nothing when there is no round for
 * that iteration — the common case, since branch-select is opt-in and only
 * fires on a CRITICAL stall.
 */
import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';

import { LoopStore } from '../../core/state/loop.store';

@Component({
  selector: 'app-loop-branch-episode-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (episode(); as ep) {
      <section class="branch-episode" [attr.data-adopted]="ep.adopted" aria-label="Branch-and-select round">
        <header class="branch-episode__head">
          <span class="branch-episode__title">Branch &amp; select</span>
          <span class="branch-episode__outcome">
            {{ ep.adopted ? 'Adopted a candidate' : 'Adopted nothing' }}
          </span>
        </header>

        <p class="branch-episode__reason">{{ ep.reason }}</p>

        <dl class="branch-episode__facts">
          <div>
            <dt>Candidates</dt>
            <dd>{{ ep.candidateCount }}</dd>
          </div>
          @if (ep.winnerProvider) {
            <div>
              <dt>Winner</dt>
              <dd>{{ ep.winnerProvider }}</dd>
            </div>
          }
          <div>
            <dt>Round cost</dt>
            <!-- Never "$0.00" for an unknown cost: every candidate ran a real
                 CLI turn, so a confident zero would be a lie about spend. -->
            <dd>{{ ep.totalCostUsd === undefined ? 'not reported' : dollars(ep.totalCostUsd) }}</dd>
          </div>
        </dl>

        @if (scoreRows(); as rows) {
          <ul class="branch-episode__scores">
            @for (row of rows; track row.id) {
              <li><span>{{ row.id }}</span><span>{{ row.score }}</span></li>
            }
          </ul>
        }
      </section>
    }
  `,
  styleUrl: './loop-branch-episode-card.component.scss',
})
export class LoopBranchEpisodeCardComponent {
  private readonly store = inject(LoopStore);

  readonly loopRunId = input<string | null>(null);
  readonly seq = input<number | null>(null);

  protected readonly episode = computed(
    () => this.store.branchEpisodeFor(this.loopRunId(), this.seq()),
  );

  /**
   * Scores as rows, or null when there are none.
   *
   * `scores` must be checked for CONTENT, not truthiness: `{}` is truthy, and
   * `selectWinner` returns exactly `scores: {}` for its "no candidate passed
   * verify" outcome — arguably the most common failure path — which would
   * otherwise render an empty list with a heading and no rows.
   */
  protected readonly scoreRows = computed(() => {
    const scores = this.episode()?.scores;
    if (!scores) return null;
    const entries = Object.entries(scores);
    if (entries.length === 0) return null;
    return entries.map(([id, score]) => ({ id, score }));
  });

  protected dollars(usd: number): string {
    return `$${usd.toFixed(2)}`;
  }
}
