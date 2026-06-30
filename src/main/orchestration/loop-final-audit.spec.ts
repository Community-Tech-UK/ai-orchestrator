import { describe, expect, it } from 'vitest';
import type { LoopRepoComparison } from './loop-repo-state';
import {
  evaluateLoopFinalAudit,
  renderLoopFinalAuditMarkdown,
  scanAddedLinesForCleanliness,
} from './loop-final-audit';

function comparison(overrides: Partial<LoopRepoComparison> = {}): LoopRepoComparison {
  return {
    source: 'git',
    baseline: {
      source: 'git',
      capturedAt: 1,
      workspaceCwd: '/repo',
      headRef: 'abc',
      dirtyAtStart: false,
      trackedDirtyAtStart: [],
      untrackedAtStart: [],
    },
    changedFiles: ['src/a.ts'],
    trackedDiff: '',
    untrackedFiles: [],
    dirtyAtStartCarriedForward: false,
    truncated: false,
    ...overrides,
  };
}

describe('evaluateLoopFinalAudit', () => {
  it('returns skipped when final audit mode is off', () => {
    const result = evaluateLoopFinalAudit({
      goalIntent: 'implementation',
      mode: 'off',
      verifyStatus: 'passed',
      repoComparison: comparison(),
      ledger: { total: 1, resolved: 1, open: 0 },
      cleanliness: { status: 'passed', findings: [] },
    });

    expect(result.status).toBe('skipped');
    expect(result.findings).toEqual([]);
  });

  it('fails when verify failed', () => {
    const result = evaluateLoopFinalAudit({
      goalIntent: 'implementation',
      mode: 'gate',
      verifyStatus: 'failed',
      repoComparison: comparison(),
      ledger: { total: 1, resolved: 1, open: 0 },
      cleanliness: { status: 'passed', findings: [] },
    });

    expect(result.status).toBe('failed');
    expect(result.findings.map((finding) => finding.code)).toContain('verify-failed');
  });

  it('fails when ledger has open items', () => {
    const result = evaluateLoopFinalAudit({
      goalIntent: 'implementation',
      mode: 'gate',
      verifyStatus: 'passed',
      repoComparison: comparison(),
      ledger: { total: 3, resolved: 1, open: 2 },
      cleanliness: { status: 'passed', findings: [] },
    });

    expect(result.status).toBe('failed');
    expect(result.findings.map((finding) => finding.code)).toContain('ledger-open');
  });

  it('fails implementation goals with no changed files after a clean baseline', () => {
    const result = evaluateLoopFinalAudit({
      goalIntent: 'implementation',
      mode: 'gate',
      verifyStatus: 'passed',
      repoComparison: comparison({ changedFiles: [] }),
      ledger: { total: 1, resolved: 1, open: 0 },
      cleanliness: { status: 'passed', findings: [] },
    });

    expect(result.status).toBe('failed');
    expect(result.findings.map((finding) => finding.code)).toContain('no-deliverable-change');
  });

  it('fails implementation goals with no new changed files after a dirty baseline', () => {
    const result = evaluateLoopFinalAudit({
      goalIntent: 'implementation',
      mode: 'gate',
      verifyStatus: 'passed',
      repoComparison: comparison({
        baseline: {
          source: 'git',
          capturedAt: 1,
          workspaceCwd: '/repo',
          headRef: 'abc',
          dirtyAtStart: true,
          trackedDirtyAtStart: ['src/preexisting.ts'],
          untrackedAtStart: [],
        },
        changedFiles: [],
      }),
      ledger: { total: 1, resolved: 1, open: 0 },
      cleanliness: { status: 'skipped', findings: [] },
    });

    expect(result.status).toBe('failed');
    expect(result.findings.map((finding) => finding.code)).toContain('no-deliverable-change');
  });

  it('needs review for non-git repo state even when verify passed', () => {
    const result = evaluateLoopFinalAudit({
      goalIntent: 'implementation',
      mode: 'gate',
      verifyStatus: 'passed',
      repoComparison: comparison({
        source: 'none',
        baseline: {
          source: 'none',
          capturedAt: 1,
          workspaceCwd: '/repo',
          headRef: null,
          dirtyAtStart: false,
          trackedDirtyAtStart: [],
          untrackedAtStart: [],
        },
        changedFiles: [],
      }),
      ledger: { total: 1, resolved: 1, open: 0 },
      cleanliness: { status: 'passed', findings: [] },
    });

    expect(result.status).toBe('needs-review');
    expect(result.findings.map((finding) => finding.code)).toContain('repo-state-unavailable');
  });

  it('passes when verify, repo diff, ledger, and cleanliness all pass', () => {
    const result = evaluateLoopFinalAudit({
      goalIntent: 'implementation',
      mode: 'gate',
      verifyStatus: 'passed',
      repoComparison: comparison(),
      ledger: { total: 1, resolved: 1, open: 0 },
      cleanliness: { status: 'passed', findings: [] },
    });

    expect(result.status).toBe('passed');
    expect(result.coverage).toMatchObject({
      criteriaTotal: 1,
      criteriaVerified: 1,
      criteriaUnverified: 0,
      verifyCommandRan: true,
      repoComparisonRan: true,
      cleanlinessScanRan: true,
    });
  });

  it('needs review when plan packet criteria lack evidence', () => {
    const result = evaluateLoopFinalAudit({
      goalIntent: 'implementation',
      mode: 'gate',
      verifyStatus: 'passed',
      repoComparison: comparison(),
      ledger: { total: 1, resolved: 1, open: 0 },
      planPacket: {
        roadmapPath: '/repo/.aio-loop-state/loop/ROADMAP.md',
        phases: [],
        criteriaTotal: 3,
        criteriaWithEvidence: 1,
        malformed: false,
      },
      cleanliness: { status: 'passed', findings: [] },
    });

    expect(result.status).toBe('needs-review');
    expect(result.coverage.criteriaUnverified).toBe(2);
    expect(result.findings.map((finding) => finding.code)).toContain('plan-criteria-unproven');
  });

  it('needs review when the plan packet is malformed even if criteria have evidence', () => {
    const result = evaluateLoopFinalAudit({
      goalIntent: 'implementation',
      mode: 'gate',
      verifyStatus: 'passed',
      repoComparison: comparison(),
      ledger: { total: 1, resolved: 1, open: 0 },
      planPacket: {
        roadmapPath: '/repo/.aio-loop-state/loop/ROADMAP.md',
        phases: [],
        criteriaTotal: 1,
        criteriaWithEvidence: 1,
        malformed: true,
      },
      cleanliness: { status: 'passed', findings: [] },
    });

    expect(result.status).toBe('needs-review');
    expect(result.findings.map((finding) => finding.code)).toContain('plan-criteria-unproven');
  });
});

describe('scanAddedLinesForCleanliness', () => {
  it('detects conflict markers, focused tests, and debug statements in added lines only', () => {
    const result = scanAddedLinesForCleanliness([
      '+++ b/src/a.ts',
      '+<<<<<<< HEAD',
      '+it.only("does x", () => {})',
      '+console.log("debug")',
      '+debugger;',
      '-console.log("old")',
    ].join('\n'));

    expect(result.status).toBe('failed');
    expect(result.findings).toHaveLength(4);
    expect(result.findings.every((finding) => finding.severity === 'blocking')).toBe(true);
  });

  it('emits review findings for temporary marker comments', () => {
    const result = scanAddedLinesForCleanliness('+// FIXME remove after migration\n+const ok = true;');

    expect(result.status).toBe('passed');
    expect(result.findings).toEqual([
      expect.objectContaining({
        severity: 'review',
        code: 'cleanliness-blocking',
      }),
    ]);
  });
});

describe('renderLoopFinalAuditMarkdown', () => {
  it('renders status, findings, and changed files', () => {
    const result = evaluateLoopFinalAudit({
      goalIntent: 'implementation',
      mode: 'gate',
      verifyStatus: 'failed',
      repoComparison: comparison(),
      ledger: { total: 1, resolved: 1, open: 0 },
      cleanliness: { status: 'passed', findings: [] },
    });

    const markdown = renderLoopFinalAuditMarkdown(result);

    expect(markdown).toContain('# Loop Final Audit');
    expect(markdown).toContain('- Status: failed');
    expect(markdown).toContain('- Repo comparison source: git');
    expect(markdown).toContain('## Blocking Findings');
    expect(markdown).toContain('- verify-failed: The verify command failed.');
    expect(markdown).toContain('- src/a.ts');
  });
});
