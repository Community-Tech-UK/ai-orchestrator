import { describe, expect, it, vi } from 'vitest';
import { pauseLoopForDeclinedPermission } from '../loop-declined-permission-pause';

function coordinator(loops: { id: string; chatId?: string; status?: string }[], pauseResult = true) {
  return { getActiveLoops: () => loops, pauseLoop: vi.fn().mockReturnValue(pauseResult) };
}

describe('pauseLoopForDeclinedPermission', () => {
  it('pauses the running loop on that session and no other', () => {
    const target = coordinator([
      { id: 'other', chatId: 'instance-2', status: 'running' },
      { id: 'mine', chatId: 'instance-1', status: 'running' },
    ]);
    expect(pauseLoopForDeclinedPermission('instance-1', () => target)).toBe(true);
    expect(target.pauseLoop).toHaveBeenCalledExactlyOnceWith('mine');
  });

  it('leaves a loop that is not running, and a session with no loop, alone', () => {
    const target = coordinator([{ id: 'parked', chatId: 'instance-1', status: 'paused' }]);
    expect(pauseLoopForDeclinedPermission('instance-1', () => target)).toBe(false);
    expect(pauseLoopForDeclinedPermission('instance-9', () => target)).toBe(false);
    expect(target.pauseLoop).not.toHaveBeenCalled();
  });

  it('does not throw when the coordinator fails, so the written decision stands', () => {
    expect(pauseLoopForDeclinedPermission('instance-1', () => { throw new Error('not ready'); })).toBe(false);
  });
});
