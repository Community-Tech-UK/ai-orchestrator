/**
 * WS8 context attribution + cache analytics panel.
 *
 * Renders "what is eating this instance's context window" as a stacked
 * per-source bar with a legend, plus a prompt-cache hit-ratio sparkline with
 * the last detected cache break. Data is fetched on mount and refreshed on a
 * slow interval — the component is only mounted while the panel is expanded,
 * so there is no hot-path cost.
 */

import { DatePipe, DecimalPipe } from '@angular/common';
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
import type {
  ContextManifestBlockKind,
  ContextManifestEntryStatus,
  ContextManifestReport,
  ContextManifestSnapshot,
  ContextManifestTrigger,
} from '../../../../shared/types/context-manifest.types';
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

const MANIFEST_BLOCK_LABELS: Record<ContextManifestBlockKind, string> = {
  instructions: 'Instructions',
  'output-style': 'Output style',
  'observation-memory': 'Observation memory',
  'project-brief': 'Project brief',
  lessons: 'Lessons',
  'repo-map': 'Repo map',
  'wake-context': 'Wake context',
  'mcp-tool-context': 'MCP tool context',
  'tool-permissions': 'Tool permissions',
};

const MANIFEST_TRIGGER_LABELS: Record<ContextManifestTrigger, string> = {
  spawn: 'Spawn',
  respawn: 'Respawn / continuity',
  'restart-compact': 'Restart (compaction)',
};

const MANIFEST_STATUS_LABELS: Record<ContextManifestEntryStatus, string> = {
  supplied: 'supplied',
  'skipped-empty': 'skipped (empty)',
  unavailable: 'unavailable',
};

export interface ManifestEntryRow {
  kind: ContextManifestBlockKind;
  label: string;
  status: ContextManifestEntryStatus;
  statusLabel: string;
  shortHash?: string;
  charLength?: number;
}

export interface ManifestEpochRow {
  epoch: number;
  at: number;
  trigger: ContextManifestTrigger;
  triggerLabel: string;
  note?: string;
  suppliedCount: number;
  totalCount: number;
  entries: ManifestEntryRow[];
}

/** Newest epoch first, with human-readable labels for the template. */
export function buildManifestEpochRows(
  history: readonly ContextManifestSnapshot[] | undefined,
): ManifestEpochRow[] {
  if (!history || history.length === 0) return [];
  return [...history].reverse().map((snapshot) => ({
    epoch: snapshot.epoch,
    at: snapshot.at,
    trigger: snapshot.trigger,
    triggerLabel: MANIFEST_TRIGGER_LABELS[snapshot.trigger],
    note: snapshot.note,
    suppliedCount: snapshot.entries.filter((entry) => entry.status === 'supplied').length,
    totalCount: snapshot.entries.length,
    entries: snapshot.entries.map((entry) => ({
      kind: entry.kind,
      label: MANIFEST_BLOCK_LABELS[entry.kind],
      status: entry.status,
      statusLabel: MANIFEST_STATUS_LABELS[entry.status],
      shortHash: entry.contentHash ? entry.contentHash.slice(0, 8) : undefined,
      charLength: entry.charLength,
    })),
  }));
}

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
  imports: [DecimalPipe, DatePipe],
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

        <div class="section">
          <div class="section-title">
            Context manifest
            <span class="estimated-note" title="AIO can only prove what it composed and sent — never what the provider's own process actually kept or used from it.">AIO-owned sources only</span>
          </div>
          <p class="manifest-honesty-note">
            Records exactly which AIO-owned context sources (instructions, project brief, lessons, etc.)
            this instance's system prompt actually received, per reassembly. Provider-side prompt
            caching or session state cannot be verified from here.
          </p>
          @if (manifestEpochs().length === 0) {
            <p class="panel-loading">No context manifest recorded yet.</p>
          } @else {
            <ul class="manifest-epoch-list">
              @for (epoch of manifestEpochs(); track epoch.epoch) {
                <li>
                  <details [open]="isEpochExpanded(epoch.epoch)" (toggle)="onEpochToggle(epoch.epoch, $event)">
                    <summary>
                      <span class="epoch-badge">Epoch {{ epoch.epoch }}</span>
                      <span class="epoch-trigger">{{ epoch.triggerLabel }}</span>
                      <span class="epoch-supplied">{{ epoch.suppliedCount }}/{{ epoch.totalCount }} supplied</span>
                      <span class="epoch-at">{{ epoch.at | date:'short' }}</span>
                    </summary>
                    @if (epoch.note) {
                      <p class="manifest-honesty-note epoch-note">{{ epoch.note }}</p>
                    }
                    <ul class="manifest-entry-list">
                      @for (entry of epoch.entries; track entry.kind) {
                        <li [class]="'manifest-entry status-' + entry.status">
                          <span class="entry-label">{{ entry.label }}</span>
                          <span class="entry-status">{{ entry.statusLabel }}</span>
                          @if (entry.shortHash) {
                            <span class="entry-hash" [title]="'sha256 ' + entry.shortHash">{{ entry.shortHash }}</span>
                          }
                          @if (entry.charLength !== undefined) {
                            <span class="entry-length">{{ entry.charLength | number:'1.0-0' }} chars</span>
                          }
                        </li>
                      }
                    </ul>
                  </details>
                </li>
              }
            </ul>
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

    .manifest-honesty-note {
      margin: 0 0 6px;
      color: var(--text-muted);
      line-height: 1.4;
    }

    .manifest-epoch-list {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: 4px;
    }

    .manifest-epoch-list summary {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
      font-family: var(--font-mono);
      padding: 2px 0;
    }

    .manifest-epoch-list summary::marker { color: var(--text-muted); }

    .epoch-badge { font-weight: 600; color: var(--text-primary); }
    .epoch-trigger { color: var(--primary-color); }
    .epoch-supplied { color: var(--text-muted); }
    .epoch-at { margin-left: auto; color: var(--text-muted); }

    .epoch-note { padding-left: 16px; }

    .manifest-entry-list {
      list-style: none;
      margin: 4px 0 6px;
      padding: 0 0 0 16px;
      display: grid;
      gap: 2px;
    }

    .manifest-entry {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto auto;
      gap: 8px;
      align-items: center;
      font-family: var(--font-mono);
    }

    .manifest-entry.status-skipped-empty,
    .manifest-entry.status-unavailable {
      color: var(--text-muted);
    }

    .manifest-entry.status-unavailable .entry-status { color: var(--warning-color); }

    .entry-label {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .entry-hash, .entry-length { color: var(--text-muted); }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ContextAttributionPanelComponent implements OnInit, OnDestroy {
  instanceId = input.required<string>();

  private readonly ipc = inject(ElectronIpcService);
  private refreshTimer: ReturnType<typeof setInterval> | null = null;

  private readonly attributionState = signal<ContextAttributionReport | null>(null);
  private readonly cacheState = signal<CacheAnalyticsReport | null>(null);
  private readonly manifestState = signal<ContextManifestReport | null>(null);
  private readonly errorState = signal<string | null>(null);
  /** Epoch numbers the user has explicitly expanded/collapsed; unset epochs default to "latest expanded". */
  private readonly manifestEpochOverrides = signal<ReadonlyMap<number, boolean>>(new Map());

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

  readonly manifestEpochs = computed(() => buildManifestEpochRows(this.manifestState()?.history));
  private readonly latestManifestEpoch = computed(() => this.manifestEpochs()[0]?.epoch);

  isEpochExpanded(epoch: number): boolean {
    const override = this.manifestEpochOverrides().get(epoch);
    return override ?? epoch === this.latestManifestEpoch();
  }

  onEpochToggle(epoch: number, event: Event): void {
    const isOpen = (event.target as HTMLDetailsElement).open;
    const next = new Map(this.manifestEpochOverrides());
    next.set(epoch, isOpen);
    this.manifestEpochOverrides.set(next);
  }

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
      const [attribution, cache, manifest] = await Promise.all([
        api.contextAttributionGet({ instanceId: this.instanceId() }),
        api.cacheAnalyticsGet({ instanceId: this.instanceId() }),
        // Optional: older builds' preload bundle may not expose this channel yet.
        api.contextManifestGet?.({ instanceId: this.instanceId() }) ?? Promise.resolve(null),
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
      if (manifest?.success && manifest.data) {
        this.manifestState.set(manifest.data as ContextManifestReport);
      }
    } catch (error) {
      this.errorState.set(error instanceof Error ? error.message : String(error));
    }
  }
}
