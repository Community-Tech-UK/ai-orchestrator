/**
 * Auto Title Service - Generates a short session title from the first user
 * message.
 *
 * Phase 1 (instant): applies a truncated first-message title immediately.
 * Phase 2 (async): upgrades to an AI-generated summary using the existing
 * CLI adapter infrastructure (no separate API key required).
 *
 * That is the only automatic naming a session ever gets. Once Phase 2 has
 * landed or given up, the name belongs to the user: nothing later (a settled
 * turn, a follow-up message, hibernate/wake, restore) retitles it. Sessions
 * used to be retitled again when their first turn settled — sometimes hours
 * in — and again on a later message after a failed Phase 2, so a name the
 * user had been looking at all day would change under them.
 */

import { resolveCliType, type CliAdapter } from '../cli/adapters/adapter-factory';
import type { CliMessage, CliUsage } from '../cli/adapters/base-cli-adapter';
import { isCliAvailable } from '../cli/cli-detection';
import { isProviderNotice } from '../cli/provider-notice';
import { resolveModelForTier } from '../../shared/types/provider.types';
import { deriveRailTitle, frontLoadTitle } from '../../shared/types/history.types';
import {
  attachmentLabels,
  deriveAttachmentTaskTitle,
  extractAttachmentPreamble,
  isLowSignalTitle,
  LOW_SIGNAL_TITLE_WORDS,
  sanitizeGeneratedTitle,
  validateGeneratedTitle,
  standaloneDocumentPathTitle,
  titleFromAttachments,
  truncateForRail,
} from '../../shared/types/title-derivation';
import { getLogger } from '../logging/logger';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import { attachProviderRoutes } from './lifecycle/provider-route-preflight';
import { getAuxiliaryLlmService } from '../rlm/auxiliary-llm-service';
import type { AuxiliaryLlmDecision } from '../../shared/types/auxiliary-llm.types';
import { filterProvidersForAutomation } from '../providers/automation-provider-exclusions';
import {
  runAuthorizedFrontierFallback,
  runCorrelatedPaidFrontierCall,
} from '../local-ai-guard/local-ai-cost-correlation';
import { recordCorrelatedFrontierAttribution } from '../rlm/frontier-cost-attribution';
import { buildTitleUserPrompt, TITLE_SYSTEM_PROMPT } from './auto-title-prompt';

const logger = getLogger('AutoTitle');

/** Minimum message length worth summarizing */
const MIN_MESSAGE_LENGTH = 10;

/** Maximum input length sent to the model (trim very long prompts) */
const MAX_INPUT_LENGTH = 2000;

/**
 * Timeout for the CLI one-shot title generation (ms).
 *
 * Was 15s. Measured on an idle machine, the identical call
 * (`claude --print --model haiku "<the real title prompt>"`) takes **6.95s** —
 * under half the old budget, with no headroom for a cold CLI spawn while the app
 * is busy. The `titleGeneration` slot's own `timeoutMs` is already 45000, so the
 * CLI leg was budgeted at a third of the local leg for the slower operation.
 * This is a background, fire-and-forget task with a deterministic fallback, so
 * waiting longer costs nothing. See LT-533.
 */
const AI_TITLE_TIMEOUT = 60_000;

/**
 * Longest model output still treated as a title rather than narration. A model
 * that answers at this length has ignored the instruction, and its output is
 * discarded in favour of the deterministic first-message title.
 */
const MAX_GENERATED_TITLE_LENGTH = 80;

/** Provider preference order for title generation (fastest first) */
const FAST_PROVIDER_PREFERENCE = ['antigravity', 'claude', 'codex'] as const;

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
  // Text too short to say anything — the attachment name is the only subject we
  // have. (`deriveRailTitle` would happily title from two words; here we would
  // rather name the file.)
  const preamble = extractAttachmentPreamble(message);
  const prose = preamble ? preamble.remainder : message;
  if (prose.trim().length < MIN_MESSAGE_LENGTH) {
    const labels = attachmentLabels([...attachmentNames, ...(preamble?.paths ?? [])]);
    const fromAttachments = titleFromAttachments(labels);
    if (fromAttachments) return fromAttachments;
  }

  return deriveRailTitle(message, attachmentNames) || null;
}

/**
 * Turn raw model output into a title that is safe to put in the rail, or `null`
 * when it is not usable.
 *
 * Both generation paths — the local auxiliary model and the CLI one-shot — run
 * through this. They used to diverge: the CLI branch rejected over-long output
 * and provider notices and front-loaded the result, while the auxiliary branch
 * returned whatever the model said. That hole put a 119-character numbered list
 * and a 193-character block of leaked chain-of-thought into real session titles.
 */
function finalizeGeneratedTitle(
  raw: string | null | undefined,
  sourceMessage: string,
  labels: readonly string[],
): string | null {
  const candidate = sanitizeGeneratedTitle(raw);
  if (candidate && labels.length > 0 && isLowSignalTitle(candidate)) {
    // A generic model answer must not replace a known subject with an incidental
    // screenshot filename. Attachment repair is for generic opening text only.
    if (!isLowSignalTitle(deriveRailTitle(sourceMessage))) return null;
    const fallback = deriveAttachmentTaskTitle(sourceMessage, labels);
    const title = fallback ? truncateForRail(fallback) : null;
    return title && title.length >= 3 && !isLowSignalTitle(title) ? title : null;
  }
  const title = validateGeneratedTitle(raw);
  // Too short to mean anything, or long enough to prove the model ignored the
  // "3-6 words" instruction and is narrating instead of answering.
  if (!title || title.length < 3 || title.length > MAX_GENERATED_TITLE_LENGTH) {
    return null;
  }
  // A throttled or errored call can return a provider status notice
  // ("You've hit your session limit · resets 6:30pm") instead of a title.
  if (isProviderNotice(title)) {
    logger.warn('Discarded AI title that looked like a provider limit/status notice', { title });
    return null;
  }

  const frontLoadedTitle = truncateForRail(frontLoadTitle(title));
  // Removing lead-ins can expose numbered answers or narration. Revalidate the
  // entire contract, but return the formatted string to keep its rail ellipsis.
  return validateGeneratedTitle(frontLoadedTitle) ? frontLoadedTitle : null;
}

/** Keep a filename-only task anchored to its document, not a parent directory. */
function titleMatchesDocumentSubject(title: string, subject: string): boolean {
  const meaningfulWords = (value: string): string[] =>
    (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
      .filter((word) => word.length >= 3 && !LOW_SIGNAL_TITLE_WORDS.has(word));
  const subjectWords = new Set<string>(meaningfulWords(subject));
  if (subjectWords.size === 0) return false;
  const titleWords = new Set<string>(meaningfulWords(title));
  const overlap = [...subjectWords].filter((word) => titleWords.has(word)).length;
  return overlap >= Math.min(2, subjectWords.size);
}

function finalizeDocumentTitle(
  raw: string | null | undefined,
  sourceMessage: string,
  labels: readonly string[],
  documentSubject: string | null,
): string | null {
  const title = finalizeGeneratedTitle(raw, sourceMessage, labels);
  if (!title || !documentSubject) return title;
  return titleMatchesDocumentSubject(title, documentSubject) ? title : documentSubject;
}

function hasSendMessage(adapter: CliAdapter): adapter is CliAdapter & {
  sendMessage: (m: CliMessage) => Promise<{ content: string; usage?: CliUsage }>;
} {
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
 * On failure, the instant title remains — permanently; there is no later retry.
 */
export class AutoTitleService {
  private static instance: AutoTitleService | null = null;

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
      if (!this.processed.has(instanceId)) return;
      if (title) {
        applyTitle(instanceId, title, 'ai');
        logger.info('Auto-titled instance (AI)', { instanceId, title });
      }
    } catch (error) {
      if (!this.processed.has(instanceId)) return;
      logger.warn('AI title upgrade failed, keeping instant title', {
        instanceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Generate a title using only the configured auxiliary model. This path is
   * used for background history maintenance, where an explicitly authorized
   * paid frontier fallback must still never launch an external CLI process.
   */
  async generateLocalTitle(
    text: string,
    attachmentNames: readonly string[] = [],
  ): Promise<string | null> {
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
      ? `${trimmed.slice(0, MAX_INPUT_LENGTH)}...`
      : trimmed;
    const documentSubject = standaloneDocumentPathTitle(trimmed);
    const modelMessage = documentSubject
      ? `Document filename subject: ${documentSubject}. Ignore directory names.`
      : truncatedMessage;
    const systemPrompt = TITLE_SYSTEM_PROMPT;
    const userPrompt = buildTitleUserPrompt(modelMessage, labels);

    try {
      const { text: generatedTitle, decision } = await getAuxiliaryLlmService().generate(
        'titleGeneration',
        systemPrompt,
        userPrompt,
      );
      if (decision.source === 'fallback') return null;
      const cleaned = finalizeDocumentTitle(generatedTitle, modelMessage, labels, documentSubject);
      if (!cleaned) {
        logger.debug('Auxiliary model returned unusable title output', {
          model: decision.model,
          outputLength: generatedTitle?.length ?? 0,
        });
        return null;
      }
      logger.debug('Auto-title via local auxiliary model', {
        source: decision.source,
        model: decision.model,
      });
      return cleaned;
    } catch {
      return null;
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
  async generateTitle(
    text: string,
    attachmentNames: readonly string[] = [],
  ): Promise<string | null> {
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
    const documentSubject = standaloneDocumentPathTitle(trimmed);
    const modelMessage = documentSubject
      ? `Document filename subject: ${documentSubject}. Ignore directory names.`
      : truncatedMessage;

    // Try auxiliary LLM (local/cheap model) first — much cheaper than a full CLI spawn
    const auxSystemPrompt = TITLE_SYSTEM_PROMPT;
    const auxUserPrompt = buildTitleUserPrompt(modelMessage, labels);
    let fallbackDecision: AuxiliaryLlmDecision;
    try {
      const { text: auxTitle, decision: auxDecision } = await getAuxiliaryLlmService().generate(
        'titleGeneration',
        auxSystemPrompt,
        auxUserPrompt
      );
      if (auxDecision.source !== 'fallback') {
        const cleaned = finalizeDocumentTitle(auxTitle, modelMessage, labels, documentSubject);
        if (cleaned) {
          logger.debug('Auto-title via auxiliary model', { source: auxDecision.source, model: auxDecision.model });
          return cleaned;
        }
        logger.debug('Auxiliary model returned unusable title output', {
          model: auxDecision.model,
          outputLength: auxTitle?.length ?? 0,
        });
      }
      if (!auxDecision.allowFrontierFallback) {
        // Nothing else may run: the local model failed (or was never reachable)
        // and this slot is not allowed to escalate. The instant first-message
        // title is what the session keeps. Logged because this used to be a
        // silent `return null` that hid 4,500+ abandoned upgrades.
        logger.info('AI title upgrade abandoned — local model unavailable and escalation not permitted', {
          slot: 'titleGeneration',
          auxSource: auxDecision.source,
          fallbackReason: auxDecision.reason,
          disposition: auxDecision.fallbackDisposition,
        });
        return null;
      }
      fallbackDecision = auxDecision;
    } catch {
      return null;
    }

    const userInstruction = buildTitleUserPrompt(modelMessage, labels);
    const candidates = filterProvidersForAutomation(FAST_PROVIDER_PREFERENCE, 'autoTitle');
    let resolvedAnyCli = false;
    for (const candidate of candidates) {
      let cliType: Awaited<ReturnType<typeof resolveCliType>>;
      try {
        const info = await isCliAvailable(candidate);
        if (!info.installed) continue;
        cliType = await resolveCliType(candidate);
      } catch {
        continue;
      }
      resolvedAnyCli = true;
      const model = resolveModelForTier('fast', cliType);
      let titleSpawnOptions;
      let adapter: CliAdapter;
      try {
        titleSpawnOptions = await attachProviderRoutes(cliType, {
          workingDirectory: process.cwd(),
          model,
          systemPrompt: TITLE_SYSTEM_PROMPT,
          systemPromptMode: 'replace' as const,
          yoloMode: false,
          timeout: AI_TITLE_TIMEOUT,
        }, 'internal');
        adapter = getProviderRuntimeService().createAdapter({ cliType, options: titleSpawnOptions });
      } catch (error) {
        logger.warn('AI title escalation provider setup failed', {
          cliType, model, error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      if (!hasSendMessage(adapter)) {
        logger.warn('AI title escalation abandoned — CLI adapter cannot do a one-shot send', {
          cliType, model,
        });
        continue;
      }

      const startedAt = Date.now();
      let response: { content: string };
      try {
        response = await runAuthorizedFrontierFallback(fallbackDecision, async () => {
          const result = await runCorrelatedPaidFrontierCall(() => adapter.sendMessage({
            role: 'user', content: userInstruction,
          }));
          const usage = cliType === 'antigravity' && result.usage?.inputTokens === 0
            ? { ...result.usage, inputTokens: undefined }
            : result.usage;
          recordCorrelatedFrontierAttribution({
            taskType: 'aux:titleGeneration', provider: cliType, model,
            inputTexts: [TITLE_SYSTEM_PROMPT, userInstruction], outputText: result.content, usage,
          });
          return result;
        });
      } catch (error) {
        logger.warn('AI title escalation failed', {
          cliType, model, elapsedMs: Date.now() - startedAt, timeoutMs: AI_TITLE_TIMEOUT,
          workingDirectory: titleSpawnOptions.workingDirectory,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      const cliTitle = finalizeDocumentTitle(response.content, modelMessage, labels, documentSubject);
      if (!cliTitle) {
        logger.warn('AI title escalation returned unusable output', {
          cliType, model, elapsedMs: Date.now() - startedAt,
          outputLength: response.content?.length ?? 0,
        });
        continue;
      }
      logger.info('AI title generated via CLI escalation', {
        cliType, model, elapsedMs: Date.now() - startedAt,
      });
      return cliTitle;
    }

    if (!resolvedAnyCli) {
      logger.warn('AI title escalation abandoned — no fast-tier CLI available', {
        tried: [...FAST_PROVIDER_PREFERENCE],
      });
    }
    return null;
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
