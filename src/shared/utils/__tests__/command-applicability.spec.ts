import { describe, expect, it } from 'vitest';
import { evaluateApplicability } from '../command-applicability';
import type { CommandApplicability } from '../../types/command.types';

const command = (applicability?: CommandApplicability, disabledReason?: string) => ({
  applicability,
  disabledReason,
});

describe('evaluateApplicability', () => {
  it('allows commands without applicability', () => {
    expect(evaluateApplicability(command(), {})).toEqual({ eligible: true });
  });

  it('blocks provider mismatches', () => {
    const result = evaluateApplicability(command({ provider: 'claude' }), { provider: 'gemini' });
    expect(result.eligible).toBe(false);
    expect(result.failedPredicate).toBe('provider');
    expect(result.reason).toContain('claude');
  });

  it('allows provider arrays', () => {
    expect(
      evaluateApplicability(command({ provider: ['claude', 'gemini'] }), { provider: 'gemini' }).eligible,
    ).toBe(true);
  });

  it('blocks status mismatches', () => {
    const result = evaluateApplicability(command({ instanceStatus: 'idle' }), { instanceStatus: 'busy' });
    expect(result.eligible).toBe(false);
    expect(result.failedPredicate).toBe('instanceStatus');
  });

  it('blocks when a working directory is required but absent', () => {
    const result = evaluateApplicability(command({ requiresWorkingDirectory: true }), {
      workingDirectory: null,
    });
    expect(result.eligible).toBe(false);
    expect(result.failedPredicate).toBe('workingDirectory');
  });

  it('blocks when a git repo is required and the probe says false', () => {
    const result = evaluateApplicability(command({ requiresGitRepo: true }), {
      workingDirectory: '/tmp/project',
      isGitRepo: false,
    });
    expect(result.eligible).toBe(false);
    expect(result.failedPredicate).toBe('gitRepo');
  });

  it('treats unknown git status as eligible', () => {
    expect(
      evaluateApplicability(command({ requiresGitRepo: true }), {
        workingDirectory: '/tmp/project',
      }).eligible,
    ).toBe(true);
  });

  it('blocks disabled feature flags', () => {
    const result = evaluateApplicability(command({ featureFlag: 'showThinking' }), {
      featureFlags: { showThinking: false },
    });
    expect(result.eligible).toBe(false);
    expect(result.failedPredicate).toBe('featureFlag');
  });

  it('uses disabledReason over generated reasons', () => {
    const result = evaluateApplicability(
      command({ requiresWorkingDirectory: true }, 'Custom reason'),
      { workingDirectory: null },
    );
    expect(result.reason).toBe('Custom reason');
  });
});
