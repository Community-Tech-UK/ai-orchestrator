import { describe, expect, it } from 'vitest';
import { defaultLoopConfig } from './loop.types';

describe('defaultLoopConfig', () => {
  it('defaults loop iterations to fresh child contexts', () => {
    const config = defaultLoopConfig('/tmp/project', 'finish the backlog');

    expect(config.contextStrategy).toBe('fresh-child');
  });

  it('defaults the iteration cap to null for unbounded loops', () => {
    const config = defaultLoopConfig('/tmp/project', 'finish the backlog');

    expect(config.caps.maxIterations).toBeNull();
  });
});
