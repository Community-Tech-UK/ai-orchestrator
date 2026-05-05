import { describe, expect, it } from 'vitest';
import type {
  OperatorProjectRecord,
  OperatorVerificationSummary,
} from '../../shared/types/operator.types';
import { buildOperatorFixWorkerPrompt } from './operator-fix-worker-prompt';

describe('buildOperatorFixWorkerPrompt', () => {
  it('includes the repair goal, project, attempt, and required verification failures', () => {
    const prompt = buildOperatorFixWorkerPrompt({
      originalGoal: 'In AI Orchestrator, add retry support',
      project: projectRecord(),
      attempt: 2,
      previousWorkerOutputPreview: 'Implemented the first attempt.',
      verification: verificationSummary(),
    });

    expect(prompt).toContain('Original user request:');
    expect(prompt).toContain('In AI Orchestrator, add retry support');
    expect(prompt).toContain('AI Orchestrator');
    expect(prompt).toContain('/work/ai-orchestrator');
    expect(prompt).toContain('Repair attempt:');
    expect(prompt).toContain('2');
    expect(prompt).toContain('Previous worker output:');
    expect(prompt).toContain('Implemented the first attempt.');
    expect(prompt).toContain('Required verification failures:');
    expect(prompt).toContain('typecheck');
    expect(prompt).toContain('npx tsc --noEmit');
    expect(prompt).toContain('Exit code: 2');
    expect(prompt).toContain('Timed out: false');
    expect(prompt).toContain('src/main/operator/operator-engine.ts(10,1): error TS2322');
    expect(prompt).toContain('Make the smallest change that addresses the required verification failures.');
    expect(prompt).toContain('The Operator will independently rerun verification after you finish.');
  });

  it('labels optional failures as context instead of primary retry causes', () => {
    const prompt = buildOperatorFixWorkerPrompt({
      originalGoal: 'Fix the project',
      project: projectRecord(),
      attempt: 1,
      previousWorkerOutputPreview: null,
      verification: verificationSummary(),
    });

    expect(prompt).toContain('Previous worker output:');
    expect(prompt).toContain('No output preview was captured.');
    expect(prompt).toContain('Optional verification failures:');
    expect(prompt).toContain('lint');
    expect(prompt).toContain('npm run lint');
    expect(prompt.indexOf('Required verification failures:')).toBeLessThan(prompt.indexOf('Optional verification failures:'));
  });

  it('truncates large worker output and command excerpts', () => {
    const prompt = buildOperatorFixWorkerPrompt({
      originalGoal: 'Fix the project',
      project: projectRecord(),
      attempt: 1,
      previousWorkerOutputPreview: 'worker '.repeat(80),
      verification: verificationSummary({
        stdoutExcerpt: 'stdout '.repeat(80),
        stderrExcerpt: 'stderr '.repeat(80),
      }),
      maxSectionChars: 120,
    });

    expect(prompt.length).toBeLessThan(2200);
    expect(prompt).toContain('[truncated]');
  });
});

function projectRecord(): OperatorProjectRecord {
  return {
    id: 'project-1',
    canonicalPath: '/work/ai-orchestrator',
    displayName: 'AI Orchestrator',
    aliases: ['AI Orchestrator'],
    source: 'scan',
    gitRoot: '/work/ai-orchestrator',
    remotes: [],
    currentBranch: 'main',
    isPinned: false,
    lastSeenAt: 1,
    lastAccessedAt: 1,
    metadata: {},
  };
}

function verificationSummary(
  overrides: Partial<OperatorVerificationSummary['checks'][number]> = {},
): OperatorVerificationSummary {
  return {
    status: 'failed',
    projectPath: '/work/ai-orchestrator',
    kinds: ['node', 'typescript'],
    requiredFailed: 1,
    optionalFailed: 1,
    checks: [
      {
        label: 'typecheck',
        command: 'npx',
        args: ['tsc', '--noEmit'],
        cwd: '/work/ai-orchestrator',
        required: true,
        status: 'failed',
        exitCode: 2,
        durationMs: 345,
        timedOut: false,
        stdoutBytes: 0,
        stderrBytes: 56,
        stdoutExcerpt: '',
        stderrExcerpt: 'src/main/operator/operator-engine.ts(10,1): error TS2322',
        error: 'Command failed',
        ...overrides,
      },
      {
        label: 'lint',
        command: 'npm',
        args: ['run', 'lint'],
        cwd: '/work/ai-orchestrator',
        required: false,
        status: 'failed',
        exitCode: 1,
        durationMs: 200,
        timedOut: false,
        stdoutBytes: 20,
        stderrBytes: 0,
        stdoutExcerpt: 'lint warning',
        stderrExcerpt: '',
        error: 'Command failed',
      },
    ],
  };
}
