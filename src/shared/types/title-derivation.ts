/**
 * Title Derivation - Pure, framework-free helpers for turning raw prompt text
 * (and any attached file names) into a short, rail-friendly session title.
 *
 * These were originally private to `AutoTitleService`, but the chat auto-name
 * path (`frontLoadTitle` in `history.types.ts`) needs the same logic so that a
 * loop started with attachments is titled by its files rather than by the
 * injected "Attached files …" boilerplate. Living in `shared` keeps the two
 * surfaces (chat + instance) producing identical titles and removes the
 * duplicate filename-cleaning logic.
 *
 * Everything here is deterministic and dependency-free — no Electron, no Node,
 * no logging — so it is safe to import from both the main process and the
 * renderer.
 */

/** Maximum length of a rail-visible title before truncation. */
export const MAX_FALLBACK_TITLE_LENGTH = 60;

/**
 * Marker {@link truncateForRail} appends when it shortens a title.
 *
 * `sanitizeGeneratedTitle` strips trailing `.!?`, which would otherwise eat this
 * — and whether it did depended purely on which ran last. The live resolver
 * sanitizes then truncates (marker survives); the history resolver derived a
 * title that was already truncated and then sanitized it (marker stripped), so
 * the same session read `"…servers and..."` live and `"…servers and"` once it
 * left the live rail. Preserving the marker through sanitization makes the two
 * orders equivalent. See LT-534.
 */
export const RAIL_TRUNCATION_SUFFIX = '...';

const GENERATED_TITLE_THINKING_BLOCK_PATTERN =
  /<\s*(think|thinking|thought|antthinking|reasoning)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const GENERATED_TITLE_THINKING_TAG_PATTERN =
  /<\s*\/?\s*(?:think|thinking|thought|antthinking|reasoning)\b[^>]*>/i;
const GENERATED_TITLE_BRACKET_THINKING_BLOCK_PATTERN =
  /\[\s*THINKING\s*\][\s\S]*?\[\s*\/\s*THINKING\s*\]/gi;
const GENERATED_TITLE_BRACKET_THINKING_TAG_PATTERN =
  /\[\s*\/?\s*THINKING\s*\]/i;

/**
 * Canonical header that {@link renderAttachmentBlock} (loop-attachments) emits
 * at the top of an attachment preamble. Shared so the producer and the title
 * parser stay in lockstep — if the wording changes in one place, the other must
 * change with it, and importing the constant makes that coupling explicit.
 */
export const ATTACHMENT_PREAMBLE_HEADER =
  'Attached files (relative to workspace; use your file-read tools):';

/**
 * Words that, on their own, identify nothing — generic openers, instruction
 * verbs, and pointers. A title built entirely from these is "low signal": it
 * needs the attachment filename to become recognizable.
 */
export const LOW_SIGNAL_TITLE_WORDS = new Set<string>([
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
export function attachmentLabel(name: string): string {
  return (name.split(/[/\\]/).pop() ?? name).trim();
}

/** Map raw attachment names to clean, non-empty labels. */
export function attachmentLabels(names: readonly string[]): string[] {
  return names.map(attachmentLabel).filter((label) => label.length > 0);
}

/** Build a title from attachment labels alone (used when there's no real text). */
export function titleFromAttachments(labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  if (labels.length === 1) return labels[0];
  return `${labels[0]} +${labels.length - 1} more`;
}

/**
 * Convert model-generated title output into a display-safe title.
 *
 * Reasoning models can leak raw chain-of-thought into low-token helper calls,
 * often as `<think>...</think>` or `[THINKING]...[/THINKING]`. Closed thinking
 * blocks are removed; unfinished thinking tags cause the generated title to be
 * rejected so callers can fall back to a deterministic first-message title.
 */
export function sanitizeGeneratedTitle(
  rawTitle: string | null | undefined,
  options: { preserveTruncationMarker?: boolean } = {},
): string | null {
  if (!rawTitle) return null;

  const withoutClosedThinking = rawTitle
    .replace(GENERATED_TITLE_THINKING_BLOCK_PATTERN, ' ')
    .replace(GENERATED_TITLE_BRACKET_THINKING_BLOCK_PATTERN, ' ');

  if (
    GENERATED_TITLE_THINKING_TAG_PATTERN.test(withoutClosedThinking) ||
    GENERATED_TITLE_BRACKET_THINKING_TAG_PATTERN.test(withoutClosedThinking)
  ) {
    return null;
  }

  const collapsed = withoutClosedThinking
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();

  const stripped = collapsed.replace(/[.!?]+$/, '').trim();

  // `preserveTruncationMarker` is opt-in, and only the resolvers set it.
  //
  // For an already-rail-truncated title the trailing `...` is structural — it
  // says the title was cut short — and stripping it made the live and history
  // resolvers disagree by one character depending on which of sanitize/truncate
  // ran last (LT-534). For RAW model output the same characters are just
  // punctuation the model was told not to emit, so the default still strips
  // them: a model answering "Continuing the analysis..." must not be dressed up
  // as a truncated title.
  const preserve =
    options.preserveTruncationMarker === true && collapsed.endsWith(RAIL_TRUNCATION_SUFFIX);
  const cleaned = preserve && stripped ? `${stripped}${RAIL_TRUNCATION_SUFFIX}` : stripped;

  return cleaned || null;
}

export function stripGenericQualityTail(value: string): string {
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

export function titleFromGenericAttachmentTask(message: string, labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  const action = inferGenericAttachmentAction(message);
  if (!action) return titleFromAttachments(labels);
  return truncateForRail(`${attachmentSubjectForAction(labels[0], action)} ${action}`);
}

/** True when a title is built entirely from generic filler words. */
export function isLowSignalTitle(title: string): boolean {
  const words = title.toLowerCase().match(/[\p{L}\p{N}.+#-]+/gu) ?? [];
  if (words.length === 0) return true;
  return words.every((word) => LOW_SIGNAL_TITLE_WORDS.has(word));
}

/** Trim a long title down to the rail-visible length at a sentence/word boundary. */
export function truncateForRail(title: string): string {
  if (title.length <= MAX_FALLBACK_TITLE_LENGTH) return title;
  const sentenceEnd = title.search(/[.!?]\s/);
  if (sentenceEnd > 0 && sentenceEnd <= MAX_FALLBACK_TITLE_LENGTH) {
    return title.slice(0, sentenceEnd + 1);
  }
  // Truncate at word boundary
  return title.slice(0, MAX_FALLBACK_TITLE_LENGTH).replace(/\s+\S*$/, '') + RAIL_TRUNCATION_SUFFIX;
}

/** Parsed form of an injected attachment preamble. */
export interface AttachmentPreamble {
  /** Workspace-relative paths pulled from the bullet list (always ≥ 1). */
  paths: string[];
  /** Prompt text that follows the block, trimmed (may be empty). */
  remainder: string;
}

/**
 * Detect and parse the attachment preamble that loop runs prepend to a prompt
 * (see {@link renderAttachmentBlock}). Returns `null` for any text that does not
 * begin with the canonical header followed by at least one `- <path>` bullet —
 * so ordinary prompts pass straight through unchanged.
 *
 * The header + bullet list are Harness-generated boilerplate that carries no
 * per-task signal; the file names do. Callers use the parsed `paths` to title
 * the session from its attachments instead of from the boilerplate.
 */
export function extractAttachmentPreamble(text: string | null | undefined): AttachmentPreamble | null {
  if (!text) return null;
  const lines = String(text).split(/\r?\n/);

  // Skip leading blank lines, then require the canonical header.
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length || lines[i].trim() !== ATTACHMENT_PREAMBLE_HEADER) {
    return null;
  }
  i++;

  const paths: string[] = [];
  while (i < lines.length) {
    const match = /^\s*-\s+(.+?)\s*$/.exec(lines[i]);
    if (!match) break;
    // Drop the trailing "(skipped: too large or unwritable)" annotation we add
    // for oversized/unwritable attachments so the bare path remains.
    const path = match[1].replace(/\s*\(skipped:[^)]*\)\s*$/i, '').trim();
    if (path) paths.push(path);
    i++;
  }
  if (paths.length === 0) return null;

  const remainder = lines.slice(i).join('\n').trim();
  return { paths, remainder };
}

/**
 * Build a session title from an attachment-driven task: the (cleaned) file name
 * is the subject, optionally suffixed with the action verb inferred from the
 * accompanying prose ("implementation", "review", "fix", "update"). Returns
 * `null` only when there are no usable attachment names.
 *
 * This is the shared decision used by both the chat auto-name path
 * (`frontLoadTitle`) and the instance `AutoTitleService` so the two surfaces
 * agree. When an attachment preamble is present the files ARE the subject and
 * the prose is, in practice, a generic instruction ("work these files and
 * implement them"), so we deliberately lead with the file name.
 */
export function deriveAttachmentTaskTitle(
  message: string,
  attachmentNames: readonly string[],
): string | null {
  const labels = attachmentLabels(attachmentNames);
  if (labels.length === 0) return null;
  return titleFromGenericAttachmentTask(stripGenericQualityTail(message), labels)
    ?? titleFromAttachments(labels);
}

export function normalizeHistoryTitlePart(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}


/**
 * Generic conversational lead-ins that carry no identifying information. They
 * are stripped from the front of a title so the distinctive part of a task
 * (project, feature, file, PR) lands within the first ~30 characters — the
 * slice that survives truncation in the narrow workspace rail. Applied
 * iteratively so stacked openers ("Please go ahead and implement this PR …")
 * peel off one layer at a time.
 */
const TITLE_LEAD_IN_PATTERNS: readonly RegExp[] = [
  /^[[(<"'\s]+/, // leading brackets / quotes / whitespace
  /^(?:hey|hi|hello|yo)\b[\s,!:.-]*/i,
  /^(?:please|pls|plz|kindly)\b[\s,]*/i,
  /^(?:thanks?|thank you|cheers)\b[\s,!:.-]*/i,
  /^(?:can|could|would|will)\s+you\s+(?:please\s+|kindly\s+)?/i,
  /^(?:i'?d|we'?d|i would|we would)\s+like\s+(?:you\s+)?(?:to\s+)?/i,
  /^(?:i|we)\s+(?:need|want|wanna)\s+(?:you\s+)?(?:to\s+)?/i,
  /^(?:we|you)\s+(?:should|must|have to|need to|gotta|ought to)\s+/i,
  /^let'?s\s+/i,
  /^help\s+me\s+(?:to\s+|with\s+)?/i,
  /^go\s+ahead\s+and\s+/i,
  // "<verb> this/that/the PR/the following:" — the verb+pointer adds no signal,
  // the words after it are what identify the thread.
  /^(?:implement|review|fix|address|investigate|debug|handle|resolve|complete|finish|do|check|update|look\s+at|take\s+a\s+look\s+at|work\s+on)\s+(?:this|that|these|those|the\s+following|it)\b[\s:,.-]*(?:pr|mr|pull\s+request|merge\s+request|issue|ticket|task)?\b[\s:,.-]*/i,
];

/** Shorten a leading absolute/home path to its last two segments. */
function shortenLeadingPath(text: string): string {
  const match = /^(~?\/[^\s]+|[A-Za-z]:\\[^\s]+)/.exec(text);
  if (!match) return text;
  const token = match[1];
  const segments = token.split(/[/\\]/).filter(Boolean);
  if (segments.length <= 2) return text;
  return (`…/${segments.slice(-2).join('/')}` + text.slice(token.length)).trim();
}

/** Replace a leading bare URL with a readable host + first path segment. */
function shortenLeadingUrl(text: string): string {
  const match = /^https?:\/\/(?:www\.)?([^/\s]+)(\/[^\s?#]*)?/i.exec(text);
  if (!match) return text;
  const host = match[1];
  const firstSegment = (match[2] ?? '').split('/').filter(Boolean)[0];
  const label = firstSegment ? `${host}/${firstSegment}` : host;
  return (label + text.slice(match[0].length)).trim();
}

/**
 * Produce a rail-friendly title from raw message text by stripping generic
 * lead-ins and surfacing the distinctive token early. Deterministic and free —
 * used as the fallback whenever no AI-generated title is available, and to tidy
 * the instant (pre-AI) title. Never strips down to (near-)nothing: if cleaning
 * would leave too little, the normalized original is returned unchanged.
 */
export function frontLoadTitle(value: string | null | undefined): string {
  // A loop started with attachments prepends an injected "Attached files …"
  // block whose header carries no per-task signal. When the text leads with it,
  // the attached files are the real subject — title from their names instead of
  // letting the boilerplate header become the title. Run on the raw value so the
  // line-structured block is still intact (normalization collapses newlines).
  const preamble = extractAttachmentPreamble(value);
  if (preamble) {
    const attachmentTitle = deriveAttachmentTaskTitle(preamble.remainder, preamble.paths);
    if (attachmentTitle) return attachmentTitle;
  }

  const normalized = normalizeHistoryTitlePart(value);
  if (!normalized) return '';

  let result = normalized;
  for (let pass = 0; pass < 6; pass++) {
    let changed = false;
    for (const pattern of TITLE_LEAD_IN_PATTERNS) {
      const stripped = result.replace(pattern, '');
      if (stripped !== result) {
        result = stripped.trimStart();
        changed = true;
        break;
      }
    }
    if (!changed) break;
  }

  result = shortenLeadingUrl(result);
  result = shortenLeadingPath(result);
  result = result.replace(/^[[(<"'\s:,.-]+/, '').trim();

  // Guard against over-stripping (e.g. a message that was only filler).
  if (result.length < 3) return normalized;

  // Capitalize the first alphabetic character for a tidy rail title.
  return result.replace(/^(\p{Ll})/u, (char) => char.toUpperCase());
}

/**
 * Reduce a raw prompt to the exact string the rail should show for it:
 * attachment-aware, first line only, front-loaded, and truncated to the rail
 * budget.
 *
 * This is the single derivation shared by the live auto-title path
 * (`AutoTitleService`) and the history resolver below. They used to derive
 * independently — the live path took the first line and truncated, the history
 * path front-loaded the whole message and never truncated — so a session's
 * title visibly changed the moment it stopped being a live rail item. Any
 * change to how a message becomes a title belongs here, in one place, or the
 * two surfaces drift again.
 *
 * Returns `''` when the text carries nothing titleable, so callers can fall
 * through to their next candidate.
 */
export function deriveRailTitle(
  message: string | null | undefined,
  attachmentNames: readonly string[] = [],
): string {
  // A loop started with attachments prepends an injected "Attached files …"
  // block. The attached files are the subject, so title from their names rather
  // than from the boilerplate header. Run before any line slicing — the block
  // is line-structured and would not survive it.
  const preamble = extractAttachmentPreamble(message);
  let body = message ?? '';
  if (preamble) {
    const attachmentTitle = deriveAttachmentTaskTitle(
      preamble.remainder,
      [...attachmentNames, ...preamble.paths],
    );
    if (attachmentTitle) return attachmentTitle;
    // No usable file names — title from the prose that followed the block.
    body = preamble.remainder;
  }

  const labels = attachmentLabels(attachmentNames);
  const trimmed = body.trim();
  if (!trimmed) return titleFromAttachments(labels) ?? '';

  const firstLine = trimmed.split(/\r?\n/)[0];
  const title = truncateForRail(frontLoadTitle(firstLine));

  // The text alone identifies nothing ("Please implement this") but a file is
  // attached: the file is the subject.
  if (labels.length > 0 && isLowSignalTitle(title)) {
    return deriveAttachmentTaskTitle(firstLine, labels) ?? title;
  }

  return title || titleFromAttachments(labels) || '';
}
