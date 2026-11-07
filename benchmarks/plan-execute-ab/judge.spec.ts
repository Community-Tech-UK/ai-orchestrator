import { describe, expect, it } from 'vitest';
import { buildJudgePrompt, judgeOneOrder, judgePair, parseJudgeResponse, stripIdentifyingText } from './judge';
import type { JudgeRunner } from './judge';
import type { AgentRunResult, TaskDefinition } from './types';
import { emptyUsage } from './types';

const task: TaskDefinition = {
  id: 'T-1',
  repoId: 'r',
  commitSha: 'c1',
  parentSha: 'p1',
  commitMessage: 'fix: thing',
  size: 'small',
  prompt: 'Fix the thing.',
  hiddenTests: ['t.spec.ts'],
  hiddenTestCommand: ['true'],
  damageCommands: [],
  sourceFiles: ['t.ts'],
  verification: { failOnParent: true, passOnCommit: true, checkedAt: '', evidenceDir: '' },
};

function agentResult(finalText: string): AgentRunResult {
  return {
    finalText,
    usage: emptyUsage(),
    turns: 1,
    toolErrors: [],
    hitTurnCap: false,
    durationMs: 1,
    exitCode: 0,
    timedOut: false,
    rawLogPath: '',
  };
}

function verdictJson(winner: 'x' | 'y', xScore: number, yScore: number): string {
  return JSON.stringify({
    x: { correctBeyondTests: xScore, fitsCodebaseStyle: xScore, noUnrequestedChanges: xScore, wouldMergeAsIs: xScore > 5, notes: '' },
    y: { correctBeyondTests: yScore, fitsCodebaseStyle: yScore, noUnrequestedChanges: yScore, wouldMergeAsIs: yScore > 5, notes: '' },
    winner,
  });
}

function judgePreferring(preferred: 'subject' | 'baseline' | 'first'): JudgeRunner {
  return async (prompt: string): Promise<AgentRunResult> => {
    const xSection = prompt.split('Patch X:')[1]?.split('Patch Y:')[0] ?? '';
    const subjectIsX = xSection.includes('+subject');
    const winner: 'x' | 'y' = preferred === 'first'
      ? 'x'
      : preferred === 'subject'
        ? (subjectIsX ? 'x' : 'y')
        : (subjectIsX ? 'y' : 'x');
    return agentResult(verdictJson(winner, winner === 'x' ? 9 : 3, winner === 'y' ? 9 : 3));
  };
}

describe('judge', () => {
  it('strips co-author trailers and model-identifying comments but keeps code', () => {
    const diff = [
      'diff --git a/a.ts b/a.ts',
      '-old line',
      '+new line',
      '+// Generated with Claude Code',
      '+Co-Authored-By: Claude <noreply@anthropic.com>',
      '+// written by codex',
      '+const value = compute();',
    ].join('\n');
    const stripped = stripIdentifyingText(diff);
    expect(stripped).toContain('+new line');
    expect(stripped).toContain('+const value = compute();');
    expect(stripped).not.toContain('Claude');
    expect(stripped).not.toContain('codex');
  });

  it('asks both rubric questions and an explicit winner', () => {
    const prompt = buildJudgePrompt('fix it', '+x', '+y');
    expect(prompt).toContain('correctBeyondTests');
    expect(prompt).toContain('wouldMergeAsIs');
    expect(prompt).toContain('"winner"');
  });

  it('parses a verdict and rejects malformed judge output', () => {
    const parsed = parseJudgeResponse(verdictJson('x', 9, 3));
    expect(parsed?.winner).toBe('x');
    expect(parsed?.scores.x.correctBeyondTests).toBe(9);
    expect(parseJudgeResponse('not json at all')).toBeNull();
    expect(parseJudgeResponse('{"x": {"correctBeyondTests": 1}, "y": null, "winner": "x"}')).toBeNull();
  });

  it('records which side the subject occupied in each order', async () => {
    const subjectFirst = await judgeOneOrder(judgePreferring('first'), task, '+subject', '+baseline', 'x');
    expect(subjectFirst.subjectSide).toBe('x');
    expect(subjectFirst.winner).toBe('x');
    const subjectSecond = await judgeOneOrder(judgePreferring('first'), task, '+subject', '+baseline', 'y');
    expect(subjectSecond.subjectSide).toBe('y');
    expect(subjectSecond.winner).toBe('x');
  });

  it('counts a win only when the subject wins in both orders', async () => {
    const firstPositionBias = judgePreferring('first');
    const pair = await judgePair('claude', firstPositionBias, task, 'D', '+subject', '+baseline');
    expect(pair.verdict).toBe('tie');
    expect(pair.orders).toHaveLength(2);
  });

  it('returns arm-win when the subject wins both orders', async () => {
    const pair = await judgePair('claude', judgePreferring('subject'), task, 'D', '+subject', '+baseline');
    expect(pair.verdict).toBe('arm-win');
  });

  it('returns baseline-win when the baseline wins both orders', async () => {
    const pair = await judgePair('claude', judgePreferring('baseline'), task, 'D', '+subject', '+baseline');
    expect(pair.verdict).toBe('baseline-win');
  });

  it('collapses a split decision to a tie', async () => {
    let call = 0;
    const split: JudgeRunner = async (prompt) => {
      const runner = judgePreferring(call === 0 ? 'subject' : 'baseline');
      call += 1;
      return runner(prompt);
    };
    const pair = await judgePair('claude', split, task, 'D', '+subject', '+baseline');
    expect(pair.verdict).toBe('tie');
  });

  it('records an unavailable judge instead of silently substituting another model', async () => {
    const broken = async (): Promise<AgentRunResult> => {
      throw new Error('codex CLI missing');
    };
    const pair = await judgePair('codex', broken, task, 'G', '+subject', '+baseline');
    expect(pair.verdict).toBe('judge-unavailable');
    expect(pair.error).toContain('codex CLI missing');
  });
});
