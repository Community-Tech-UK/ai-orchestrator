/**
 * N12 — "while you were away", built from the loop store and nothing else.
 *
 * Zero LLM calls, by requirement and by good sense: a recap you cannot trust is
 * worse than no recap, and every number here is already recorded. Summarising
 * settled facts with a model would add cost, latency and the chance of a
 * confident wrong sentence about what happened overnight.
 */

import type { LoopRunSummary } from '../../shared/types/loop-stream.types';
import { isTerminalLoopRuntimeStatus } from './loop-runtime-status';

/** Outcome classes, ordered by how much they want a human. */
export type AwayOutcome = 'needs-you' | 'stopped-short' | 'finished';

export interface AwayRunCard {
  runId: string;
  goal: string;
  outcome: AwayOutcome;
  status: string;
  iterations: number;
  durationMs: number;
  costCents: number;
  outstandingCount: number;
  endReason: string | null;
}

export interface AwayRecap {
  /** Cards, most-wanting-attention first. */
  cards: AwayRunCard[];
  finished: number;
  stoppedShort: number;
  needsYou: number;
  totalCostCents: number;
  /** One-line summary safe to put in a notification or a header. */
  headline: string;
}

const MAX_GOAL_CHARS = 100;

/** Ended without converging. Distinct from an error and from a clean finish. */
const STOPPED_SHORT: ReadonlySet<string> = new Set([
  'no-progress',
  'cap-reached',
  'cost-exceeded',
  'provider-limit',
]);

const OUTCOME_ORDER: Record<AwayOutcome, number> = {
  'needs-you': 0,
  'stopped-short': 1,
  finished: 2,
};

function clip(text: string, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return 'Untitled run';
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function classifyAwayOutcome(run: LoopRunSummary): AwayOutcome {
  if (run.status === 'completed') return 'finished';
  if (STOPPED_SHORT.has(run.status)) return 'stopped-short';
  // Everything else terminal — error, failed, needs-review, arbitration,
  // reviewer-unreliable — wants a person. `completed-needs-review` is a
  // SUCCESS state, but it is still asking for a human, which is the axis
  // this recap sorts on.
  return 'needs-you';
}

export interface AwayRecapInput {
  runs: readonly LoopRunSummary[];
  /** Only runs that ended at or after this are reported. */
  awaySince: number;
  now: number;
}

export function buildAwayRecap(input: AwayRecapInput): AwayRecap | null {
  const ended = input.runs.filter((run) =>
    run.endedAt !== null
    && run.endedAt >= input.awaySince
    && run.endedAt <= input.now
    && isTerminalLoopRuntimeStatus(run.status));

  if (ended.length === 0) return null;

  const cards: AwayRunCard[] = ended
    .map((run) => ({
      runId: run.id,
      goal: clip(run.initialPrompt, MAX_GOAL_CHARS),
      outcome: classifyAwayOutcome(run),
      status: run.status,
      iterations: run.totalIterations,
      durationMs: Math.max(0, (run.endedAt ?? input.now) - run.startedAt),
      costCents: run.totalCostCents,
      outstandingCount: run.openOutstandingCount ?? 0,
      endReason: run.endReason,
    }))
    .sort((a, b) => OUTCOME_ORDER[a.outcome] - OUTCOME_ORDER[b.outcome]
      || b.durationMs - a.durationMs);

  const needsYou = cards.filter((c) => c.outcome === 'needs-you').length;
  const stoppedShort = cards.filter((c) => c.outcome === 'stopped-short').length;
  const finished = cards.filter((c) => c.outcome === 'finished').length;
  const totalCostCents = cards.reduce((sum, c) => sum + c.costCents, 0);

  // Lead with what needs a person. "3 runs finished" is a worse first sentence
  // than "1 needs you" when both are true.
  const parts: string[] = [];
  if (needsYou > 0) parts.push(`${needsYou} need${needsYou === 1 ? 's' : ''} you`);
  if (stoppedShort > 0) parts.push(`${stoppedShort} stopped short`);
  if (finished > 0) parts.push(`${finished} finished`);

  return {
    cards,
    finished,
    stoppedShort,
    needsYou,
    totalCostCents,
    headline: `${cards.length} loop run${cards.length === 1 ? '' : 's'} ended: ${parts.join(', ')}.`,
  };
}
