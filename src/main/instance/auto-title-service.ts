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
const FAST_PROVIDER_PREFERENCE = ['gemini', 'copilot', 'claude', 'codex'] as const;

/**
 * A bare pointer at the end of a sentence ("…implement this", "…review these")
 * carries no identifying information. When that's all the user typed and a file
 * is attached, the filename is the real subject, so we swap it in.
 */
const TRAILING_POINTER_PATTERN = /\b(?:this|that|these|those|it|the\s+following)[\s:.!?-]*$/i;

/**
 * Words that, on their own, identify nothing — generic openers, instruction
 * verbs, and pointers. A title built entirely from these is "low signal": it
 * needs the attachment filename to become recognizable.
 */
const LOW_SIGNAL_TITLE_WORDS = new Set<string>([
  'please', 'pls', 'plz', 'kindly', 'hey', 'hi', 'hello', 'yo',
  'can', 'could', 'would', 'will', 'you', 'i', 'we', 'need', 'want', 'wanna', 'to',
  'implement', 'fully', 'complete', 'completely', 'finish', 'do', 'make',
  'fix', 'address', 'resolve', 'handle', 'investigate', 'debug', 'review',
  'check', 'update', 'look', 'at', 'take', 'a', 'work', 'on', 'help', 'me', 'with',
  'go', 'ahead', 'and', 'lets', 'let', 'just', 'now', 'all',
  'be', 'stay', 'thorough', 'thoroughly', 'careful', 'carefully',
  'proper', 'properly', 'correct', 'correctly', 'comprehensive',
  'comprehensively', 'detailed', 'meticulous', 'rigorous', 'robust', 'well',
  'this', 'that', 'these', 'those', 'it', 'them', 'the', 'following', 'everything',
  'for', 'of', 'in',
]);

const GENERIC_QUALITY_TAIL_PATTERN =
  /(?:[,;:.!?-]\s*)?(?:and\s+)?(?:please\s+)?(?:(?:be|stay)\s+)?(?:thorough|thoroughly|careful|carefully|proper|properly|correct|correctly|comprehensive|comprehensively|detailed|meticulous|rigorous|robust|well)[\s.!?,-]*$/i;

const GENERIC_ATTACHMENT_ACTIONS: readonly { pattern: RegExp; noun: string }[] = [
  { pattern: /\b(?:implement|implementation|build|create|develop|ship|port)\b/i, noun: 'implementation' },
  { pattern: /\b(?:review|audit)\b/i, noun: 'review' },
  { pattern: /\b(?:fix|repair|debug|investigate|resolve|address)\b/i, noun: 'fix' },
  { pattern: /\b(?:update|revise|change|modify)\b/i, noun: 'update' },
];

const DOCUMENT_TITLE_EXTENSIONS = new Set<string>([
  '.md',
  '.markdown',
  '.txt',
  '.doc',
  '.docx',
  '.pdf',
  '.rtf',
]);

const IMPLEMENTATION_SUBJECT_SUFFIX_PATTERN =
  /\b(?:implementation|implement|plan|spec|design|brief|proposal|notes?)\b$/i;

/** Reduce an attachment name to a clean basename for use in a title. */
function attachmentLabel(name: string): string {
  return (name.split(/[/\\]/).pop() ?? name).trim();
}

/** Map raw attachment names to clean, non-empty labels. */
function attachmentLabels(names: readonly string[]): string[] {
  return names.map(attachmentLabel).filter((label) => label.length > 0);
}

/** Build a title from attachment labels alone (used when there's no real text). */
function titleFromAttachments(labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  if (labels.length === 1) return labels[0];
  return `${labels[0]} +${labels.length - 1} more`;
}

function stripGenericQualityTail(value: string): string {
  let result = value.trim();
  for (let pass = 0; pass < 3; pass++) {
    const stripped = result.replace(GENERIC_QUALITY_TAIL_PATTERN, '').trimEnd();
    if (stripped === result || stripped.length < 3) break;
    result = stripped.replace(/[\s,;:.-]+$/, '').trimEnd();
  }
  return result;
}

function inferGenericAttachmentAction(message: string): string | null {
  for (const action of GENERIC_ATTACHMENT_ACTIONS) {
    if (action.pattern.test(message)) {
      return action.noun;
    }
  }
  return null;
}

function attachmentSubjectForAction(label: string, action: string): string {
  const withoutDatePrefix = label.replace(/^\d{4}-\d{2}-\d{2}[-_\s]+/, '');
  const extension = withoutDatePrefix.match(/\.[A-Za-z0-9]{1,10}$/)?.[0]?.toLowerCase();
  const isDocument = extension ? DOCUMENT_TITLE_EXTENSIONS.has(extension) : false;
  const withoutExtension = isDocument && extension
    ? withoutDatePrefix.slice(0, -extension.length)
    : withoutDatePrefix;

  let subject = (isDocument ? withoutExtension.replace(/[-_]+/g, ' ') : withoutExtension)
    .replace(/\s+/g, ' ')
    .trim();

  if (action === 'implementation') {
    const withoutSuffix = subject.replace(IMPLEMENTATION_SUBJECT_SUFFIX_PATTERN, '').trim();
    if (withoutSuffix.length >= 3) {
      subject = withoutSuffix;
    }
  }

  return (subject || label).replace(/^(\p{Ll})/u, (char) => char.toUpperCase());
}

function titleFromGenericAttachmentTask(message: string, labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  const action = inferGenericAttachmentAction(message);
  if (!action) return titleFromAttachments(labels);
  return truncateForRail(`${attachmentSubjectForAction(labels[0], action)} ${action}`);
}

/** True when a title is built entirely from generic filler words. */
function isLowSignalTitle(title: string): boolean {
  const words = title.toLowerCase().match(/[\p{L}\p{N}.+#-]+/gu) ?? [];
  if (words.length === 0) return true;
  return words.every((word) => LOW_SIGNAL_TITLE_WORDS.has(word));
}

/** Trim a long title down to the rail-visible length at a sentence/word boundary. */
function truncateForRail(title: string): string {
  if (title.length <= MAX_FALLBACK_TITLE_LENGTH) return title;
  const sentenceEnd = title.search(/[.!?]\s/);
  if (sentenceEnd > 0 && sentenceEnd <= MAX_FALLBACK_TITLE_LENGTH) {
    return title.slice(0, sentenceEnd + 1);
  }
  // Truncate at word boundary
  return title.slice(0, MAX_FALLBACK_TITLE_LENGTH).replace(/\s+\S*$/, '') + '...';
}

/**
 * Derive a short title from the raw first user message.
 * Takes the first line (or first sentence), trims, and truncates. When the
 * message is generic filler ("please implement this") but a file is attached,
 * the attachment filename is folded in so the title still identifies the task.
 */
function deriveInstantTitle(message: string, attachmentNames: readonly string[] = []): string | null {
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
  let title = truncateForRail(frontLoadTitle(firstLine));

  // The text alone identifies nothing ("Fully implement this") but a file is
  // attached: rebuild the title around the filename. Swapping it into the raw
  // line before re-stripping keeps lead-in removal clean ("Please implement
  // this" + loopfixex.md → "Implement loopfixex.md").
  if (labels.length > 0 && isLowSignalTitle(title)) {
    const withoutQualityTail = stripGenericQualityTail(firstLine);
    if (withoutQualityTail !== firstLine.trim()) {
      const attachmentTaskTitle = titleFromGenericAttachmentTask(withoutQualityTail, labels);
      if (attachmentTaskTitle) {
        return attachmentTaskTitle;
      }
    }

    const withFile = TRAILING_POINTER_PATTERN.test(withoutQualityTail)
      ? withoutQualityTail.replace(TRAILING_POINTER_PATTERN, labels[0])
      : `${withoutQualityTail} ${labels[0]}`;
    title = truncateForRail(frontLoadTitle(withFile)) || titleFromAttachments(labels) || title;
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
    const trimmed = text.trim();
    const labels = attachmentLabels(attachmentNames);
    if (trimmed.length < MIN_MESSAGE_LENGTH && labels.length === 0) {
      return null;
    }

    const truncatedMessage = trimmed.length > MAX_INPUT_LENGTH
      ? trimmed.slice(0, MAX_INPUT_LENGTH) + '...'
      : trimmed;

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
      return titleFromGenericAttachmentTask(stripGenericQualityTail(truncatedMessage), labels)
        ?? titleFromAttachments(labels);
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
