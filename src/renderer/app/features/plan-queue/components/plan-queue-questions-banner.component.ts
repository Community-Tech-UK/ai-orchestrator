import { ChangeDetectionStrategy, Component, OnInit, computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { PlanQueueStore } from '../../../core/state/plan-queue.store';

/** Documents named in the banner before the rest collapse into "and N more". */
const NAMED_DOCUMENTS = 2;

/** `…/desk-shared-crm_plan.md` → `desk-shared-crm`. */
export function planQueueDocumentLabel(documentPath: string): string {
  const name = documentPath.split(/[\\/]/).pop() ?? documentPath;
  return name.replace(/\.md$/i, '').replace(/_(plan|livetest|spec(_planned)?)$/i, '');
}

/**
 * Sessions-page banner shown while any Plan Queue question waits on James, so
 * a run never stalls unnoticed behind the Control Center. The whole banner is
 * one button that opens the Plan Queue page, whose first section holds the
 * question cards.
 */
@Component({
  selector: 'app-plan-queue-questions-banner',
  standalone: true,
  templateUrl: './plan-queue-questions-banner.component.html',
  styleUrl: './plan-queue-questions-banner.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueQuestionsBannerComponent implements OnInit {
  private readonly store = inject(PlanQueueStore);
  private readonly router = inject(Router);

  protected readonly count = computed(() => this.store.needsAnswerItems().length);

  protected readonly title = computed(() => {
    const count = this.count();
    return count === 1
      ? 'Plan Queue: 1 question needs your answer'
      : `Plan Queue: ${count} questions need your answer`;
  });

  protected readonly summary = computed(() => {
    const labels = [...new Set(this.store.needsAnswerItems().map((item) => planQueueDocumentLabel(item.documentPath)))];
    const named = labels.slice(0, NAMED_DOCUMENTS).join(', ');
    const rest = labels.length - NAMED_DOCUMENTS;
    return rest > 0 ? `${named} and ${rest} more` : named;
  });

  ngOnInit(): void {
    this.store.ensureWired();
    void this.store.load();
  }

  protected open(): void {
    void this.router.navigate(['/plan-queue']);
  }
}
