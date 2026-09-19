import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { PlanQueueKind } from '@contracts/schemas/plan-queue';

export interface PlanQueueParentSessionOption {
  readonly id: string;
  readonly label: string;
  readonly workingDirectory: string;
}

export interface PlanQueueStartRequest {
  readonly parentInstanceId: string;
  readonly kind: PlanQueueKind;
  readonly workspaceCwd: string;
  readonly glob?: string;
}

const KINDS: PlanQueueKind[] = ['plans', 'livetests'];

/**
 * Starts a new run: pick a root session as the parent (its working directory
 * becomes the run's workspace), the document kind, and an optional glob.
 */
@Component({
  selector: 'app-plan-queue-start-form',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './plan-queue-start-form.component.html',
  styleUrl: './plan-queue-start-form.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueStartFormComponent {
  parentSessions = input<PlanQueueParentSessionOption[]>([]);
  start = output<PlanQueueStartRequest>();

  protected readonly kinds = KINDS;
  protected readonly selectedParentId = signal('');
  protected readonly kind = signal<PlanQueueKind>('plans');
  protected readonly glob = signal('');

  protected readonly selectedParent = computed(() =>
    this.parentSessions().find((session) => session.id === this.selectedParentId()) ?? null,
  );
  protected readonly canStart = computed(() => this.selectedParent() !== null);

  onSubmit(): void {
    const parent = this.selectedParent();
    if (!parent) return;
    const glob = this.glob().trim();
    this.start.emit({
      parentInstanceId: parent.id,
      kind: this.kind(),
      workspaceCwd: parent.workingDirectory,
      ...(glob ? { glob } : {}),
    });
  }
}
