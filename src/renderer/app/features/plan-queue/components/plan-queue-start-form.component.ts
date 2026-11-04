import { copyFor } from '../../../shared/tooltip/tooltip-copy';
import { AioTooltipDirective } from '../../../shared/tooltip/aio-tooltip.directive';
import { ChangeDetectionStrategy, Component, computed, inject, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { PlanQueueDiscoveryPreview, PlanQueueKind } from '@contracts/schemas/plan-queue';
import { PlanQueueIpcService } from '../../../core/services/ipc/plan-queue-ipc.service';
import { planQueueKindLabel, pluralise } from '../plan-queue-item-display';

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
  imports: [AioTooltipDirective, FormsModule],
  templateUrl: './plan-queue-start-form.component.html',
  styleUrl: './plan-queue-start-form.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueStartFormComponent {
  private readonly ipc = inject(PlanQueueIpcService);
  private requestVersion = 0;
  private pending: PlanQueueStartRequest | null = null;
  protected readonly copy = copyFor;
  protected readonly kindLabel = planQueueKindLabel;
  protected readonly pluralise = pluralise;
  parentSessions = input<PlanQueueParentSessionOption[]>([]);
  start = output<PlanQueueStartRequest>();

  protected readonly kinds = KINDS;
  protected readonly selectedParentId = signal('');
  protected readonly kind = signal<PlanQueueKind>('plans');
  protected readonly glob = signal('');
  protected readonly checking = signal(false);
  protected readonly preview = signal<PlanQueueDiscoveryPreview | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly confirming = signal(false);

  protected readonly selectedParent = computed(() =>
    this.parentSessions().find((session) => session.id === this.selectedParentId()) ?? null,
  );
  protected readonly canStart = computed(() => this.selectedParent() !== null && !this.checking() && !this.confirming());

  onSelectionChange(): void {
    this.requestVersion++;
    this.pending = null;
    this.confirming.set(false);
    this.checking.set(false);
    this.preview.set(null);
    this.error.set(null);
  }

  confirmStart(): void {
    const request = this.pending;
    const parent = this.selectedParent();
    if (!request || !parent || parent.id !== request.parentInstanceId || parent.workingDirectory !== request.workspaceCwd) return;
    this.pending = null;
    this.confirming.set(false);
    this.start.emit(request);
  }

  async onSubmit(): Promise<void> {
    const parent = this.selectedParent();
    if (!parent || !this.canStart()) return;
    const glob = this.glob().trim();
    const request: PlanQueueStartRequest = {
      parentInstanceId: parent.id,
      kind: this.kind(),
      workspaceCwd: parent.workingDirectory,
      ...(glob ? { glob } : {}),
    };
    const version = ++this.requestVersion;
    this.checking.set(true);
    this.error.set(null);
    try {
      const response = await this.ipc.preview(request);
      if (version !== this.requestVersion) return;
      if (!response.success || !response.data) throw new Error(response.error?.message ?? 'Could not check which documents will start.');
      this.preview.set(response.data);
      if (response.data.found > 25) {
        this.pending = request;
        this.confirming.set(true);
      } else if (response.data.found > 0) this.start.emit(request);
    } catch (error) {
      if (version === this.requestVersion) this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      if (version === this.requestVersion) this.checking.set(false);
    }
  }
}
