import { describe, expect, it } from 'vitest';
import { formatReviewJson, type HeadlessReviewResult } from './review-command-output';

function makeResult(overrides: Partial<HeadlessReviewResult> = {}): HeadlessReviewResult {
  return {
    target: 'HEAD',
    cwd: '/repo',
    startedAt: '2026-05-06T10:00:00.000Z',
    completedAt: '2026-05-06T10:00:01.000Z',
    reviewers: [
      { provider: 'gemini', status: 'used' },
      { provider: 'codex', model: 'gpt-5.4', status: 'skipped', reason: 'not available' },
    ],
    findings: [
      {
        title: 'Missing null check',
        body: 'The handler assumes the payload exists.',
        file: 'src/handler.ts',
        line: 42,
        severity: 'medium',
        confidence: 0.82,
      },
    ],
    summary: 'One medium finding.',
    infrastructureErrors: [],
    ...overrides,
  };
}

describe('formatReviewJson', () => {
  it('formats findings and skipped reviewers as stable pretty JSON', () => {
    const parsed = JSON.parse(formatReviewJson(makeResult())) as HeadlessReviewResult;

    expect(parsed.reviewers).toEqual([
      { provider: 'gemini', status: 'used' },
      { provider: 'codex', model: 'gpt-5.4', status: 'skipped', reason: 'not available' },
    ]);
    expect(parsed.findings[0]).toMatchObject({
      title: 'Missing null check',
      severity: 'medium',
      confidence: 0.82,
    });
  });

  it('formats infrastructure errors without throwing when optional fields are absent', () => {
    const parsed = JSON.parse(formatReviewJson(makeResult({
      reviewers: [{ provider: 'gemini', status: 'failed', reason: 'CLI exited 1' }],
      findings: [{ title: 'Review failed', body: 'No model output', severity: 'low', confidence: 0 }],
      infrastructureErrors: ['CLI exited 1'],
    }))) as HeadlessReviewResult;

    expect(parsed.reviewers[0]).toEqual({
      provider: 'gemini',
      status: 'failed',
      reason: 'CLI exited 1',
    });
    expect(parsed.findings[0]).not.toHaveProperty('file');
    expect(parsed.infrastructureErrors).toEqual(['CLI exited 1']);
  });
});
