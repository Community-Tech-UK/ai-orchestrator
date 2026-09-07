import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { truncateQueuedMessage } from './input-panel-formatters';

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
  templateUrl: './composer-queue.component.html',
  styleUrl: './composer-queue.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ComposerQueueComponent {
  readonly messages = input<ComposerQueuedMessage[]>([]);
  readonly holdReasonLabel = input<string | null>(null);
  readonly canSteer = input(false);
  /** B7 — the queue is held back after a user-initiated Stop. */
  readonly parked = input(false);

  readonly editMessage = output<number>();
  readonly steerMessage = output<number>();
  readonly cancelMessage = output<number>();
  readonly resumeQueue = output<void>();

  protected truncate(message: string): string {
    return truncateQueuedMessage(message);
  }
}
