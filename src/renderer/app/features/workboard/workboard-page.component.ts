import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
} from '@angular/core';
import { Router } from '@angular/router';
import { InstanceDetailComponent } from '../instance-detail/instance-detail.component';
import { WorkboardCardComponent } from './workboard-card.component';
import { WorkboardSourceSummaryComponent } from './workboard-source-summary.component';
import { WorkboardStore } from './workboard.store';
import type { WorkboardLane } from './workboard.types';

interface LaneMeta {
  lane: WorkboardLane;
  heading: string;
  empty: string;
}

/** Fixed lane presentation metadata, in display order. */
export const WORKBOARD_LANE_META: readonly LaneMeta[] = [
  { lane: 'needs-you', heading: 'Needs You', empty: 'All clear' },
  { lane: 'working', heading: 'Working', empty: 'Nothing active' },
  { lane: 'waiting', heading: 'Waiting', empty: 'Nothing queued or paused' },
  { lane: 'done', heading: 'Done / Idle', empty: 'No recent completions' },
];

const REFRESH_INTERVAL_MS = 4000;

/**
 * The Workboard: a workspace-filtered, four-lane attention board that projects
 * instances, loop runs, automation runs, and repository jobs, with a detail pane
 * that reuses the existing instance transcript for instance-linked work.
 *
 * Template and styles are inlined (rather than external files) so the component
 * renders under the JIT vitest harness — the same pattern as the Fleet dashboard
 * this surface replaces.
 */
@Component({
  selector: 'app-workboard-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [InstanceDetailComponent, WorkboardCardComponent, WorkboardSourceSummaryComponent],
  providers: [WorkboardStore],
  template: `
    <div class="wb" [class.wb-detail-open]="showDetail()">
      <header class="wb-header">
        <div class="wb-heading">
          <h1 class="wb-title">Workboard</h1>
          <span class="wb-total" aria-label="Total visible items">{{ store.visibleCount() }} visible</span>
        </div>
        <div class="wb-controls">
          <label class="wb-workspace">
            <span class="wb-workspace-label">Workspace</span>
            <select
              class="wb-workspace-select"
              [value]="store.selectedWorkspaceId()"
              (change)="onSelectWorkspace($event)"
            >
              @for (option of store.workspaceOptions(); track option.id) {
                <option
                  [value]="option.id"
                  [attr.title]="option.workingDirectory || option.label"
                  [attr.aria-label]="option.workingDirectory || option.label"
                >
                  {{ option.label }}
                </option>
              }
            </select>
          </label>
          <button type="button" class="wb-refresh" (click)="onRefresh()" [attr.aria-busy]="store.refreshing()">
            Refresh
          </button>
        </div>
      </header>

      @if (store.loopError() || store.repoJobError() || store.automationError()) {
        <div class="wb-source-errors">
          @if (store.loopError()) {
            <div class="wb-source-error" role="status">
              <span>Loops: {{ store.loopError() }}</span>
              <button type="button" (click)="store.retryLoops()">Retry</button>
            </div>
          }
          @if (store.repoJobError()) {
            <div class="wb-source-error" role="status">
              <span>Background Jobs: {{ store.repoJobError() }}</span>
              <button type="button" (click)="store.retryRepoJobs()">Retry</button>
            </div>
          }
          @if (store.automationError()) {
            <div class="wb-source-error" role="status">
              <span>Automations: {{ store.automationError() }}</span>
              <button type="button" (click)="store.retryAutomations()">Retry</button>
            </div>
          }
        </div>
      }

      <div class="wb-body">
        <section class="wb-board" aria-label="Workboard lanes">
          @for (meta of laneMeta; track meta.lane) {
            <section class="wb-lane" [attr.data-lane]="meta.lane" [attr.aria-labelledby]="'wb-lane-' + meta.lane">
              <h2 class="wb-lane-head" [id]="'wb-lane-' + meta.lane">
                <span class="wb-lane-name">{{ meta.heading }}</span>
                <span class="wb-lane-count">{{ store.lanes()[meta.lane].length }}</span>
              </h2>
              <div class="wb-lane-cards">
                @for (item of store.lanes()[meta.lane]; track item.id) {
                  <app-workboard-card
                    [item]="item"
                    [now]="0"
                    [selected]="store.selectedItemId() === item.id"
                    (activate)="onActivate($event)"
                  />
                }
                @if (store.lanes()[meta.lane].length === 0) {
                  <p class="wb-lane-empty">{{ meta.empty }}</p>
                }
              </div>
            </section>
          }
        </section>

        <section class="wb-detail" aria-label="Selected item detail">
          @if (showDetail()) {
            <button type="button" class="wb-back" (click)="onBack()">← Back to Workboard</button>
          }
          @if (store.selectedWorkboardItem(); as selected) {
            @if (detailInstanceId()) {
              <div class="wb-detail-instance">
                <app-instance-detail />
              </div>
            } @else {
              <app-workboard-source-summary
                [item]="selected"
                [now]="0"
                (openSpecialist)="onOpenSpecialist($event)"
              />
            }
          } @else {
            <div class="wb-detail-placeholder">
              <p>Select a card to see its details.</p>
            </div>
          }
        </section>
      </div>

      <p class="wb-live" aria-live="polite">{{ liveAnnouncement() }}</p>
    </div>
  `,
  styles: [`
    :host { display: block; height: 100%; overflow: hidden; }

    .wb {
      display: flex;
      flex-direction: column;
      height: 100%;
      background: var(--bg-primary);
      color: var(--text-primary);
    }

    .wb-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3, 12px);
      padding: var(--space-3, 12px) var(--space-4, 20px);
      border-bottom: 1px solid var(--border-color);
      background: var(--bg-secondary);
      flex-shrink: 0;
      flex-wrap: wrap;
    }

    .wb-heading { display: flex; align-items: baseline; gap: var(--space-3, 12px); }
    .wb-title { font-size: var(--text-lg, 16px); font-weight: 700; margin: 0; }
    .wb-total { font-family: var(--font-mono, monospace); font-size: 11px; color: var(--text-secondary); }
    .wb-controls { display: flex; align-items: center; gap: var(--space-3, 12px); flex-wrap: wrap; }
    .wb-workspace { display: flex; align-items: center; gap: var(--space-2, 6px); }

    .wb-workspace-label {
      font-size: var(--text-xs, 11px);
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }

    .wb-workspace-select,
    .wb-refresh {
      font-size: var(--text-sm, 12px);
      padding: var(--space-2, 6px) var(--space-3, 10px);
      border-radius: var(--radius-md, 8px);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      cursor: pointer;
    }

    .wb-workspace-select:focus-visible,
    .wb-refresh:focus-visible {
      outline: 2px solid var(--border-focus, var(--primary-color));
      outline-offset: 2px;
    }

    .wb-refresh:hover { background: var(--bg-hover); }

    .wb-source-errors {
      display: flex;
      flex-direction: column;
      gap: var(--space-2, 6px);
      padding: var(--space-2, 8px) var(--space-4, 20px);
      flex-shrink: 0;
    }

    .wb-source-error {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3, 12px);
      padding: var(--space-2, 6px) var(--space-3, 10px);
      border-radius: var(--radius-md, 8px);
      background: var(--status-warning-bg, var(--error-bg));
      border: 1px solid var(--status-warning-border, var(--error-border));
      font-size: var(--text-sm, 12px);
      color: var(--text-secondary);
    }

    .wb-source-error button {
      flex-shrink: 0;
      padding: 2px 10px;
      border-radius: var(--radius-sm, 6px);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      cursor: pointer;
    }

    .wb-body {
      display: grid;
      grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
      gap: var(--space-3, 12px);
      flex: 1;
      min-height: 0;
      padding: var(--space-3, 12px) var(--space-4, 20px);
    }

    .wb-board {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: var(--space-3, 12px);
      align-content: start;
      overflow: auto;
      min-height: 0;
    }

    .wb-lane { display: flex; flex-direction: column; gap: var(--space-2, 8px); min-width: 0; }

    .wb-lane-head {
      display: flex;
      align-items: center;
      gap: var(--space-2, 8px);
      margin: 0;
      padding: var(--space-2, 6px) var(--space-2, 4px);
      font-size: var(--text-sm, 12px);
      font-weight: 600;
      border-bottom: 1px solid var(--border-subtle, var(--border-color));
    }

    .wb-lane[data-lane='needs-you'] .wb-lane-head {
      border-bottom-color: var(--status-error, var(--error-color));
    }

    .wb-lane-name { flex: 1; }

    .wb-lane-count {
      font-family: var(--font-mono, monospace);
      font-size: 11px;
      min-width: 20px;
      padding: 1px 7px;
      border-radius: var(--radius-full, 999px);
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle, var(--border-color));
      color: var(--text-secondary);
      text-align: center;
    }

    .wb-lane-cards { display: flex; flex-direction: column; gap: var(--space-2, 8px); }

    .wb-lane-empty {
      font-size: var(--text-sm, 12px);
      color: var(--text-muted);
      margin: 0;
      padding: var(--space-2, 6px) var(--space-2, 4px);
    }

    .wb-detail {
      display: flex;
      flex-direction: column;
      min-height: 0;
      overflow: hidden;
      border: 1px solid var(--border-subtle, var(--border-color));
      border-radius: var(--radius-lg, 10px);
      background: var(--bg-secondary);
    }

    .wb-detail-instance { flex: 1; min-height: 0; overflow: hidden; display: flex; }
    .wb-detail-instance > * { flex: 1; min-width: 0; }

    .wb-detail-placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 1;
      color: var(--text-muted);
      font-size: var(--text-sm, 13px);
    }

    .wb-back {
      display: none;
      align-self: flex-start;
      margin: var(--space-2, 8px);
      padding: var(--space-2, 6px) var(--space-3, 12px);
      border-radius: var(--radius-md, 8px);
      border: 1px solid var(--border-color);
      background: var(--bg-tertiary);
      color: var(--text-primary);
      font-size: var(--text-sm, 13px);
      cursor: pointer;
    }

    .wb-back:focus-visible {
      outline: 2px solid var(--border-focus, var(--primary-color));
      outline-offset: 2px;
    }

    .wb-live {
      position: absolute;
      width: 1px;
      height: 1px;
      margin: -1px;
      padding: 0;
      overflow: hidden;
      clip: rect(0 0 0 0);
      white-space: nowrap;
      border: 0;
    }

    @media (max-width: 900px) {
      .wb-body { grid-template-columns: 1fr; }
      .wb-detail { display: none; }
      .wb-detail-open .wb-board { display: none; }
      .wb-detail-open .wb-detail { display: flex; }
      .wb-detail-open .wb-back { display: inline-flex; }
    }
  `],
})
export class WorkboardPageComponent {
  protected readonly store = inject(WorkboardStore);
  private readonly router = inject(Router);

  protected readonly laneMeta = WORKBOARD_LANE_META;

  /** True while the detail pane should take over on a narrow layout. */
  protected readonly showDetail = computed(() => this.store.selectedWorkboardItem() !== null);
  /** The selected item resolves to an embedded instance transcript when linked. */
  protected readonly detailInstanceId = computed(
    () => this.store.selectedWorkboardItem()?.instanceId ?? null,
  );

  /** Announcement text for the polite live region (refresh failures only). */
  protected readonly liveAnnouncement = computed(() => {
    const errors = [this.store.loopError(), this.store.repoJobError(), this.store.automationError()]
      .filter((e): e is string => !!e);
    return errors.length ? `Some sources failed to refresh: ${errors.join('; ')}` : '';
  });

  constructor() {
    // One initial refresh, then a bounded tick only while mounted. The store
    // keeps existing cards during refresh, so this never blanks the board.
    void this.store.refresh();
    const timer = window.setInterval(() => {
      this.store.advanceClock();
      void this.store.refresh();
    }, REFRESH_INTERVAL_MS);
    inject(DestroyRef).onDestroy(() => window.clearInterval(timer));
  }

  protected onSelectWorkspace(event: Event): void {
    this.store.selectWorkspace((event.target as HTMLSelectElement).value);
  }

  protected onActivate(itemId: string): void {
    this.store.selectItem(itemId);
  }

  protected onBack(): void {
    this.store.clearSelection();
  }

  protected onRefresh(): void {
    void this.store.refresh();
  }

  protected onOpenSpecialist(route: string): void {
    void this.router.navigateByUrl(route);
  }
}
