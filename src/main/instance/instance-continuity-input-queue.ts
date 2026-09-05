/** Owns one-shot continuity and context-warning preambles for instance input. */
export class InstanceContinuityInputQueue {
  private readonly continuityPreambles = new Map<string, PendingPreamble>();
  private readonly contextWarnings = new Map<string, PendingPreamble>();
  private nextGeneration = 0;

  queueContinuity(instanceId: string, preamble: string): boolean {
    if (!preamble.trim()) return false;
    this.continuityPreambles.set(instanceId, this.createPendingPreamble(preamble));
    logger.info('Queued continuity preamble for next user input', { instanceId });
    return true;
  }

  queueContextWarning(instanceId: string, warning: string): boolean {
    if (!warning.trim()) return false;
    this.contextWarnings.set(instanceId, this.createPendingPreamble(warning));
    logger.info('Queued context warning for next user input', { instanceId });
    return true;
  }

  consume(
    instanceId: string,
    contextBlock: string | null | undefined,
  ): string | null | undefined {
    const prepared = this.prepare(instanceId, contextBlock);
    prepared.commit();
    return prepared.contextBlock;
  }

  prepare(
    instanceId: string,
    contextBlock: string | null | undefined,
  ): PreparedContinuityInput {
    const preambles: string[] = [];
    const continuity = this.continuityPreambles.get(instanceId);
    if (continuity) {
      preambles.push(continuity.value);
    }
    const warning = this.contextWarnings.get(instanceId);
    if (warning) {
      preambles.push(warning.value);
    }
    if (preambles.length === 0) {
      return { contextBlock, commit: () => undefined };
    }

    const preparedContextBlock = contextBlock
      ? `${preambles.join('\n\n')}\n\n${contextBlock}`
      : preambles.join('\n\n');
    let committed = false;
    return {
      contextBlock: preparedContextBlock,
      commit: () => {
        if (committed) return;
        committed = true;
        if (continuity && this.continuityPreambles.get(instanceId)?.generation === continuity.generation) {
          this.continuityPreambles.delete(instanceId);
          logger.info('Prepended pending continuity preamble to user input', { instanceId });
        }
        if (warning && this.contextWarnings.get(instanceId)?.generation === warning.generation) {
          this.contextWarnings.delete(instanceId);
          logger.info('Prepended pending context warning to user input', { instanceId });
        }
      },
    };
  }

  cleanup(instanceId: string): void {
    this.continuityPreambles.delete(instanceId);
    this.contextWarnings.delete(instanceId);
  }

  private createPendingPreamble(value: string): PendingPreamble {
    this.nextGeneration += 1;
    return { value, generation: this.nextGeneration };
  }
}

interface PendingPreamble {
  value: string;
  generation: number;
}

interface PreparedContinuityInput {
  contextBlock: string | null | undefined;
  commit: () => void;
}
import { getLogger } from '../logging/logger';

const logger = getLogger('InstanceContinuityInputQueue');
