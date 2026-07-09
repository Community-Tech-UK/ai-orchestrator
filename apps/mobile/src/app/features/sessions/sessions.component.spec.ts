import '@angular/compiler';
import { describe, expect, it } from 'vitest';
import {
  SESSION_PAGE_SIZE,
  nextSessionsPageSize,
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
