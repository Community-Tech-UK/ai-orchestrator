/**
 * Parsed view of a markdown plan-file's checkbox state. Single source of
 * truth shared by `LoopStageMachine.captureStartupSnapshot` and
 * `LoopCompletionDetector.observe` so the baseline measurement matches the
 * runtime measurement bit-for-bit.
 */
export interface PlanChecklistState {
  /** `[x]` or `[X]` items. */
  checked: number;
  /** `[ ]` items. */
  unchecked: number;
  /** `checked + unchecked`. */
  total: number;
  /** True iff the file has at least one item and none are unchecked. */
  fullyChecked: boolean;
}

/**
 * Parse markdown checkboxes (`- [x]`, `- [ ]`, `* [X]`, etc.) out of a plan
 * file. Pure function shared by the completion detector and startup snapshot.
 */
export function parsePlanChecklist(text: string): PlanChecklistState {
  const checked = (text.match(/^\s*[-*]\s*\[[xX]\]/gm) || []).length;
  const unchecked = (text.match(/^\s*[-*]\s*\[\s\]/gm) || []).length;
  const total = checked + unchecked;
  return { checked, unchecked, total, fullyChecked: total > 0 && unchecked === 0 };
}

/** Parsed view of OUTSTANDING.md's actionable sections. */
export interface OutstandingSections {
  /** Real bullets under a "Needs human" / "Requires human" / "Manual verif" heading. */
  needsHuman: string[];
  /** Real bullets under an "Open questions" heading. */
  openQuestions: string[];
}

/** Section a heading maps to, or null when it's an unrelated heading. */
type OutstandingSectionKind = 'needs-human' | 'open-questions' | null;

const NEEDS_HUMAN_HEADING =
  /needs?[-\s]*human|requires?[-\s]*human|human[-\s]*review|manual[-\s]*verif/i;
const OPEN_QUESTIONS_HEADING = /open[-\s]*questions?|unresolved[-\s]*questions?/i;

/** Placeholder bullets that mean "section is empty" — never counted as items. */
const OUTSTANDING_PLACEHOLDER = /^(none|n\/?a|nil|empty|tbd|—|-)\.?$/i;

function classifyOutstandingHeading(title: string): OutstandingSectionKind {
  // Needs-human takes precedence so a "Needs human questions" heading (unlikely
  // but possible) lands in the higher-signal bucket.
  if (NEEDS_HUMAN_HEADING.test(title)) return 'needs-human';
  if (OPEN_QUESTIONS_HEADING.test(title)) return 'open-questions';
  return null;
}

/** Strip markdown emphasis/brackets and a leading checkbox; return '' for placeholders. */
function normalizeOutstandingBullet(line: string): string | null {
  const bullet = line.match(/^\s*(?:[-*+]|\d+\.)\s+(?:\[[ xX~-]\]\s*)?(.*)$/);
  if (!bullet) return null;
  const text = bullet[1].trim().replace(/[*_`]/g, '').trim();
  if (!text) return null;
  // Placeholder check runs against a bracket-stripped copy so "(none)" / "[n/a]"
  // are still recognised, but the returned text keeps user punctuation intact.
  const bare = text.replace(/[()[\]]/g, '').trim();
  if (!bare || OUTSTANDING_PLACEHOLDER.test(bare)) return null;
  return text;
}

/**
 * Parse OUTSTANDING.md into its actionable sections. Single source of truth for
 * both the boolean completion gate ({@link outstandingHasHumanItems}) and the
 * structured capture persisted to `loop_outstanding_items` / surfaced in the UI.
 */
export function parseOutstandingSections(raw: string): OutstandingSections {
  const result: OutstandingSections = { needsHuman: [], openQuestions: [] };
  if (!raw.trim()) return result;
  let section: OutstandingSectionKind = null;
  for (const line of raw.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) {
      section = classifyOutstandingHeading(heading[1].trim().toLowerCase());
      continue;
    }
    if (!section) continue;
    const text = normalizeOutstandingBullet(line);
    if (text === null) continue;
    if (section === 'needs-human') result.needsHuman.push(text);
    else result.openQuestions.push(text);
  }
  return result;
}

/**
 * review-driven mode: does OUTSTANDING.md's "Needs human" section contain at
 * least one real item? Placeholders like "(none)", "none", "n/a", "-" don't count.
 */
export function outstandingHasHumanItems(raw: string): boolean {
  return parseOutstandingSections(raw).needsHuman.length > 0;
}

/**
 * Root-level `.md` filenames that are not plan files. These are stable project
 * docs that we never expect the agent to rename to `_completed`.
 */
const PROJECT_DOC_DENYLIST = new Set<string>([
  'readme.md',
  'changelog.md',
  'license.md',
  'agents.md',
  'claude.md',
  'design.md',
  'development.md',
  'architecture.md',
  'contributing.md',
  'code_of_conduct.md',
  'security.md',
  'support.md',
  'notes.md',
  'stage.md',
  'iteration_log.md',
  'loop_tasks.md',
  'todo.md',
  'roadmap.md',
  // The consolidated outstanding-items digest (exported by the Outstanding
  // panel) lives at the workspace root and contains `- [ ]` checkboxes. Without
  // this entry a *future* loop in the same workspace would see it as an
  // uncompleted plan doc (body has a checklist) and demand it be renamed
  // `_completed`, polluting the completion gate. It's a stable digest, not a plan.
  'outstanding.md',
]);

function looksLikeCompletedRename(basename: string): boolean {
  return /_[Cc]ompleted\.md$/.test(basename);
}

export function isPlanLikeMarkdown(basename: string): boolean {
  if (!basename.toLowerCase().endsWith('.md')) return false;
  if (PROJECT_DOC_DENYLIST.has(basename.toLowerCase())) return false;
  if (looksLikeCompletedRename(basename)) return false;
  return true;
}

const PLAN_NAME_HINT_RE = /(plan|backlog|roadmap|todo|review|spec|task|milestone|checklist|implementation)/i;

export function hasPlanNameHint(basename: string): boolean {
  return PLAN_NAME_HINT_RE.test(basename);
}

/** Default NOTES.md curation thresholds (LF-3). Conservative so curation only
 *  fires on genuinely bloated notes - most loops never trip it. */
export const NOTES_CURATION_MAX_CHARS = 24_000;
export const NOTES_CURATION_KEEP_TAIL_CHARS = 12_000;

export interface NotesCurationResult {
  /** The (possibly) curated NOTES.md content. */
  curated: string;
  /** True iff curation actually rewrote the content. */
  changed: boolean;
  /** Approximate characters elided (0 when unchanged). */
  elidedChars: number;
}

/**
 * Extract the `## Completion Inventory` section verbatim (heading through the
 * line before the next `##` heading, or EOF). Returns null when absent.
 */
function extractCompletionInventory(content: string): string | null {
  const heading = content.match(/^##\s+Completion Inventory\b.*$/im);
  if (!heading || heading.index === undefined) return null;
  const afterHeadingStart = heading.index + heading[0].length;
  const rest = content.slice(afterHeadingStart);
  const nextHeading = rest.search(/^##\s+/m);
  const end = nextHeading >= 0 ? afterHeadingStart + nextHeading : content.length;
  return content.slice(heading.index, end);
}

/**
 * LF-3 - bound NOTES.md growth while preserving the durable
 * `## Completion Inventory` section byte-for-byte.
 */
export function curateNotesContent(
  content: string,
  opts: { maxChars?: number; keepTailChars?: number } = {},
): NotesCurationResult {
  const maxChars = opts.maxChars ?? NOTES_CURATION_MAX_CHARS;
  const keepTailChars = opts.keepTailChars ?? NOTES_CURATION_KEEP_TAIL_CHARS;
  if (content.length <= maxChars) {
    return { curated: content, changed: false, elidedChars: 0 };
  }

  const inventory = extractCompletionInventory(content);

  let tail = content.slice(-keepTailChars);
  const firstNewline = tail.indexOf('\n');
  if (firstNewline >= 0) tail = tail.slice(firstNewline + 1);
  tail = tail.replace(/^\s+/, '');

  const banner = '# Loop Notes\n';
  const marker =
    '\n_[loop] Older NOTES.md entries were elided to bound context. ' +
    'Full per-iteration history remains in ITERATION_LOG.md._\n\n';
  let curated = `${banner}${marker}${tail}`;

  const inventoryTrimmed = inventory?.trim();
  if (inventoryTrimmed && !curated.includes(inventoryTrimmed)) {
    curated = `${curated.replace(/\s+$/, '')}\n\n${inventoryTrimmed}\n`;
  }

  return {
    curated,
    changed: curated !== content,
    elidedChars: Math.max(0, content.length - curated.length),
  };
}
