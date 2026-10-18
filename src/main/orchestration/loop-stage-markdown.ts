import { classifyQuestionRisk } from '../../shared/attention/question-need';
import { OUTSTANDING_TEMPLATE } from './loop-stage-files';
import type { LoopOutstandingEntry } from '../../shared/types/loop-outstanding.types';

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
  needsHuman: LoopOutstandingEntry[];
  /** Real bullets under an "Open questions" heading. */
  openQuestions: LoopOutstandingEntry[];
  decisionsApplied: LoopOutstandingEntry[];
  forInformation: LoopOutstandingEntry[];
}

/** Section a heading maps to, or null when it's an unrelated heading. */
type OutstandingSectionKind = 'needs-human' | 'open-questions' | 'decisions-applied' | 'for-information' | null;

const NEEDS_HUMAN_HEADING =
  /needs?[-\s]*human|requires?[-\s]*human|human[-\s]*review|manual[-\s]*verif/i;
const OPEN_QUESTIONS_HEADING = /open[-\s]*questions?|unresolved[-\s]*questions?/i;

/** Placeholder bullets that mean "section is empty" — never counted as items. */
const OUTSTANDING_PLACEHOLDER = /^(none|n\/?a|nil|empty|tbd|—|-)\.?$/i;

/**
 * A bullet whose text is the agent's recommended decision for the item it
 * follows, e.g. `- Recommendation: provision the VPS in the UK region`. Requires
 * an explicit colon so a genuine item that merely starts with the word (e.g.
 * "Recommendation from legal needed") is NOT swallowed. Capture group 1 is the
 * recommendation text (guaranteed non-empty by `(.+)`).
 */
const RECOMMENDATION_BULLET = /^(?:recommendation|recommended|suggestion|suggested|applied)\s*:\s*(.+)$/i;

/** Return the recommendation text if `text` is a `Recommendation:` bullet, else null. */
function parseRecommendationBullet(text: string): string | null {
  const m = text.match(RECOMMENDATION_BULLET);
  return m ? m[1].trim() : null;
}

function classifyOutstandingHeading(title: string): OutstandingSectionKind {
  // Needs-human takes precedence so a "Needs human questions" heading (unlikely
  // but possible) lands in the higher-signal bucket.
  if (NEEDS_HUMAN_HEADING.test(title)) return 'needs-human';
  if (/decisions?[-\s]*applied|applied[-\s]*decisions?/i.test(title)) return 'decisions-applied';
  if (/for[-\s]*information|\bfyi\b/i.test(title)) return 'for-information';
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
  const result: OutstandingSections = { needsHuman: [], decisionsApplied: [], forInformation: [], openQuestions: [] };
  let section: OutstandingSectionKind = null;
  let lastEntry: LoopOutstandingEntry | null = null;
  let recommendationContinuation = false;
  let fence: { marker: string; length: number } | null = null;
  for (const line of raw.replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = { marker: marker[1][0], length: marker[1].length };
      else if (marker[1][0] === fence.marker && marker[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    if (heading) { section = classifyOutstandingHeading(heading[1]); lastEntry = null; recommendationContinuation = false; continue; }
    if (!section) continue;
    const text = normalizeOutstandingBullet(line);
    if (text === null) {
      if (lastEntry && /^\s+\S/.test(line) && !/^\s*(?:[-*+]|\d+\.)\s/.test(line)) {
        if (recommendationContinuation) lastEntry.recommendation = `${lastEntry.recommendation ?? ''} ${line.trim()}`.trim();
        else lastEntry.text += ` ${line.trim()}`;
      }
      continue;
    }
    const recommendation = parseRecommendationBullet(text);
    if (recommendation !== null) {
      if (lastEntry && lastEntry.recommendation === null) { lastEntry.recommendation = recommendation; recommendationContinuation = true; }
      continue;
    }
    const entry: LoopOutstandingEntry = { text, recommendation: null };
    if (section === 'needs-human') result.needsHuman.push(entry);
    else if (section === 'decisions-applied') result.decisionsApplied.push(entry);
    else { result.forInformation.push(entry); result.openQuestions.push(entry); }
    lastEntry = entry;
    recommendationContinuation = false;
  }
  return result;
}

export function renderOutstandingFile(sections: OutstandingSections): string {
  const header = OUTSTANDING_TEMPLATE.slice(0, OUTSTANDING_TEMPLATE.indexOf('## Needs human'));
  const render = (heading: string, entries: LoopOutstandingEntry[], applied = false) => `## ${heading}\n` + (entries.length ? entries.map(entry => `- ${entry.text}` + (entry.recommendation ? `\n  - ${applied ? 'Applied' : 'Recommendation'}: ${entry.recommendation}` : '')).join('\n') : '- (none)');
  return header + [render('Needs human', sections.needsHuman), render('Decisions applied', sections.decisionsApplied, true), render('For information', sections.forInformation)].join('\n\n') + '\n';
}

/** Risky decisions and information require the same sign-off as explicit human questions. */
export function outstandingHasHumanItems(raw: string): boolean {
  const sections = parseOutstandingSections(raw);
  return sections.needsHuman.length > 0 || [...sections.decisionsApplied, ...sections.forInformation].some(entry => classifyQuestionRisk(entry.text, entry.recommendation ?? '') !== null);
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
export function extractCompletionInventory(content: string): string | null {
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
  // A UTF-16 cut can land between the two units of one Unicode character.
  // Drop that partial oldest character before any UTF-8 file write.
  const precedingUnit = content.charCodeAt(content.length - tail.length - 1);
  const firstUnit = tail.charCodeAt(0);
  if (precedingUnit >= 0xD800 && precedingUnit <= 0xDBFF && firstUnit >= 0xDC00 && firstUnit <= 0xDFFF) {
    tail = tail.slice(1);
  }
  const firstNewline = tail.indexOf('\n');
  if (firstNewline >= 0) tail = tail.slice(firstNewline + 1);
  tail = tail.replace(/^\s+/, '');

  const banner = '# Loop Notes\n';
  const marker =
    '\n_[loop] Older NOTES.md entries were removed to keep this file short; the newest entries follow._\n\n';
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

export const ITERATION_LOG_MAX_BYTES = 64 * 1024;
export const ITERATION_LOG_KEEP_TAIL_BYTES = 32 * 1024;

/** Drop a partial oldest entry, including a partial UTF-8 character at the cut. */
export function trimIterationLogTail(tailText: string): string {
  const boundary = tailText.indexOf('\n## Iteration ');
  const tail = tailText.startsWith('## Iteration ') ? tailText : boundary >= 0 ? tailText.slice(boundary + 1) : '';
  return '# Iteration Log\n\n_[loop] Older entries were trimmed to keep this file under 64 KB. ' +
    'Harness keeps every iteration in its run history._\n\n' + tail;
}
