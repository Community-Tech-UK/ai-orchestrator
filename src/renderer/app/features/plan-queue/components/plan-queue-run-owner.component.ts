import { ChangeDetectionStrategy, Component, ElementRef, Injector, afterNextRender, computed, effect, inject, input, signal, untracked, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import type { PlanQueueRunDto } from '@contracts/schemas/plan-queue';
import { PlanQueueIpcService } from '../../../core/services/ipc/plan-queue-ipc.service';
import { GlossaryTermComponent } from '../../../shared/glossary/glossary-term.component';
import { AioTooltipDirective } from '../../../shared/tooltip/aio-tooltip.directive';
import { copyFor } from '../../../shared/tooltip/tooltip-copy';
import { planQueueRunCanMove } from '../../../../../shared/utils/plan-queue-run-movable';

/** A session that may own a run, or already does. */
export interface PlanQueueSessionOption {
  readonly id: string;
  readonly label: string;
  /** False for a session offered only as a name, such as a helper or failed session. */
  readonly canBeParent: boolean;
}

/**
 * Shows which session owns a run and lets James move it to another one. This
 * is the panel's handover: it needs no agreement from the current parent, so it
 * works when that session is asleep or will not answer a handover request.
 */
@Component({
  selector: 'app-plan-queue-run-owner',
  standalone: true,
  imports: [AioTooltipDirective, FormsModule, GlossaryTermComponent],
  templateUrl: './plan-queue-run-owner.component.html',
  styleUrl: './plan-queue-run-owner.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PlanQueueRunOwnerComponent {
  /** The IPC call, not the store: a refusal is shown once, beside Move, not again in the page banner. */
  private readonly ipc = inject(PlanQueueIpcService);
  private readonly injector = inject(Injector);
  protected readonly copy = copyFor;
  run = input.required<PlanQueueRunDto>();
  sessions = input<readonly PlanQueueSessionOption[]>([]);

  private readonly trigger = viewChild<ElementRef<HTMLButtonElement>>('trigger');
  private readonly picker = viewChild<ElementRef<HTMLSelectElement>>('picker');
  private readonly choosingState = signal(false);
  private readonly movingState = signal(false);
  private readonly targetIdState = signal('');
  private readonly errorState = signal<string | null>(null);
  protected readonly choosing = this.choosingState.asReadonly();
  protected readonly moving = this.movingState.asReadonly();
  protected readonly targetId = this.targetIdState.asReadonly();
  protected readonly error = this.errorState.asReadonly();

  protected readonly ownerLabel = computed(() =>
    this.sessions().find(session => session.id === this.run().parentInstanceId)?.label ?? 'a session that is no longer open');
  /** Running, paused, or finished with set-aside jobs only its owner can act on; otherwise nothing is shown. */
  protected readonly canMove = computed(() => planQueueRunCanMove(this.run()));
  protected readonly targets = computed(() =>
    this.sessions().filter(session => session.canBeParent && session.id !== this.run().parentInstanceId));
  /** Empty when the chosen session has since closed or failed, so Move never silently does nothing. */
  protected readonly target = computed(() => this.targets().find(session => session.id === this.targetId()) ?? null);

  constructor() {
    // A run left with nothing to move while the choice is open must not reopen it, with a stale target, if shown again.
    effect(() => {
      if (this.canMove()) return;
      untracked(() => {
        this.choosingState.set(false);
        this.targetIdState.set('');
        this.errorState.set(null);
      });
    });
  }

  onChoose(): void {
    this.targetIdState.set('');
    this.errorState.set(null);
    this.choosingState.set(true);
    afterNextRender(() => this.picker()?.nativeElement.focus(), { injector: this.injector });
  }

  async onConfirm(): Promise<void> {
    const target = this.target();
    if (!target || this.moving()) return;
    this.movingState.set(true);
    this.errorState.set(null);
    try {
      const result = await this.ipc.control({ action: 'handover', runId: this.run().id, targetInstanceId: target.id });
      if (result.success) this.close();
      else this.errorState.set(result.error?.message ?? 'The run could not be moved.');
    } catch (error) {
      this.errorState.set(error instanceof Error ? error.message : 'The run could not be moved.');
    } finally {
      this.movingState.set(false);
    }
  }

  onTargetChange(id: string): void {
    this.targetIdState.set(id);
  }

  onNeverMind(): void {
    this.close();
  }

  private close(): void {
    this.choosingState.set(false);
    afterNextRender(() => this.trigger()?.nativeElement.focus(), { injector: this.injector });
  }
}
