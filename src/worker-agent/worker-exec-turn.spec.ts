import { describe, expect, it } from 'vitest';
import { blocksWorkerRestart } from './worker-exec-turn';

describe('blocksWorkerRestart', () => {
  it.each([
    ['idle', false],
    ['ready', false],
    ['busy', true],
    ['processing', true],
    ['thinking_deeply', true],
    ['waiting_for_input', true],
  ])('a session reporting %s blocks a restart: %s', (lastStatus, blocks) => {
    expect(blocksWorkerRestart({ lastStatus, adapter: {} })).toBe(blocks);
  });

  it('blocks on an idle-looking session whose adapter still has a turn running', () => {
    expect(blocksWorkerRestart({ lastStatus: 'idle', adapter: { hasActiveTurn: () => true } })).toBe(true);
    expect(blocksWorkerRestart({ lastStatus: 'idle', adapter: { hasActiveTurn: () => false } })).toBe(false);
  });

  it('ignores a session that is no longer there', () => {
    expect(blocksWorkerRestart(undefined)).toBe(false);
  });
});
