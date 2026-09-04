import { describe, expect, it } from 'vitest';

import { isRecoverableAcpPromptTurnError } from '../../instance/instance-communication-adapter-helpers';
import {
  DEFAULT_CHILD_STALL_WARNING_MS,
  DEFAULT_INTERACTIVE_STALL_WARNING_MS,
  classifyAcpTurnWait,
  selectCurrentTurnPermissions,
  describeAcpPromptTimeoutCause,
  describeAcpStallWarning,
  hasActiveAcpToolCall,
  resolveAcpStallWarningMs,
} from './acp-prompt-timeout-policy';

describe('hasActiveAcpToolCall', () => {
  it('reports pending and in-progress calls as active', () => {
    expect(hasActiveAcpToolCall([{ status: 'pending' as const }])).toBe(true);
    expect(hasActiveAcpToolCall([{ status: 'in_progress' as const }])).toBe(true);
  });

  it('reports settled calls as inactive', () => {
    expect(hasActiveAcpToolCall([
      { status: 'completed' as const },
      { status: 'failed' as const },
    ])).toBe(false);
    expect(hasActiveAcpToolCall([])).toBe(false);
  });
});

describe('resolveAcpStallWarningMs', () => {
  // Asserted against literals, not against the constants themselves: comparing
  // the resolver's output to the constant it returns passes even if both are
  // zeroed, which switches the whole watchdog off (armStallWatchdog returns
  // early on `timeoutMs <= 0`).
  it('arms the watchdog for interactive sessions', () => {
    expect(resolveAcpStallWarningMs(false)).toBe(300_000);
    expect(DEFAULT_INTERACTIVE_STALL_WARNING_MS).toBeGreaterThan(0);
  });

  it('keeps the tighter child interval', () => {
    expect(resolveAcpStallWarningMs(true)).toBe(90_000);
    expect(DEFAULT_CHILD_STALL_WARNING_MS).toBeGreaterThan(0);
  });

  it('warns before the default 10-minute prompt lease expires', () => {
    expect(DEFAULT_INTERACTIVE_STALL_WARNING_MS).toBeLessThan(10 * 60_000);
    expect(DEFAULT_CHILD_STALL_WARNING_MS).toBeLessThan(10 * 60_000);
  });
});

describe('classifyAcpTurnWait', () => {
  it('puts an unanswered permission request ahead of a running tool', () => {
    expect(classifyAcpTurnWait({
      toolCalls: [{ title: 'Run tests', status: 'pending' as const }],
      permissions: [{ title: 'Write file' }],
    })).toEqual({ kind: 'permission', subject: 'Write file' });
  });

  it('reports the first still-running tool call', () => {
    expect(classifyAcpTurnWait({
      toolCalls: [
        { title: 'Read File', status: 'completed' as const },
        { title: 'Run tests', status: 'in_progress' as const },
      ],
      permissions: [],
    })).toEqual({ kind: 'tool', subject: 'Run tests', status: 'in_progress' });
  });

  it('reports unowned silence when everything has settled', () => {
    expect(classifyAcpTurnWait({
      toolCalls: [{ title: 'Read File', status: 'completed' as const }],
      permissions: [],
    })).toEqual({ kind: 'unowned' });
  });

  it('bounds agent-supplied titles before they reach a message or a log', () => {
    const wait = classifyAcpTurnWait({
      toolCalls: [{ title: `rtk ${'x'.repeat(500)}`, status: 'pending' as const }],
      permissions: [],
    });

    expect(wait.subject).toHaveLength(120);
    expect(wait.subject?.endsWith('…')).toBe(true);
  });

  it('collapses newlines out of a title so it stays one log line', () => {
    const wait = classifyAcpTurnWait({
      toolCalls: [],
      permissions: [{ title: 'run\n  this\tcommand' }],
    });

    expect(wait.subject).toBe('run this command');
  });
});

describe('selectCurrentTurnPermissions', () => {
  const stale = { createdAt: 1_000, title: 'Write file from a dead turn' };
  const live = { createdAt: 3_000, title: 'Write file' };

  it('drops a request leaked by an earlier turn', () => {
    expect(selectCurrentTurnPermissions([stale, live], 2_000)).toEqual([live]);
  });

  it('keeps a request that arrived exactly at the turn boundary', () => {
    expect(selectCurrentTurnPermissions([live], 3_000)).toEqual([live]);
  });

  it('keeps everything when no turn is in flight', () => {
    // Nothing to attribute to, so silently dropping every candidate would be
    // its own wrong answer.
    expect(selectCurrentTurnPermissions([stale, live], null)).toEqual([stale, live]);
  });
});

describe('describeAcpPromptTimeoutCause', () => {
  it('names an unanswered permission request', () => {
    expect(describeAcpPromptTimeoutCause({ kind: 'permission', subject: 'Write file' }))
      .toContain('permission request (Write file)');
  });

  it('names the outstanding tool call and its status', () => {
    const cause = describeAcpPromptTimeoutCause({
      kind: 'tool',
      subject: 'Run tests',
      status: 'in_progress',
    });

    expect(cause).toContain('Tool call Run tests');
    expect(cause).toContain('in_progress');
  });

  it('says the agent went quiet when nothing was outstanding', () => {
    // Regression for the incident this was written for: the turn timed out ten
    // minutes after its last *completed* tool result, and the old fixed text
    // blamed an orphaned tool call that did not exist.
    const cause = describeAcpPromptTimeoutCause({ kind: 'unowned' });

    expect(cause).toContain('No tool call or permission request was outstanding');
  });

  it('does not tell the user to restart a session the runtime keeps recoverable', () => {
    // isRecoverableAcpPromptTurnError keeps the instance alive and returns it
    // to idle, so advising a restart would contradict what actually happens.
    for (const wait of [
      { kind: 'unowned' as const },
      { kind: 'tool' as const, subject: 'Run tests', status: 'pending' as const },
      { kind: 'permission' as const, subject: 'Write file' },
    ]) {
      expect(describeAcpPromptTimeoutCause(wait).toLowerCase()).not.toContain('restart');
    }
  });
});

describe('describeAcpStallWarning', () => {
  it('only claims the turn may be stuck when nothing owns the silence', () => {
    expect(describeAcpStallWarning({ kind: 'unowned' }, 300_000))
      .toBe("This turn hasn't produced any output for 300s — it may be stuck. Cancel the turn to try again.");
  });

  it('names a long-running tool instead of calling a healthy turn stuck', () => {
    const warning = describeAcpStallWarning(
      { kind: 'tool', subject: 'npm run build', status: 'in_progress' },
      90_000,
    );

    expect(warning).toBe('Tool call npm run build has been in_progress for 90s with no update.');
    expect(warning).not.toContain('stuck');
  });

  it('names a permission request the user has not answered', () => {
    const warning = describeAcpStallWarning({ kind: 'permission', subject: 'Write file' }, 90_000);

    expect(warning).toContain('permission request (Write file)');
    expect(warning).not.toContain('stuck');
  });
});

describe('timeout message ↔ recovery classifier contract', () => {
  // The cause sentence is free text, but the prefix in front of it is load
  // bearing: instance-communication keeps the instance alive and returns it to
  // idle only when isRecoverableAcpPromptTurnError matches. A reworded cause
  // that broke the regex would silently turn every ACP prompt timeout into a
  // hard instance error.
  it.each([
    { kind: 'unowned' as const },
    { kind: 'tool' as const, subject: 'npm run build', status: 'pending' as const },
    { kind: 'permission' as const, subject: 'Write file' },
  ])('stays recoverable for a $kind wait', (wait) => {
    const message = `ACP session/prompt request timed out after 600000ms without a session/update (id=6). `
      + describeAcpPromptTimeoutCause(wait);

    expect(isRecoverableAcpPromptTurnError(message)).toBe(true);
  });
});
