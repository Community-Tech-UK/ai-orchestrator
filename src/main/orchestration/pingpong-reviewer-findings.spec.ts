import { describe, expect, it } from 'vitest';
import { normalizeReviewerFindings } from './pingpong-reviewer-findings';

// LT-644: shape captured from real Codex ping-pong reviewer rollouts on
// 2026-09-24 (values anonymised). All 7 rounds used `issue` for the title and
// `suggestedFix` for the body, one used `location` for the file, and the
// parser dropped every finding, so each CHANGES_REQUESTED round reached the
// builder with an empty issue list.
const CAPTURED_CODEX_FINDING = {
  severity: 'medium',
  confidence: 85,
  novelty: 'new',
  file: 'calc.py:1',
  issue: 'The change adds generated files outside the requested scope',
  evidence: 'git status shows __pycache__/ and .gitignore added alongside calc.py',
  suggestedFix: 'Remove the generated files and keep the change to calc.py',
};

describe('normalizeReviewerFindings', () => {
  it('keeps a finding that uses the captured Codex field names', () => {
    const { findings, dropped } = normalizeReviewerFindings([CAPTURED_CODEX_FINDING]);

    expect(dropped).toBe(0);
    expect(findings).toEqual([{
      title: 'The change adds generated files outside the requested scope',
      severity: 'medium',
      file: 'calc.py:1',
      evidence: 'git status shows __pycache__/ and .gitignore added alongside calc.py',
      body: 'Remove the generated files and keep the change to calc.py',
      novelty: 'new',
    }]);
  });

  it('reads `location` as the file when `file` is absent', () => {
    const { file: _file, ...withoutFile } = CAPTURED_CODEX_FINDING;
    const { findings } = normalizeReviewerFindings([{ ...withoutFile, location: 'src/a.ts:12' }]);

    expect(findings[0]?.file).toBe('src/a.ts:12');
  });

  it('prefers the contract field names when both are present', () => {
    const { findings } = normalizeReviewerFindings([{
      ...CAPTURED_CODEX_FINDING, title: 'Contract title', body: 'Contract body',
    }]);

    expect(findings[0]).toMatchObject({ title: 'Contract title', body: 'Contract body' });
  });

  it('still drops a finding that cites no evidence, and counts it', () => {
    const { findings, dropped } = normalizeReviewerFindings([
      { ...CAPTURED_CODEX_FINDING, evidence: '' },
      { ...CAPTURED_CODEX_FINDING, severity: 'blocker' },
      'not an object',
    ]);

    expect(findings).toEqual([]);
    expect(dropped).toBe(3);
  });

  it('returns nothing dropped for an absent or empty list', () => {
    expect(normalizeReviewerFindings(undefined)).toEqual({ findings: [], dropped: 0 });
    expect(normalizeReviewerFindings([])).toEqual({ findings: [], dropped: 0 });
  });
});
