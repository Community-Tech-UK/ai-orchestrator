import { describe, expect, it } from 'vitest';
import { ClaudeNativeHelpers } from './claude-native-helpers';

describe('native helper tracking resource bounds', () => {
  it('bounds live identities and accepts new work after the bounded set finishes', () => {
    const helpers = new ClaudeNativeHelpers();
    for (let index = 0; index < 10_001; index++) helpers.observe({ type: 'system', subtype: 'task_started',
      task_type: 'local_agent', task_id: `helper-${index}` });
    expect(helpers.summary.running).toBe(10_000);
    helpers.finishTurn();
    expect(helpers.summary.running).toBe(0);
    helpers.observe({ type: 'system', subtype: 'task_started', task_type: 'local_agent', task_id: 'next-turn-helper' });
    expect(helpers.summary.running).toBe(1);
  });
});
