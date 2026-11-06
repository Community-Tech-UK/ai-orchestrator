import { describe, expect, it } from 'vitest';
import { USER_ACTION_DEFAULT_BODY, userActionNotificationTitle } from './user-action-notification';

describe('userActionNotificationTitle', () => {
  it('asks for an answer when the agent put a question', () => {
    expect(userActionNotificationTitle('ask_questions')).toBe('Needs your answer');
    expect(userActionNotificationTitle('select_option')).toBe('Needs your answer');
    expect(userActionNotificationTitle(undefined)).toBe('Needs your answer');
  });

  it('asks for an OK when the agent wants permission or confirmation', () => {
    expect(userActionNotificationTitle('approve_action')).toBe('Needs your OK');
    expect(userActionNotificationTitle('confirm')).toBe('Needs your OK');
  });

  it('names the mode a switch would go to', () => {
    expect(userActionNotificationTitle('switch_mode', 'plan')).toBe('Needs your OK: switch to Plan mode');
    expect(userActionNotificationTitle('switch_mode')).toBe('Needs your OK: switch to requested mode');
  });

  it('no longer says "AI Instance", "Approval Needed" or "Input Needed"', () => {
    const everyTitle = ['ask_questions', 'approve_action', 'switch_mode', 'secret_required', 'confirm']
      .map((type) => userActionNotificationTitle(type, 'build'));
    for (const text of [...everyTitle, USER_ACTION_DEFAULT_BODY]) {
      expect(text).not.toMatch(/AI Instance|Approval Needed|Input Needed|\binstance\b/i);
    }
  });
});
