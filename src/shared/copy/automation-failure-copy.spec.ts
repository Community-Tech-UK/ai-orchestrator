import { describe, expect, it } from 'vitest';
import { automationRunStatusLabel, presentAutomationFailure } from './automation-failure-copy';
import { renderUserMessage } from './user-message';

describe('automation failure copy', () => {
  it.each([
    'Instance entered error', 'Instance entered failed', 'Instance entered terminated', 'Instance entered cancelled', 'Instance entered superseded',
    'Automation requires unattended permission approval', 'Automation requires unattended user input', 'Automation instance was removed',
    'App restarted before automation run completed',
  ])('explains the stored error %s with an action and preserved detail', raw => {
    const copy = presentAutomationFailure(raw);
    expect(copy.next).toBeTruthy();
    expect(copy.detail).toBe(raw);
    expect(renderUserMessage(copy)).not.toMatch(/Instance entered|unattended|superseded/);
  });
  it('keeps unknown diagnostics only in detail', () => {
    const copy = presentAutomationFailure('Unknown provider diagnostic');
    expect(copy).toEqual({ text: 'Something went wrong.', detail: 'Unknown provider diagnostic' });
    expect(renderUserMessage(copy)).toBe('Something went wrong.');
  });
  it('uses plain words for every run status', () => {
    expect(['pending', 'running', 'failed', 'succeeded', 'skipped', 'cancelled'].map(status => automationRunStatusLabel(status as Parameters<typeof automationRunStatusLabel>[0])))
      .toEqual(['Waiting', 'Running', 'Failed', 'Done', 'Skipped', 'Cancelled']);
  });
});
