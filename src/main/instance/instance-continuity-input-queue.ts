/**
 * Owns one-shot continuity and context-warning preambles for instance input.
 *
 * Continuity text (condensed history and similar context) is not forgotten the
 * moment it is sent: it is held until the model replies. A turn stopped before
 * the reply may never have been stored by the provider, so the held text rides
 * with the next input instead of being lost.
 */
export class InstanceContinuityInputQueue {
  private readonly continuityPreambles = new Map<string, PendingPreamble>();
  private readonly contextWarnings = new Map<string, PendingPreamble>();
  private readonly unanswered = new Map<string, string>();
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

  /**
   * Record continuity text sent to the model outside this queue (for example
   * the condensed history a runtime change delivers as its own turn), so it is
   * sent again if that turn ends before the model replies.
   */
  holdUntilAnswered(instanceId: string, text: string): void {
    if (!text.trim()) return;
    this.unanswered.set(instanceId, text);
  }

  /** The model replied, so it has the continuity text it was sent. */
  markAnswered(instanceId: string): void {
    if (this.unanswered.delete(instanceId)) {
      logger.info('Model replied after continuity text; no longer holding it', { instanceId });
    }
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
    const unanswered = this.unanswered.get(instanceId);
    // A retried turn already carries what it was first sent with.
    const resend = unanswered && !contextBlock?.includes(unanswered) ? unanswered : undefined;
    const continuity = this.continuityPreambles.get(instanceId);
    const warning = this.contextWarnings.get(instanceId);
    const preambles = [resend, continuity?.value, warning?.value]
      .filter((part): part is string => Boolean(part));
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
        if (resend) {
          logger.info('Sending continuity text again because the model never replied to it', { instanceId });
        }
        if (continuity && this.continuityPreambles.get(instanceId)?.generation === continuity.generation) {
          this.continuityPreambles.delete(instanceId);
          logger.info('Prepended pending continuity preamble to user input', { instanceId });
        }
        const held = [unanswered, continuity?.value]
          .filter((part): part is string => Boolean(part))
          .join('\n\n');
        if (held) this.unanswered.set(instanceId, held);
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
    this.unanswered.delete(instanceId);
  }

  private createPendingPreamble(value: string): PendingPreamble {
    this.nextGeneration += 1;
    return { value, generation: this.nextGeneration };
  }
}

/**
 * A reply proves the model has any continuity text it was sent: stop holding
 * it, and end the replay-recovery state so later updates do not bring back the
 * "condensed context will attach" notice.
 */
export function noteModelReplied(
  queue: InstanceContinuityInputQueue,
  instanceId: string,
  instance: Pick<Instance, 'recoveryMethod'> | undefined,
): void {
  queue.markAnswered(instanceId);
  if (instance?.recoveryMethod === 'replay') instance.recoveryMethod = undefined;
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
import type { Instance } from '../../shared/types/instance.types';

const logger = getLogger('InstanceContinuityInputQueue');
