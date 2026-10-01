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

import { INSTANCE_ID_PREFIXES, ORCHESTRATION_ID_PREFIXES } from '../utils/id-generator';

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

/** Only unwrap matching outer markers; never extract a title from narration. */
function unwrapTitlePresentation(value: string): string {
  const wrappers: readonly [string, string][] = [
    ['**', '**'], ['__', '__'], ['`', '`'], ['*', '*'], ['_', '_'],
    ['"', '"'], ["'", "'"], ['“', '”'], ['‘', '’'],
  ];
  let plain = value.trim();
  if (plain.startsWith('```')) return plain;
  for (let pass = 0; pass < 4; pass++) {
    const wrapper = wrappers.find(([start, end]) => {
      if (!plain.startsWith(start) || !plain.endsWith(end) || plain.length <= start.length + end.length) return false;
      const inner = plain.slice(start.length, -end.length);
      return !inner.includes(start) && !inner.includes(end);
    });
    if (!wrapper) break;
    plain = plain.slice(wrapper[0].length, -wrapper[1].length).trim();
  }
  return plain;
}

/**
 * Canonical header that {@link renderAttachmentBlock} (loop-attachments) emits
 * at the top of an attachment preamble. Shared so the producer and the title
 * parser stay in lockstep — if the wording changes in one place, the other must
 * change with it, and importing the constant makes that coupling explicit.
 */
export const ATTACHMENT_PREAMBLE_HEADER =
  'Attached files (relative to workspace; use your file-read tools):';

const MODEL_TITLE_LABEL_NOUNS = new Set<string>([
  'title', 'name', 'heading', 'label', 'tab', 'task', 'subject', 'session', 'topic', 'summary',
]);

const MODEL_TITLE_LABEL_WORDS = new Set<string>([
  ...MODEL_TITLE_LABEL_NOUNS, 'suggested', 'proposed', 'recommended',
  'candidate', 'possible', 'potential', 'alternative', 'appropriate', 'suitable',
  'short', 'concise', 'brief', 'descriptive', 'final', 'new', 'best', 'better',
  'chosen', 'selected', 'ideal', 'suggestion', 'proposal', 'recommendation',
]);

/**
 * Words that, on their own, identify nothing: generic openers, instruction
 * verbs, pointers and states. A title built entirely from these lacks a subject.
 */
const GENERIC_TITLE_ACTION_ROOTS = new Set<string>([
  'fix', 'review', 'investigate', 'debug', 'check', 'update', 'handle', 'resolve',
  'complete', 'finish', 'implement', 'process', 'report', 'assist', 'confirm',
  'wait', 'continue', 'work', 'test', 'prepare', 'acknowledge', 'need', 'want', 'require', 'request',
  'address', 'look', 'take', 'help', 'go', 'stay', 'make', 'do', 'proceed', 'get',
  'start', 'run', 'resume', 'restart', 'stop', 'pause', 'cancel', 'apply', 'verify',
  'restore', 'accept', 'deliver', 'execute', 'achieve', 'accomplish', 'conclude',
  'satisfy', 'detect', 'find', 'observe', 'identify', 'answer', 'reply', 'wrap',
  'approve', 'reject', 'deny', 'abort', 'initialize', 'interrupt', 'respawn',
  'hibernate', 'wake', 'degrade', 'terminate', 'supersede', 'think', 'escalate',
  'suggest', 'propose', 'recommend', 'summarize', 'describe', 'name',
]);

export const LOW_SIGNAL_TITLE_WORDS = new Set<string>([
  ...GENERIC_TITLE_ACTION_ROOTS,
  ...MODEL_TITLE_LABEL_WORDS,
  'please', 'pls', 'plz', 'kindly', 'hey', 'hi', 'hello', 'yo',
  'can', 'could', 'would', 'will', 'you', 'i', 'we', 'need', 'want', 'wanna', 'to',
  'implement', 'implementation', 'fully', 'complete', 'completely', 'finish', 'do', 'make',
  'fix', 'address', 'resolve', 'handle', 'investigate', 'debug', 'review',
  'check', 'update', 'look', 'at', 'take', 'a', 'work', 'on', 'help', 'me', 'with',
  'go', 'ahead', 'and', 'lets', 'let', 'just', 'now', 'all',
  'be', 'stay', 'thorough', 'thoroughly', 'careful', 'carefully',
  'proper', 'properly', 'correct', 'correctly', 'comprehensive',
  'comprehensively', 'detailed', 'meticulous', 'rigorous', 'robust', 'well',
  'this', 'that', 'these', 'those', 'it', 'them', 'the', 'following', 'everything',
  'for', 'of', 'in',
  'yes', 'yep', 'yeah', 'ok', 'okay', 'done', 'continue', 'continuing',
  'proceed', 'sure', 'thanks', 'thank', 'no',
  // Status alone carries no subject; these remain useful beside identifying nouns.
  'task', 'tasks', 'session', 'instance', 'thread', 'conversation', 'request', 'response',
  'status', 'completed', 'finished', 'success', 'successful', 'successfully',
  'progress', 'pending', 'waiting', 'blocked', 'unblocked', 'started', 'starting',
  'running', 'processing', 'ready', 'failed', 'failure', 'resolved', 'fixed',
  'updated', 'reviewed', 'checked', 'implemented',
  'is', 'are', 'was', 'were', 'has', 'have', 'had', 'been', 'being',
  'not', 'yet', 'currently', 'still', 'working', 'ongoing', 'under', 'hold',
  'set', 'clear', 'awaiting', 'instructions', 'user', 'input', 'action', 'further',
  'required', 'needed', 'necessary', 'nothing', 'changes',
  'cancelled', 'canceled', 'stopped', 'paused', 'abandoned', 'deferred', 'scheduled', 'queued',
  'restarting', 'resuming', 'resumed', 'requested', 'approval',
  'error', 'errors', 'warning', 'warnings', 'pass', 'passed', 'test', 'tests', 'tested', 'testing',
  'verified', 'verification', 'checks', 'restored', 'without', 'by',
  'needs', 'requires', 'specified', 'clarification', 'applied', 'good',
  // Acknowledgements and diagnostic states still need an identifying subject.
  'am', 'my', 'your', 'our', 'get', 'got', 'getting',
  'acknowledged', 'acknowledgement', 'acknowledgment', 'understood', 'noted',
  'received', 'confirmed', 'affirmative', 'roger', 'happy', 'glad', 'welcome',
  'assist', 'assisting', 'assistance', 'report', 'reports', 'reporting',
  'issue', 'issues', 'problem', 'problems', 'concern', 'concerns',
  'found', 'finding', 'findings', 'detected', 'observed', 'identified',
  'looks', 'looked', 'appears', 'appeared', 'seems', 'seemed',
  'fine', 'normal', 'healthy', 'clean', 'process', 'underway',
  // Generic actors, operations, outcomes and their completion states are not
  // subjects by themselves. Identifying nouns still make the whole title useful.
  'job', 'jobs', 'operation', 'operations', 'activity', 'activities',
  'result', 'results', 'outcome', 'outcomes', 'requests', 'responses',
  'analysis', 'investigation', 'investigating', 'execution', 'completion',
  'assistant', 'agent', 'handled', 'processed', 'provided', 'concluded',
  'executed', 'achieved', 'accomplished', 'satisfied', 'delivered',
  'available', 'unavailable', 'standing', 'encountered', 'left', 'outstanding',
  'confirmation', 'answer', 'answered', 'reply', 'replying', 'prepare', 'preparing',
  'proceeding', 'taken', 'accepted', 'wrapped', 'up', 'change', 'fixes',
  'when', 'whenever', 'more', 'only', 'any', 'additional', 'another', 'remaining',
  'next', 'previous', 'again', 'as', 'instruction', 'perfect', 'perfectly',
  // Default naming metadata is no task subject, including our absence sentinel.
  'untitled', 'unnamed', 'new', 'empty', 'default', 'unknown', 'chat',
  'title', 'name', 'heading', 'label', 'subject', 'summary',
  // Bare lifecycle/permission states must not become names. Subject-bearing
  // phrases still survive (e.g. idle timeout diagnostics, permission editor).
  'idle', 'busy', 'initializing', 'thinking', 'deeply', 'permission',
  'interrupting', 'interrupt', 'escalating', 'cancelling', 'superseded',
  'respawning', 'hibernating', 'hibernated', 'waking', 'degraded', 'terminated',
  'approved', 'rejected', 'denied', 'aborted', 'command', 'receipt',
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

/**
 * A bare UUID/GUID (session ID, instance ID, request ID, …) with nothing else
 * on the line. Users routinely paste one ahead of their real message — e.g.
 * copying a session ID from a title bar or bug report — and unlike a URL or
 * path it carries zero identifying signal: every ID looks like every other
 * ID's random hex, so a title built from it cannot be "easily differentiated
 * within the first ~40 characters", it just produces more indistinguishable
 * hex. Matched on a whole trimmed line (optionally trailed by punctuation)
 * so ordinary prose that merely contains a UUID mid-sentence is untouched.
 */
const BARE_UUID_LINE_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[\s:,.-]*$/i;

/** Same UUID, but as a stripped-off lead-in when more text follows on the line. */
const LEADING_BARE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[\s:,.-]+(?=\S)/i;

const BARE_HASH_LINE_PATTERN = /^[0-9a-f]{16,}[\s:,.-]*$/i;
const BARE_SESSION_IDENTIFIER_PATTERN =
  /^(?:(?:session|instance|thread|request)[-_](?:\d+|[0-9a-f]{16,}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})|(?:claude|codex|gemini|copilot)-\d{10,}-[a-z0-9]+)[\s:,.-]*$/i;

const HARNESS_ID_PREFIXES = new Set<string>([
  ...Object.values(INSTANCE_ID_PREFIXES), ...Object.values(ORCHESTRATION_ID_PREFIXES),
]);

/** Recognize random-looking Harness IDs without treating words/version labels as IDs. */
function isBareHarnessId(line: string): boolean {
  const token = line.replace(/[\s:,.-]+$/, '');
  return /^[A-Za-z][a-z0-9]{8}$/.test(token)
    && HARNESS_ID_PREFIXES.has(token.charAt(0).toLowerCase())
    // A digit followed by a lowercase letter distinguishes observed random IDs
    // from words (component) and version labels (Angular22/Copilot22). All-letter
    // IDs are inherently ambiguous; preserve real subjects instead of guessing.
    && /\d[a-z]/.test(token.slice(1));
}

/** True when a line is a bare UUID, hash, or recognizable generated session ID. */
export function isBareIdentifierLine(line: string): boolean {
  const trimmed = line.trim();
  return BARE_UUID_LINE_PATTERN.test(trimmed)
    || BARE_HASH_LINE_PATTERN.test(trimmed)
    || BARE_SESSION_IDENTIFIER_PATTERN.test(trimmed)
    || isBareHarnessId(trimmed);
}

/** Reduce an attachment name to a clean basename for use in a title. */
export function attachmentLabel(name: string): string {
  return (name.split(/[/\\]/).pop() ?? name).trim();
}

/** Map raw attachment names to clean, non-empty labels. */
export function attachmentLabels(names: readonly string[]): string[] {
  return names.map(attachmentLabel).filter((label) => label.length > 0);
}

/** A document path sent as the entire opening message has its subject in the filename. */
export function standaloneDocumentPathTitle(message: string): string | null {
  const path = message.trim();
  if (
    /[\r\n]/.test(path)
    || !/^(?:~?\/|\.{1,2}[/\\]|[A-Za-z]:[\\/]|[^\s/\\]+[/\\])/.test(path)
  ) {
    return null;
  }

  const label = attachmentLabel(path);
  const extension = label.match(/\.[A-Za-z0-9]{1,10}$/)?.[0]?.toLowerCase();
  if (!extension || !DOCUMENT_TITLE_EXTENSIONS.has(extension)) return null;

  const subject = label.slice(0, -extension.length)
    .replace(/^\d{4}-\d{2}-\d{2}[-_\s]+/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b(?:implementation|plan|spec|design|brief|proposal|notes?)$/i, '')
    .trim();
  if (!subject) return null;
  const readableSubject = subject
    .replace(/\b(?:kpi|api|ui|ux|sql|ai)\b/gi, (word) => word.toUpperCase())
    .replace(/^(\p{Ll})/u, (char) => char.toUpperCase());
  return truncateForRail(readableSubject);
}

/** Build a title from attachment labels alone (used when there's no real text). */
export function titleFromAttachments(labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  if (labels.length === 1) return labels[0];
  return `${labels[0]} +${labels.length - 1} more`;
}

/** Recognize answer labels, while preserving subject-bearing labels such as HTTP 500. */
function hasModelAnswerLabel(plain: string): boolean {
  const separator = plain.search(/:|\s+[-–—]\s*|[-–—]\s+/u);
  if (separator < 0 || separator > 80) return false;
  const prefix = plain.slice(0, separator)
    .replace(/^(?:here(?:['’]s| is)|this is)\s+/i, '').toLowerCase();
  const words = prefix.match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.some((word) => MODEL_TITLE_LABEL_NOUNS.has(word))
    && words.every((word) => MODEL_TITLE_LABEL_WORDS.has(word) || LOW_SIGNAL_TITLE_WORDS.has(word));
}

/** Check structure before whitespace collapse or truncation can hide it. */
function hasPlainTitlePresentation(plain: string): boolean {
  return !(
    plain.startsWith('```')
    || /[\r\n\u2028\u2029]/u.test(plain)
    || /^(?:\p{N}+(?:[):]|\.(?!\p{N})|\s+[-–—]\s*|[-–—]\s+|[–—](?!\p{N}))|\(\p{N}+\)(?:\s|$))/u.test(plain)
    || /^#{1,6}\s+/u.test(plain)
    || /^(?:[a-z][.)]|[-*+•])\s+/i.test(plain)
    || /[.!?]\s+\p{L}/u.test(plain)
    || hasModelAnswerLabel(plain)
    || /^(?:i|we|you|he|she|they)(?:\s|['’](?:m|re|ve|ll|d|s)\b)/i.test(plain)
    || (!/^IT(?:\s|$)/.test(plain) && /^it(?:\s|['’](?:s|ll|d)\b)/i.test(plain))
    || /^(?:(?:here(?:'s| is)|this is)\s+(?:the|a|your)\s+title|(?:the\s+)?title\s*:|(?:the|this)\s+(?:session|conversation|task|title)\s+(?:is|was|should|involves|involved)|(?:i|we)\s+(?:am|are|will|have|need|can|would|should)|the user\s+(?:wants|asked|needs))/i.test(plain)
  );
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
  options: { preserveTruncationMarker?: boolean; rejectInvalidPresentation?: boolean } = {},
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

  if (options.rejectInvalidPresentation
    && !hasPlainTitlePresentation(unwrapTitlePresentation(withoutClosedThinking.trim()))) return null;

  const collapsed = unwrapTitlePresentation(withoutClosedThinking
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim());

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

/**
 * Accept one plain model-generated title, both before and after rail formatting.
 * Keep line structure until validation: collapsing a numbered answer first can
 * make its opening "1." look like the sentence the rail should display.
 * Deterministic prompt-derived/stored names have a different contract and use
 * sanitizeGeneratedTitle instead, so useful existing titles remain stable.
 */
export function validateGeneratedTitle(rawTitle: string | null | undefined): string | null {
  if (!rawTitle) return null;
  const plain = unwrapTitlePresentation(rawTitle
    .replace(GENERATED_TITLE_THINKING_BLOCK_PATTERN, '')
    .replace(GENERATED_TITLE_BRACKET_THINKING_BLOCK_PATTERN, '')
    .trim());
  // Generated answers must also be plain text. Stored deterministic names can
  // legitimately contain identifier punctuation such as __init__.py.
  if (!hasPlainTitlePresentation(plain) || /`|\*|__/.test(plain)) return null;

  const title = sanitizeGeneratedTitle(plain);
  if (!title || title.length < 3 || title.length > 80 || isLowSignalTitle(title)) return null;
  return title;
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

/** Normalize only action inflections; broad stemming would turn settings into set. */
function isGenericTitleWord(word: string): boolean {
  if (LOW_SIGNAL_TITLE_WORDS.has(word)) return true;
  const roots: string[] = [];
  // Plural nouns can use the complete generic vocabulary. Tense stemming is
  // restricted to actions so a feature noun such as settings stays meaningful.
  if (word.endsWith('s') && LOW_SIGNAL_TITLE_WORDS.has(word.slice(0, -1))) return true;
  if (word.endsWith('es') && LOW_SIGNAL_TITLE_WORDS.has(word.slice(0, -2))) return true;
  if (word.endsWith('ed')) roots.push(word.slice(0, -2), word.slice(0, -1));
  if (word.endsWith('ing')) {
    const stem = word.slice(0, -3);
    roots.push(stem, `${stem}e`);
    if (/(.)\1$/.test(stem)) roots.push(stem.slice(0, -1));
  }
  return roots.some((root) => GENERIC_TITLE_ACTION_ROOTS.has(root));
}

/** True when a title is filler, a bare number, or an opaque identifier. */
export function isLowSignalTitle(title: string): boolean {
  const trimmed = unwrapTitlePresentation(title);
  if (
    isBareIdentifierLine(trimmed)
    || /^[\p{N}\s.,:;!?()[\]#+-]+$/u.test(trimmed)
    || /^(?:question|step|option|item|point|section|task|answer)\s+\p{N}+[.!?:)]*$/iu.test(trimmed)
  ) return true;
  // Hyphenated status phrases carry the same signal as their spaced forms.
  const words = trimmed.toLowerCase()
    .replace(/\b(i|we|you|it|that|this)['’](?:m|re|ve|ll|d|s)\b/g, '$1')
    .replace(/-/g, ' ').match(/[\p{L}\p{N}.+#]+/gu) ?? [];
  if (words.length === 0) return true;
  return words.every((word) =>
    isGenericTitleWord(word.replace(/[.!?]+$/, '')) || /^\p{N}+(?:\.\p{N}+)*\.?$/u.test(word));
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
  LEADING_BARE_UUID_PATTERN, // pasted session/instance ID ahead of the real text
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

  const documentTitle = standaloneDocumentPathTitle(value ?? '');
  if (documentTitle) return documentTitle;

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

  // Skip a leading line that is nothing but a pasted session/instance ID (a
  // common way for a bug report to start — copying an ID from a title bar or
  // screenshot onto its own line before the real question). It contains no
  // identifying signal of its own, so — unlike ordinary first lines — titling
  // from it would make the session indistinguishable from any other, and the
  // real subject is one line down.
  const lines = trimmed.split(/\r?\n/);
  const firstLine = lines.find((line) => line.trim() && !isBareIdentifierLine(line)) ?? lines[0];
  const title = truncateForRail(frontLoadTitle(firstLine));

  // The text alone identifies nothing ("Please implement this") but a file is
  // attached: the file is the subject.
  if (labels.length > 0 && isLowSignalTitle(title)) {
    return deriveAttachmentTaskTitle(firstLine, labels) ?? title;
  }

  return title || titleFromAttachments(labels) || '';
}
