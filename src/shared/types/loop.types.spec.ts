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

  it('defaults the estimated cost cap to unbounded', () => {
    const config = defaultLoopConfig('/tmp/project', 'finish the backlog');

    expect(config.caps.maxCostCents).toBeNull();
  });
});
