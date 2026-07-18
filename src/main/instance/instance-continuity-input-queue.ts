/** Owns one-shot continuity and context-warning preambles for instance input. */
export class InstanceContinuityInputQueue {
  private readonly continuityPreambles = new Map<string, string>();
  private readonly contextWarnings = new Map<string, string>();

  queueContinuity(instanceId: string, preamble: string): boolean {
    if (!preamble.trim()) return false;
    this.continuityPreambles.set(instanceId, preamble);
    logger.info('Queued continuity preamble for next user input', { instanceId });
    return true;
  }

  queueContextWarning(instanceId: string, warning: string): boolean {
    if (!warning.trim()) return false;
    this.contextWarnings.set(instanceId, warning);
    logger.info('Queued context warning for next user input', { instanceId });
    return true;
  }

  consume(
    instanceId: string,
    contextBlock: string | null | undefined,
  ): string | null | undefined {
    const preambles: string[] = [];
    const continuity = this.continuityPreambles.get(instanceId);
    if (continuity) {
      preambles.push(continuity);
      logger.info('Prepended pending continuity preamble to user input', { instanceId });
    }
    const warning = this.contextWarnings.get(instanceId);
    if (warning) {
      preambles.push(warning);
      logger.info('Prepended pending context warning to user input', { instanceId });
    }
    if (preambles.length === 0) return contextBlock;

    this.continuityPreambles.delete(instanceId);
    this.contextWarnings.delete(instanceId);
    return contextBlock
      ? `${preambles.join('\n\n')}\n\n${contextBlock}`
      : preambles.join('\n\n');
  }

  cleanup(instanceId: string): void {
    this.continuityPreambles.delete(instanceId);
    this.contextWarnings.delete(instanceId);
  }
}
import { getLogger } from '../logging/logger';

const logger = getLogger('InstanceContinuityInputQueue');
