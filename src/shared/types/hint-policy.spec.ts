import { describe, expect, it } from 'vitest';

import {
  COST_HIDDEN_BUSY_THRESHOLD,
  HINTS,
  shouldHintCostHiddenWhileBusy,
  shouldHintProviderLimitResumeOff,
  shouldHintQueuedWhileLooping,
  shouldHintToolLoopAutoInterruptOff,
  shouldShowHint,
  type HintId,
  withDismissed,
} from './hint-policy';

describe('shouldShowHint (UX5)', () => {
  it('shows a relevant, undismissed hint', () => {
    expect(shouldShowHint({
      id: 'loop-config-first-open', dismissed: [], condition: true,
    })).toEqual({ show: true });
  });

  /** Dismissed means gone for good; a hint that returns is an advert. */
  it('never returns after dismissal', () => {
    expect(shouldShowHint({
      id: 'loop-config-first-open', dismissed: ['loop-config-first-open'], condition: true,
    })).toEqual({ show: false, reason: 'dismissed' });
  });

  /**
   * Not-yet-relevant is different from dismissed: the hint stays eligible, so
   * it can appear later when the behaviour actually earns it.
   */
  it('withholds a hint whose moment has not arrived, without burning it', () => {
    const decision = shouldShowHint({
      id: 'settings-overview-profiles', dismissed: [], condition: false,
    });
    expect(decision).toEqual({ show: false, reason: 'condition-not-met' });
    expect(shouldShowHint({
      id: 'settings-overview-profiles', dismissed: [], condition: true,
    }).show).toBe(true);
  });

  it('refuses an unknown id rather than rendering an empty box', () => {
    expect(shouldShowHint({
      id: 'not-a-hint' as HintId, dismissed: [], condition: true,
    })).toEqual({ show: false, reason: 'unknown-hint' });
  });
});

describe('withDismissed', () => {
  it('records a dismissal', () => {
    expect(withDismissed([], 'loop-config-first-open')).toEqual(['loop-config-first-open']);
  });

  /** Dismissing twice should not cost a settings round trip. */
  it('returns the same reference when already dismissed', () => {
    const existing = ['loop-config-first-open'];
    expect(withDismissed(existing, 'loop-config-first-open')).toBe(existing);
  });

  it('keeps earlier dismissals', () => {
    expect(withDismissed(['a'], 'settings-overview-profiles'))
      .toEqual(['a', 'settings-overview-profiles']);
  });
});

describe('hint copy', () => {
  it('every hint says something specific enough to be worth the space', () => {
    for (const [id, copy] of Object.entries(HINTS)) {
      expect(copy.id, id).toBe(id);
      expect(copy.title.length, id).toBeGreaterThan(10);
      expect(copy.body.length, id).toBeGreaterThan(40);
    }
  });
});

describe('UX5 predicates', () => {
  describe('shouldHintQueuedWhileLooping', () => {
    it('fires only when something is queued AND a loop is running', () => {
      expect(shouldHintQueuedWhileLooping(1, true)).toBe(true);
    });

    it('stays silent on an ordinary queued message', () => {
      // The composer's normal "sends at the end of this turn" model is correct
      // here, so advice would be noise.
      expect(shouldHintQueuedWhileLooping(1, false)).toBe(false);
    });

    it('stays silent for a loop with nothing queued', () => {
      expect(shouldHintQueuedWhileLooping(0, true)).toBe(false);
    });
  });

  describe('shouldHintProviderLimitResumeOff', () => {
    it('fires for a parked run with self-resume off', () => {
      expect(shouldHintProviderLimitResumeOff('provider-limit', null, false)).toBe(true);
    });

    it('stays silent when recovery is already on', () => {
      expect(shouldHintProviderLimitResumeOff('provider-limit', null, true)).toBe(false);
    });

    /** `endedAt` set means the provider-limit state is terminal — past helping. */
    it('stays silent once the run has ended', () => {
      expect(shouldHintProviderLimitResumeOff('provider-limit', 123, false)).toBe(false);
    });

    it('stays silent for any other status', () => {
      expect(shouldHintProviderLimitResumeOff('running', null, false)).toBe(false);
      expect(shouldHintProviderLimitResumeOff('paused', null, false)).toBe(false);
    });
  });

  describe('shouldHintToolLoopAutoInterruptOff', () => {
    it('fires while a loop is live and nothing will stop it', () => {
      expect(shouldHintToolLoopAutoInterruptOff(true, false)).toBe(true);
    });

    it('stays silent when auto-interrupt will handle it', () => {
      expect(shouldHintToolLoopAutoInterruptOff(true, true)).toBe(false);
    });

    it('stays silent with no live alert', () => {
      expect(shouldHintToolLoopAutoInterruptOff(false, false)).toBe(false);
    });
  });
  describe('shouldHintCostHiddenWhileBusy', () => {
    it('fires when several sessions are busy and cost is hidden', () => {
      expect(shouldHintCostHiddenWhileBusy(COST_HIDDEN_BUSY_THRESHOLD, false)).toBe(true);
    });

    it('stays silent while cost is on show, however busy', () => {
      expect(shouldHintCostHiddenWhileBusy(20, true)).toBe(false);
    });

    /** One or two is an ordinary session someone is watching. */
    it('stays silent below the threshold', () => {
      expect(shouldHintCostHiddenWhileBusy(COST_HIDDEN_BUSY_THRESHOLD - 1, false)).toBe(false);
    });

    it('stays silent with nothing running', () => {
      expect(shouldHintCostHiddenWhileBusy(0, false)).toBe(false);
    });
  });
  /**
   * The copy makes a claim about where spend is and is not visible, and that
   * claim was wrong once — it said "anywhere in the app" while the Costs &
   * Usage page still renders per-session cost. This pins the corrected scope
   * so the overstatement cannot come back unnoticed.
   */
  describe('cost-hidden-while-busy copy is scoped to what is actually hidden', () => {
    const copy = HINTS['cost-hidden-while-busy'];

    it('does not claim spend is hidden everywhere', () => {
      expect(copy.body).not.toContain('anywhere in the app');
    });

    it('points at the surface that still shows it', () => {
      expect(copy.action).toContain('Costs & Usage');
    });

    /**
     * `context-bar` reads `showCost`, but its only mount hardcodes
     * `[showCost]="false"`, and `token-counter` is unmounted — so the sidebar
     * total is the one visible thing this toggle changes. Claiming per-session
     * views would be the same overstatement one narrowing smaller.
     */
    it('claims only the sidebar total, which is all the setting really gates', () => {
      expect(copy.body).toContain('sidebar total');
      expect(copy.body).not.toContain('per-session');
    });
  });

  /**
   * The panel this hint is mounted on states the cap rule correctly a few
   * sections down. An earlier version of the hint said "Caps add one wrap-up
   * turn on top" unconditionally, contradicting that copy on the same screen —
   * and contradicting the coordinator, where a cost cap stops immediately
   * because another full turn would overshoot the budget that just stopped it.
   */
  describe('loop-config-first-open states the cap rule the coordinator actually follows', () => {
    const copy = HINTS['loop-config-first-open'];

    /**
     * Two drafts were wrong here, each narrower than the last, so this asserts
     * the hint makes NO wrap-up promise at all. Whether a cap gets a wrap-up
     * turn depends on the cap kind AND `capWrapUpIteration` AND the provider
     * enforcing the tools-disable (`loop-pre-iteration-guard.ts`) — today only
     * Claude, one of seven providers. That rule does not fit in a first-open
     * hint, and every attempt to compress it produced a false sentence.
     */
    it('makes no wrap-up promise it cannot keep', () => {
      expect(copy.body).not.toContain('wrap-up');
      expect(copy.body).not.toContain('stops immediately');
    });

    it('still says the thing that is unconditionally true — a cap ends the run', () => {
      expect(copy.body).toContain('a cap ends the run');
    });

    /**
     * The other half of the same sentence was wrong for the same reason: it
     * claimed a loop repeats "until your verify command passes and the
     * completion gate clears", full stop. Operator-reviewed completion — a
     * checkbox on the very panel this hint is mounted on — ends the run when a
     * human clicks Accept as complete, with neither verify nor the gate
     * involved (`loop-verify-command.ts` resolves it as its own authority).
     */
    it('does not claim verify plus the gate is the only way a loop ends', () => {
      expect(copy.body).toContain('operator-reviewed completion');
    });

    it('still names the automatic path, which is the common one', () => {
      expect(copy.body).toContain('completion gate clears');
    });

    /**
     * Acceptance is not the only ending — `failed`, `error`, `no-progress` and
     * `needs-human-arbitration` are all terminal. The sentence deliberately does
     * NOT enumerate them; enumerating is the move that produced every earlier
     * false claim in this entry. It makes the weaker "it can also stop before
     * then", which cannot be wrong.
     */
    it('does not imply acceptance is the only way a run ends', () => {
      expect(copy.body).toContain('can also stop before then');
    });
  });

  /**
   * The detector has three kinds (`doom-loop-detector.ts`: `repeat-no-progress`,
   * `ping-pong`, `runaway`), all of which escalate to critical independently and
   * all of which fire this hint. Describing only the first was accurate for a
   * third of the cases it appears in.
   */
  describe('tool-loop-auto-interrupt-off covers every detector kind', () => {
    const copy = HINTS['tool-loop-auto-interrupt-off'];

    it('does not describe only the repeat-no-progress case', () => {
      expect(copy.body).not.toContain('A tool call is repeating');
    });

    it('names the condition in terms that hold for all three detectors', () => {
      expect(copy.body).toContain('stuck in a tool loop');
    });
  });
});
