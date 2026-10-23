import { describe, expect, it } from 'vitest';
import { countUpdateBlockingSessions } from '../cli-update-session-guard';

describe('CLI update session guard', () => {
  it('allows idle and hibernated sessions while counting turns and approvals once', () => {
    expect(countUpdateBlockingSessions([
      { id: 'idle', status: 'idle' },
      { id: 'asleep', status: 'hibernated' },
      { id: 'turn', status: 'busy' },
      { id: 'permission', status: 'waiting_for_permission' },
      { id: 'approval', status: 'idle' },
    ], new Set(['approval', 'turn']))).toBe(3);
  });
});
