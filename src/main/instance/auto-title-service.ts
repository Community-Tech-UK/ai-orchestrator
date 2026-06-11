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
import { isProviderNotice } from '../cli/provider-notice';
import { resolveModelForTier } from '../../shared/types/provider.types';
import { frontLoadTitle } from '../../shared/types/history.types';
import {
  attachmentLabels,
  deriveAttachmentTaskTitle,
  extractAttachmentPreamble,
  isLowSignalTitle,
  titleFromAttachments,
  truncateForRail,
} from '../../shared/types/title-derivation';
import { getLogger } from '../logging/logger';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import { getAuxiliaryLlmService } from '../rlm/auxiliary-llm-service';

const logger = getLogger('AutoTitle');

/** Minimum message length worth summarizing */
const MIN_MESSAGE_LENGTH = 10;

/** Maximum input length sent to the model (trim very long prompts) */
const MAX_INPUT_LENGTH = 2000;

/** Timeout for the AI title generation (ms) */
const AI_TITLE_TIMEOUT = 15_000;

/** Provider preference order for title generation (fastest first) */
const FAST_PROVIDER_PREFERENCE = ['gemini', 'claude', 'codex'] as const;

/**
 * Derive a short title from the raw first user message.
 * Takes the first line (or first sentence), trims, and truncates. When the
 * message is generic filler ("please implement this") but a file is attached,
 * the attachment filename is folded in so the title still identifies the task.
 *
 * When the message leads with an injected attachment preamble (a loop started
 * with attachments — see `renderAttachmentBlock`), the attached files are the
 * subject, so we title from the file names rather than from the boilerplate
 * header that would otherwise become "Attached files (relative to workspace…".
 */
function deriveInstantTitle(message: string, attachmentNames: readonly string[] = []): string | null {
  const preamble = extractAttachmentPreamble(message);
  if (preamble) {
    const attachmentTitle = deriveAttachmentTaskTitle(
      preamble.remainder,
      [...attachmentNames, ...preamble.paths],
    );
    if (attachmentTitle) return attachmentTitle;
    // No usable file names — fall through and title from the remainder prose.
    message = preamble.remainder;
  }

  const labels = attachmentLabels(attachmentNames);
  const trimmed = message.trim();

  // No meaningful text — fall back to the attachment name(s) if we have them.
  if (trimmed.length < MIN_MESSAGE_LENGTH) {
    return titleFromAttachments(labels);
  }

  // Take the first line, stripping generic lead-ins ("Please …", "review this
  // PR", a bare URL) so the distinctive part shows up front even before the AI
  // upgrade lands.
  const firstLine = trimmed.split(/\r?\n/)[0];
  const title = truncateForRail(frontLoadTitle(firstLine));

  // The text alone identifies nothing ("Please implement this") but a file is
  // attached: the file is the subject. Title from its (cleaned) name, led by
  // the subject rather than the verb — "Please implement this" + a long-named
  // plan becomes "Chrome devtools managed profile implementation", not
  // "Implement 2026-06-02-chrome-devtools-…" (whose distinctive part is invisible
  // once the rail truncates the leading verb away).
  if (labels.length > 0 && isLowSignalTitle(title)) {
    return deriveAttachmentTaskTitle(firstLine, labels) ?? title;
  }

  return title || titleFromAttachments(labels);
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
   * @param applyTitle - Callback to set the title on the instance. `source` is
   *   `'instant'` for the immediate truncated fallback and `'ai'` for the
   *   cheap-model summary — callers persist the `'ai'` title so closed threads
   *   keep an AI-chosen name.
   * @param isRenamed - Whether the user has already explicitly renamed
   * @param attachmentNames - File names attached to the first message. Used to
   *   title the thread when the typed text is generic filler ("implement this")
   *   but the real subject is the attachment ("Implement loopfixex.md").
   */
  async maybeGenerateTitle(
    instanceId: string,
    message: string,
    applyTitle: (instanceId: string, title: string, source: 'instant' | 'ai') => void,
    isRenamed = false,
    attachmentNames: readonly string[] = [],
  ): Promise<void> {
    // Guard: already processed or in-flight
    if (this.processed.has(instanceId)) return;
    this.processed.add(instanceId);

    // Guard: user already renamed
    if (isRenamed) return;

    // Guard: nothing to summarize — short message AND no attachment to fall back on
    const hasAttachment = attachmentLabels(attachmentNames).length > 0;
    if (message.trim().length < MIN_MESSAGE_LENGTH && !hasAttachment) return;

    // Phase 1: Immediate fallback — truncated first message (or attachment) title
    const instantTitle = deriveInstantTitle(message, attachmentNames);
    if (instantTitle) {
      applyTitle(instanceId, instantTitle, 'instant');
      logger.info('Auto-titled instance (instant)', { instanceId, title: instantTitle });
    }

    // Phase 2: Upgrade with an AI-generated title via the fastest available CLI
    // (Haiku tier). Non-critical — on any failure the instant title remains.
    try {
      const title = await this.generateTitle(message, attachmentNames);
      if (title) {
        applyTitle(instanceId, title, 'ai');
        logger.info('Auto-titled instance (AI)', { instanceId, title });
      }
    } catch (error) {
      logger.warn('AI title upgrade failed, keeping instant title', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Generate a short, front-loaded title for arbitrary text using the fastest
   * available CLI (Haiku tier). Shared by live auto-titling and the history
   * backfill. Attachment file names, when supplied, are given to the model so a
   * generic message ("implement this") can still be titled from its attachment.
   * Returns null when no CLI is available, the adapter can't do a one-shot, the
   * text is too short with no attachment, or generation fails/times out.
   */
  async generateTitle(text: string, attachmentNames: readonly string[] = []): Promise<string | null> {
    // A loop started with attachments prepends an injected "Attached files …"
    // block. Strip it so the model summarizes the real prompt, and fold the
    // referenced file paths into the attachment list so they remain the subject.
    const preamble = extractAttachmentPreamble(text);
    const effectiveText = preamble ? preamble.remainder : text;
    const effectiveAttachmentNames = preamble
      ? [...attachmentNames, ...preamble.paths]
      : attachmentNames;

    const trimmed = effectiveText.trim();
    const labels = attachmentLabels(effectiveAttachmentNames);
    if (trimmed.length < MIN_MESSAGE_LENGTH && labels.length === 0) {
      return null;
    }

    const truncatedMessage = trimmed.length > MAX_INPUT_LENGTH
      ? trimmed.slice(0, MAX_INPUT_LENGTH) + '...'
      : trimmed;

    // Try auxiliary LLM (local/cheap model) first — much cheaper than a full CLI spawn
    const auxSystemPrompt =
      'You generate very short tab titles (3-6 words) that summarize a task. ' +
      'Lead with the most distinctive word. Reply with ONLY the title — no quotes, no trailing punctuation.';
    const auxUserPrompt = labels.length > 0
      ? `${truncatedMessage}\n\nAttached: ${labels.join(', ')}`
      : truncatedMessage;
    try {
      const { text: auxTitle, decision: auxDecision } = await getAuxiliaryLlmService().generate(
        'titleGeneration',
        auxSystemPrompt,
        auxUserPrompt
      );
      if (auxDecision.source !== 'fallback' && auxTitle.trim()) {
        const cleaned = auxTitle.trim().replace(/^["']|["']$/g, '').replace(/[.!?]+$/, '').trim();
        if (cleaned.length >= 3) {
          logger.debug('Auto-title via auxiliary model', { source: auxDecision.source, model: auxDecision.model });
          return cleaned;
        }
      }
    } catch {
      // Auxiliary unavailable — fall through to CLI adapter
    }

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
      return null;
    }

    const model = resolveModelForTier('fast', cliType);

    const adapter = getProviderRuntimeService().createAdapter({
      cliType,
      options: {
        workingDirectory: process.cwd(),
        model,
        systemPrompt: 'You generate very short tab titles (3-6 words) that summarize a task. The title is shown in a narrow sidebar and is realistically only legible by its first ~25 characters, so LEAD WITH THE MOST DISTINCTIVE, IDENTIFYING WORD — the project, feature, file, repo, or subject. Never start with generic filler ("Please", "Implement", "Fix", "Review this PR", "Help", "I need", "We need to") or a URL; drop it and open with what makes this task unique. If the message text is generic filler with no specific subject, build the title around the attached file name instead. Reply with ONLY the title — no quotes, no trailing punctuation, no explanation.',
        yoloMode: false,
        timeout: AI_TITLE_TIMEOUT,
      },
    });

    if (!hasSendMessage(adapter)) {
      logger.debug('CLI adapter does not support one-shot sendMessage');
      return null;
    }

    const attachmentLine = labels.length > 0
      ? `\n\nAttached file${labels.length > 1 ? 's' : ''}: ${labels.join(', ')}`
      : '';
    const messageBlock = truncatedMessage.length > 0
      ? truncatedMessage
      : '(no message text — the task is about the attached file)';

    const response = await adapter.sendMessage({
      role: 'user',
      content: `Summarize this task in 3-6 words for a sidebar tab title. Put the most distinctive, identifying word first so it's recognizable from just the first ~25 characters. If the message text is generic filler with no specific subject, use the attached file name as the subject:\n\n${messageBlock}${attachmentLine}`,
    });

    const title = response.content?.trim();
    if (!title || title.length === 0 || title.length > 80) {
      return null;
    }
    // A throttled or errored one-shot can return a provider status notice
    // ("You've hit your session limit · resets 6:30pm") instead of a title.
    // Discard it so the instant first-message title stands rather than stamping
    // the limit message on the session.
    if (isProviderNotice(title)) {
      logger.warn('Discarded AI title that looked like a provider limit/status notice', { title });
      return null;
    }
    const frontLoadedTitle = truncateForRail(frontLoadTitle(title));
    if (labels.length > 0 && isLowSignalTitle(frontLoadedTitle)) {
      return deriveAttachmentTaskTitle(truncatedMessage, labels) ?? frontLoadedTitle;
    }
    return frontLoadedTitle;
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
