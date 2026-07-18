import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';

import { truncateQueuedMessage } from './input-panel-formatters';

export interface ComposerQueuedMessage {
  message: string;
  files?: File[];
  kind?: 'queue' | 'steer';
  hadAttachmentsDropped?: boolean;
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

  readonly editMessage = output<number>();
  readonly steerMessage = output<number>();
  readonly cancelMessage = output<number>();

  protected truncate(message: string): string {
    return truncateQueuedMessage(message);
  }
}
