import {
  createLoopPendingInput,
  type LoopIteration,
  type LoopState,
} from '../../shared/types/loop.types';

const MAX_ANNOUNCE_THEN_HALT_NUDGES = 2;
const ACTION_VERBS =
  '(?:run|rerun|execute|test|verify|check|inspect|read|open|edit|update|write|create|add|fix|implement|refactor|change|remove|debug|investigate|build|typecheck|lint)';
const FIRST_PERSON_FUTURE_ACTION_RE = new RegExp(
  String.raw`\b(?:i(?:['’]ll|\s+will|\s+(?:am|['’]m)\s+going\s+to|\s+need\s+to)|next\s*,?\s+i(?:['’]ll|\s+will|\s+(?:am|['’]m)\s+going\s+to))\b(?!\s+not\b).{0,140}\b${ACTION_VERBS}\b`,
  'i',
);

export interface AnnounceThenHaltMatch {
  excerpt: string;
}

export function detectAnnounceThenHalt(output: string): AnnounceThenHaltMatch | null {
  const normalized = output.replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  const match = FIRST_PERSON_FUTURE_ACTION_RE.exec(normalized);
  if (!match) return null;
  const before = normalized.slice(0, match.index);
  const previousBoundary = Math.max(before.lastIndexOf('.'), before.lastIndexOf('!'), before.lastIndexOf('?'));
  const nextBoundaryCandidates = ['.', '!', '?']
    .map((token) => normalized.indexOf(token, match.index + match[0].length))
    .filter((index) => index >= 0);
  const nextBoundary = nextBoundaryCandidates.length > 0 ? Math.min(...nextBoundaryCandidates) : normalized.length;
  const start = previousBoundary >= 0 ? previousBoundary + 1 : 0;
  const end = nextBoundary < normalized.length ? nextBoundary + 1 : normalized.length;
  return { excerpt: normalized.slice(start, end).trim().slice(0, 180) };
}

export function maybeQueueAnnounceThenHaltContinuation(
  state: LoopState,
  iteration: LoopIteration,
): boolean {
  if (iteration.stage !== 'IMPLEMENT') return false;
  if (iteration.toolCalls.length > 0 || iteration.filesChanged.length > 0) return false;
  if (iteration.completionSignalsFired.some((signal) => signal.sufficient)) return false;
  if (state.pendingInterventions.length > 0) return false;

  const count = state.announceThenHaltNudgeCount ?? 0;
  if (count >= MAX_ANNOUNCE_THEN_HALT_NUDGES) return false;

  const detected = detectAnnounceThenHalt(iteration.outputFull || iteration.outputExcerpt);
  if (!detected) return false;

  state.announceThenHaltNudgeCount = count + 1;
  state.pendingInterventions.push(createLoopPendingInput(
    [
      'Continue now. You ended the last iteration by announcing the next action instead of executing it.',
      'Execute the required tool calls or file edits now; do not narrate plans without acting.',
      `Announced intent: "${detected.excerpt}"`,
    ].join(' '),
    { kind: 'queue', source: 'announce-then-halt' },
  ));
  return true;
}
