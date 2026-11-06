import { copyFor } from '../../shared/tooltip/tooltip-copy';
import { ChangeDetectionStrategy, Component, computed, effect, input, output, signal } from '@angular/core';

import { formatWaitReasonLabel, truncateQueuedMessage } from './input-panel-formatters';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import type { InstanceWaitReason } from '../../../../shared/types/instance.types';
import { GlossaryTermComponent } from '../../shared/glossary/glossary-term.component';

export interface ComposerQueuedMessage {
  message: string;
  files?: File[];
  kind?: 'queue' | 'steer';
  hadAttachmentsDropped?: boolean;
  /** True while this entry's durable send-queue row is unconfirmed or failed to persist. */
  notDurable?: boolean;
}

@Component({
  selector: 'app-composer-queue',
  standalone: true,
  imports: [AioTooltipDirective, GlossaryTermComponent],
  templateUrl: './composer-queue.component.html',
  styleUrl: './composer-queue.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposerQueueComponent {
  protected readonly copy = copyFor;
  readonly messages = input<ComposerQueuedMessage[]>([]);
  readonly holdReasonLabel = input<string | null>(null);
  readonly waitReason = input<InstanceWaitReason>();
  readonly canSteer = input(false);
  /** B7 — the queue is held back after a user-initiated Stop. */
  readonly parked = input(false);

  readonly editMessage = output<number>();
  readonly steerMessage = output<number>();
  readonly cancelMessage = output<number>();
  readonly resumeQueue = output<void>();

  protected hasUnsavedMessages(): boolean { return this.messages().some(message => message.notDurable); }

  private readonly clock = signal(Date.now());
  private readonly observedAt = signal(Date.now());
  private readonly acknowledgedAt = signal(0);
  protected readonly liveHoldReason = computed(() =>
    formatWaitReasonLabel(this.waitReason(), this.clock(), this.observedAt()) ?? this.holdReasonLabel(),
  );
  protected readonly longWait = computed(() => {
    const reason = this.waitReason();
    if (!reason) return false;
    const start = 'startedAt' in reason ? reason.startedAt : reason.kind === 'auth-required' ? reason.since : this.observedAt();
    return this.clock() - Math.max(start, this.acknowledgedAt()) >= 120_000;
  });

  constructor() {
    effect((cleanup) => {
      if (!this.waitReason()) return;
      this.observedAt.set(Date.now());
      this.clock.set(Date.now());
      const timer = setInterval(() => this.clock.set(Date.now()), 1000);
      cleanup(() => clearInterval(timer));
    });
  }

  protected keepWaiting(): void {
    this.acknowledgedAt.set(this.clock());
  }

  protected truncate(message: string): string {
    return truncateQueuedMessage(message);
  }
}
