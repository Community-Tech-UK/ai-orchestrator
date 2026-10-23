import { describe, expect, it } from 'vitest';
import type { WakeHint } from './wake-context.types';
import { summarizeWakeHints } from './wake-hint-summary';

const now = Date.UTC(2026, 9, 20);
const week = 7 * 24 * 60 * 60 * 1000;
function hint(id: string, content: string, overrides: Partial<WakeHint> = {}): WakeHint {
  return { id, content, room: 'general', importance: 5, createdAt: now, lastUsed: now, usageCount: 0, ...overrides };
}

describe('Wake notes summary', () => {
  it('puts legacy and case/whitespace duplicate copies behind Hidden', () => {
    const summary = summarizeWakeHints([
      hint('legacy', 'Legacy note', { createdAt: Date.UTC(2026, 4, 3), lastUsed: Date.UTC(2026, 4, 3) }),
      hint('first', 'Use const', { importance: 8 }),
      hint('copy', ' use  CONST '),
      hint('other', 'Keep output bounded'),
    ], now);
    expect(summary.visible.map(note => note.id)).toEqual(['first', 'other']);
    expect(summary.hidden.map(note => note.id).sort()).toEqual(['copy', 'legacy']);
    expect(summary.different).toBe(3);
  });

  it('counts notes actually shown in the last week, excluding freshly created unused notes', () => {
    const summary = summarizeWakeHints([
      hint('new-unused', 'New unused'),
      hint('recent', 'Recently shown', { usageCount: 3, lastUsed: now - week + 1 }),
      hint('old', 'Shown previously', { usageCount: 20, lastUsed: now - week - 1 }),
      hint('revived', 'Old but recently shown', { createdAt: 1, lastUsed: now, usageCount: 1 }),
    ], now);
    expect(summary.shownThisWeek).toBe(2);
    expect(summary.visible.map(note => note.id)).toContain('revived');
  });
});
