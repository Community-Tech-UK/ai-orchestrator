/**
 * Turn summary: the one quiet line under a finished turn, and the warning for
 * edits that failed and were never redone.
 *
 * `summariseTurn(toolEvents, elapsedMs)` turns the reconciled tool calls of one
 * turn (see turn-tool-events.ts) into "12 s · edited 2 files +18 −3 · ran 3
 * commands · 1 failed". Every number is counted from the tool
 * calls; nothing is rounded up to look tidy. The line has at most four visible
 * segments including the time, and the failure count is never the one that is
 * dropped: when there are too many kinds of activity the least important ones
 * merge into "used N other tools".
 *
 * `findEditFailureWarning` answers a different question: did the reply gloss
 * over an edit that never went through? It only speaks when the turn ended in a
 * text reply and was not interrupted, and a later successful write to the same
 * file (or a later command that writes to it) clears the failure.
 */

import { normaliseToolPath, type TurnToolEvent } from './turn-tool-events';

/** A turn shorter than this, with no tool calls, gets no note. */
export const QUIET_TURN_MS = 10_000;
/** Visible segments including elapsed and failures. */
export const MAX_SUMMARY_SEGMENTS = 4;

const MINUS = '−';
const MAX_LISTED_FILES = 3;
const CHECK_ADVICE = 'Check before trusting the summary.';

export type SummarySegmentKind = 'edited' | 'read' | 'ran' | 'searched' | 'other' | 'failed';

export interface SummarySegment {
  kind: SummarySegmentKind;
  text: string;
  count: number;
}

export interface TurnSummary {
  /** The whole line, ready to show. */
  text: string;
  /** "12 s", or an empty string when the turn lasted under a second. */
  duration: string;
  segments: readonly SummarySegment[];
  /** Failed tool calls, by the definition in turn-tool-events.ts. */
  failed: number;
}

interface Candidate {
  segment: SummarySegment;
  /** Tool calls behind this segment, used when segments are merged. */
  calls: number;
}

/** Display order of the activity segments. */
const DISPLAY_ORDER: readonly SummarySegmentKind[] = ['edited', 'read', 'ran', 'searched', 'other'];
/** Which segments survive when there are too many to show. */
const KEEP_ORDER: readonly SummarySegmentKind[] = ['edited', 'ran', 'read', 'searched', 'other'];

/** "12 s", "2 m 14 s", "1 h 5 m". Empty for anything under a second. */
export function formatTurnDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1_000) return '';
  const total = Math.round(ms / 1_000);
  const hours = Math.floor(total / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  const seconds = total % 60;
  if (hours > 0) return minutes > 0 ? `${hours} h ${minutes} m` : `${hours} h`;
  if (minutes > 0) return seconds > 0 ? `${minutes} m ${seconds} s` : `${minutes} m`;
  return `${seconds} s`;
}

/**
 * The quiet line for one turn, or null when there is nothing worth saying: no
 * tool ran and the turn was short.
 */
export function summariseTurn(toolEvents: readonly TurnToolEvent[], elapsedMs: number): TurnSummary | null {
  if (toolEvents.length === 0 && !(elapsedMs >= QUIET_TURN_MS)) return null;

  const duration = formatTurnDuration(elapsedMs);
  const failed = toolEvents.filter((event) => event.failed).length;
  const segments = chooseSegments(buildCandidates(toolEvents), failed, duration ? 1 : 0);
  if (failed > 0) segments.push({ kind: 'failed', text: `${failed} failed`, count: failed });

  const parts = [...(duration ? [duration] : []), ...segments.map((segment) => segment.text)];
  return { text: parts.join(' · '), duration, segments, failed };
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

function buildCandidates(events: readonly TurnToolEvent[]): Candidate[] {
  const candidates: Candidate[] = [];

  // "Edited" claims an effect, so a failed edit is left out of it; the failure
  // is reported by its own segment.
  const edits = events.filter((event) => event.kind === 'edit' && event.succeeded === true && !event.failed);
  if (edits.length > 0) {
    const named = edits.every((event) => event.paths.length > 0);
    const files = new Set(edits.flatMap((event) => event.paths)).size;
    const exact = edits.every((event) => event.added !== undefined && event.removed !== undefined);
    const lines = exact
      ? ` +${sum(edits, (event) => event.added)} ${MINUS}${sum(edits, (event) => event.removed)}`
      : '';
    candidates.push({
      segment: {
        kind: 'edited',
        text: `${named ? `edited ${plural(files, 'file')}` : `made ${plural(edits.length, 'edit')}`}${lines}`,
        count: named ? files : edits.length,
      },
      calls: edits.length,
    });
  }

  const reads = events.filter((event) => event.kind === 'read');
  if (reads.length > 0) {
    const named = reads.every((event) => event.paths.length > 0);
    const files = new Set(reads.flatMap((event) => event.paths)).size;
    candidates.push({
      segment: {
        kind: 'read',
        text: named ? `read ${plural(files, 'file')}` : plural(reads.length, 'read'),
        count: named ? files : reads.length,
      },
      calls: reads.length,
    });
  }

  // A command counts whether or not it worked: "ran 3 commands · 1 failed".
  const commands = events.filter((event) => event.kind === 'command');
  if (commands.length > 0) {
    candidates.push({
      segment: { kind: 'ran', text: `ran ${plural(commands.length, 'command')}`, count: commands.length },
      calls: commands.length,
    });
  }

  const searches = events.filter((event) => event.kind === 'search');
  if (searches.length > 0) {
    candidates.push({
      segment: { kind: 'searched', text: `searched ${plural(searches.length, 'time')}`, count: searches.length },
      calls: searches.length,
    });
  }

  const others = events.filter((event) => event.kind === 'other');
  if (others.length > 0) {
    candidates.push({ segment: otherSegment(others.length), calls: others.length });
  }
  return candidates;
}

function otherSegment(calls: number): SummarySegment {
  return { kind: 'other', text: `used ${calls} other ${calls === 1 ? 'tool' : 'tools'}`, count: calls };
}

/**
 * Picks the segments to show. When the failure segment is coming, it takes one
 * of the places left after elapsed time; if the rest do not fit, the lowest
 * priority kinds merge into one "used N other tools" segment so the total
 * number of tool calls is still accounted for.
 */
function chooseSegments(candidates: Candidate[], failed: number, durationSlots: number): SummarySegment[] {
  const slots = MAX_SUMMARY_SEGMENTS - durationSlots - (failed > 0 ? 1 : 0);
  const byImportance = [...candidates].sort(
    (a, b) => KEEP_ORDER.indexOf(a.segment.kind) - KEEP_ORDER.indexOf(b.segment.kind),
  );
  let chosen = byImportance.map((candidate) => candidate.segment);
  if (byImportance.length > slots) {
    const kept = byImportance.slice(0, slots - 1).map((candidate) => candidate.segment);
    const mergedCalls = byImportance.slice(slots - 1).reduce((total, candidate) => total + candidate.calls, 0);
    chosen = [...kept, otherSegment(mergedCalls)];
  }
  return chosen.sort((a, b) => DISPLAY_ORDER.indexOf(a.kind) - DISPLAY_ORDER.indexOf(b.kind));
}

function sum(events: readonly TurnToolEvent[], pick: (event: TurnToolEvent) => number | undefined): number {
  return events.reduce((total, event) => total + (pick(event) ?? 0), 0);
}

function plural(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

// ---------------------------------------------------------------------------
// Edits that failed and were not redone
// ---------------------------------------------------------------------------

export interface EditFailureGate {
  /** The turn ended with a text reply from the assistant. */
  hasFinalReply: boolean;
  interrupted: boolean;
  /** Working folder, so absolute and relative spellings of one file compare equal. */
  cwd?: string;
}

export interface UnrecoveredEdit {
  /** The file, or undefined when the provider did not say which. */
  path?: string;
  /** One plain sentence fragment; never the raw tool text. */
  reason: string;
  /** The tool's own text, cleaned and truncated, for the Details view. */
  detail: string;
  /** The same file was tried again after this failure and still did not go through. */
  retried: boolean;
}

export interface EditFailureWarning {
  /** The sentence to show under the reply. */
  text: string;
  /** Failed edit calls that nothing redid. */
  count: number;
  items: readonly UnrecoveredEdit[];
}

/** Words for why an edit failed, from a closed list. The raw text is never used in a sentence. */
export function describeEditFailure(raw: string | undefined): string {
  const text = raw ?? '';
  if (/permission|eacces|eperm|read-only|not permitted|not allowed/i.test(text)) {
    return 'Harness was not allowed to change the file';
  }
  if (/declin|rejected|denied by (the )?user|user (denied|refused)/i.test(text)) {
    return 'the change was declined';
  }
  if (/multiple|more than one|\d+ matches|not unique|ambiguous/i.test(text)) {
    return 'the text to change appears more than once';
  }
  if (/(string|text|pattern|old_?string)[^.]*?(not found|did not match|no match|does not match)|not found in (the )?file|could not find (the )?(text|string)/i.test(text)) {
    return 'the text to change was not found in the file';
  }
  if (/no such file|enoent|does not exist|file not found|cannot find (the )?(file|path)/i.test(text)) {
    return 'the file was not found';
  }
  if (/too (large|big)|exceeds? (the )?(size|limit)|size limit/i.test(text)) {
    return 'the file is too large';
  }
  return 'the tool reported an error';
}

/**
 * Finds edits that failed and that nothing later redid, and writes the one
 * warning sentence for them. Returns null when there is nothing to warn about
 * or when the turn did not end in a reply that could have glossed over it.
 */
export function findEditFailureWarning(
  events: readonly TurnToolEvent[],
  gate: EditFailureGate,
): EditFailureWarning | null {
  if (!gate.hasFinalReply || gate.interrupted) return null;
  const path = (raw: string): string => normaliseToolPath(raw, gate.cwd);

  const items: UnrecoveredEdit[] = [];
  const failedCalls = new Set<number>();
  events.forEach((event, index) => {
    if (event.kind !== 'edit' || !event.failed) return;
    const reason = describeEditFailure(event.failureText);
    const detail = event.failureText ?? '';
    if (event.paths.length === 0) {
      items.push({ reason, detail, retried: false });
      failedCalls.add(index);
      return;
    }
    for (const file of new Set(event.paths.map(path))) {
      if (isRecovered(events, index, file, path)) continue;
      items.push({ path: file, reason, detail, retried: attemptsFromFirstFailure(events, file, path) > 1 });
      failedCalls.add(index);
    }
  });
  if (items.length === 0) return null;

  return { text: warningSentence(items, failedCalls.size), count: failedCalls.size, items };
}

/** A later successful write to the file, or a later command that writes to it, redoes a failed edit. */
function isRecovered(
  events: readonly TurnToolEvent[],
  failedIndex: number,
  file: string,
  path: (raw: string) => string,
): boolean {
  for (let index = failedIndex + 1; index < events.length; index += 1) {
    const later = events[index];
    if (later.failed || !later.settled || later.succeeded !== true) continue;
    if (later.kind === 'edit' && later.paths.some((candidate) => path(candidate) === file)) return true;
    if (later.kind === 'command' && later.exitCode === 0 && commandMayWrite(later.command, file, path)) return true;
  }
  return false;
}

/** How many times this file was tried from its first failure on, counting that failure. */
function attemptsFromFirstFailure(
  events: readonly TurnToolEvent[],
  file: string,
  path: (raw: string) => string,
): number {
  const touches = (event: TurnToolEvent): boolean =>
    event.kind === 'edit' && event.paths.some((candidate) => path(candidate) === file);
  const first = events.findIndex((event) => touches(event) && event.failed);
  return first < 0 ? 0 : events.slice(first).filter(touches).length;
}

/** Only an explicit destination in a simple command can stand for a successful write.
 * A matching basename, a copy's input, or a compound command's exit status is not proof.
 */
function commandMayWrite(command: string | undefined, file: string, normalise: (raw: string) => string): boolean {
  if (!command || /[;&|`$()#\\\n]/.test(command)) return false;
  const unquote = (raw: string) => raw.replace(/^(['"])([\s\S]*)\1$/, '$2');
  const matches = (raw: string) => normalise(unquote(raw)) === file;
  // Keep quoted arguments intact: a redirect mentioned inside one is only text.
  const rawTokens = command.match(/'[^']*'|"[^"]*"|[12]?>>?|[^\s<>]+/g) ?? [];
  for (let index = 0; index + 1 < rawTokens.length; index += 1) {
    if (/^[12]?>>?$/.test(rawTokens[index]) && matches(rawTokens[index + 1])) return true;
  }
  const tokens = rawTokens.map(unquote);
  if (tokens.some(token => token === '--help' || token === '--version')) return false;
  const tool = tokens[0]?.split('/').pop();
  if (tool === 'sed' && tokens.length === 4 && tokens[1] === '-i') return matches(tokens[3]);
  if (tool === 'cp' || tool === 'mv' || tool === 'install') {
    return tokens.length === 3 && !tokens[1].startsWith('-') && matches(tokens[2]);
  }
  if (tool === 'truncate') return !tokens.some(token => token === '-c' || token === '--no-create') && matches(tokens.at(-1) ?? '');
  if (tool === 'tee') return tokens.slice(1).filter(token => !token.startsWith('-')).some(matches);
  if (tool === 'dd') return tokens.slice(1).some(token => token.startsWith('of=') && matches(token.slice(3)));
  return false;
}

function warningSentence(items: readonly UnrecoveredEdit[], count: number): string {
  const groups = new Map<string, { reasons: string[]; retried: boolean }>();
  for (const item of items) {
    const key = item.path ?? 'a file';
    const group = groups.get(key) ?? { reasons: [], retried: false };
    if (!group.reasons.includes(item.reason)) group.reasons.push(item.reason);
    group.retried ||= item.retried;
    groups.set(key, group);
  }
  const listed = [...groups.entries()].slice(0, MAX_LISTED_FILES)
    .map(([file, group]) => `${file} (${group.reasons.join('; ')})`);
  const hidden = groups.size - listed.length;
  const list = `${listed.join(', ')}${hidden > 0 ? `, and ${hidden} more` : ''}`;

  const named = items.every((item) => item.path !== undefined);
  const allRetried = named && items.every((item) => item.retried);
  const noneRetried = named && items.every((item) => !item.retried);
  const verb = count === 1 ? 'was' : 'were';
  const outcome = allRetried
    ? 'failed, even after a retry'
    : noneRetried ? `failed and ${verb} not retried` : `failed and ${verb} not ${named ? 'fixed' : 'completed'}`;
  return `${plural(count, 'edit')} ${outcome}: ${list}. ${CHECK_ADVICE}`;
}
