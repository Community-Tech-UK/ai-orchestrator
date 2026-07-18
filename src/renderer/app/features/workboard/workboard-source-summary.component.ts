import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { basename, relativeTime } from './workboard-projection';
import { sourceLabel } from './workboard-card.component';
import type { WorkboardItem, WorkboardSourceKind } from './workboard.types';

export interface WorkboardSpecialistTarget {
  label: string;
  route: string;
}

/**
 * The specialist surface a Workboard item links to, by primary source kind.
 * Repository jobs open Background Jobs, automation runs open Automations, and
 * loop/instance work opens the main dashboard session view. Controls stay
 * source-specific — the Workboard only navigates, it never mutates status.
 */
export function workboardSpecialistTarget(kind: WorkboardSourceKind): WorkboardSpecialistTarget {
  switch (kind) {
    case 'repo-job':
      return { label: 'Open in Background Jobs', route: '/tasks' };
    case 'automation-run':
      return { label: 'Open in Automations', route: '/automations' };
    case 'loop-run':
    case 'instance':
      return { label: 'Open full session', route: '/' };
  }
}

/**
 * Detail pane for a Workboard item that has no live linked instance. Shows the
 * primary/related statuses, timestamps, workspace, progress, and any error/output
 * summary, plus a single safe navigation button to the owning specialist surface.
 * It deliberately does NOT duplicate repo-job cancel/rerun or loop/automation
 * commands — those stay on their specialist pages.
 */
@Component({
  selector: 'app-workboard-source-summary',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="wb-summary">
      <header class="wb-summary-head">
        <h2 class="wb-summary-title">{{ item().title }}</h2>
        <span class="wb-summary-source">{{ sourceText() }}</span>
      </header>

      <dl class="wb-summary-grid">
        <div class="wb-summary-row">
          <dt>Status</dt>
          <dd>{{ item().statusLabel }} <span class="wb-summary-raw">({{ item().primary.rawStatus }})</span></dd>
        </div>
        <div class="wb-summary-row">
          <dt>Workspace</dt>
          <dd [title]="item().workingDirectory">{{ workspaceLabel() }}</dd>
        </div>
        <div class="wb-summary-row">
          <dt>Updated</dt>
          <dd>{{ relTime() }}</dd>
        </div>
        @if (hasProgress()) {
          <div class="wb-summary-row">
            <dt>Progress</dt>
            <dd>{{ item().progress }}%</dd>
          </div>
        }
      </dl>

      @if (relatedRelations().length > 0) {
        <section class="wb-summary-related">
          <h3>Related</h3>
          <ul>
            @for (relation of relatedRelations(); track relation.kind + relation.id) {
              <li>{{ label(relation.kind) }} · {{ relation.rawStatus }}</li>
            }
          </ul>
        </section>
      }

      @if (item().errorText) {
        <section class="wb-summary-error">
          <h3>Error</h3>
          <p>{{ item().errorText }}</p>
        </section>
      }

      @if (item().outputSummary) {
        <section class="wb-summary-output">
          <h3>Summary</h3>
          <p>{{ item().outputSummary }}</p>
        </section>
      }

      <button type="button" class="wb-summary-open" (click)="openSpecialist.emit(specialist().route)">
        {{ specialist().label }}
      </button>
    </div>
  `,
  styleUrl: './workboard-source-summary.component.scss',
})
export class WorkboardSourceSummaryComponent {
  readonly item = input.required<WorkboardItem>();
  readonly now = input<number>(0);
  /** Emits the specialist route to navigate to (the page owns the Router). */
  readonly openSpecialist = output<string>();

  protected readonly sourceText = computed(() => sourceLabel(this.item().primary.kind));
  protected readonly specialist = computed(() => workboardSpecialistTarget(this.item().primary.kind));
  protected readonly hasProgress = computed(() => typeof this.item().progress === 'number');
  protected readonly workspaceLabel = computed(() => basename(this.item().workingDirectory) || 'No workspace');
  protected readonly relTime = computed(() => relativeTime(this.item().updatedAt, this.now() || Date.now()));
  protected readonly relatedRelations = computed(() =>
    this.item().relations.filter((relation) => relation.kind !== this.item().primary.kind),
  );

  protected label(kind: WorkboardSourceKind): string {
    return sourceLabel(kind);
  }
}
