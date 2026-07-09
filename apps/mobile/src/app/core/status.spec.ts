import { describe, expect, it } from 'vitest';
import {
  displayStatusColor,
  displayStatusLabel,
  isLiveActivityCandidate,
  isWorkingOrLooping,
  liveActivityStatusLabel,
} from './status';

describe('loop-aware session status display', () => {
  it('treats idle looping sessions as active loop sessions', () => {
    const session = { status: 'idle', isLooping: true };

    expect(displayStatusLabel(session)).toBe('loop');
    expect(displayStatusColor(session)).toBe('#a78bfa');
    expect(isWorkingOrLooping(session)).toBe(true);
    expect(isLiveActivityCandidate(session)).toBe(true);
    expect(liveActivityStatusLabel(session)).toBe('looping');
  });

  it('keeps attention states ahead of loop state', () => {
    const session = { status: 'waiting_for_permission', isLooping: true };

    expect(displayStatusLabel(session)).toBe('waiting for permission');
    expect(displayStatusColor(session)).toBe('var(--accent-attention)');
    expect(isLiveActivityCandidate(session)).toBe(true);
    expect(liveActivityStatusLabel(session)).toBe('needs approval');
  });

  it('keeps normal working sessions active without a loop flag', () => {
    const session = { status: 'busy' };

    expect(displayStatusLabel(session)).toBe('busy');
    expect(displayStatusColor(session)).toBe('var(--accent-action)');
    expect(isWorkingOrLooping(session)).toBe(true);
    expect(isLiveActivityCandidate(session)).toBe(true);
    expect(liveActivityStatusLabel(session)).toBe('working');
  });
});
