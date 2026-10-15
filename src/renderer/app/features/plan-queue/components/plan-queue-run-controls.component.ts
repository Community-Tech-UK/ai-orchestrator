import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import type { PlanQueueRunDto, PlanQueueRunStatus } from '@contracts/schemas/plan-queue';
import { planQueueDocumentBasename } from './plan-queue-item-list.component';

const STATUS_LABELS: Record<PlanQueueRunStatus, string> = {
  running: 'Running', paused: 'Paused', completed: 'Finished', cancelled: 'Cancelled',
};

/**
 * Pause/resume/cancel controls for one run. Cancel is destructive (parks
 * every in-flight item), so it requires an explicit confirm click rather than
 * firing on the first press.
 */
@Component({
  selector: 'app-plan-queue-run-controls',
  standalone: true,
  imports: [],
  templateUrl: './plan-queue-run-controls.component.html',
  styleUrl: './plan-queue-run-controls.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueRunControlsComponent {
  run = input.required<PlanQueueRunDto>();

  pauseRun = output<string>();
  resumeRun = output<string>();
  cancelRun = output<string>();

  protected readonly confirmingCancel = signal(false);
  protected readonly statusLabel = computed(() => {
    const run = this.run();
    if (run.status !== 'running') return STATUS_LABELS[run.status];
    const current = run.items.find(item => ['preparing', 'working', 'fixing', 'verifying', 'landing'].includes(item.state));
    const next = run.items.find(item => item.state === 'queued');
    return 'Running' + (current ? ` · working on ${planQueueDocumentBasename(current.documentPath)}` : '')
      + (next ? `${current ? ';' : ' ·'} next ${planQueueDocumentBasename(next.documentPath)}` : '');
  });

  onPause(): void {
    this.pauseRun.emit(this.run().id);
  }

  onResume(): void {
    this.resumeRun.emit(this.run().id);
  }

  onCancelClick(): void {
    this.confirmingCancel.set(true);
  }

  onConfirmCancel(): void {
    this.confirmingCancel.set(false);
    this.cancelRun.emit(this.run().id);
  }

  onCancelCancel(): void {
    this.confirmingCancel.set(false);
  }
}
