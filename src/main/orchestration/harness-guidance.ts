/**
 * Harness guidance delivery (A12, Step 10).
 *
 * Owns the short guide's eligibility rule and the once-per-conversation
 * delivery of the detailed scheduling and consensus rules. The guide itself
 * (`HARNESS_GUIDE`) is a system-prompt block assembled at create time; the
 * rule sets ride in the user turn that asks for them, so they never touch the
 * cached system prompt.
 */

import { getLogger } from '../logging/logger';
import type { Instance, InstanceCreateConfig } from '../../shared/types/instance.types';
import { machineSessionReasonOf } from '../../shared/utils/machine-session';
import { buildActiveGoalContext } from '../commands/goal-command';
import {
  CONSENSUS_RULES,
  CONSENSUS_RULES_REPEAT_LINE,
  HARNESS_GUIDE,
  SCHEDULING_RULES_REPEAT_LINE,
  buildSchedulingRules,
  detectsConsensusIntent,
  detectsSchedulingIntent,
} from './orchestration-protocol.prompts';

export type HarnessGuidanceSection = 'scheduling' | 'consensus';

export interface HarnessGuidanceSelection {
  text: string | null;
  added: HarnessGuidanceSection[];
  repeated: HarnessGuidanceSection[];
}

export interface HarnessGuidanceHandle {
  text: string | null;
  /** Marks the sections as delivered. Call only after the send succeeded. */
  commit(): void;
}

const logger = getLogger('HarnessGuidance');

/** A message starting with `/` is a slash command, never a scheduling ask. */
function isSlashCommand(message: string): boolean {
  return message.trimStart().startsWith('/');
}

const FENCED_BLOCK_RE = /```[\s\S]*?(?:```|$)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const QUOTED_LINE_RE = /^[ \t]*>/;
const ISO_LINE_RE = /^[ \t]*\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
const CLOCK_LINE_RE = /^[ \t]*\d{1,2}:\d{2}(?::\d{2})?/;
const JSON_LINE_RE = /^[ \t]*\{"[^\n]*$/;
const JSON_ARRAY_LINE_RE = /^[ \t]*\[\{[^\n]*$/;
const FILE_EXTENSION_RE = /\.[A-Za-z0-9]{1,8}$/;

/**
 * Strip a user message down to the prose the intent detectors should see.
 * Slash commands, fenced and inline code, quoted lines, log-like lines and
 * path/file tokens are removed first, so a pasted log or a path such as
 * `src/main/automations/automation-runner.ts` cannot trip a detector.
 */
export function textForIntentMatching(message: string): string {
  if (!message) return '';
  if (isSlashCommand(message)) return '';
  const withoutCode = message
    .replace(FENCED_BLOCK_RE, ' ')
    .replace(INLINE_CODE_RE, ' ');
  const keptLines: string[] = [];
  for (const line of withoutCode.split('\n')) {
    if (QUOTED_LINE_RE.test(line)) continue;
    if (ISO_LINE_RE.test(line)) continue;
    if (CLOCK_LINE_RE.test(line)) continue;
    if (JSON_LINE_RE.test(line)) continue;
    if (JSON_ARRAY_LINE_RE.test(line)) continue;
    keptLines.push(line);
  }
  return keptLines
    .join('\n')
    .split(/\s+/)
    .filter((token) => {
      if (!token) return false;
      if (token.includes('/') || token.includes('\\')) return false;
      if (FILE_EXTENSION_RE.test(token)) return false;
      return true;
    })
    .join(' ');
}

/**
 * Pure selection: which guidance this message needs, given what the
 * conversation has already received. Scheduling before consensus. A section
 * already delivered gives its one-line repeat instead of the full text.
 */
export function selectHarnessGuidance(
  message: string,
  delivered: ReadonlySet<HarnessGuidanceSection>,
  now: Date,
  timeZone: string,
): HarnessGuidanceSelection {
  const stripped = textForIntentMatching(message);
  const added: HarnessGuidanceSection[] = [];
  const repeated: HarnessGuidanceSection[] = [];
  const parts: string[] = [];

  if (detectsSchedulingIntent(stripped)) {
    if (delivered.has('scheduling')) {
      repeated.push('scheduling');
      parts.push(SCHEDULING_RULES_REPEAT_LINE);
    } else {
      added.push('scheduling');
      parts.push(buildSchedulingRules(now, timeZone));
    }
  }
  if (detectsConsensusIntent(stripped)) {
    if (delivered.has('consensus')) {
      repeated.push('consensus');
      parts.push(CONSENSUS_RULES_REPEAT_LINE);
    } else {
      added.push('consensus');
      parts.push(CONSENSUS_RULES);
    }
  }

  return {
    text: parts.length > 0 ? parts.join('\n\n') : null,
    added,
    repeated,
  };
}

/**
 * The guide goes to person-started root sessions only. Sessions Harness starts
 * for itself (loops, the plan queue, scheduled jobs, repo jobs, reviewers,
 * worker-machine runs) and children keep today's behaviour of no guide.
 */
export function shouldReceiveHarnessGuide(
  instance: { depth: number },
  config: Pick<InstanceCreateConfig, 'parentId' | 'metadata'>,
): boolean {
  return instance.depth === 0 && machineSessionReasonOf(config) === null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The scheduling rules differ between sends only in the local-time line, so
 * the matcher is derived from the real builder with that one line opened up.
 * Everything else comes from the same constants the sender uses, so the two
 * cannot drift apart.
 */
const LOCAL_TIME_LABEL = 'Local time now: ';
const SCHEDULING_RULES_SOURCE = (() => {
  const sample = buildSchedulingRules(new Date(0), 'UTC');
  const labelAt = sample.indexOf(LOCAL_TIME_LABEL);
  if (labelAt < 0) return escapeRegExp(sample);
  const valueAt = labelAt + LOCAL_TIME_LABEL.length;
  const lineEnd = sample.indexOf('\n', valueAt);
  const tail = lineEnd < 0 ? '' : sample.slice(lineEnd);
  return `${escapeRegExp(sample.slice(0, valueAt))}[^\\n]*${escapeRegExp(tail)}`;
})();

/**
 * Harness puts guidance immediately before the user's own text, joined with a
 * blank line (`instance-system-prompt.ts` first message, `instance-manager.ts`
 * later turns): scheduling first, then consensus, each either in full or as its
 * one-line repeat. Only that exact shape, at the start of the text, matches.
 */
const LEADING_GUIDANCE_SOURCE =
  `\\s*(?:(?:${SCHEDULING_RULES_SOURCE}|${escapeRegExp(SCHEDULING_RULES_REPEAT_LINE)})\\n\\n)?`
  + `(?:(?:${escapeRegExp(CONSENSUS_RULES)}|${escapeRegExp(CONSENSUS_RULES_REPEAT_LINE)})\\n\\n)?`;
const LEADING_HARNESS_GUIDANCE_RE = new RegExp(`^${LEADING_GUIDANCE_SOURCE}`);

/** True when `content` starts with guidance exactly as Harness adds it. */
export function startsWithHarnessGuidance(content: string): boolean {
  const match = LEADING_HARNESS_GUIDANCE_RE.exec(content);
  return match !== null && match[0].trim().length > 0;
}

/**
 * Remove the guidance Harness added in front of a user message, leaving the
 * text the user typed. Text that merely mentions a guidance heading, or has it
 * anywhere but the start, is returned untouched.
 */
export function stripLeadingHarnessGuidance(content: string): string {
  const match = LEADING_HARNESS_GUIDANCE_RE.exec(content);
  return match !== null && match[0].trim().length > 0 ? content.slice(match[0].length) : content;
}

// ── Leading Harness prefix (Step 10, re-import) ──────────────────────────────
//
// A later turn is composed in two layers.
//
// 1. The current turn (`instance-manager.ts` later-turn path): `buildContextBlock`
//    (memory, indexed codebase, retrieved/RLM; `instance-input-contexts.ts`), the
//    active /goal block (`appendActiveGoalContext`), then the guidance above, each
//    joined with a blank line.
// 2. The continuity input queue (`InstanceContinuityInputQueue.prepare`, fed by
//    `queueContinuityPreamble` / `queueContextWarning`) puts what it holds in FRONT
//    of that: one queued continuity preamble, then one context warning, each joined
//    with a blank line. The preamble is either an earlier turn's late context set
//    (`queueDeferredInputContexts`: `buildContextBlock` output, so memory/indexed/
//    retrieved only, never a goal or guidance) or a replay/handoff history
//    (`buildReplayContinuityMessage`, `buildHandoffDocumentFromMessages`). The
//    queue holds one of each, so there are at most two sets.
//
// Plan mode then puts `ultrathink\n\n` in front of the whole thing
// (`applyPlanModeTurnHint`).
//
//   [ultrathink] [history | set] [warning] [set] [guidance] typed text
//
// Each shape below copies its builder's fixed lines; only the retrieved body is
// open. A piece that is not exactly this shape, or that arrives in another
// order or count, ends the match, so text the user typed is never taken for a
// block and nothing after the user's own words is ever removed.
//
// The builders are `formatUnifiedMemoryContextBlock` and `formatRlmContextBlock`
// (`instance-context.ts` and `context-worker-client.ts`),
// `IndexedCodebaseContextService.formatContextBlock` (matched by its marker lines only, see
// below), `buildActiveGoalContext`, `buildReplayContinuityMessage`
// (`session/replay-continuity.ts`), `buildHandoffDocumentFromMessages`
// (`session/handoff-state-service.ts`) and `checkContextWarningThreshold`
// (`instance-communication.ts`). `harness-guidance.spec.ts` and
// `native-user-message.spec.ts` run the real builders and the real queue through
// these matchers.

const MEMORY_GUIDANCE_SKILLS = [
  'This context was added by the app, not typed by the user.',
  'Follow activated skill instructions when relevant.',
  'Treat memory notes as background.',
  'Do not mention this block unless directly asked about injected context.',
].join(' ');
const MEMORY_GUIDANCE_PLAIN = [
  'This context was added by the app, not typed by the user.',
  'Treat it as non-authoritative background and do not mention this block',
  'unless directly asked about injected context.',
].join(' ');

/** Block text between a fixed head and a fixed tail, as the builders emit it. */
function blockPattern(head: string, tail: string): string {
  return `${head}[\\s\\S]*?${tail}`;
}

const MEMORY_BLOCK_SOURCE = blockPattern(
  escapeRegExp('[Orchestrator Memory Context]\nSource: Harness memory retrieval\n')
  + `(?:${escapeRegExp(MEMORY_GUIDANCE_SKILLS)}|${escapeRegExp(MEMORY_GUIDANCE_PLAIN)})\\n`,
  escapeRegExp('\n[End Orchestrator Memory Context]'),
);
// Deliberately loose: the native importer has always dropped any leading indexed block
// by its two marker lines, and transcripts written by older builds use other bodies.
const INDEXED_BLOCK_SOURCE = blockPattern(
  escapeRegExp('[Indexed Codebase Context]'),
  escapeRegExp('[End Indexed Codebase Context]'),
);
const RLM_BLOCK_SOURCE = blockPattern(
  `${escapeRegExp('[Retrieved Context]\nSource: ')}(?:RLM hybrid search|RLM lexical search|RLM semantic search)\\n`,
  escapeRegExp('\n[End Retrieved Context]'),
);
// The replay and handoff builders share their first `Resume mode:` line shape, the
// "already executed" line and the closing two lines; the reason and the transcript
// are the open parts. Both are only matched when the closing lines are present.
const HISTORY_PREAMBLE_SOURCE = blockPattern(
  escapeRegExp('<conversation_history>\nResume mode: ')
  + `(?:${escapeRegExp('replay fallback (')}|${escapeRegExp('maintained handoff document (')})[^\\n]*\\)\\. `
  + escapeRegExp('Native session state was unavailable, so this ')
  + `(?:${escapeRegExp('archived transcript summary')}|${escapeRegExp('incrementally maintained handoff')})`
  + escapeRegExp(' is being provided as context.\n'
    + 'Tool calls and tool results from the earlier conversation were already executed. '
    + 'Do not repeat them unless the user explicitly asks you to rerun something.\n'),
  escapeRegExp('\n</conversation_history>\n'
    + 'Use this as background context for the next reply. Prefer continuing the task over '
    + 'asking the user to repeat information unless critical context is still missing.'),
);
// `percentage` is printed with at most two decimals; `used` and `total` are token counts.
const CONTEXT_WARNING_SOURCE = escapeRegExp('[SYSTEM: Context Usage Warning]\nYour context is at ')
  + '\\d+(?:\\.\\d+)?'
  + escapeRegExp('% capacity (')
  + '\\d+(?:\\.\\d+)?'
  + escapeRegExp(' / ')
  + '\\d+(?:\\.\\d+)?'
  + escapeRegExp(' tokens).\n'
    + 'To avoid hitting the limit:\n'
    + '1. Do NOT read large files directly — spawn child instances for file reading.\n'
    + '2. Use get_child_summary instead of get_child_output for results.\n'
    + '3. Summarize rather than copying full file contents.\n'
    + '[END SYSTEM WARNING]');
/**
 * The goal block is derived from the real builder: the objective is the one open
 * part, so a sentinel objective marks where the fixed head ends and the tail begins.
 */
function goalBlockSource(): string | null {
  const sentinel = '\u0000objective\u0000';
  const sample = buildActiveGoalContext({
    metadata: { goal: { objective: sentinel, status: 'active', createdAt: 0, updatedAt: 0 } },
  });
  const at = sample?.indexOf(sentinel) ?? -1;
  if (!sample || at < 0) return null;
  return blockPattern(escapeRegExp(sample.slice(0, at)), escapeRegExp(sample.slice(at + sentinel.length)));
}

type LeadingPiece = 'history' | 'warning' | 'memory' | 'indexed' | 'retrieved' | 'goal';

interface LeadingMatchers {
  pieces: readonly (readonly [LeadingPiece, RegExp])[];
  guidance: RegExp;
}

/** Order inside one set, as `buildContextBlock` and `appendActiveGoalContext` emit it. */
const SET_RANK: Readonly<Record<'memory' | 'indexed' | 'retrieved' | 'goal', number>> = {
  memory: 0,
  indexed: 1,
  retrieved: 2,
  goal: 3,
};

/** `applyPlanModeTurnHint` (`instance-communication-provider-limit.ts`): in front of everything. */
const PLAN_MODE_HINT = 'ultrathink\n\n';

/**
 * A history preamble can be the whole turn (the CLI trims the trailing blank line when
 * nothing was typed after it); the other pieces always need the blank line, so a block
 * pasted alone is never taken for Harness text.
 */
const HISTORY_END = '(?:\\n\\n|$)';

let leadingMatchers: LeadingMatchers | undefined;

/**
 * Built on first use rather than at module load, so importing this module never
 * calls into the goal builder (callers that only send guidance never need it).
 * Every piece is matched with a sticky regex at the current offset, so no
 * remainder is copied. A piece is always followed by the blank line the join
 * adds. The indexed block also keeps the older, looser `\s*` the native importer
 * has always applied, and consecutive indexed blocks are one piece.
 */
function getLeadingMatchers(): LeadingMatchers {
  if (!leadingMatchers) {
    const goal = goalBlockSource();
    leadingMatchers = {
      pieces: [
        ['history', new RegExp(`\\s*(?:${HISTORY_PREAMBLE_SOURCE})${HISTORY_END}`, 'y')],
        ['warning', new RegExp(`\\s*(?:${CONTEXT_WARNING_SOURCE})\\n\\n`, 'y')],
        ['memory', new RegExp(`\\s*(?:${MEMORY_BLOCK_SOURCE})\\n\\n`, 'y')],
        ['indexed', new RegExp(`\\s*(?:(?:${INDEXED_BLOCK_SOURCE})\\s*)+`, 'y')],
        ['retrieved', new RegExp(`\\s*(?:${RLM_BLOCK_SOURCE})\\n\\n`, 'y')],
        ...(goal ? [['goal', new RegExp(`\\s*(?:${goal})\\n\\n`, 'y')] as const] : []),
      ],
      guidance: new RegExp(LEADING_GUIDANCE_SOURCE, 'y'),
    };
  }
  return leadingMatchers;
}

/**
 * Walks the pieces Harness puts in front of a typed message and says how far the
 * prefix reaches. The grammar is what the queue and the later-turn path really
 * compose: at most one history preamble or earlier set, at most one warning, at
 * most one current set (memory, indexed, retrieved, goal, each in that order and
 * nothing after the goal), then the guidance. The first piece that does not fit
 * ends the walk and is left in the text.
 */
function harnessPrefixLength(content: string): number {
  const { pieces, guidance } = getLeadingMatchers();
  const hintLength = content.startsWith(PLAN_MODE_HINT) ? PLAN_MODE_HINT.length : 0;
  let offset = hintLength;
  let sets = 0; // history preamble or block sets started so far (at most two)
  let rank = -1; // rank of the last block in the open set; -1 when no set is open
  let warned = false;
  let goalSeen = false;
  let any = false;

  walk: for (;;) {
    for (const [piece, matcher] of pieces) {
      matcher.lastIndex = offset;
      const match = matcher.exec(content);
      if (!match) continue;
      if (piece === 'history') {
        if (any) break walk; // only ever the very first piece (the queue's continuity slot)
        sets = 1;
        rank = -1;
      } else if (piece === 'warning') {
        if (warned || goalSeen || sets >= 2) break walk;
        warned = true;
        if (sets === 0) sets = 1; // nothing queued ahead of it, so the next set is the current one
        rank = -1;
      } else {
        const next = SET_RANK[piece];
        if (goalSeen) break walk;
        if (rank >= 0 && next > rank) {
          rank = next; // same set, builder order
        } else if (sets < 2) {
          sets += 1; // a new set: the queued earlier one, then the current one
          rank = next;
        } else {
          break walk;
        }
        goalSeen = piece === 'goal';
      }
      any = true;
      offset += match[0].length;
      continue walk;
    }
    break;
  }

  guidance.lastIndex = offset;
  const end = offset + (guidance.exec(content)?.[0].length ?? 0);
  return content.slice(hintLength, end).trim().length > 0 ? end : 0;
}

/** True when `content` starts with Harness context blocks and/or guidance exactly as Harness adds them. */
export function startsWithHarnessContext(content: string): boolean {
  return harnessPrefixLength(content) > 0;
}

/**
 * Remove everything Harness put in front of a user message: the plan-mode
 * `ultrathink` line, a queued history preamble or earlier context set, a context
 * warning, the current memory, indexed, retrieved and active-goal blocks, then the
 * guidance, each only in its exact builder shape and in the order Harness composes
 * them. The result is the text the user typed, which is what the chat showed when
 * the turn was sent, except that it may lose leading whitespace. Every matcher
 * opens with `\s*` (the guidance matcher too, and it always runs last, matching
 * nothing when no guidance is present), so after a context block the typed text's
 * own leading whitespace is dropped; after guidance it is kept. This is not
 * normalised because the one caller (`extractAuthoredUserMessage`) trims anyway,
 * so do not rely on either behaviour. Text with no Harness prefix is returned
 * untouched, leading whitespace included.
 */
export function stripLeadingHarnessContext(content: string): string {
  return content.slice(harnessPrefixLength(content));
}

interface LatchEntry {
  key: string | undefined;
  sections: Set<HarnessGuidanceSection>;
}

/**
 * Per-instance latch of which guidance sections have been delivered. Keyed by
 * the provider session id: a different id means a new provider conversation
 * (fresh restart, replay fallback and respawn all replace the id), so the set
 * starts empty. In-memory only — after an app restart a section may be added
 * once more.
 */
class HarnessGuidance {
  private latches = new WeakMap<Instance, LatchEntry>();

  takeHarnessGuidance(
    instance: Instance,
    message: string,
    path: 'first-message' | 'later-turn',
  ): HarnessGuidanceHandle {
    const entry = this.entryFor(instance);
    const selection = selectHarnessGuidance(
      message,
      entry.sections,
      new Date(),
      Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    );
    if (!selection.text) {
      return { text: null, commit: () => undefined };
    }
    const { text } = selection;
    let committed = false;
    return {
      text,
      commit: () => {
        // Selection is repeatable (a failed send is selected again, and the
        // pending initial prompt is re-selected before delivery), so the log
        // belongs to the delivery: once per addition that actually went out.
        if (committed) return;
        committed = true;
        for (const section of selection.added) entry.sections.add(section);
        logger.info('Harness guidance added', {
          instanceId: instance.id,
          path,
          added: selection.added,
          repeated: selection.repeated,
          chars: text.length,
        });
      },
    };
  }

  /**
   * The CLI's own session id was adopted for the same conversation — move the
   * latch so the delivery state survives the id change.
   */
  adoptProviderSessionId(instance: Instance, previousId: string | undefined, nextId: string): void {
    const entry = this.latches.get(instance);
    if (entry && entry.key === previousId) {
      entry.key = nextId;
    }
  }

  private entryFor(instance: Instance): LatchEntry {
    const key = instance.providerSessionId;
    const existing = this.latches.get(instance);
    if (existing && existing.key === key) {
      return existing;
    }
    const fresh: LatchEntry = { key, sections: new Set() };
    this.latches.set(instance, fresh);
    return fresh;
  }

  _resetForTesting(): void {
    this.latches = new WeakMap();
  }
}

const harnessGuidance = new HarnessGuidance();

export function getHarnessGuidance(): HarnessGuidance {
  return harnessGuidance;
}

export { HARNESS_GUIDE };
