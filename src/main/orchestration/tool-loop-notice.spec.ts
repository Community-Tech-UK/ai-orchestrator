import { describe, expect, it } from 'vitest';

import { MAX_BODY_CHARS, toolLoopNotice } from './tool-loop-notice';

const base = {
  toolName: 'Read',
  windowDescription: '8 calls in 2 minutes',
  autoInterruptEnabled: false,
} as const;

describe('toolLoopNotice (N2)', () => {
  /**
   * Promoting every warning to a desktop notification trains the operator to
   * dismiss the whole class, which costs exactly when a real one arrives.
   */
  it('does not notify for a warning, which already has a toast', () => {
    expect(toolLoopNotice({ ...base, severity: 'warning' })).toBeNull();
  });

  it('notifies for a critical detection', () => {
    const notice = toolLoopNotice({ ...base, severity: 'critical' });
    expect(notice?.urgency).toBe('critical');
    expect(notice?.body).toContain('Read');
    expect(notice?.body).toContain('8 calls in 2 minutes');
  });

  /** The two cases need different responses from the human, so say which it is. */
  it('says the loop will continue when auto-interrupt is off', () => {
    const notice = toolLoopNotice({ ...base, severity: 'critical' });
    expect(notice?.body).toContain('auto-interrupt is off');
  });

  it('says it will be stopped when auto-interrupt is on', () => {
    const notice = toolLoopNotice({ ...base, severity: 'critical', autoInterruptEnabled: true });
    expect(notice?.body).toContain('Auto-interrupt will stop it');
    expect(notice?.body).not.toContain('until you stop it');
  });

  it('names the instance when several are running', () => {
    const notice = toolLoopNotice({ ...base, severity: 'critical', instanceName: 'api-refactor' });
    expect(notice?.body).toContain('api-refactor');
  });

  it('reads sensibly without an instance name', () => {
    expect(toolLoopNotice({ ...base, severity: 'critical' })?.body).toMatch(/^repeating /);
  });

  it('clips runaway inputs rather than shipping a wall of text', () => {
    const notice = toolLoopNotice({
      ...base,
      severity: 'critical',
      toolName: 't'.repeat(200),
      windowDescription: 'w'.repeat(200),
      instanceName: 'i'.repeat(200),
    });
    expect(notice!.body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
  });
});
