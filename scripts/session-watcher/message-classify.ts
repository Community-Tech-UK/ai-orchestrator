import type { InternalInputSource } from '../../src/shared/types/input-provenance.types';

/**
 * Tells what a person typed from what the app wrote, for Claude Code
 * transcripts. Same patterns the evidence analysis used (they live in the
 * script, not in production code).
 */

const AUTO_PATTERNS: Array<[string, RegExp]> = [
  ['harness_internal_message', /^<harness_internal_message\b/],
  ['continue-now-announcing', /^Continue now\. You ended the last turn by announcing/],
  ['automatic-check-in', /^Automatic check-in:/],
  ['harness-answers-questions', /^Harness answers questions like/],
  ['orchestrator-response', /^\[Orchestrator Response\]/],
  ['system-bracket', /^\[System:/],
  ['session-reopened', /^Your session was stopped and has now been reopened/],
  ['task-notification', /^<task-notification>/],
  ['system-reminder-only', /^<system-reminder>[\s\S]*<\/system-reminder>$/],
  ['request-interrupted', /^\[Request interrupted/],
  ['loop-mode-prompt', /^# Loop Mode/],
  ['loop-context', /^\[Loop context\]/],
  ['conversation-history-resume', /^<conversation_history>/],
  ['session-continued-summary', /^This session is being continued from a previous/],
  ['slash-command-wrapper', /^<(?:local-command-|command-name>|command-message>)/],
];
const BRIEF_RE = /^(?:#{1,3} |You are |Review this change|Verify |<[a-z_-]+>)/;

const KNOWN_SOURCES: readonly InternalInputSource[] = [
  'global-pause-note', 'global-pause-resume', 'context-policy', 'async-work-continuation',
  'announce-then-halt-continuation', 'continue-question-reply', 'waiting-check-in', 'crash-turn-continuation',
  'reasoning-collapse-continuation', 'content-filter-continuation', 'orchestrator-status-request',
  'child-announcement', 'lsp-feedback', 'compaction-continuity', 'plan-queue', 'reaction', 'browser-gateway',
  'provider-limit-resume', 'orchestrator-response', 'parent-agent-message',
];

const SOURCE_BY_PATTERN: Record<string, InternalInputSource> = {
  'continue-now-announcing': 'announce-then-halt-continuation',
  'automatic-check-in': 'waiting-check-in',
  'harness-answers-questions': 'continue-question-reply',
  'orchestrator-response': 'orchestrator-response',
  'session-reopened': 'crash-turn-continuation',
  'task-notification': 'async-work-continuation',
  'session-continued-summary': 'compaction-continuity',
  'conversation-history-resume': 'compaction-continuity',
};

/** The app prepends context blocks and reminders to typed messages; this removes them. */
export function stripInjected(text: string): string {
  let s = text.replace(/\[(?:Indexed Codebase|Retrieved|Orchestrator Memory)[A-Za-z ]* Context\][\s\S]*?\[End [A-Za-z ]+ Context\]/g, '');
  const ends = [
    '(If this message is not actually about scheduling, ignore this note and do not create anything.)',
    '(If this message does not actually warrant consensus, ignore this note.)',
  ];
  for (let guard = 0; guard < 3 && s.trimStart().startsWith('> **Reminder'); guard += 1) {
    let cut = -1;
    for (const end of ends) {
      const at = s.indexOf(end);
      if (at >= 0 && (cut < 0 || at + end.length < cut)) cut = at + end.length;
    }
    if (cut < 0) break;
    s = s.slice(cut).trimStart();
  }
  return s.trim();
}

export type UserLineClass =
  | { kind: 'person'; text: string }
  | { kind: 'app'; pattern: string; source: InternalInputSource };

/** `rawLength` is the length before stripping, used by the long-brief rule. */
export function classifyUserText(raw: string): UserLineClass {
  const clean = stripInjected(raw);
  for (const [name, re] of AUTO_PATTERNS) {
    if (!re.test(clean)) continue;
    let source: InternalInputSource = SOURCE_BY_PATTERN[name] ?? 'orchestrator-response';
    if (name === 'harness_internal_message') {
      const declared = clean.match(/source="([^"]+)"/)?.[1];
      const known = KNOWN_SOURCES.find((candidate) => candidate === declared);
      if (known) source = known;
    }
    return { kind: 'app', pattern: name, source };
  }
  if (raw.length > 1500 && clean.length > 1500 && BRIEF_RE.test(clean)) {
    return { kind: 'app', pattern: 'long-structured-brief', source: 'orchestrator-response' };
  }
  return { kind: 'person', text: clean };
}

const NUDGE_CORE = '(?:go with your recommendations|go with your recommendation|continue|carry on|go ahead|proceed|yes|yeah|yep|yup|yes please|please|do it|do that|do them|do these|do both|do all|do all of it|do all of them|do all those things|do all of these things|keep going|go on|go for it|ok|okay|sure|next|finish it|finish|all|all of them|all of it|crack on|good|great|go|then|now|thanks|thank you|and|to both|both|too|those|these|that|it|them|things|of|next steps|you can|the next step|start|lets go|lets do it|nice|perfect|fine|right|alright|correct|approved|approve|you do it|do those|do those things)';
const NUDGE_RE = new RegExp(`^(?:${NUDGE_CORE}(?: |$))+$`);
const NUDGE_ACTION = /\b(continue|carry on|go ahead|proceed|yes|yeah|yep|yup|do it|do that|do them|do these|do both|do all|keep going|go on|go for it|ok|okay|sure|next|finish|all|crack on|go|start|lets go|lets do it|alright|correct|approved|approve|recommendations|you do it)\b/;

/** A message of at most 80 characters made only of continue-words ("yes", "go ahead", "carry on"). */
export function isBareGoAhead(text: string): boolean {
  const t = stripInjected(text);
  if (t.length === 0 || t.length > 80) return false;
  const norm = t.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  return norm.length > 0 && NUDGE_RE.test(norm) && NUDGE_ACTION.test(norm);
}
