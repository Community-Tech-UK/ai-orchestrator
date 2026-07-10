import { describe, expect, it } from 'vitest';
import type { BranchCandidate } from './loop-branch-select';
import {
  buildBranchCandidatePrompt,
  buildBranchListwiseScoringRequest,
} from './loop-branch-task-prompt';

function candidate(id: string): BranchCandidate {
  return {
    id,
    provider: 'claude',
    workdir: `/tmp/${id}`,
    verifyPassed: true,
    filesChanged: 1,
    summary: `${id} changed the implementation seam`,
  };
}

describe('branch candidate prompts', () => {
  it('builds a purpose-specific prompt with an assigned approach instead of loop-state instructions', () => {
    const prompt = buildBranchCandidatePrompt({
      goal: 'Fix the race without changing the public API.',
      candidateIndex: 0,
      candidateCount: 3,
      verifyCommand: 'npm run test:quiet -- race.spec.ts',
      taskPacket: {
        id: 'candidate-1',
        objective: 'Fix the race without changing the public API.',
        scope: { read: ['src'], write: ['candidate-1'] },
        acceptanceCriteria: ['The race is covered by a regression test.'],
        verificationPlan: ['npm run test:quiet -- race.spec.ts'],
        depth: 0,
      },
    });

    expect(prompt).toMatch(/^## Branch-and-Select Candidate/);
    expect(prompt).toContain('Assigned approach: minimal targeted repair');
    expect(prompt).toContain('Fix the race without changing the public API.');
    expect(prompt).toContain('Ignore loop state files');
    expect(prompt).toContain('npm run test:quiet -- race.spec.ts');
    expect(prompt).not.toContain('<promise>DONE</promise>');
    expect(prompt).not.toContain('Begin.');
  });

  it('assigns distinct approaches across the first three candidates', () => {
    const approaches = [0, 1, 2].map((candidateIndex) =>
      buildBranchCandidatePrompt({
        goal: 'Improve the implementation.',
        candidateIndex,
        candidateCount: 3,
        verifyCommand: 'npm test',
      }).match(/Assigned approach: ([^\n]+)/)?.[1],
    );

    expect(new Set(approaches).size).toBe(3);
  });
});

describe('branch listwise scoring prompt', () => {
  it('scores implementation quality without exposing or double-counting verify status', () => {
    const request = buildBranchListwiseScoringRequest(
      [candidate('a'), { ...candidate('b'), verifyPassed: false }],
      'Fix the race.',
    );

    expect(request.prompt).toContain('Verification is enforced independently');
    expect(request.prompt).not.toContain('prefer candidates whose verify passed');
    expect(request.context).not.toContain('verify=');
    expect(request.context).toContain('CANDIDATE id=a');
    expect(request.context).toContain('CANDIDATE id=b');
  });
});
