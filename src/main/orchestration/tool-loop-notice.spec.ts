import { describe, expect, it } from 'vitest';

import { MAX_BODY_CHARS, toolLoopNotice } from './tool-loop-notice';

const base = {
  detector: 'repeat-no-progress',
  toolName: 'Read',
  count: 9,
  harnessWillStop: false,
} as const;

describe('toolLoopNotice (N2)', () => {
  /**
   * Promoting every warning to a desktop notification trains the operator to
   * dismiss the whole class, which costs exactly when a real one arrives.
   */
  it('does not notify for a warning, which already has a toast', () => {
    expect(toolLoopNotice({ ...base, severity: 'warning' })).toBeNull();
  });

  it('notifies for a critical detection in the same plain words as the session bar', () => {
    const notice = toolLoopNotice({ ...base, severity: 'critical' });
    expect(notice).toEqual({
      title: 'A session may be stuck',
      body: 'It has run Read 9 times in a row and got the same result each time. It keeps going until you stop it.',
      urgency: 'critical',
    });
  });

  it('never shows the detector\'s log wording or the word "loop"', () => {
    for (const detector of ['repeat-no-progress', 'ping-pong', 'runaway'] as const) {
      const notice = toolLoopNotice({ ...base, detector, severity: 'critical' });
      expect(`${notice?.title} ${notice?.body}`).not.toMatch(/loop|consecutive|canary/i);
    }
  });

  /** The two cases need different responses from the human, so say which it is. */
  it('says Harness is stopping it when it will', () => {
    const notice = toolLoopNotice({ ...base, severity: 'critical', harnessWillStop: true });
    expect(notice?.body).toContain('Harness is stopping it.');
    expect(notice?.body).not.toContain('until you stop it');
  });

  it('names the instance when several are running', () => {
    const notice = toolLoopNotice({ ...base, severity: 'critical', instanceName: 'api-refactor' });
    expect(notice?.body).toMatch(/^api-refactor: It has run Read/);
  });

  it('keeps both tool names when two long ones are clipped', () => {
    const notice = toolLoopNotice({ ...base, detector: 'ping-pong', severity: 'critical', toolName: `${'a'.repeat(60)}/${'b'.repeat(60)}` });
    expect(notice?.body).toMatch(/^It keeps switching between a+… and b+… and getting/);
  });

  it('shows a long tool-server name readably rather than clipping its raw form', () => {
    const notice = toolLoopNotice({ ...base, severity: 'critical', toolName: `mcp__browser-gateway__${'browser_snapshot_'.repeat(4)}` });
    expect(notice?.body).toMatch(/^It has run browser_snapshot_/);
    expect(notice?.body).not.toContain('mcp__');
  });

  it('clips runaway inputs rather than shipping a wall of text', () => {
    for (const detector of ['repeat-no-progress', 'ping-pong', 'runaway'] as const) {
      const notice = toolLoopNotice({
        ...base,
        detector,
        severity: 'critical',
        toolName: 't'.repeat(200),
        count: 999_999,
        instanceName: 'i'.repeat(200),
      });
      expect(notice!.body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    }
  });
});
