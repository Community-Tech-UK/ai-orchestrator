/**
 * WS8 context attribution + cache analytics panel.
 *
 * Renders "what is eating this instance's context window" as a stacked
 * per-source bar with a legend, plus a prompt-cache hit-ratio sparkline with
 * the last detected cache break. Data is fetched on mount and refreshed on a
 * slow interval — the component is only mounted while the panel is expanded,
 * so there is no hot-path cost.
 */

import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import type {
  CacheAnalyticsReport,
  ContextAttributionBucketKey,
  ContextAttributionReport,
} from '../../../../shared/types/context-attribution.types';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';

const REFRESH_INTERVAL_MS = 10_000;

const BUCKET_LABELS: Record<ContextAttributionBucketKey, string> = {
  instructionFiles: 'Instruction files',
  mcpToolSchemas: 'MCP tool schemas',
  conversationHistory: 'Conversation',
  toolResults: 'Tool traffic',
  attachments: 'Attachments',
  other: 'Other / unattributed',
};

export interface AttributionRow {
  key: ContextAttributionBucketKey;
  label: string;
  tokens: number;
  percent: number;
  detail: { label: string; tokens: number }[];
}

/** Non-empty buckets as legend/bar rows with percentages of the known total. */
export function buildAttributionRows(report: ContextAttributionReport | null): AttributionRow[] {
  if (!report) return [];
  const total = report.buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
  return report.buckets
    .filter((bucket) => bucket.tokens > 0)
    .map((bucket) => ({
      key: bucket.key,
      label: BUCKET_LABELS[bucket.key],
      tokens: bucket.tokens,
      percent: total > 0 ? (bucket.tokens / total) * 100 : 0,
      detail: bucket.detail ?? [],
    }));
}

/** SVG polyline points for a 100×24 viewBox; ratio 1.0 → y=2, ratio 0 → y=22. */
export function buildSparklinePoints(samples: readonly { ratio: number }[]): string {
  if (samples.length < 2) return '';
  const step = 100 / (samples.length - 1);
  return samples
    .map((sample, index) => `${(index * step).toFixed(2)},${(22 - sample.ratio * 20).toFixed(2)}`)
    .join(' ');
}

@Component({
  selector: 'app-context-attribution-panel',
  standalone: true,
  imports: [DecimalPipe],
  template: `
    <div class="attribution-panel">
      @if (error(); as message) {
        <p class="panel-error" role="alert">{{ message }}</p>
      } @else if (!attribution()) {
        <p class="panel-loading" role="status">Measuring context usage…</p>
      } @else {
        <div class="section">
          <div class="section-title">
            Context by source
            <span class="estimated-note" title="Char-heuristic estimates (same family as the compactor); the provider-owned system prompt is not observable and lands in Other.">~estimated</span>
          </div>
          <div class="stacked-bar" role="img" aria-label="Context usage by source">
            @for (row of rows(); track row.key) {
              <div
                class="segment"
                [class]="'segment seg-' + row.key"
                [style.width.%]="row.percent"
                [title]="row.label + ': ' + row.tokens + ' tokens'"
              ></div>
            }
          </div>
          <ul class="legend">
            @for (row of rows(); track row.key) {
              <li>
                <span class="swatch" [class]="'swatch seg-' + row.key"></span>
                <span class="label">{{ row.label }}</span>
                <span class="tokens">{{ row.tokens | number:'1.0-0' }}</span>
                <span class="percent">({{ row.percent | number:'1.0-0' }}%)</span>
              </li>
              @for (detail of row.detail; track detail.label) {
                <li class="detail-row">
                  <span class="label detail-label" [title]="detail.label">{{ detail.label }}</span>
                  <span class="tokens">{{ detail.tokens | number:'1.0-0' }}</span>
                </li>
              }
            }
          </ul>
        </div>

        <div class="section">
          <div class="section-title">Prompt-cache hit ratio</div>
          @if (cacheSamples().length > 1) {
            <svg class="sparkline" viewBox="0 0 100 24" preserveAspectRatio="none" role="img"
                 aria-label="Cache hit ratio per turn">
              <polyline [attr.points]="sparklinePoints()" />
            </svg>
            <div class="cache-meta">
              <span>latest {{ latestRatioPct() | number:'1.0-0' }}%</span>
              @if (lastBreak(); as brk) {
                <span class="cache-break" [title]="'Hit ratio fell to ' + (brk.ratio * 100 | number:'1.0-0') + '% vs median ' + (brk.trailingMedian * 100 | number:'1.0-0') + '%'">
                  cache broke{{ brk.probableCause ? ' after: ' + brk.probableCause : '' }}
                </span>
              }
            </div>
          } @else {
            <p class="panel-loading">Not enough completed turns with cache data yet.</p>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .attribution-panel {
      display: grid;
      gap: 10px;
      padding: 8px 0 2px;
      font-size: 11px;
      color: var(--text-secondary);
    }

    .section-title {
      display: flex;
      align-items: center;
      gap: 6px;
      font-weight: 600;
      color: var(--text-primary);
      margin-bottom: 4px;
    }

    .estimated-note {
      font-weight: 400;
      color: var(--warning-color);
      cursor: help;
    }

    .stacked-bar {
      display: flex;
      height: 10px;
      border-radius: var(--radius-full);
      overflow: hidden;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .segment { height: 100%; min-width: 0; }

    .seg-instructionFiles { background: #7aa2f7; }
    .seg-mcpToolSchemas { background: #bb9af7; }
    .seg-conversationHistory { background: #9ece6a; }
    .seg-toolResults { background: #e0af68; }
    .seg-attachments { background: #f7768e; }
    .seg-other { background: rgba(255, 255, 255, 0.18); }

    .legend {
      list-style: none;
      margin: 6px 0 0;
      padding: 0;
      display: grid;
      gap: 2px;
    }

    .legend li {
      display: grid;
      grid-template-columns: 10px minmax(0, 1fr) auto auto;
      align-items: center;
      gap: 6px;
      font-family: var(--font-mono);
    }

    .legend li.detail-row {
      grid-template-columns: minmax(0, 1fr) auto;
      padding-left: 16px;
      color: var(--text-muted);
    }

    .swatch {
      width: 10px;
      height: 10px;
      border-radius: 2px;
    }

    .label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .detail-label { direction: rtl; text-align: left; }
    .tokens { color: var(--text-primary); }
    .percent { color: var(--text-muted); }

    .sparkline {
      width: 100%;
      height: 24px;
      display: block;
    }

    .sparkline polyline {
      fill: none;
      stroke: var(--primary-color);
      stroke-width: 1.5;
      vector-effect: non-scaling-stroke;
    }

    .cache-meta {
      display: flex;
      gap: 10px;
      margin-top: 2px;
      font-family: var(--font-mono);
    }

    .cache-break { color: var(--warning-color); }
    .panel-error { color: var(--error-color); margin: 0; }
    .panel-loading { color: var(--text-muted); margin: 0; }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContextAttributionPanelComponent implements OnInit, OnDestroy {
  instanceId = input.required<string>();

  private readonly ipc = inject(ElectronIpcService);
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  private readonly attributionState = signal<ContextAttributionReport | null>(null);
  private readonly cacheState = signal<CacheAnalyticsReport | null>(null);
  private readonly errorState = signal<string | null>(null);

  readonly attribution = this.attributionState.asReadonly();
  readonly error = this.errorState.asReadonly();

  readonly rows = computed(() => buildAttributionRows(this.attributionState()));

  readonly cacheSamples = computed(() => this.cacheState()?.samples ?? []);
  readonly lastBreak = computed(() => this.cacheState()?.lastBreak ?? null);

  readonly latestRatioPct = computed(() => {
    const samples = this.cacheSamples();
    return samples.length > 0 ? samples[samples.length - 1].ratio * 100 : 0;
  });

  readonly sparklinePoints = computed(() => buildSparklinePoints(this.cacheSamples()));

  ngOnInit(): void {
    void this.refresh();
    this.refreshTimer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS);
  }

  ngOnDestroy(): void {
    if (this.refreshTimer !== null) clearInterval(this.refreshTimer);
  }

  async refresh(): Promise<void> {
    const api = this.ipc.getApi();
    if (!api?.contextAttributionGet || !api?.cacheAnalyticsGet) {
      this.errorState.set('Context attribution IPC is unavailable.');
      return;
    }
    try {
      const [attribution, cache] = await Promise.all([
        api.contextAttributionGet({ instanceId: this.instanceId() }),
        api.cacheAnalyticsGet({ instanceId: this.instanceId() }),
      ]);
      if (attribution.success && attribution.data) {
        this.attributionState.set(attribution.data as ContextAttributionReport);
        this.errorState.set(null);
      } else {
        this.errorState.set(attribution.error?.message ?? 'Failed to compute attribution.');
      }
      if (cache.success && cache.data) {
        this.cacheState.set(cache.data as CacheAnalyticsReport);
      }
    } catch (error) {
      this.errorState.set(error instanceof Error ? error.message : String(error));
    }
  }
}
