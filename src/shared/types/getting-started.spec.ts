/**
 * UX5 — the cases that matter are the ones where the bar must be WRONG-proof:
 * it must not tell a working installation it is unconfigured, and it must
 * disappear rather than linger once there is nothing left to do.
 */
import { describe, expect, it } from 'vitest';

import {
  buildGettingStarted,
  gettingStartedCounter,
  type GettingStartedInput,
} from './getting-started';

function input(over: Partial<GettingStartedInput> = {}): GettingStartedInput {
  return {
    providerAnyStatus: 'unavailable',
    defaultWorkingDirectory: '',
    hasEverStartedSession: false,
    ...over,
  };
}

describe('buildGettingStarted', () => {
  it('offers three steps', () => {
    expect(buildGettingStarted(input()).total).toBe(3);
  });

  it('counts nothing done on a fresh install', () => {
    const state = buildGettingStarted(input());
    expect(state.completed).toBe(0);
    expect(state.visible).toBe(true);
  });

  it('counts a provider as connected only when the aggregate says ready', () => {
    expect(buildGettingStarted(input({ providerAnyStatus: 'ready' })).completed).toBe(1);
  });

  /**
   * The bug this reducer shipped with, and the reason it reads the aggregate.
   *
   * A first version read every `provider`-category check and treated `degraded`
   * as "installed with a caveat". `capability-probe.ts` assigns `degraded` to a
   * provider that is NOT ON PATH, and probes five providers unconditionally —
   * so a machine with no CLI at all produced five `degraded` checks and the
   * step was permanently "done". These are the statuses that install really
   * emits; the step must be undone for it.
   */
  it('is not fooled by a zero-CLI install, which reports every provider degraded', () => {
    // `provider.any` is `unavailable` because no individual check is `ready`.
    expect(buildGettingStarted(input({ providerAnyStatus: 'unavailable' })).completed).toBe(0);
  });

  it('does not count a degraded aggregate as connected', () => {
    expect(buildGettingStarted(input({ providerAnyStatus: 'degraded' })).completed).toBe(0);
  });

  it('counts a working directory only when it is really set', () => {
    expect(buildGettingStarted(input({ defaultWorkingDirectory: '   ' })).completed).toBe(0);
    expect(buildGettingStarted(input({ defaultWorkingDirectory: '/tmp/p' })).completed).toBe(1);
  });

  it('counts a session that has ever been started', () => {
    expect(buildGettingStarted(input({ hasEverStartedSession: true })).completed).toBe(1);
  });

  it('puts pending steps first', () => {
    const state = buildGettingStarted(input({ providerAnyStatus: 'ready' }));
    expect(state.steps[state.steps.length - 1]?.id).toBe('provider-available');
    expect(state.steps[0]?.done).toBe(false);
  });

  /** The spec asks for a surface that unmounts, not one more thing to dismiss. */
  it('disappears once every step is done', () => {
    const state = buildGettingStarted({
      providerAnyStatus: 'ready',
      defaultWorkingDirectory: '/tmp/p',
      hasEverStartedSession: true,
    });
    expect(state.completed).toBe(3);
    expect(state.visible).toBe(false);
  });

  /**
   * The load-bearing one. Before the startup report arrives there are no
   * provider statuses, and a configured install would be told "0 of 3" for the
   * first second after launch — a confident wrong answer, on the one surface
   * whose whole value is being believed.
   */
  it('stays hidden until the startup report has actually arrived', () => {
    const state = buildGettingStarted(input({
      providerAnyStatus: null,
      defaultWorkingDirectory: '/tmp/p',
      hasEverStartedSession: true,
    }));
    expect(state.visible).toBe(false);
  });

  it('every step says what doing it gets you', () => {
    for (const step of buildGettingStarted(input()).steps) {
      expect(step.detail.length).toBeGreaterThan(30);
    }
  });
});

describe('gettingStartedCounter', () => {
  it('reads as an N of M counter', () => {
    expect(gettingStartedCounter(buildGettingStarted(input({ providerAnyStatus: 'ready' }))))
      .toBe('1 of 3 done');
  });

  it('counts zero without pretending otherwise', () => {
    expect(gettingStartedCounter(buildGettingStarted(input()))).toBe('0 of 3 done');
  });
});
