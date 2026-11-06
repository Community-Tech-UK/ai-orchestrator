/**
 * "Biggest turns this week" for the Costs page (Oct-2 Phase D Step 1), with the
 * credits Codex reports for the sessions that ended this week (Step 11.1).
 *
 * A turn is everything the AI does for one message. Tokens here are everything
 * it processed, including text it re-read from its cache and its helpers' work,
 * which is why a few runaway turns can dominate the total. Self-contained so the
 * main Costs template only needs one line: <app-biggest-turns ... />.
 */

import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { CostBiggestTurn, CostCodexCreditsSummary } from '../../../../shared/types/cost-purpose.types';
import type { SessionKind } from '../../../../shared/types/session-kind.types';
import { InstanceStateService } from '../../core/state/instance/instance-state.service';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';

const KIND_LABELS: Record<SessionKind | 'unknown', string> = {
  chat: 'Your chat',
  child: 'Helper',
  loop: 'Loop',
  'plan-queue': 'Plan queue',
  automation: 'Scheduled job',
  review: 'Review',
  unknown: 'Other',
};

export function biggestTurnKindLabel(kind: SessionKind | 'unknown'): string {
  return KIND_LABELS[kind];
}

/** 310,000,000 → "310M"; always three significant figures or fewer, so a column lines up. */
export function formatTurnTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(2)}B`;
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens >= 100_000_000 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K`;
  return String(Math.round(tokens));
}

export interface BiggestTurnRow {
  key: string;
  when: string;
  session: string;
  sessionTitle: string;
  kind: string;
  tokens: string;
  helpers: string;
  note: string;
}

@Component({
  selector: 'app-biggest-turns',
  standalone: true,
  imports: [AioTooltipDirective],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="turns" aria-labelledby="biggest-turns-title">
      <header>
        <h3 id="biggest-turns-title">Biggest turns this week</h3>
        <p class="detail">The ten largest single turns by tokens processed, including text re-read from the cache and helper work.</p>
      </header>

      @if (!turns()) {
        <p class="detail" data-testid="biggest-turns-unavailable">Biggest turns are not available right now.</p>
      } @else if (rows().length === 0) {
        <p class="detail" data-testid="biggest-turns-empty">No turns recorded in the last seven days.</p>
      } @else {
        <table class="grid" data-testid="biggest-turns-table">
          <thead>
            <tr>
              <th scope="col">When</th><th scope="col">Session</th><th scope="col">Kind</th>
              <th scope="col" class="num">Tokens</th><th scope="col" class="num">Helpers' part</th><th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            @for (row of rows(); track row.key) {
              <tr>
                <td>{{ row.when }}</td>
                <td [appTooltip]="row.sessionTitle">{{ row.session }}</td>
                <td>{{ row.kind }}</td>
                <td class="num mono">{{ row.tokens }}</td>
                <td class="num mono">{{ row.helpers }}</td>
                <td>{{ row.note }}</td>
              </tr>
            }
          </tbody>
        </table>
      }

      @if (credits(); as summary) {
        @if (summary.threads > 0) {
          <p class="detail" data-testid="codex-credits">
            Codex reports {{ creditsText(summary) }} used by {{ summary.threads }} {{ summary.threads === 1 ? 'session' : 'sessions' }}
            that ended this week{{ summary.estimatedUsd !== null ? ' (about ' + usdText(summary.estimatedUsd) + ' where it gave a dollar figure)' : '' }}.
            @if (summary.byKind.length > 1) {
              By kind: {{ kindCredits(summary) }}.
            }
          </p>
        }
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .turns { border: 1px solid var(--border-color); border-radius: var(--radius-md); background: var(--bg-secondary); padding: var(--spacing-md); display: flex; flex-direction: column; gap: var(--spacing-sm); }
    h3 { margin: 0; font-size: 14px; font-weight: 700; color: var(--text-primary); }
    .detail { margin: 0; font-size: 12px; color: var(--text-secondary); }
    .grid { width: 100%; border-collapse: collapse; font-size: 12px; }
    .grid th, .grid td { text-align: left; padding: var(--spacing-xs); border-top: 1px solid var(--border-color); }
    .grid th { color: var(--text-muted); font-weight: 600; border-top: 0; }
    .num { text-align: right !important; }
    .mono { font-family: var(--font-family-mono); }
  `],
})
export class BiggestTurnsComponent {
  /** Null or missing means the list did not arrive, which is not the same as no turns recorded. */
  readonly turns = input<readonly CostBiggestTurn[] | null | undefined>(null);
  readonly credits = input<CostCodexCreditsSummary | null>(null);

  private readonly instances = inject(InstanceStateService, { optional: true });

  readonly rows = computed((): BiggestTurnRow[] => (this.turns() ?? []).map((turn, index) => {
    const name = turn.instanceId ? this.instances?.getInstance(turn.instanceId)?.displayName : undefined;
    return {
      key: `${turn.instanceId ?? 'unknown'}:${turn.at}:${index}`,
      when: new Date(turn.at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
      session: name ?? (turn.instanceId ? 'Closed session' : 'Unknown'),
      sessionTitle: [turn.provider, turn.model].filter(Boolean).join(' · '),
      kind: biggestTurnKindLabel(turn.kind),
      tokens: formatTurnTokens(turn.processedTokens),
      helpers: turn.helperTokens !== undefined && turn.helperTokens > 0
        ? `${formatTurnTokens(turn.helperTokens)} (${Math.round((turn.helperShare ?? 0) * 100)}%)` : '',
      note: turn.stopRequested ? 'Stopped by Harness' : '',
    };
  }));

  creditsText(summary: CostCodexCreditsSummary): string {
    return `${summary.credits.toLocaleString('en-US', { maximumFractionDigits: 1 })} credits`;
  }

  usdText(value: number): string {
    return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }

  kindCredits(summary: CostCodexCreditsSummary): string {
    return summary.byKind
      .map((entry) => `${biggestTurnKindLabel(entry.kind).toLowerCase()} ${entry.credits.toLocaleString('en-US', { maximumFractionDigits: 1 })}`)
      .join(', ');
  }
}
