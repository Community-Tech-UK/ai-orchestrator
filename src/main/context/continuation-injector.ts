/**
 * Continuation Injector
 *
 * Creates seamless continuation messages when model output is truncated.
 * The injected message tells the model to resume directly without
 * apology, recap, or context repetition.
 *
 * Inspired by Claude Code's max-output-tokens recovery injection:
 * "Output token limit hit. Resume directly — no apology, no recap..."
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('ContinuationInjector');

/** How many characters of truncated output to include as context hint */
const CONTEXT_TAIL_LENGTH = 200;

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  metadata?: Record<string, unknown>;
}

export interface ContinuationOptions {
  attemptNumber?: number;
}

export class ContinuationInjector {
  /**
   * Create a continuation message to inject after truncated output.
   */
  createContinuation(
    messages: ConversationMessage[],
    options?: ContinuationOptions
  ): ConversationMessage {
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
    const contextTail = lastAssistant
      ? lastAssistant.content.slice(-CONTEXT_TAIL_LENGTH)
      : '';

    const parts: string[] = [
      'Output token limit hit. Resume directly from where you left off — no apology, no recap, no repeating what was already said.',
    ];

    if (contextTail) {
      parts.push(`\nYou stopped at: ...${contextTail}`);
    }

    parts.push('\nContinue immediately.');

    logger.info('Created continuation message', {
      attemptNumber: options?.attemptNumber,
      contextTailLength: contextTail.length,
    });

    return {
      role: 'user',
      content: parts.join(''),
      metadata: {
        isContinuation: true,
        attemptNumber: options?.attemptNumber,
        injectedAt: Date.now(),
      },
    };
  }
}
