import { describe, expect, it } from 'vitest';
import { defaultLoopConfig } from './loop.types';

describe('defaultLoopConfig', () => {
  it('defaults loop iterations to same-session context reuse', () => {
    const config = defaultLoopConfig('/tmp/project', 'finish the backlog');

    expect(config.contextStrategy).toBe('same-session');
  });

  it('defaults the iteration cap to 50 iterations', () => {
    const config = defaultLoopConfig('/tmp/project', 'finish the backlog');

    expect(config.caps.maxIterations).toBe(50);
  });

  it('defaults the token cap to unbounded (iteration/wall-time caps govern)', () => {
    const config = defaultLoopConfig('/tmp/project', 'finish the backlog');

    expect(config.caps.maxTokens).toBeNull();
  });

  it('WS6: defaults the estimated cost cap to 3,000 cents ($30)', () => {
    const config = defaultLoopConfig('/tmp/project', 'finish the backlog');

    expect(config.caps.maxCostCents).toBe(3_000);
    // WS6: new loops are finite by default — 30 turns per iteration.
    expect(config.maxTurnsPerIteration).toBe(30);
  });
});
