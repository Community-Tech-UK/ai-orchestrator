import { getInterruptedContextQueue } from './instance-interrupted-context';

/**
 * Owns one-shot continuity and context-warning preambles for instance input.
 *
 * Continuity text (condensed history and similar context) is not forgotten the
 * moment it is sent: it is held until the model replies. A turn stopped before
 * the reply may never have been stored by the provider, so the held text rides
 * with the next input instead of being lost.
 */
import { getLogger } from '../logging/logger';
import type { FileAttachment, Instance } from '../../shared/types/instance.types';

const logger = getLogger('InstanceContinuityInputQueue');

export interface ContinuityPreambleOptions { userOnly?: boolean; retrievedContextTokens?: number | null }
export type InputMessageOrigin = 'user' | 'internal' | 'automated';

export class InstanceContinuityInputQueue {
  private readonly continuityPreambles = new Map<string, PendingPreamble>();
  private readonly retrievedContexts = new Map<string, PendingPreamble>();
  private readonly contextWarnings = new Map<string, PendingPreamble>();
  private readonly unanswered = new Map<string, HeldContinuity>();
  private nextGeneration = 0;

  queueContinuity(instanceId: string, preamble: string, options?: ContinuityPreambleOptions): boolean {
    if (!preamble.trim()) return false;
    this.continuityPreambles.set(instanceId, { ...this.createPendingPreamble(preamble, options?.userOnly ?? true), retrievedContextTokens: options?.retrievedContextTokens });
    logger.info('Queued continuity preamble for next user input', { instanceId });
    return true;
  }

  /**
   * Code and memory search results that missed their own turn. One-shot and
   * kept apart from continuity, so they never displace or replace history.
   */
  queueRetrievedContext(instanceId: string, context: string, retrievedContextTokens: number | null = null): boolean {
    if (!context.trim()) return false;
    this.retrievedContexts.set(instanceId, { ...this.createPendingPreamble(context, true), retrievedContextTokens });
    logger.info('Queued retrieved context for next user input', { instanceId });
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
   * sent again, with any images it carried, if that turn ends before the model
   * replies.
   */
  holdUntilAnswered(instanceId: string, text: string, attachments?: FileAttachment[]): void {
    if (!text.trim()) return;
    const heldAttachments = attachments ?? this.unanswered.get(instanceId)?.attachments;
    this.unanswered.set(instanceId, heldAttachments?.length ? { text, attachments: heldAttachments } : { text });
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
    origin?: InputMessageOrigin,
  ): string | null | undefined {
    const prepared = this.prepare(instanceId, contextBlock, undefined, origin);
    prepared.commit();
    return prepared.contextBlock;
  }

  prepare(
    instanceId: string,
    contextBlock: string | null | undefined,
    attachments?: FileAttachment[],
    origin?: InputMessageOrigin,
  ): PreparedContinuityInput {
    const unanswered = this.unanswered.get(instanceId);
    // A retried turn already carries what it was first sent with.
    const resend = unanswered && !contextBlock?.includes(unanswered.text) ? unanswered : undefined;
    const pendingContinuity = this.continuityPreambles.get(instanceId);
    const continuity = pendingContinuity && (!pendingContinuity.userOnly || origin === 'user') ? pendingContinuity : undefined;
    const retrieved = origin === 'user' ? this.retrievedContexts.get(instanceId) : undefined;
    const interrupted = getInterruptedContextQueue().prepare(instanceId);
    const warning = this.contextWarnings.get(instanceId);
    const preambles = [resend?.text, continuity?.value, interrupted.value, retrieved?.value, warning?.value]
      .filter((part): part is string => Boolean(part));
    if (preambles.length === 0) {
      return { contextBlock, attachments, commit: () => undefined };
    }

    const preparedContextBlock = contextBlock
      ? `${preambles.join('\n\n')}\n\n${contextBlock}`
      : preambles.join('\n\n');
    const tokenCounts = [continuity?.retrievedContextTokens, retrieved?.retrievedContextTokens];
    const retrievedContextTokens = tokenCounts.includes(null) ? null
      : tokenCounts.some(tokens => tokens !== undefined)
        ? tokenCounts.reduce<number>((sum, tokens) => sum + (tokens ?? 0), 0) : undefined;
    let committed = false;
    return {
      contextBlock: preparedContextBlock,
      retrievedContextTokens,
      attachments: resend?.attachments ? [...resend.attachments, ...(attachments ?? [])] : attachments,
      commit: () => {
        if (committed) return;
        committed = true;
        interrupted.commit();
        if (resend) {
          logger.info('Sending continuity text again because the model never replied to it', { instanceId });
        }
        if (this.deleteIfCurrent(this.continuityPreambles, instanceId, continuity)) {
          logger.info('Prepended pending continuity preamble to user input', { instanceId });
        }
        // Newer continuity is newer history: it replaces the held text rather
        // than joining it, so repeated stopped turns cannot pile up copies (a
        // condensed history alone may fill 30% of the context window). This
        // text-only queue has no replacement image list: keep unanswered images
        // until a reply or an explicit image list from a complete runtime replay.
        if (continuity && !continuity.userOnly) this.holdUntilAnswered(instanceId, continuity.value);
        this.deleteIfCurrent(this.retrievedContexts, instanceId, retrieved);
        if (this.deleteIfCurrent(this.contextWarnings, instanceId, warning)) {
          logger.info('Prepended pending context warning to user input', { instanceId });
        }
      },
    };
  }

  cleanup(instanceId: string): void {
    getInterruptedContextQueue().cleanup(instanceId);
    this.continuityPreambles.delete(instanceId);
    this.retrievedContexts.delete(instanceId);
    this.contextWarnings.delete(instanceId);
    this.unanswered.delete(instanceId);
  }

  private createPendingPreamble(value: string, userOnly = false): PendingPreamble {
    this.nextGeneration += 1;
    return { value, generation: this.nextGeneration, userOnly };
  }

  /** Remove `sent` unless something newer was queued while it was being sent. */
  private deleteIfCurrent(
    pending: Map<string, PendingPreamble>,
    instanceId: string,
    sent: PendingPreamble | undefined,
  ): boolean {
    if (!sent || pending.get(instanceId)?.generation !== sent.generation) return false;
    pending.delete(instanceId);
    return true;
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
  userOnly: boolean;
  retrievedContextTokens?: number | null;
  value: string;
  generation: number;
}

interface HeldContinuity {
  text: string;
  attachments?: FileAttachment[];
}

interface PreparedContinuityInput {
  retrievedContextTokens?: number | null;
  contextBlock: string | null | undefined;
  /** The caller's attachments, preceded by images carried with resent history. */
  attachments: FileAttachment[] | undefined;
  commit: () => void;
}
