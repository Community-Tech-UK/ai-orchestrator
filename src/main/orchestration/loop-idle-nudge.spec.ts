import { describe, expect, it } from 'vitest';
import {
  IDLE_TURN_GRACE_MS,
  MAX_IDLE_NUDGES,
  maybeQueueIdleNotDoneNudge,
  queueQuietTurnNudge,
} from './loop-idle-nudge';
import {
  coercePendingInput,
  defaultLoopConfig,
  type LoopIteration,
  type LoopState,
} from '../../shared/types/loop.types';

function stateFor(over: Partial<LoopState> = {}): LoopState {
  const config = defaultLoopConfig('/tmp/idle-nudge', 'finish the module');
  config.contextStrategy = 'same-session';
  return {
    id: 'loop-1',
    config,
    status: 'running',
    manualReviewOnly: false,
    pendingInterventions: [],
    ...over,
  } as unknown as LoopState;
}

function quietIteration(over: Partial<LoopIteration> = {}): LoopIteration {
  return {
    seq: 3,
    stage: 'IMPLEMENT',
    startedAt: 0,
    endedAt: IDLE_TURN_GRACE_MS + 1_000,
    toolCalls: [],
    filesChanged: [],
    completionSignalsFired: [],
    outputFull: 'Nothing to report.',
    outputExcerpt: 'Nothing to report.',
    ...over,
  } as unknown as LoopIteration;
}

const OPEN = { openLeaves: 3 };

describe('maybeQueueIdleNotDoneNudge (L1)', () => {
  it('queues one nudge on a quiet same-session turn with an open ledger', () => {
    const state = stateFor();

    expect(maybeQueueIdleNotDoneNudge(state, quietIteration(), OPEN)).toBe(true);
    expect(state.pendingInterventions).toHaveLength(1);
    const queued = coercePendingInput(state.pendingInterventions[0]!);
    expect(queued.source).toBe('idle-nudge');
    expect(queued.message).toContain('You are not done');
    expect(queued.message).toContain('3 ledger items are still open');
  });

  // A 500ms turn is a transport failure or a refusal, both of which have their
  // own handling. Nudging there papers over a real fault.
  it('does not treat a turn shorter than the grace window as idle', () => {
    const state = stateFor();
    const short = quietIteration({ startedAt: 0, endedAt: IDLE_TURN_GRACE_MS - 1 });

    expect(maybeQueueIdleNotDoneNudge(state, short, OPEN)).toBe(false);
    expect(state.pendingInterventions).toHaveLength(0);
  });

  it('does not nudge an unsealed iteration', () => {
    const state = stateFor();
    const unsealed = quietIteration({ endedAt: null as unknown as number });

    expect(maybeQueueIdleNotDoneNudge(state, unsealed, OPEN)).toBe(false);
  });

  it('does not nudge when the turn actually did something', () => {
    const state = stateFor();
    const busy = quietIteration({
      filesChanged: [{ path: 'src/app.ts', additions: 1, deletions: 0, contentHash: 'h' }],
    } as Partial<LoopIteration>);

    expect(maybeQueueIdleNotDoneNudge(state, busy, OPEN)).toBe(false);
  });

  it('does not nudge when the turn declared completion', () => {
    const state = stateFor();
    const done = quietIteration({
      completionSignalsFired: [{ id: 'declared-complete', sufficient: true }],
    } as unknown as Partial<LoopIteration>);

    expect(maybeQueueIdleNotDoneNudge(state, done, OPEN)).toBe(false);
  });

  // Telling a child to keep going when there is nothing open invites invented work.
  it('does not nudge when the ledger has nothing open', () => {
    expect(maybeQueueIdleNotDoneNudge(stateFor(), quietIteration(), { openLeaves: 0 })).toBe(false);
  });

  it('never nudges an exec-per-message strategy — there is no live turn to nudge', () => {
    const state = stateFor();
    state.config.contextStrategy = 'fresh-child';

    expect(maybeQueueIdleNotDoneNudge(state, quietIteration(), OPEN)).toBe(false);
  });

  it('never nudges an operator-reviewed loop, which pauses for a human by design', () => {
    const manual = stateFor({ manualReviewOnly: true });
    expect(maybeQueueIdleNotDoneNudge(manual, quietIteration(), OPEN)).toBe(false);

    const operatorReviewed = stateFor();
    operatorReviewed.config.completion.allowOperatorReviewedCompletion = true;
    expect(maybeQueueIdleNotDoneNudge(operatorReviewed, quietIteration(), OPEN)).toBe(false);
  });

  it('does not pile an automated hint on top of active steering', () => {
    const state = stateFor();
    state.pendingInterventions.push({
      id: 'p1', kind: 'queue', message: 'do this instead', enqueuedAt: 0, source: 'human',
    });

    expect(maybeQueueIdleNotDoneNudge(state, quietIteration(), OPEN)).toBe(false);
    expect(state.pendingInterventions).toHaveLength(1);
  });

  it('nudges at most once per iteration', () => {
    const state = stateFor();
    const iteration = quietIteration();

    expect(maybeQueueIdleNotDoneNudge(state, iteration, OPEN)).toBe(true);
    state.pendingInterventions = [];
    expect(maybeQueueIdleNotDoneNudge(state, iteration, OPEN)).toBe(false);
  });

  it('is bounded per run so a stuck child cannot burn the cap on nudges', () => {
    const state = stateFor();
    for (let i = 0; i < MAX_IDLE_NUDGES; i += 1) {
      expect(maybeQueueIdleNotDoneNudge(state, quietIteration({ seq: i }), OPEN)).toBe(true);
      state.pendingInterventions = [];
    }
    expect(maybeQueueIdleNotDoneNudge(state, quietIteration({ seq: 99 }), OPEN)).toBe(false);
  });
});

describe('queueQuietTurnNudge (L1)', () => {
  it('prefers the announce-then-halt diagnosis when the child named its next action', () => {
    const state = stateFor();
    const announced = quietIteration({
      outputFull: "Good progress. Next I'll run the tests to confirm.",
      outputExcerpt: "Good progress. Next I'll run the tests to confirm.",
    });

    expect(queueQuietTurnNudge(state, announced, OPEN)).toBe(true);
    expect(coercePendingInput(state.pendingInterventions[0]!).source).toBe('announce-then-halt');
  });

  it('falls back to the idle nudge for an ordinary quiet turn', () => {
    const state = stateFor();

    expect(queueQuietTurnNudge(state, quietIteration(), OPEN)).toBe(true);
    expect(coercePendingInput(state.pendingInterventions[0]!).source).toBe('idle-nudge');
  });

  it('queues nothing when neither diagnosis applies', () => {
    const state = stateFor();

    expect(queueQuietTurnNudge(state, quietIteration(), { openLeaves: 0 })).toBe(false);
    expect(state.pendingInterventions).toHaveLength(0);
  });
});
