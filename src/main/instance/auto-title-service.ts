/**
 * Auto Title Service - Generates short session titles from the first user message
 *
 * Phase 1 (instant): applies a truncated first-message title immediately.
 * Phase 2 (async): upgrades to an AI-generated summary using the existing
 * CLI adapter infrastructure (no separate API key required).
 */

import { resolveCliType, type CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliMessage } from '../cli/adapters/base-cli-adapter';
import { isCliAvailable } from '../cli/cli-detection';
import { resolveModelForTier } from '../../shared/types/provider.types';
import { getLogger } from '../logging/logger';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';

const logger = getLogger('AutoTitle');

/** Minimum message length worth summarizing */
const MIN_MESSAGE_LENGTH = 10;

/** Maximum input length sent to the model (trim very long prompts) */
const MAX_INPUT_LENGTH = 2000;

/** Maximum length of the instant fallback title */
const MAX_FALLBACK_TITLE_LENGTH = 60;

/** Timeout for the AI title generation (ms) */
const AI_TITLE_TIMEOUT = 15_000;

/** Provider preference order for title generation (fastest first) */
const FAST_PROVIDER_PREFERENCE = ['claude', 'gemini', 'copilot', 'codex'] as const;

/**
 * Derive a short title from the raw first user message.
 * Takes the first line (or first sentence), trims, and truncates.
 */
function deriveInstantTitle(message: string): string | null {
  const trimmed = message.trim();
  if (trimmed.length < MIN_MESSAGE_LENGTH) return null;

  // Take first line
  let title = trimmed.split(/\r?\n/)[0].trim();

  // If the first line is very long, take the first sentence
  if (title.length > MAX_FALLBACK_TITLE_LENGTH) {
    const sentenceEnd = title.search(/[.!?]\s/);
    if (sentenceEnd > 0 && sentenceEnd <= MAX_FALLBACK_TITLE_LENGTH) {
      title = title.slice(0, sentenceEnd + 1);
    } else {
      // Truncate at word boundary
      title = title.slice(0, MAX_FALLBACK_TITLE_LENGTH).replace(/\s+\S*$/, '') + '...';
    }
  }

  return title || null;
}

function hasSendMessage(adapter: CliAdapter): adapter is CliAdapter & { sendMessage: (m: CliMessage) => Promise<{ content: string }> } {
  return typeof (adapter as unknown as { sendMessage?: unknown }).sendMessage === 'function';
}

/**
 * Auto-generates a short session title from the first user message.
 *
 * Phase 1 (instant): applies a truncated first-message title immediately.
 * Phase 2 (async): upgrades to an AI-generated summary via the CLI adapter
 *   (uses whichever CLI provider the user has configured — no separate key needed).
 *
 * Fire-and-forget: callers should not await or depend on the result.
 * On failure, the instant title remains.
 */
export class AutoTitleService {
  private static instance: AutoTitleService;

  /** Instance IDs that have already been auto-titled (or are in-flight) */
  private processed = new Set<string>();

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  private constructor() {}

  static getInstance(): AutoTitleService {
    if (!this.instance) {
      this.instance = new AutoTitleService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.processed.clear();
    }
    (this.instance as AutoTitleService | undefined) = undefined;
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

    // Phase 1: Immediate fallback — truncated first message as title
    const instantTitle = deriveInstantTitle(message);
    if (instantTitle) {
      applyTitle(instanceId, instantTitle);
      logger.info('Auto-titled instance (instant)', { instanceId, title: instantTitle });
    }

    // Phase 2: Upgrade with AI-generated title via CLI adapter.
    // Always use the fastest available CLI — title generation doesn't need
    // provider consistency with the session.
    try {
      const truncatedMessage = message.length > MAX_INPUT_LENGTH
        ? message.slice(0, MAX_INPUT_LENGTH) + '...'
        : message;

      let cliType: Awaited<ReturnType<typeof resolveCliType>> | null = null;
      for (const candidate of FAST_PROVIDER_PREFERENCE) {
        try {
          const info = await isCliAvailable(candidate);
          if (info.installed) {
            cliType = await resolveCliType(candidate);
            break;
          }
        } catch {
          // Skip unavailable providers
        }
      }

      if (!cliType) {
        logger.debug('No CLI available for AI title generation');
        return;
      }

      const model = resolveModelForTier('fast', cliType);

      const adapter = getProviderRuntimeService().createAdapter({
        cliType,
        options: {
          workingDirectory: process.cwd(),
          model,
          systemPrompt: 'You generate very short tab titles (3-6 words) that summarize a task. Reply with ONLY the title, no quotes, no punctuation at the end, no explanation.',
          yoloMode: false,
          timeout: AI_TITLE_TIMEOUT,
        },
      });

      if (!hasSendMessage(adapter)) {
        logger.debug('CLI adapter does not support one-shot sendMessage, keeping instant title');
        return;
      }

      const response = await adapter.sendMessage({
        role: 'user',
        content: `Summarize this task in 3-6 words for a tab title:\n\n${truncatedMessage}`,
      });

      const title = response.content?.trim();

      if (title && title.length > 0 && title.length <= 80) {
        applyTitle(instanceId, title);
        logger.info('Auto-titled instance (AI)', { instanceId, title });
      }
    } catch (error) {
      // Non-critical: the instant title remains. Just log and move on.
      logger.warn('AI title upgrade failed, keeping instant title', {
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
