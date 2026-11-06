/**
 * "Recover context" buttons on compaction markers in the output stream.
 *
 * Extracted from `output-stream.component.ts` so the component stays inside its
 * LOC ceiling. Behaviour matches the methods it replaced: the button queues the
 * context the compaction preserved for the next turn, and shows Recovering,
 * Queued or Retry recover as the request goes.
 */

import { inject, signal } from '@angular/core';
import { InstanceIpcService } from '../../core/services/ipc';
import {
  compactionRecoveryLabel,
  isCompactionRecoveryDisabled,
  type CompactionRecoveryState,
} from './compaction-recovery-copy';

export class CompactionRecoveryController {
  private readonly instanceIpc = inject(InstanceIpcService);

  /** Where each marker's recovery has got to, by marker id. */
  readonly states = signal<Record<string, CompactionRecoveryState>>({});

  constructor(private readonly instanceId: () => string) {}

  label(markerId: string): string {
    return compactionRecoveryLabel(this.states()[markerId]);
  }

  isDisabled(markerId: string): boolean {
    return isCompactionRecoveryDisabled(this.states()[markerId]);
  }

  async recover(event: MouseEvent, markerId: string): Promise<void> {
    event.preventDefault();
    event.stopPropagation();
    if (!markerId || this.isDisabled(markerId)) {
      return;
    }
    this.setState(markerId, 'recovering');
    try {
      const result = await this.instanceIpc.recoverCompactionContext(this.instanceId(), markerId);
      if (result.success) {
        this.setState(markerId, 'queued');
      } else {
        this.setState(markerId, 'failed');
        console.error('Failed to recover compaction context:', result.error?.message ?? 'Unknown error');
      }
    } catch (error) {
      this.setState(markerId, 'failed');
      console.error('Failed to recover compaction context:', error instanceof Error ? error.message : String(error));
    }
  }

  private setState(markerId: string, state: CompactionRecoveryState): void {
    this.states.update((current) => ({ ...current, [markerId]: state }));
  }
}
