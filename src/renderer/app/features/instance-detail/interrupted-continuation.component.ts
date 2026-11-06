import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { InstanceStore } from '../../core/state/instance';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { SAFE_CONTINUATION } from '../../../../shared/turn-continuation';
import { UserInputRequestRegistry } from './user-input-request.registry';

@Component({
  selector: 'app-interrupted-continuation',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (canContinue()) {
      <button type="button" [disabled]="sending() || sent()" (click)="continueTurn()">
        {{ sending() || sent() ? 'Continuing…' : 'Continue' }}
      </button>
      @if (failed()) { <span role="status">Couldn't continue. Check this session is ready, then try again.</span> }
    }
  `,
})
export class InterruptedContinuationComponent {
  readonly instanceId = input.required<string>();
  private readonly instances = inject(InstanceStore);
  private readonly ipc = inject(InstanceIpcService);
  private readonly questions = inject(UserInputRequestRegistry);
  private key = crypto.randomUUID();
  private previousInstanceId?: string;
  private readonly sentFor = signal<string | null>(null);
  protected readonly sent = computed(() => this.sentFor() === this.instanceId());
  protected readonly sending = signal(false);
  protected readonly failed = signal(false);
  protected readonly canContinue = computed(() => {
    const instance = this.instances.getInstance(this.instanceId());
    return !!instance && !instance.activeTurnId && !instance.waitReason
      && !this.questions.hasWaitingQuestion(this.instanceId()) && ['interrupted', 'cancelled'].includes(instance.lastTurnOutcome ?? '')
      && ['idle', 'ready', 'cancelled', 'waiting_for_input'].includes(instance.status);
  });

  constructor() {
    effect(() => {
      const instanceId = this.instanceId();
      const canContinue = this.canContinue();
      if (this.previousInstanceId !== instanceId || !canContinue) {
        this.previousInstanceId = instanceId;
        this.sentFor.set(null);
        this.key = crypto.randomUUID();
        this.failed.set(false);
      }
    });
  }

  protected async continueTurn(): Promise<void> {
    if (!this.canContinue() || this.sending() || this.sent()) return;
    const instanceId = this.instanceId();
    const requestKey = this.key;
    this.sending.set(true);
    this.failed.set(false);
    try {
      const response = await this.ipc.continueInterrupted(instanceId, SAFE_CONTINUATION, requestKey);
      if (response.success) {
        // Work can resume before its IPC acknowledgement. That old acknowledgement
        // must not disable Continue for the next interrupted turn.
        if (this.instanceId() === instanceId && this.key === requestKey && this.canContinue()) this.sentFor.set(instanceId);
      }
      else if (this.instanceId() === instanceId && this.key === requestKey) {
        this.key = crypto.randomUUID();
        this.failed.set(true);
      }
    } catch {
      // Keep the key on a transport failure: the command may already have arrived.
      if (this.instanceId() === instanceId && this.key === requestKey) this.failed.set(true);
    } finally {
      this.sending.set(false);
    }
  }
}
