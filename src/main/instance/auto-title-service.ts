/**
 * Auto Title Service - Generates short session titles from the first user message
 *
 * Phase 1 (instant): applies a truncated first-message title immediately.
 * Phase 2 (async): upgrades to an AI-generated summary using the existing
 * CLI adapter infrastructure (no separate API key required).
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
  sanitizeGeneratedTitle,
  titleFromAttachments,
  truncateForRail,
} from '../../shared/types/title-derivation';
import { getLogger } from '../logging/logger';
import { getProviderRuntimeService } from '../providers/provider-runtime-service';
import { attachCopilotRoute } from './lifecycle/copilot-route-preflight';
import { getAuxiliaryLlmService } from '../rlm/auxiliary-llm-service';
import type { AuxiliaryLlmDecision } from '../../shared/types/auxiliary-llm.types';
import {
  runAuthorizedFrontierFallback,
  runCorrelatedPaidFrontierCall,
} from '../local-ai-guard/local-ai-cost-correlation';
import { recordCorrelatedFrontierAttribution } from '../rlm/frontier-cost-attribution';

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
const CLI_TITLE_SYSTEM_PROMPT =
  'You generate very short tab titles (3-6 words) that summarize a task. The title is shown in a narrow sidebar and is realistically only legible by its first ~25 characters, so LEAD WITH THE MOST DISTINCTIVE, IDENTIFYING WORD — the project, feature, file, repo, or subject. Never start with generic filler ("Please", "Implement", "Fix", "Review this PR", "Help", "I need", "We need to") or a URL; drop it and open with what makes this task unique. If the message text is generic filler with no specific subject, build the title around the attached file name instead. Reply with ONLY the title — no quotes, no trailing punctuation, no explanation.';
const CLI_TITLE_USER_INSTRUCTION =
  "Summarize this task in 3-6 words for a sidebar tab title. Put the most distinctive, identifying word first so it's recognizable from just the first ~25 characters. If the message text is generic filler with no specific subject, use the attached file name as the subject:";

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
  const title = sanitizeGeneratedTitle(raw);
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
  if (labels.length > 0 && isLowSignalTitle(frontLoadedTitle)) {
    return deriveAttachmentTaskTitle(sourceMessage, labels) ?? frontLoadedTitle;
  }
  return frontLoadedTitle;
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
    const systemPrompt =
      'You generate very short tab titles (3-6 words) that summarize a task. '
      + 'Lead with the most distinctive word. Reply with ONLY the title — no quotes, no trailing punctuation.';
    const userPrompt = labels.length > 0
      ? `${truncatedMessage}\n\nAttached: ${labels.join(', ')}`
      : truncatedMessage;

    try {
      const { text: generatedTitle, decision } = await getAuxiliaryLlmService().generate(
        'titleGeneration',
        systemPrompt,
        userPrompt,
      );
      if (decision.source === 'fallback') return null;
      const cleaned = finalizeGeneratedTitle(generatedTitle, truncatedMessage, labels);
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
    let fallbackDecision: AuxiliaryLlmDecision;
    try {
      const { text: auxTitle, decision: auxDecision } = await getAuxiliaryLlmService().generate(
        'titleGeneration',
        auxSystemPrompt,
        auxUserPrompt
      );
      if (auxDecision.source !== 'fallback') {
        const cleaned = finalizeGeneratedTitle(auxTitle, truncatedMessage, labels);
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
      // Persisted, not debug: every exit from here down used to be invisible, so
      // an escalation that silently produced nothing was indistinguishable from
      // one that never ran. That is the LT-533 fault.
      logger.warn('AI title escalation abandoned — no fast-tier CLI available', {
        tried: [...FAST_PROVIDER_PREFERENCE],
      });
      return null;
    }

    const model = resolveModelForTier('fast', cliType);

    // Copilot account routing: title generation runs unattended, so it uses
    // the `internal` origin and is blocked for a manual-only profile.
    const titleSpawnOptions = await attachCopilotRoute(
      cliType,
      {
        workingDirectory: process.cwd(),
        model,
        systemPrompt: CLI_TITLE_SYSTEM_PROMPT,
        // One-shot, no tools: replace the CLI's default system prompt instead
        // of appending — inheriting the full default prompt would add cost and
        // latency to every title generation for no benefit.
        systemPromptMode: 'replace' as const,
        yoloMode: false,
        timeout: AI_TITLE_TIMEOUT,
      },
      'internal',
    );
    const adapter = getProviderRuntimeService().createAdapter({
      cliType,
      options: titleSpawnOptions,
    });

    if (!hasSendMessage(adapter)) {
      logger.warn('AI title escalation abandoned — CLI adapter cannot do a one-shot send', {
        cliType,
        model,
      });
      return null;
    }

    const attachmentLine = labels.length > 0
      ? `\n\nAttached file${labels.length > 1 ? 's' : ''}: ${labels.join(', ')}`
      : '';
    const messageBlock = truncatedMessage.length > 0
      ? truncatedMessage
      : '(no message text — the task is about the attached file)';
    const userInstruction = `${CLI_TITLE_USER_INSTRUCTION}\n\n${messageBlock}${attachmentLine}`;

    const send = async () => {
      const result = await runCorrelatedPaidFrontierCall(() => adapter.sendMessage!({
        role: 'user',
        content: userInstruction,
      }));
      const usage = cliType === 'antigravity' && result.usage?.inputTokens === 0
        ? { ...result.usage, inputTokens: undefined }
        : result.usage;
      recordCorrelatedFrontierAttribution({
        taskType: 'aux:titleGeneration',
        provider: cliType,
        model,
        inputTexts: [CLI_TITLE_SYSTEM_PROMPT, userInstruction],
        outputText: result.content,
        usage,
      });
      return result;
    };
    let response: { content: string };
    const startedAt = Date.now();
    try {
      response = await runAuthorizedFrontierFallback(fallbackDecision, send);
    } catch (error) {
      // `workingDirectory` is logged because a packaged app's `process.cwd()` is
      // not a sensible cwd for a spawned CLI and is a live suspect for this
      // failure — recorded rather than changed on a hypothesis (LT-533).
      logger.warn('AI title escalation failed', {
        cliType,
        model,
        elapsedMs: Date.now() - startedAt,
        timeoutMs: AI_TITLE_TIMEOUT,
        workingDirectory: titleSpawnOptions.workingDirectory,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }

    const cliTitle = finalizeGeneratedTitle(response.content, truncatedMessage, labels);
    if (!cliTitle) {
      logger.warn('AI title escalation returned unusable output', {
        cliType,
        model,
        elapsedMs: Date.now() - startedAt,
        outputLength: response.content?.length ?? 0,
      });
      return null;
    }
    logger.info('AI title generated via CLI escalation', {
      cliType,
      model,
      elapsedMs: Date.now() - startedAt,
    });
    return cliTitle;
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
