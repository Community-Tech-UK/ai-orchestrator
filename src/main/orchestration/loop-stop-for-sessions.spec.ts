import { describe, expect, it, vi } from 'vitest';
import { stopLoopsForSessions } from './loop-stop-for-sessions';
import type { LoopState } from '../../shared/types/loop.types';

const loop = (id: string, chatId: string, status: LoopState['status'], endedAt: number | null = null) =>
  ({ id, chatId, status, endedAt });

describe('stopLoopsForSessions', () => {
  it('stops running, paused and quota-parked loops only for closing session ids', async () => {
    const cancelLoop = vi.fn(async (_id: string) => true);
    const getActiveLoops = () => [
      loop('running', 's1', 'running'), loop('paused', 's1', 'paused'),
      loop('quota', 's2', 'provider-limit'), loop('chat-owned', 'chat-id', 'running'),
      loop('done', 's1', 'completed'), loop('failed', 's1', 'failed'),
      loop('quota-ended', 's1', 'provider-limit', 100),
    ];
    expect(await stopLoopsForSessions(['s1', 's2', 's1'], { getActiveLoops, cancelLoop })).toBe(3);
    expect(cancelLoop.mock.calls.map(([id]) => id)).toEqual(['running', 'paused', 'quota']);
  });

  it('waits for every cancellation and counts successful stops when another rejects', async () => {
    let release!: (value: boolean) => void;
    const slow = new Promise<boolean>((resolve) => { release = resolve; });
    const cancelLoop = vi.fn((id: string) => {
      if (id === 'reject') return Promise.reject(new Error('cleanup failed'));
      if (id === 'gone') return Promise.resolve(false);
      return slow;
    });
    const getActiveLoops = () => ['reject', 'slow', 'gone'].map((id) => loop(id, 's1', 'paused'));
    let finished = false;
    const stopped = stopLoopsForSessions(['s1'], { getActiveLoops, cancelLoop }).then((count) => {
      finished = true;
      return count;
    });
    await Promise.resolve();
    expect(cancelLoop).toHaveBeenCalledTimes(3);
    expect(finished).toBe(false);
    release(true);
    expect(await stopped).toBe(1);
  });

  it('returns zero when no session is closing', async () => {
    const getActiveLoops = vi.fn(() => []);
    expect(await stopLoopsForSessions([], { getActiveLoops, cancelLoop: vi.fn() })).toBe(0);
    expect(getActiveLoops).not.toHaveBeenCalled();
  });
});
