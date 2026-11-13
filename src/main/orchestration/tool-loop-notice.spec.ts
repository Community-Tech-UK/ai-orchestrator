import { describe, expect, it } from 'vitest';

import { MAX_BODY_CHARS, shouldTellUserAboutToolLoop, toolLoopNotice, toolLoopTranscriptNotice } from './tool-loop-notice';

const base = {
  detector: 'repeat-no-progress',
  toolName: 'Read',
  count: 9,
  harnessWillStop: false,
} as const;

describe('toolLoopTranscriptNotice', () => {
  it.each(['repeat-no-progress', 'ping-pong'] as const)('explains an automatic %s stop and offers a way forward', (detector) => {
    expect(toolLoopTranscriptNotice({ severity: 'critical', detector }, true)).toBe(
      'Harness is stopping this turn because the agent kept repeating tool calls with the same results. Completed work is preserved. Choose Continue to retry. If it repeats, start a fresh session or change model.',
    );
  });

  it('describes the call limit without claiming that different calls repeated', () => {
    expect(toolLoopTranscriptNotice({ severity: 'critical', detector: 'runaway' }, true))
      .toContain('made too many tool calls without finishing');
  });

  it('does not say the session stopped when the user can still choose to let it run', () => {
    expect(toolLoopTranscriptNotice({ severity: 'critical', detector: 'repeat-no-progress' }, false)).toBeUndefined();
    expect(toolLoopTranscriptNotice({ severity: 'warn', detector: 'repeat-no-progress' }, true)).toBeUndefined();
  });

  it('explains when the automatic stop failed rather than claiming it succeeded', () => {
    expect(toolLoopTranscriptNotice({ severity: 'critical', detector: 'repeat-no-progress', autoStopFailed: true }, false))
      .toBe('Harness could not stop this turn automatically. The agent may still be repeating actions. Use Stop to end the turn.');
  });
});

describe('shouldTellUserAboutToolLoop', () => {
  /** A first guess with nothing to do; showing every one taught the user to ignore the whole class. */
  it('never shows a warning, whatever the detector or stop state', () => {
    for (const detector of ['repeat-no-progress', 'ping-pong', 'runaway'] as const) {
      expect(shouldTellUserAboutToolLoop({ severity: 'warn', detector }, false)).toBe(false);
      expect(shouldTellUserAboutToolLoop({ severity: 'warn', detector }, true)).toBe(false);
    }
  });

  it('shows a critical repeat of the same call and result', () => {
    expect(shouldTellUserAboutToolLoop({ severity: 'critical', detector: 'repeat-no-progress' }, false)).toBe(true);
    expect(shouldTellUserAboutToolLoop({ severity: 'critical', detector: 'ping-pong' }, false)).toBe(true);
  });

  /** A long working turn passes 400 tool calls routinely; that alone is not "stuck". */
  it('shows a long turn only when Harness acts on it', () => {
    expect(shouldTellUserAboutToolLoop({ severity: 'critical', detector: 'runaway' }, false)).toBe(false);
    expect(shouldTellUserAboutToolLoop({ severity: 'critical', detector: 'runaway' }, true)).toBe(true);
    // Harness said it was stopping the turn and could not: the user must hear that it is still running.
    expect(shouldTellUserAboutToolLoop({ severity: 'critical', detector: 'runaway', autoStopFailed: true }, false)).toBe(true);
  });
});

describe('toolLoopNotice (N2)', () => {
  it('notifies for a critical detection in the same plain words as the session bar', () => {
    const notice = toolLoopNotice(base);
    expect(notice).toEqual({
      title: 'A session may be stuck',
      body: 'It has run Read 9 times in a row and got the same result each time. It keeps going until you stop it.',
      urgency: 'critical',
    });
  });

  it('never shows the detector\'s log wording or the word "loop"', () => {
    for (const detector of ['repeat-no-progress', 'ping-pong', 'runaway'] as const) {
      const notice = toolLoopNotice({ ...base, detector });
      expect(`${notice.title} ${notice.body}`).not.toMatch(/loop|consecutive|canary/i);
    }
  });

  /** The two cases need different responses from the human, so say which it is. */
  it('says Harness is stopping it when it will', () => {
    const notice = toolLoopNotice({ ...base, harnessWillStop: true });
    expect(notice.body).toContain('Harness is stopping it.');
    expect(notice.body).not.toContain('until you stop it');
  });

  it('names the instance when several are running', () => {
    const notice = toolLoopNotice({ ...base, instanceName: 'api-refactor' });
    expect(notice.body).toMatch(/^api-refactor: It has run Read/);
  });

  it('keeps both tool names when two long ones are clipped', () => {
    const notice = toolLoopNotice({ ...base, detector: 'ping-pong', toolName: `${'a'.repeat(60)}/${'b'.repeat(60)}` });
    expect(notice.body).toMatch(/^It keeps switching between a+… and b+… and getting/);
  });

  it('shows a long tool-server name readably rather than clipping its raw form', () => {
    const notice = toolLoopNotice({ ...base, toolName: `mcp__browser-gateway__${'browser_snapshot_'.repeat(4)}` });
    expect(notice.body).toMatch(/^It has run browser_snapshot_/);
    expect(notice.body).not.toContain('mcp__');
  });

  it('clips runaway inputs rather than shipping a wall of text', () => {
    for (const detector of ['repeat-no-progress', 'ping-pong', 'runaway'] as const) {
      const notice = toolLoopNotice({
        ...base,
        detector,
        toolName: 't'.repeat(200),
        count: 999_999,
        instanceName: 'i'.repeat(200),
      });
      expect(notice!.body.length).toBeLessThanOrEqual(MAX_BODY_CHARS);
    }
  });
});
