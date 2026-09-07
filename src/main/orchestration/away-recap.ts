/**
 * N12 — "while you were away", built from the loop store and nothing else.
 *
 * Zero LLM calls, by requirement and by good sense: a recap you cannot trust is
 * worse than no recap, and every number here is already recorded. Summarising
 * settled facts with a model would add cost, latency and the chance of a
 * confident wrong sentence about what happened overnight.
 */

import type { LoopRunSummary } from '../../shared/types/loop-stream.types';
import { summariseAwayCards } from '../../shared/types/away-recap-summary';
import { isTerminalLoopRuntimeStatus } from './loop-runtime-status';

// Sorting, counting and the headline sentence live in `away-recap-summary.ts`
// so the renderer can reuse them verbatim when it merges two recaps together.
export type {
  AwayOutcome,
  AwayRunCard,
  AwayRecap,
} from '../../shared/types/away-recap-summary';
import type {
  AwayOutcome,
  AwayRunCard,
  AwayRecap,
} from '../../shared/types/away-recap-summary';

const MAX_GOAL_CHARS = 100;

/** Ended without converging. Distinct from an error and from a clean finish. */
const STOPPED_SHORT: ReadonlySet<string> = new Set([
  'no-progress',
  'cap-reached',
  'cost-exceeded',
  'provider-limit',
]);

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

  const cards: AwayRunCard[] = ended.map((run) => ({
    runId: run.id,
    goal: clip(run.initialPrompt, MAX_GOAL_CHARS),
    outcome: classifyAwayOutcome(run),
    status: run.status,
    iterations: run.totalIterations,
    durationMs: Math.max(0, (run.endedAt ?? input.now) - run.startedAt),
    costCents: run.totalCostCents,
    outstandingCount: run.openOutstandingCount ?? 0,
    endReason: run.endReason,
  }));

  return summariseAwayCards(cards);
}
