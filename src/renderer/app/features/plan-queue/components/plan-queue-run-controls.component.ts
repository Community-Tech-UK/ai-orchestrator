import { ChangeDetectionStrategy, Component, input, output, signal } from '@angular/core';
import type { PlanQueueRunDto } from '@contracts/schemas/plan-queue';

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
