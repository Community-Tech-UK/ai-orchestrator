/**
 * Plan Queue plan diet — the coordinator keeps a job's document small.
 *
 * At each worktree checkpoint the document is checked: when it grew by more
 * than 8 KB since the job started, or it holds more than one `## Status`
 * block, every dated journal section below the as-built heading moves into
 * `<stem>_history.md` in the ROOT checkout (never inside a worktree, never on
 * the job's branch). Sections are moved, never deleted, and one line pointing
 * at the history file is left where they were.
 *
 * The root history file is shared — workers, checkers, ordinary sessions and
 * James all edit it — and so is the root document the diet rewrites. Both are
 * pinned by regular-file and ancestor identity plus bytes when the move is
 * prepared and again just before writing. Original inodes are retained so late
 * descriptor writes survive; an observed change refuses transformation acceptance.
 *
 * Pinned detection rule (plan-queue-plan-diet.spec.ts):
 *   - anchors are headings whose text names the as-built notes or
 *     the journal (`as built`, `as-built`, `asbuilt`, `journal`);
 *   - a dated journal section is an ATX heading at level 2 or 3 below that
 *     anchor whose text carries a recognisable date (ISO `2026-10-20`,
 *     `21 October` / `21 Oct`, or `October 21` / `Oct 21`);
 *   - step and plan-body headings (`Step N`, numbered parts like `4a.`) are
 *     never journal, level 1 and level 4+ headings are never moved, and
 *     only descendants of an as-built/journal anchor are ever moved. A peer
 *     heading ends that section, even when its title contains a date.
 */

import * as disk from 'node:fs';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { getLogger } from '../logging/logger';
import { STATUS_TEXT_RE } from './plan-queue-plan-extract';
import type { PlanQueueHistoryStore } from './plan-queue-history-store';
import type { PlanQueueItem } from './plan-queue.types';
import { changeDocumentFile } from './plan-queue-document-mutation';

const logger = getLogger('PlanQueuePlanDiet');

/** Growth since the job started that triggers the diet (T1 item 2). */
export const DIET_GROWTH_BYTES = 8 * 1024;
export const CLOSE_SMALL_SUMMARY_BYTES = 3 * 1024;

const AS_BUILT_HEADING_RE = /\bas[-\s]?built\b|\basbuilt\b|\bjournal\b/i;
const STEP_HEADING_RE = /\bsteps?\b/i;
const NUMBERED_PART_RE = /^\d+[a-z]\.\s/i;
const MONTHS = String.raw`Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?`;
const DATE_RE = new RegExp(
  [String.raw`\b20\d{2}-\d{2}-\d{2}\b`, String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:${MONTHS})\b`, String.raw`\b(?:${MONTHS})\s+\d{1,2}(?:st|nd|rd|th)?\b`].join('|'),
  'i',
);
const HEADING_RE = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

interface HeadingLine {
  line: number;
  level: number;
  text: string;
}

function headingAt(line: string): HeadingLine | null {
  const match = HEADING_RE.exec(line);
  return match ? { line: -1, level: match[1].length, text: match[2] } : null;
}

/** Markdown examples are document content, never live headings. */
function documentHeadings(lines: readonly string[]): HeadingLine[] {
  const headings: HeadingLine[] = [];
  let fence: { marker: string; length: number } | undefined;
  for (const [index, line] of lines.entries()) {
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
      continue;
    }
    if (delimiter) { fence = { marker: delimiter[1][0], length: delimiter[1].length }; continue; }
    const heading = headingAt(line);
    if (heading) headings.push({ ...heading, line: index });
  }
  return headings;
}

/**
 * Is this heading a dated journal section? `belowAsBuilt` is whether the
 * heading sits below the document's as-built/journal heading.
 */
export function isDatedJournalHeading(heading: string, level: number, belowAsBuilt: boolean): boolean {
  if (!belowAsBuilt || level < 2 || level > 3) return false;
  const text = heading.replace(/^#+\s*/, '').replace(/\s*#+\s*$/, '');
  if (STEP_HEADING_RE.test(text) || NUMBERED_PART_RE.test(text)) return false;
  return DATE_RE.test(text);
}

export function countStatusBlocks(content: string): number {
  return documentHeadings(content.split('\n')).filter(heading => heading.level === 2 && STATUS_TEXT_RE.test(heading.text)).length;
}

/** The one line left in the document where the journal sections were. */
export function dietPointerLine(historyName: string): string {
  return `> Earlier journal sections moved to \`${historyName}\`.\n`;
}

/** The active history file beside a document in the root checkout. */
export function documentHistoryPath(documentPath: string): string {
  return path.join(path.dirname(documentPath), `${stemOf(documentPath)}_history.md`);
}

/** Legacy shared completed history: snapshot it, never replace it. */
export function completedHistoryPath(documentPath: string): string {
  return path.join(path.dirname(documentPath), `${stemOf(documentPath)}_history_completed.md`);
}

function stemOf(documentPath: string): string {
  return path.basename(documentPath).replace(/\.md$/i, '').replace(/_(plan|livetest|spec_planned|spec|livetest_completed)$/i, '');
}

interface Section {
  start: number;
  end: number;
}

/** Only the anchor's Markdown descendants belong to its as-built section. */
function asBuiltSections(lines: readonly string[], headings = documentHeadings(lines)): Section[] {
  const sections: Section[] = [];
  for (const [index, anchor] of headings.entries()) {
    if (!AS_BUILT_HEADING_RE.test(anchor.text) || sections.some(section => anchor.line < section.end)) continue;
    const next = headings.slice(index + 1).find(heading => heading.level <= anchor.level);
    sections.push({ start: anchor.line, end: next?.line ?? lines.length });
  }
  return sections;
}

/** Line indices of every dated journal section, merged so overlaps stay whole. */
function datedJournalSections(lines: readonly string[]): Section[] {
  const headings = documentHeadings(lines);
  const regions = asBuiltSections(lines, headings);
  const sections: Section[] = [];
  for (let i = 0; i < headings.length; i += 1) {
    const heading = headings[i];
    const region = regions.find(section => heading.line > section.start && heading.line < section.end);
    if (!region) continue;
    if (!isDatedJournalHeading(lines[heading.line], heading.level, true)) continue;
    if (sections.some((section) => heading.line >= section.start && heading.line < section.end)) continue;
    let end = region.end;
    for (let j = i + 1; j < headings.length; j += 1) {
      if (headings[j].level <= heading.level) {
        end = Math.min(end, headings[j].line);
        break;
      }
    }
    sections.push({ start: heading.line, end });
  }
  return sections;
}

/**
 * Move every dated journal section below the as-built heading out of the
 * document text, leaving one pointer line at the first moved position.
 * `kept` and `moved` conserve bytes: kept + moved = content + pointer.
 */
export function splitDatedJournalSections(content: string, historyName: string): { kept: string; moved: string } {
  const lines = content.split('\n');
  const sections = datedJournalSections(lines);
  if (!sections.length) return { kept: content, moved: '' };
  // Character offsets, so the moved text is the exact source bytes.
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset);
    offset += line.length + 1;
  }
  const endOf = (line: number): number => (line >= lines.length ? content.length : starts[line]);
  const keptParts: string[] = [];
  const movedParts: string[] = [];
  let cursor = 0;
  for (const [index, section] of sections.entries()) {
    keptParts.push(content.slice(cursor, starts[section.start]));
    keptParts.push(index === 0 ? dietPointerLine(historyName) : '');
    movedParts.push(content.slice(starts[section.start], endOf(section.end)));
    cursor = endOf(section.end);
  }
  keptParts.push(content.slice(cursor));
  return { kept: keptParts.join(''), moved: movedParts.join('') };
}

export interface PlanDietInput {
  /** The job's document, at its absolute ROOT checkout path. */
  documentPath: string;
  /** Where the journal goes: `<stem>_history.md` in the ROOT checkout. */
  historyPath: string;
  /** Document size when the job started; null when no pin was recorded. */
  bytesAtJobStart: number | null;
  /** Test seam: run between preparing the move and the identity/byte re-check. */
  onMovePrepared?: () => void | Promise<void>;
}

export interface PlanDietResult {
  transformation?: { beforeSha256: string; afterSha256: string };
  moved: boolean;
  bytesMoved: number;
  reason: string;
}

async function readOptionalBuffer(file: string): Promise<Buffer | null> {
  try { return await fs.readFile(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

interface DietFileIdentity {
  file: string;
  stat: disk.Stats | null;
  ancestors: { folder: string; stat: disk.Stats }[];
}

function sameIdentity(left: disk.Stats | null, right: disk.Stats | null): boolean {
  return left === null || right === null ? left === right
    : left.dev === right.dev && left.ino === right.ino && left.mode === right.mode
      && (!left.isFile() || left.nlink === right.nlink);
}

function fileStat(file: string): disk.Stats | null {
  try { return disk.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Pin every lexical ancestor too: a regular leaf alone can still be redirected. */
function dietFileIdentity(file: string): DietFileIdentity {
  file = path.resolve(file);
  const ancestors: DietFileIdentity['ancestors'] = [];
  for (let folder = path.dirname(file); ; folder = path.dirname(folder)) {
    const stat = disk.lstatSync(folder);
    if (!stat.isDirectory()) throw new Error('Plan diet requires regular directory ancestors');
    ancestors.push({ folder, stat });
    if (folder === path.dirname(folder)) break;
  }
  const stat = fileStat(file);
  if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error('Plan diet requires an unshared regular file');
  return { file, stat, ancestors };
}

function identityUnchanged(identity: DietFileIdentity): boolean {
  return identity.ancestors.every(({ folder, stat }) => {
    const current = fileStat(folder);
    return current?.isDirectory() && sameIdentity(stat, current);
  }) && sameIdentity(identity.stat, fileStat(identity.file));
}

/** Read positionally so validation leaves the descriptor's write offset at zero. */
function bytesUnchanged(fd: number, expected: Buffer): boolean {
  const actual = Buffer.alloc(expected.length + 1);
  let length = 0;
  while (length < actual.length) {
    const count = disk.readSync(fd, actual, length, actual.length - length, length);
    if (!count) break;
    length += count;
  }
  return actual.subarray(0, length).equals(expected);
}

/**
 * Open without truncation or following links, then prove both path and handle
 * identities and bytes before the first write. There is no await between this
 * final proof and non-destructive claims. Both originals survive in retained
 * files; complete replacement bytes are published without overwriting a racing path.
 */
function writeDietFiles(document: DietFileIdentity, documentBefore: Buffer, kept: string,
  history: DietFileIdentity, historyBefore: Buffer | null, historyAfter: Buffer): boolean {
  if (!identityUnchanged(document) || !identityUnchanged(history)) return false;
  const flags = disk.constants.O_RDWR | disk.constants.O_NOFOLLOW;
  const documentFd = disk.openSync(document.file, flags);
  let historyFd: number | undefined;
  try {
    if (!sameIdentity(document.stat, disk.fstatSync(documentFd)) || !bytesUnchanged(documentFd, documentBefore)) return false;
    if (history.stat) {
      historyFd = disk.openSync(history.file, flags);
      if (!sameIdentity(history.stat, disk.fstatSync(historyFd)) || !bytesUnchanged(historyFd, historyBefore!)) return false;
    }
    if (!identityUnchanged(document) || !identityUnchanged(history)) return false;
    if (historyFd === undefined) {
      // Exclusive creation refuses a file/link that appeared after the absence proof.
      historyFd = disk.openSync(history.file, flags | disk.constants.O_CREAT | disk.constants.O_EXCL, 0o600);
      history = { ...history, stat: disk.fstatSync(historyFd) };
    }
    if (!identityUnchanged(document) || !identityUnchanged(history)) return false;
    if (!bytesUnchanged(documentFd, documentBefore) || !bytesUnchanged(historyFd, historyBefore ?? Buffer.alloc(0))) return false;
    changeDocumentFile({ ...history, stat: history.stat! }, historyBefore ?? Buffer.alloc(0), historyAfter);
    changeDocumentFile({ ...document, stat: document.stat! }, documentBefore, kept);
    return true;
  } finally {
    if (historyFd !== undefined) disk.closeSync(historyFd);
    disk.closeSync(documentFd);
  }
}

/**
 * The checkpoint-time diet (T1 item 2). Move, never delete; skip (and log)
 * entirely when the shared root history file changed while the move was
 * prepared.
 */
export async function maybeDietDocument(input: PlanDietInput): Promise<PlanDietResult> {
  const historyName = path.basename(input.historyPath);
  const documentIdentity = dietFileIdentity(input.documentPath);
  let content: string;
  let documentBefore: Buffer;
  try {
    documentBefore = await fs.readFile(input.documentPath);
    content = documentBefore.toString('utf-8');
  } catch {
    return { moved: false, bytesMoved: 0, reason: 'the document could not be read' };
  }
  if (!Buffer.from(content, 'utf8').equals(documentBefore)) throw new Error('Plan diet requires valid UTF-8');
  const grown = input.bytesAtJobStart !== null
    && Buffer.byteLength(content, 'utf-8') - input.bytesAtJobStart > DIET_GROWTH_BYTES;
  if (!grown && countStatusBlocks(content) <= 1) {
    return { moved: false, bytesMoved: 0, reason: 'within the size budget' };
  }
  const { kept, moved } = splitDatedJournalSections(content, historyName);
  if (!moved) return { moved: false, bytesMoved: 0, reason: 'no dated journal sections below the as-built heading' };

  const historyIdentity = dietFileIdentity(input.historyPath);
  const historyBefore = await readOptionalBuffer(input.historyPath);
  const historyAfter = historyBefore && historyBefore.length
    ? Buffer.concat([
      historyBefore,
      Buffer.from(historyBefore.toString('utf-8').endsWith('\n') ? '' : '\n', 'utf-8'),
      Buffer.from(moved, 'utf-8'),
    ])
    : Buffer.from(moved, 'utf-8');

  await input.onMovePrepared?.();

  if (!writeDietFiles(documentIdentity, documentBefore, kept, historyIdentity, historyBefore, historyAfter)) {
    logger.warn('Plan queue plan diet skipped: root file bytes or path identity changed while the move was prepared', {
      document: input.documentPath,
      history: input.historyPath,
    });
    return { moved: false, bytesMoved: 0, reason: 'the root document or history file changed while the move was prepared; skipped' };
  }

  const bytesMoved = Buffer.byteLength(moved, 'utf-8');
  logger.info('Plan queue plan diet moved journal sections to the root history file', {
    document: input.documentPath,
    history: input.historyPath,
    bytesMoved,
  });
  return { moved: true, bytesMoved, reason: `moved ${bytesMoved} bytes of journal to ${historyName}`,
    transformation: { beforeSha256: createHash('sha256').update(documentBefore).digest('hex'),
      afterSha256: createHash('sha256').update(kept).digest('hex') } };
}

/**
 * The diet at every worktree checkpoint (Step 5): run before the checkpoint's
 * `git add`/commit, from the item's pinned size at job start. Failures are
 * logged and never block the checkpoint.
 */
export async function dietAtCheckpoint(item: PlanQueueItem, memory?: PlanQueueHistoryStore): Promise<void> {
  try {
    const result = await maybeDietDocument({
      documentPath: item.sourceRef,
      historyPath: documentHistoryPath(item.sourceRef),
      bytesAtJobStart: memory?.getPin(item.id)?.documentBytes ?? null,
    });
    memory?.recordDocumentTransformation(item, result.transformation);
  } catch (error) {
    logger.warn('Plan queue plan diet failed; the checkpoint continues', {
      document: item.sourceRef,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}


/**
 * Close small (T1 item 6): the same journal sections go to the completed
 * history file, and the completed document keeps an as-built summary of at
 * most about 3 KB (the overflow is moved, never deleted).
 */
export function closeSmallDocument(content: string, historyName: string): { content: string; moved: string } {
  const { kept, moved: dated } = splitDatedJournalSections(content, historyName);
  const lines = kept.split('\n');
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) { starts.push(offset); offset += line.length + 1; }
  const at = (line: number): number => line >= lines.length ? kept.length : starts[line];
  const parts: string[] = [];
  const moved = dated ? [dated] : [];
  let budget = CLOSE_SMALL_SUMMARY_BYTES;
  let cursor = 0;
  for (const section of asBuiltSections(lines)) {
    const cutLine = summaryCutLine(lines, section, budget);
    const summary = kept.slice(at(section.start), at(cutLine));
    budget -= Buffer.byteLength(summary, 'utf8');
    if (cutLine >= section.end) continue;
    parts.push(kept.slice(cursor, at(cutLine)));
    if (!summary.includes(historyName)) parts.push(dietPointerLine(historyName));
    moved.push(kept.slice(at(cutLine), at(section.end)));
    cursor = at(section.end);
  }
  parts.push(kept.slice(cursor));
  return { content: parts.join(''), moved: moved.join('\n') };
}

/** Keep headings, complete lines and complete fences even at the byte budget. */
function summaryCutLine(lines: readonly string[], section: Section, budget: number): number {
  let safeCut = section.start + 1;
  let fence: { marker: string; length: number } | undefined;
  for (let i = section.start; i < section.end; i += 1) {
    const cost = Buffer.byteLength(lines[i], 'utf8') + (i < lines.length - 1 ? 1 : 0);
    if (budget < cost && i > section.start) break;
    budget -= cost;
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (fence) {
      if (delimiter && delimiter[1][0] === fence.marker && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
    } else if (delimiter) fence = { marker: delimiter[1][0], length: delimiter[1].length };
    if (!fence) safeCut = i + 1;
  }
  return safeCut;
}
