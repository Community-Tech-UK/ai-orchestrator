import { describe, expect, it, vi } from 'vitest';
import {
  parseReviewCommandArgs,
  resolveReviewCommandTarget,
  runReviewCommand,
} from './review-command';
import type { HeadlessReviewResult } from './review-command-output';

function makeReviewResult(overrides: Partial<HeadlessReviewResult> = {}): HeadlessReviewResult {
  return {
    target: 'HEAD',
    cwd: '/repo',
    startedAt: '2026-05-06T10:00:00.000Z',
    completedAt: '2026-05-06T10:00:01.000Z',
    reviewers: [{ provider: 'gemini', status: 'used' }],
    findings: [],
    summary: 'No findings.',
    infrastructureErrors: [],
    ...overrides,
  };
}

describe('review-command', () => {
  it('parses supported target, cwd, and json arguments', () => {
    expect(parseReviewCommandArgs(['--cwd', '/repo', '--target', 'HEAD', '--json'])).toEqual({
      cwd: '/repo',
      target: 'HEAD',
      json: true,
    });

    expect(parseReviewCommandArgs(['https://github.com/org/repo/pull/123', '--json'])).toMatchObject({
      target: 'https://github.com/org/repo/pull/123',
      json: true,
    });

    expect(parseReviewCommandArgs(['--target', 'HEAD', '--reviewer', 'none'])).toMatchObject({
      target: 'HEAD',
      reviewers: [],
    });
  });

  it('resolves a local diff target using non-interactive git commands', async () => {
    const runGit = vi.fn(async (_cwd: string, args: string[]) => {
      if (args[0] === 'diff' && args[1] === '--stat') return ' src/file.ts | 2 +-';
      if (args[0] === 'diff') return 'diff --git a/src/file.ts b/src/file.ts';
      return '';
    });

    const resolved = await resolveReviewCommandTarget(
      { cwd: '/repo', target: 'main...feature', json: true },
      { runGit, resolveGitHostMetadata: vi.fn() },
    );

    expect(runGit).toHaveBeenCalledWith('/repo', ['diff', '--stat', 'main...feature']);
    expect(runGit).toHaveBeenCalledWith('/repo', ['diff', '--find-renames', 'main...feature']);
    expect(resolved.content).toContain('diff --git');
    expect(resolved.taskDescription).toContain('Review local diff target main...feature');
  });

  it('uses PR URL metadata when it can be resolved', async () => {
    const resolved = await resolveReviewCommandTarget(
      { cwd: '/repo', target: 'https://github.com/org/repo/pull/123', json: true },
      {
        runGit: vi.fn(async () => 'diff --git a/file b/file'),
        resolveGitHostMetadata: vi.fn(async () => ({
          title: 'Fix null handling',
          description: 'Adds a missing guard.',
          baseBranch: 'main',
          headBranch: 'feature/null-guard',
        })),
      },
    );

    expect(resolved.target).toBe('https://github.com/org/repo/pull/123');
    expect(resolved.taskDescription).toContain('Fix null handling');
    expect(resolved.content).toContain('main...feature/null-guard');
  });

  it('prints JSON and exits zero when findings are present without infrastructure errors', async () => {
    const stdout: string[] = [];
    const exitCode = await runReviewCommand(['--cwd', '/repo', '--target', 'HEAD', '--json'], {
      stdout: (text) => stdout.push(text),
      stderr: vi.fn(),
      runGit: vi.fn(async () => 'diff --git a/file b/file'),
      resolveGitHostMetadata: vi.fn(),
      runHeadlessReview: vi.fn(async () => makeReviewResult({
        findings: [{ title: 'Bug', body: 'Details', severity: 'high', confidence: 0.8 }],
      })),
    });

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout.join('')).findings).toHaveLength(1);
  });

  it('exits non-zero for infrastructure errors', async () => {
    const stdout: string[] = [];
    const exitCode = await runReviewCommand(['--cwd', '/repo', '--target', 'HEAD', '--json'], {
      stdout: (text) => stdout.push(text),
      stderr: vi.fn(),
      runGit: vi.fn(async () => 'diff --git a/file b/file'),
      resolveGitHostMetadata: vi.fn(),
      runHeadlessReview: vi.fn(async () => makeReviewResult({
        infrastructureErrors: ['No review host configured'],
      })),
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(stdout.join('')).infrastructureErrors).toEqual(['No review host configured']);
  });
});
