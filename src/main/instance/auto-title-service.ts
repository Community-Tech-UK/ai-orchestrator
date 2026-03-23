/**
 * Auto Title Service - Generates short session titles from the first user message
 *
 * Uses a lightweight Anthropic Haiku call to summarize the initial prompt
 * into a handful of words suitable for a tab/session title.
 */

import Anthropic from '@anthropic-ai/sdk';
import { CLAUDE_MODELS } from '../../shared/types/provider.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('AutoTitle');

/** Minimum message length worth summarizing */
const MIN_MESSAGE_LENGTH = 10;

/** Maximum input length sent to the model (trim very long prompts) */
const MAX_INPUT_LENGTH = 2000;

/**
 * Auto-generates a short session title from the first user message.
 *
 * Fire-and-forget: callers should not await or depend on the result.
 * On failure (no API key, network error, etc.) it silently logs and
 * returns without changing anything.
 */
export class AutoTitleService {
  private static instance: AutoTitleService;

  /** Instance IDs that have already been auto-titled (or are in-flight) */
  private processed = new Set<string>();

  private client: Anthropic | null = null;

  private constructor() {
    this.initClient();
  }

  static getInstance(): AutoTitleService {
    if (!this.instance) {
      this.instance = new AutoTitleService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.processed.clear();
      this.instance.client = null;
    }
    (this.instance as AutoTitleService | undefined) = undefined;
  }

  private initClient(): void {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }

  /**
   * Try to generate and apply a title for the given instance.
   *
   * @param instanceId - Instance to title
   * @param message - The first user message
   * @param applyTitle - Callback to set the displayName on the instance
   * @param isRenamed - Whether the user has already explicitly renamed
   */
  async maybeGenerateTitle(
    instanceId: string,
    message: string,
    applyTitle: (instanceId: string, title: string) => void,
    isRenamed?: boolean,
  ): Promise<void> {
    // Guard: already processed or in-flight
    if (this.processed.has(instanceId)) return;
    this.processed.add(instanceId);

    // Guard: user already renamed
    if (isRenamed) return;

    // Guard: message too short to meaningfully summarize
    if (message.trim().length < MIN_MESSAGE_LENGTH) return;

    // Guard: no API client available
    if (!this.client) {
      // Re-check in case the env var was set after startup
      this.initClient();
      if (!this.client) {
        logger.debug('Skipping auto-title: no ANTHROPIC_API_KEY');
        return;
      }
    }

    try {
      const truncatedMessage = message.length > MAX_INPUT_LENGTH
        ? message.slice(0, MAX_INPUT_LENGTH) + '...'
        : message;

      const response = await this.client.messages.create({
        model: CLAUDE_MODELS.HAIKU,
        max_tokens: 30,
        system: 'You generate very short tab titles (3-6 words) that summarize a task. Reply with ONLY the title, no quotes, no punctuation at the end, no explanation.',
        messages: [
          { role: 'user', content: `Summarize this task in 3-6 words for a tab title:\n\n${truncatedMessage}` }
        ],
      });

      const title = response.content[0]?.type === 'text'
        ? response.content[0].text.trim()
        : null;

      if (title && title.length > 0 && title.length <= 80) {
        applyTitle(instanceId, title);
        logger.info('Auto-titled instance', { instanceId, title });
      }
    } catch (error) {
      // Non-critical: just log and move on. The instance keeps its default name.
      logger.warn('Auto-title generation failed', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Remove tracking for an instance (e.g. on termination).
   */
  clearInstance(instanceId: string): void {
    this.processed.delete(instanceId);
  }
}

export function getAutoTitleService(): AutoTitleService {
  return AutoTitleService.getInstance();
}
