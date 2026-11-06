/**
 * "Where your usage went": the last 7 days of Claude usage, split into Anthropic's
 * nine causes. Only causes that are 10% or more are drawn, each leading with its
 * percentage, then one sentence, then one button when Harness has a control for it.
 *
 * Used on the Costs page (every Claude session) and, with `instanceId`, for a single
 * session (the session status card in the session view mounts it with
 * `<app-usage-where-went-card [instanceId]="instance().id" />` once it is opened).
 *
 * The shares are cost-weighted guides, not a reading of the allowance, and three of them
 * rest on approximations. The card says so beside the figures, and says what the figures
 * cover (this computer's Claude Code records only).
 */

import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { Router } from '@angular/router';
import { InstanceStore } from '../../core/state/instance';
import { ProviderQuotaStore } from '../../core/state/provider-quota.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { CompactionPreviewDialogComponent } from '../instance-detail/compaction-preview-dialog.component';
import { ContextAttributionPanelComponent } from '../instance-detail/context-attribution-panel.component';
import {
  USAGE_CARD_TITLE,
  USAGE_CAUSE_COPY,
  USAGE_ESTIMATES_EXPLAINED,
  USAGE_OVERLAP_NOTE,
  USAGE_PROXY_NOTE,
  USAGE_UNSUPPORTED_TEXT,
  describeUsageCoverage,
  describeUsageNote,
  formatCauseShare,
} from '../../../../shared/usage-insight/usage-cause-copy';
import { shownCauses, unmeasuredCauses, usageCauseDefinition } from '../../../../shared/usage-insight/usage-cause-rules';
import {
  USAGE_CAUSE_IDS,
  type UsageCauseId,
  type UsageInsightScope,
} from '../../../../shared/usage-insight/usage-insight.types';
import { UsageInsightController } from './usage-insight.controller';
import { resolveUsageAction, type ResolvedUsageAction, type UsageActionTarget } from './usage-insight-actions';
import { claudeWeeklyPlanLine } from './usage-plan-window';

interface CauseRow {
  id: UsageCauseId;
  title: string;
  sentence: string;
  measure: string;
  percent: number;
  shareText: string;
  action: ResolvedUsageAction | null;
}

let nextCardId = 0;

@Component({
  selector: 'app-usage-where-went-card',
  standalone: true,
  imports: [AioTooltipDirective, CompactionPreviewDialogComponent, ContextAttributionPanelComponent],
  providers: [UsageInsightController],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="uwc" [attr.aria-labelledby]="titleId" data-testid="usage-where-went">
      <header class="uwc-head">
        <div class="uwc-heading">
          <h3 class="uwc-title" [id]="titleId">{{ title }}</h3>
          <span class="uwc-sub">{{ subtitle() }}</span>
        </div>
        <button type="button" class="uwc-btn" data-testid="usage-refresh" [disabled]="busy()" (click)="refresh()">Refresh</button>
      </header>

      @if (planLine(); as plan) {
        <p class="uwc-plan" data-testid="usage-plan-window">{{ plan.text }}</p>
      }

      @if (view().phase === 'loading') {
        <p class="uwc-status" role="status" data-testid="usage-loading">Reading your Claude records…</p>
      }

      @if (scanning(); as scan) {
        <div class="uwc-status" role="status" data-testid="usage-scanning">
          <p>Reading your Claude records: {{ scan.filesDone }} of {{ scan.filesTotal }} files.</p>
          <div
            class="uwc-bar"
            role="progressbar"
            aria-label="Reading your Claude records"
            aria-valuemin="0"
            aria-valuemax="100"
            [attr.aria-valuenow]="scanPercent()"
          ><div class="uwc-bar-fill" [style.width.%]="scanPercent()"></div></div>
        </div>
      }

      @if (unsupportedText(); as text) {
        <p class="uwc-status" data-testid="usage-unsupported">{{ text }}</p>
      }

      @if (failure(); as problem) {
        <div class="uwc-error" role="alert" data-testid="usage-error">
          <p data-testid="usage-error-headline">{{ problem.headline }}</p>
          <p>{{ problem.whatToDo }}</p>
          @if (problem.rawDetail) {
            <details class="uwc-raw">
              <summary>Details</summary>
              <p data-testid="usage-error-detail">{{ problem.rawDetail }}</p>
            </details>
          }
          <button type="button" class="uwc-btn" (click)="refresh()">Try again</button>
        </div>
      }

      @if (ready(); as state) {
        @if (state.refreshing) {
          <p class="uwc-note" role="status" data-testid="usage-refreshing">Updating from your latest records…</p>
        }
        @if (state.refreshFailure; as problem) {
          <div class="uwc-error-line" role="alert" data-testid="usage-refresh-error">
            <span>Couldn't update just now. This is the previous result. {{ problem.whatToDo }}</span>
            @if (problem.rawDetail) {
              <details class="uwc-raw">
                <summary>Details</summary>
                <p>{{ problem.rawDetail }}</p>
              </details>
            }
          </div>
        }

        @if (state.report.totals.requests === 0) {
          <p class="uwc-status" data-testid="usage-empty">{{ emptyText() }}</p>
          @if (noteTexts().length > 0) {
            <!-- Something could not be read: say so, so "no usage" is not mistaken for "nothing there". -->
            <ul class="uwc-notes" data-testid="usage-empty-notes">
              @for (note of noteTexts(); track note) {
                <li>{{ note }}</li>
              }
            </ul>
          }
        } @else if (rows().length === 0) {
          <p class="uwc-status" data-testid="usage-quiet">Nothing stands out. No single cause is 10% or more of this usage.</p>
        } @else {
          <ul class="uwc-list" data-testid="usage-causes">
            @for (row of rows(); track row.id) {
              <li class="uwc-row" [attr.data-cause]="row.id">
                <span class="uwc-pct" tabindex="0" [appTooltip]="row.measure">{{ row.percent }}%</span>
                <div class="uwc-body">
                  <div class="uwc-row-title">{{ row.title }}</div>
                  <div class="uwc-share">{{ row.shareText }}</div>
                  <p class="uwc-sentence">{{ row.sentence }}</p>
                  @if (row.action; as action) {
                    <button type="button" class="uwc-btn uwc-action" (click)="run(action)">{{ action.label }}</button>
                  }
                </div>
              </li>
            }
          </ul>
          <p class="uwc-note" data-testid="usage-overlap-note">{{ overlapNote }} {{ proxyNote }}</p>
        }

        @if (unmeasured().length > 0) {
          <p class="uwc-note" data-testid="usage-unmeasured">
            Not measured yet: {{ unmeasuredTitles() }}. Harness hasn't recorded the effort setting for this usage.
          </p>
        }

        @if (state.report.totals.requests > 0) {
          <p class="uwc-note" data-testid="usage-coverage">{{ coverage() }}</p>
          <details class="uwc-how">
            <summary>How this was worked out</summary>
            <p>
              Based on {{ state.report.totals.requests.toLocaleString('en-GB') }} requests across
              {{ state.report.totals.sessions.toLocaleString('en-GB') }} sessions
              ({{ state.report.totals.harnessSessions.toLocaleString('en-GB') }} started by Harness).
              Each request counts for what it would cost at API prices, so a big request counts for more than a small one.
              {{ proxyNote }}
            </p>
            <p data-testid="usage-estimates">{{ estimatesExplained }}</p>
            @if (noteTexts().length > 0) {
              <ul>
                @for (note of noteTexts(); track note) {
                  <li>{{ note }}</li>
                }
              </ul>
            }
          </details>
        }
      }

      @if (contextFor(); as contextId) {
        <div class="uwc-context" data-testid="usage-context-details">
          <div class="uwc-context-head">
            <strong>Context details</strong>
            <button type="button" class="uwc-btn" (click)="contextFor.set(null)">Close</button>
          </div>
          <app-context-attribution-panel [instanceId]="contextId" />
        </div>
      }

      <app-compaction-preview-dialog
        [instanceId]="compactFor()"
        [isOpen]="compactFor() !== null"
        (closed)="compactFor.set(null)"
      />
    </section>
  `,
  styles: [`
    .uwc {
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: var(--radius-md);
      padding: var(--spacing-md);
      display: flex;
      flex-direction: column;
      gap: var(--spacing-sm);
      color: var(--text-primary);
    }
    .uwc-head { display: flex; align-items: flex-start; gap: var(--spacing-md); }
    .uwc-heading { display: flex; flex-direction: column; flex: 1; min-width: 0; }
    .uwc-title { margin: 0; font-size: 14px; font-weight: 700; }
    .uwc-sub { font-size: 12px; color: var(--text-muted); }
    .uwc-plan { margin: 0; font-size: 13px; font-weight: 600; }
    .uwc-status, .uwc-note, .uwc-how { font-size: 12px; color: var(--text-muted); margin: 0; }
    .uwc-status p { margin: 0 0 var(--spacing-xs); }
    .uwc-error, .uwc-error-line { font-size: 12px; color: var(--error-color); }
    .uwc-error p { margin: 0 0 var(--spacing-xs); }
    .uwc-error-line { margin: 0; }
    .uwc-raw summary { cursor: pointer; }
    .uwc-raw p { margin: var(--spacing-xs) 0; font-family: var(--font-family-mono); word-break: break-word; }
    .uwc-bar { height: 6px; border-radius: 999px; background: var(--bg-tertiary); overflow: hidden; }
    .uwc-bar-fill { height: 100%; background: var(--primary-color); transition: width 0.3s ease; }
    .uwc-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: var(--spacing-md); }
    .uwc-row { display: grid; grid-template-columns: 72px minmax(0, 1fr); gap: var(--spacing-md); align-items: start; }
    .uwc-pct {
      font-family: var(--font-family-mono);
      font-size: 24px;
      font-weight: 700;
      line-height: 1.1;
      text-align: right;
      cursor: help;
    }
    .uwc-body { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .uwc-row-title { font-size: 13px; font-weight: 600; }
    .uwc-share { font-size: 11px; color: var(--text-muted); }
    .uwc-sentence { margin: 2px 0 0; font-size: 12px; line-height: 1.4; }
    .uwc-btn {
      border-radius: var(--radius-sm);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      padding: var(--spacing-xs) var(--spacing-sm);
      font-size: 12px;
      cursor: pointer;
    }
    .uwc-btn:hover:not(:disabled) { background: var(--bg-secondary); }
    .uwc-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .uwc-action { align-self: flex-start; margin-top: var(--spacing-xs); }
    .uwc-notes { margin: 0; padding-left: var(--spacing-md); font-size: 12px; color: var(--text-muted); }
    .uwc-how summary { cursor: pointer; }
    .uwc-how p, .uwc-how ul { margin: var(--spacing-xs) 0 0; }
    .uwc-context { border-top: 1px solid var(--border-color); padding-top: var(--spacing-sm); }
    .uwc-context-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--spacing-xs); font-size: 12px; }
  `],
})
export class UsageWhereWentCardComponent {
  /** Limit the card to one Claude session. Leave unset for every session. */
  readonly instanceId = input<string | null>(null);

  private readonly controller = inject(UsageInsightController);
  private readonly instances = inject(InstanceStore);
  private readonly quota = inject(ProviderQuotaStore);
  private readonly router = inject(Router);

  protected readonly title = USAGE_CARD_TITLE;
  protected readonly overlapNote = USAGE_OVERLAP_NOTE;
  protected readonly proxyNote = USAGE_PROXY_NOTE;
  protected readonly estimatesExplained = USAGE_ESTIMATES_EXPLAINED;
  protected readonly titleId = `usage-where-went-title-${nextCardId++}`;
  protected readonly view = this.controller.view;

  /** Session whose compaction preview is open. */
  protected readonly compactFor = signal<string | null>(null);
  /** Session whose context details are open under the list. */
  protected readonly contextFor = signal<string | null>(null);

  protected readonly scope = computed<UsageInsightScope>(() => {
    const id = this.instanceId();
    return id ? { kind: 'session', instanceId: id } : { kind: 'all' };
  });

  protected readonly subtitle = computed(() =>
    this.scope().kind === 'session' ? 'This session, last 7 days' : 'Claude sessions on this computer, last 7 days');

  protected readonly ready = computed(() => {
    const view = this.view();
    return view.phase === 'ready' ? view : null;
  });
  protected readonly scanning = computed(() => {
    const view = this.view();
    return view.phase === 'scanning' ? view.progress : null;
  });
  protected readonly failure = computed(() => {
    const view = this.view();
    return view.phase === 'error' ? view.failure : null;
  });
  protected readonly unsupportedText = computed(() => {
    const view = this.view();
    return view.phase === 'unsupported' ? USAGE_UNSUPPORTED_TEXT[view.reason] : null;
  });
  protected readonly busy = computed(() => {
    const view = this.view();
    return view.phase === 'loading' || view.phase === 'scanning' || (view.phase === 'ready' && view.refreshing);
  });
  protected readonly scanPercent = computed(() => {
    const progress = this.scanning();
    return progress && progress.bytesTotal > 0
      ? Math.min(100, Math.round((progress.bytesDone / progress.bytesTotal) * 100))
      : 0;
  });

  /** The Claude session the buttons would act on, or null when there is none. */
  private readonly target = computed<UsageActionTarget | null>(() => {
    const id = this.instanceId();
    const instance = id ? this.instances.instancesMap().get(id) : this.instances.selectedInstance();
    return instance && instance.provider === 'claude' ? { id: instance.id, name: instance.displayName } : null;
  });

  protected readonly planLine = computed(() => {
    if (this.scope().kind !== 'all') return null;
    const snapshots = this.quota.snapshots();
    return claudeWeeklyPlanLine([snapshots.claude, ...this.quota.accountSnapshots()], Date.now());
  });

  protected readonly rows = computed<CauseRow[]>(() => {
    const state = this.ready();
    if (!state) return [];
    const scope = this.scope();
    const target = this.target();
    return shownCauses(state.report.causes).map((cause) => {
      const copy = USAGE_CAUSE_COPY[cause.id];
      const definition = usageCauseDefinition(cause.id);
      const percent = cause.percent ?? 0;
      return {
        id: cause.id,
        title: copy.title,
        sentence: copy.sentence,
        measure: copy.measure,
        percent,
        shareText: formatCauseShare(percent, scope, { atLeast: cause.atLeast === true, estimate: definition.estimated === true }),
        action: resolveUsageAction(definition.action, scope, target),
      };
    });
  });

  protected readonly coverage = computed(() => {
    const state = this.ready();
    return state ? describeUsageCoverage(state.report) : '';
  });

  protected readonly unmeasured = computed(() => {
    const state = this.ready();
    return state ? unmeasuredCauses(state.report.causes) : [];
  });
  protected readonly unmeasuredTitles = computed(() => {
    const ids = new Set(this.unmeasured().map((cause) => cause.id));
    return USAGE_CAUSE_IDS.filter((id) => ids.has(id)).map((id) => USAGE_CAUSE_COPY[id].title).join(' and ');
  });
  /** Gaps in the evidence. "No usage" is already the card's own empty message, so it is not repeated. */
  protected readonly noteTexts = computed(() =>
    this.ready()?.report.notes.filter((note) => note.code !== 'no-claude-usage').map(describeUsageNote) ?? []);
  protected readonly emptyText = computed(() => this.scope().kind === 'session'
    ? 'No Claude usage from this session in the last 7 days.'
    : 'No Claude usage found in the last 7 days.');

  constructor() {
    effect(() => {
      const id = this.instanceId();
      untracked(() => {
        this.compactFor.set(null);
        this.contextFor.set(null);
        void this.controller.open(id);
      });
    });
  }

  protected refresh(): void {
    void this.controller.refresh();
  }

  protected run(action: ResolvedUsageAction): void {
    switch (action.kind) {
      case 'compact':
        this.compactFor.set(action.instanceId);
        return;
      case 'context':
        this.contextFor.update((current) => (current === action.instanceId ? null : action.instanceId));
        return;
      case 'settings':
        void this.router.navigate(['/settings'], { queryParams: { tab: action.tab } });
        return;
      case 'route':
        void this.router.navigate([action.path]);
        return;
    }
  }
}
