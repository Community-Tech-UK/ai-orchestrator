import { describe, expect, it } from 'vitest';
import { withOpenCodeProcessGate } from './opencode-process-gate';

describe('withOpenCodeProcessGate', () => {
  it('runs OpenCode commands one at a time and releases on failure', async () => {
    const events: string[] = [];
    let finishFirst!: () => void;
    const first = withOpenCodeProcessGate(async () => {
      events.push('first-start');
      await new Promise<void>((resolve) => { finishFirst = resolve; });
      events.push('first-end');
      throw new Error('opencode exited 1');
    });
    const second = withOpenCodeProcessGate(async () => {
      events.push('second-start');
      return 'ok';
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(['first-start']);
    finishFirst();
    await expect(first).rejects.toThrow('opencode exited 1');
    await expect(second).resolves.toBe('ok');
    expect(events).toEqual(['first-start', 'first-end', 'second-start']);
  });
});
