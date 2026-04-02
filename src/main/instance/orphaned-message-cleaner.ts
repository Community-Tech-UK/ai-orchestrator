/**
 * Orphaned Message Cleaner
 *
 * Cleans up stale/incomplete messages when switching providers during failover.
 * Prevents the fallback model from being confused by partial responses
 * from the failed model.
 *
 * Inspired by Claude Code's model fallback message cleanup:
 * - Tombstone incomplete assistant messages
 * - Remove orphaned tool_result blocks
 * - Strip signature blocks from cached-thinking models
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('OrphanedMessageCleaner');

export interface CleanableMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  complete: boolean;
  toolUseId?: string;
  tombstoned?: boolean;
  metadata?: Record<string, unknown>;
}

export interface FailoverContext {
  failedProvider: string;
}

export interface CleanResult {
  messages: CleanableMessage[];
  tombstonedCount: number;
}

const SIGNATURE_PATTERN = /<signature>[\s\S]*?<\/signature>/g;

export class OrphanedMessageCleaner {
  /**
   * Clean messages for failover to a different provider.
   * Tombstones incomplete messages and orphaned tool results.
   */
  cleanOnFailover(messages: CleanableMessage[], ctx: FailoverContext): CleanResult {
    const result = messages.map(m => ({ ...m }));
    let tombstonedCount = 0;

    // Pass 1: Tombstone incomplete assistant messages
    const tombstonedToolUseIds = new Set<string>();
    for (const msg of result) {
      if (msg.role === 'assistant' && !msg.complete) {
        msg.tombstoned = true;
        msg.content = `[Response interrupted — provider ${ctx.failedProvider} failed. Switching provider.]`;
        tombstonedCount++;

        if (msg.toolUseId) {
          tombstonedToolUseIds.add(msg.toolUseId);
        }
      }
    }

    // Pass 2: Tombstone orphaned tool results (tool_use was tombstoned)
    for (const msg of result) {
      if (msg.role === 'tool' && msg.toolUseId && tombstonedToolUseIds.has(msg.toolUseId)) {
        msg.tombstoned = true;
        msg.content = '[Tool result orphaned — associated tool_use was interrupted]';
        tombstonedCount++;
      }
    }

    if (tombstonedCount > 0) {
      logger.info('Cleaned orphaned messages on failover', {
        tombstonedCount,
        failedProvider: ctx.failedProvider,
      });
    }

    return { messages: result, tombstonedCount };
  }

  /**
   * Clean messages for a fallback model that doesn't support
   * cached-thinking signature blocks.
   */
  cleanForFallbackModel(messages: CleanableMessage[]): CleanResult {
    let strippedCount = 0;
    const result = messages.map(msg => {
      if (msg.role === 'assistant' && SIGNATURE_PATTERN.test(msg.content)) {
        strippedCount++;
        // Reset lastIndex since we used .test() with a global regex
        SIGNATURE_PATTERN.lastIndex = 0;
        return {
          ...msg,
          content: msg.content.replace(SIGNATURE_PATTERN, '').trim(),
        };
      }
      return { ...msg };
    });

    if (strippedCount > 0) {
      logger.info('Stripped signature blocks for fallback model', { strippedCount });
    }

    return { messages: result, tombstonedCount: strippedCount };
  }
}
