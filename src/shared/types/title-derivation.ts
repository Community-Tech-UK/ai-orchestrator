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
  return title.slice(0, MAX_FALLBACK_TITLE_LENGTH).replace(/\s+\S*$/, '') + '...';
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
 * The header + bullet list are AIO-generated boilerplate that carries no
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
