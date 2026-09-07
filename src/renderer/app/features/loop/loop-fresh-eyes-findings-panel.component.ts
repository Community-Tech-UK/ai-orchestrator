/**
 * N4 — one row per blocking finding, with the citation that justifies it.
 *
 * The activity feed's plain-text line stays: it is the chronological record.
 * This sits beside it and makes the findings actionable — pick the ones worth
 * fixing and send them back as a steer, using the intervention path the loop
 * store already has (`LoopStore.intervene`). No new IPC.
 *
 * Demoted findings are listed separately with their reason rather than hidden.
 * A finding that ALMOST blocked is exactly the thing an operator wants to see
 * when deciding whether the review is being too strict or not strict enough.
 */
import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

import {
  buildFixSelectedMessage,
  findingLocation,
  type FreshEyesFindingsDetail,
} from './loop-fresh-eyes-findings-panel.util';

@Component({
  selector: 'app-loop-fresh-eyes-findings-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (detail(); as d) {
      <section class="fe-findings" aria-label="Blocking review findings">
        <ul class="fe-findings__list">
          @for (finding of d.blockingFindings; track $index) {
            <li class="fe-findings__item" [attr.data-severity]="finding.severity ?? 'unknown'">
              <label class="fe-findings__select">
                <input
                  type="checkbox"
                  [checked]="isSelected($index)"
                  (change)="toggle($index)"
                />
                <span class="fe-findings__title">{{ finding.title }}</span>
              </label>

              <div class="fe-findings__meta">
                @if (finding.severity) {
                  <span class="fe-findings__severity">{{ finding.severity }}</span>
                }
                @if (location(finding); as where) {
                  <span class="fe-findings__where">{{ where }}</span>
                }
                @if (finding.anchorStatus) {
                  <span class="fe-findings__anchor">{{ finding.anchorStatus }}</span>
                }
              </div>

              @if (finding.body) {
                <p class="fe-findings__body">{{ finding.body }}</p>
              }
              @if (finding.anchor?.quote; as quote) {
                <blockquote class="fe-findings__quote">{{ quote }}</blockquote>
              }
            </li>
          }
        </ul>

        <button
          type="button"
          class="fe-findings__fix"
          [disabled]="selectedCount() === 0"
          (click)="fixSelected()"
        >Fix {{ selectedCount() }} selected</button>

        @if (d.demotedFindings.length > 0) {
          <details class="fe-findings__demoted">
            <summary>{{ d.demotedFindings.length }} demoted to advisory</summary>
            <ul>
              @for (finding of d.demotedFindings; track $index) {
                <li class="fe-findings__demoted-item">
                  <span class="fe-findings__title">{{ finding.title }}</span>
                  @if (finding.demotedReason; as reason) {
                    <span class="fe-findings__demoted-reason">{{ reason }}</span>
                  }
                </li>
              }
            </ul>
          </details>
        }
      </section>
    }
  `,
  styleUrl: './loop-fresh-eyes-findings-panel.component.scss',
})
export class LoopFreshEyesFindingsPanelComponent {
  readonly detail = input<FreshEyesFindingsDetail | null>(null);
  /** The steer text to send. The host owns the actual `intervene` call. */
  readonly fixRequested = output<string>();

  private readonly selected = signal<ReadonlySet<number>>(new Set<number>());

  protected readonly selectedCount = computed(() => this.selected().size);
  protected readonly location = findingLocation;

  protected isSelected(index: number): boolean {
    return this.selected().has(index);
  }

  protected toggle(index: number): void {
    const next = new Set(this.selected());
    if (!next.delete(index)) next.add(index);
    this.selected.set(next);
  }

  protected fixSelected(): void {
    const findings = this.detail()?.blockingFindings ?? [];
    const chosen = findings.filter((_, index) => this.selected().has(index));
    if (chosen.length === 0) return;
    this.fixRequested.emit(buildFixSelectedMessage(chosen));
    // Clear the selection: leaving it checked implies the request is still
    // pending when it has already been sent.
    this.selected.set(new Set<number>());
  }
}
