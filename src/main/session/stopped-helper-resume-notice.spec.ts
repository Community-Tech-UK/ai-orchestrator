import { describe, expect, it } from 'vitest';
import type { SessionState, StoppedHelper } from './session-continuity.types';
import {
  stoppedHelperNoticeText,
  stoppedHelperResumeNotices,
  stoppedHelperUserText,
  takeStoppedHelpersFromState,
} from './stopped-helper-resume-notice';

function helper(overrides: Partial<StoppedHelper> = {}): StoppedHelper {
  return {
    toolUseId: 'toolu-1',
    agentId: 'agent-a1',
    sessionId: 'session-old',
    transcriptPath: '/tmp/subagents/agent-a1.jsonl',
    toolUseCount: 12,
    lastActivityAt: Date.UTC(2026, 10, 12, 18, 22, 31),
    ...overrides,
  };
}

function bareState(helpers?: StoppedHelper[]): SessionState {
  return {
    instanceId: 'session-1',
    conversationHistory: [],
    ...(helpers ? { stoppedHelpers: helpers } : {}),
  } as unknown as SessionState;
}

describe('stoppedHelperNoticeText', () => {
  it('names every helper and carries the resume instruction in one [System] block', () => {
    const second = helper({
      toolUseId: 'toolu-2',
      agentId: 'agent-a2',
      transcriptPath: '/tmp/subagents/agent-a2.jsonl',
      toolUseCount: 3,
      lastActivityAt: Date.UTC(2026, 10, 12, 18, 25, 2),
    });
    const text = stoppedHelperNoticeText([helper(), second], 'the account switch');
    expect(text).toBe([
      '[System: 2 helper agents were stopped by the account switch and did not finish. Continue each stopped helper where it left off instead of starting a fresh copy.',
      '- Agent call toolu-1, agent agent-a1: last active 2026-11-12T18:22:31.000Z, 12 tool uses reported, transcript /tmp/subagents/agent-a1.jsonl.',
      '- Agent call toolu-2, agent agent-a2: last active 2026-11-12T18:25:02.000Z, 3 tool uses reported, transcript /tmp/subagents/agent-a2.jsonl.',
      "Continue a helper by sending SendMessage to its agent id; the helper's context is saved in the transcript above. If SendMessage cannot resume a helper, start exactly one replacement that first reads that transcript and checks the files the helper changed. Helpers that already finished need nothing; do not start those again.]",
    ].join('\n'));
  });

  it('uses singular wording for one helper', () => {
    const text = stoppedHelperNoticeText([helper()], 'the restart');
    expect(text).toContain('[System: 1 helper agent was stopped by the restart and did not finish.');
  });

  it('takes the cause phrase as written', () => {
    expect(stoppedHelperNoticeText([helper()], 'hibernation'))
      .toContain('1 helper agent was stopped by hibernation and did not finish.');
  });

  it('omits fields a helper record does not carry', () => {
    const text = stoppedHelperNoticeText(
      [helper({ agentId: undefined, transcriptPath: undefined, toolUseCount: undefined })],
      'the restart',
    );
    expect(text).toContain('- Agent call toolu-1: last active 2026-11-12T18:22:31.000Z.');
    expect(text).not.toContain('tool uses reported');
    expect(text).not.toContain('transcript /tmp');
    expect(text).not.toContain('agent agent-a1');
  });

  it('reports zero tool uses rather than dropping the count', () => {
    const text = stoppedHelperNoticeText([helper({ toolUseCount: 0 })], 'the restart');
    expect(text).toContain('0 tool uses reported');
  });
});

describe('stoppedHelperUserText', () => {
  it('is the exact line James reads after an account switch', () => {
    expect(stoppedHelperUserText(2, 'the account switch'))
      .toBe('2 helper agents were stopped by the account switch; the session was told to carry them on.');
  });

  it('uses singular wording for one helper', () => {
    expect(stoppedHelperUserText(1, 'the restart'))
      .toBe('1 helper agent was stopped by the restart; the session was told to carry them on.');
  });
});

describe('takeStoppedHelpersFromState', () => {
  it('returns the stored helpers and clears them, so nothing repeats', () => {
    const stored = helper();
    const state = bareState([stored]);
    expect(takeStoppedHelpersFromState(state)).toEqual([stored]);
    expect(state.stoppedHelpers).toEqual([]);
    expect(takeStoppedHelpersFromState(state)).toEqual([]);
  });

  it('returns nothing when the state never held helpers', () => {
    expect(takeStoppedHelpersFromState(bareState())).toEqual([]);
    expect(takeStoppedHelpersFromState(bareState([]))).toEqual([]);
  });
});

describe('stoppedHelperResumeNotices', () => {
  it('pairs the model text with the user line as one stopped-helpers notice', () => {
    const [notice] = stoppedHelperResumeNotices([helper()], 'the restart');
    expect(notice).toEqual({
      text: stoppedHelperNoticeText([helper()], 'the restart'),
      userText: '1 helper agent was stopped by the restart; the session was told to carry them on.',
      kind: 'stopped-helpers',
    });
  });

  it('builds nothing when no helper was running', () => {
    expect(stoppedHelperResumeNotices([], 'the restart')).toEqual([]);
  });
});
