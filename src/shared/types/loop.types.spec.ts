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

  it('defaults the token cap to one million tokens', () => {
    const config = defaultLoopConfig('/tmp/project', 'finish the backlog');

    expect(config.caps.maxTokens).toBe(1_000_000);
  });

  it('defaults the cost cap to 200 dollars', () => {
    const config = defaultLoopConfig('/tmp/project', 'finish the backlog');

    expect(config.caps.maxCostCents).toBe(20_000);
  });
});
