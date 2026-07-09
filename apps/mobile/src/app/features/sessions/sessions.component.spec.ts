import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import {
  SESSION_PAGE_SIZE,
  nextSessionsPageSize,
  sessionChipForRow,
  sessionsShowMoreLabel,
} from './sessions.component';

describe('sessions pagination controls', () => {
  it('advertises the next page size instead of implying every hidden session will load', () => {
    expect(nextSessionsPageSize(124)).toBe(SESSION_PAGE_SIZE);
    expect(sessionsShowMoreLabel(124)).toBe('Show 10 more (124 remaining)');
  });

  it('uses the remaining count when fewer than a full page is hidden', () => {
    expect(nextSessionsPageSize(4)).toBe(4);
    expect(sessionsShowMoreLabel(4)).toBe('Show 4 more');
  });
});

describe('session row status chip', () => {
  it('shows loop state for live looping sessions before the generic status label', () => {
    expect(sessionChipForRow({
      live: true,
      isLooping: true,
      status: 'idle',
      pendingApprovalCount: 0,
    })).toEqual({ kind: 'loop', label: 'Loop' });
  });

  it('keeps approval and past-session chips ahead of loop state', () => {
    expect(sessionChipForRow({
      live: true,
      isLooping: true,
      status: 'waiting_for_permission',
      pendingApprovalCount: 1,
    })).toEqual({ kind: 'attention', label: 'Awaiting approval' });

    expect(sessionChipForRow({
      live: false,
      isLooping: true,
      status: 'idle',
      pendingApprovalCount: 0,
    })).toEqual({ kind: 'past', label: 'past' });
  });
});
