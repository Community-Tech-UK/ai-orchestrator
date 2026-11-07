import { describe, expect, it } from 'vitest';
import type { UserActionRequest } from '../orchestration/orchestration-handler.types';
import { userActionNoticeTitle } from './attention-notices';

describe('userActionNoticeTitle', () => {
  it.each([
    ['approve_action', undefined, 'needs your OK'],
    ['ask_questions', undefined, 'needs your answer'],
    ['switch_mode', 'plan', 'needs your OK to switch to Plan mode'],
  ])('names %s requests with a safe fallback', (requestType, targetMode, suffix) => {
    const request = { requestType, targetMode } as UserActionRequest;
    expect(userActionNoticeTitle(request, 'Fix login')).toBe(`Fix login ${suffix}`);
    expect(userActionNoticeTitle(request)).toBe(`A session ${suffix}`);
  });
});
