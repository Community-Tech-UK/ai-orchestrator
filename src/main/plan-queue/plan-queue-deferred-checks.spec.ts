import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PlanQueueVerdict, PlanQueueWorkerReport } from '@contracts/schemas/plan-queue';
import {
  deferredPassProblems, findingKind, livetestPathsFor, parkingForDeferrals, parkingForFailure, refuseInconsistentVerdict, refuseUnclosedPlanPass,
} from './plan-queue-deferred-checks';

const verdict = (extra: Partial<PlanQueueVerdict>): PlanQueueVerdict => ({ verdict: 'FAIL', findings: [], gatesRun: [], documentComplete: true, needJames: [], ...extra });
const finding = (kind: 'code' | 'environment' | 'needs-human' | undefined, missing?: string) =>
  ({ severity: 'high' as const, confidence: 90, summary: `A ${kind ?? 'legacy'} finding.`, ...(kind ? { kind } : {}), ...(missing ? { missing } : {}) });
const report = (...titles: string[]): PlanQueueWorkerReport => ({ summary: 's', asBuilt: 'a', checksRun: [], followUps: [],
  deferredChecks: titles.map(title => ({ title, steps: 'x', expectedResult: 'y', whyDeferred: 'z' })) });

describe('finding kinds', () => {
  it('reads a stored finding with no kind as code', () => {
    expect(findingKind(finding(undefined))).toBe('code');
    expect(findingKind(finding('environment', 'Node 22'))).toBe('environment');
  });

  it('sets a FAIL aside only when every finding is environment or needs-human', () => {
    expect(parkingForFailure(verdict({ findings: [finding('environment', 'Node 22')] }))).toMatchObject({ reason: 'needs-setup' });
    expect(parkingForFailure(verdict({ findings: [finding('needs-human', 'A decision'), finding('environment', 'Node 22')] }))).toMatchObject({ reason: 'needs-james' });
    expect(parkingForFailure(verdict({ findings: [finding('environment', 'Node 22'), finding('code')] }))).toBeNull();
    expect(parkingForFailure(verdict({ findings: [finding(undefined)] }))).toBeNull();
    expect(parkingForFailure(verdict({ findings: [] }))).toBeNull();
    expect(parkingForFailure(verdict({ verdict: 'PASS', findings: [finding('environment', 'Node 22')] }))).toBeNull();
  });

  it('names each missing thing in plain words in the stop note', () => {
    const parking = parkingForFailure(verdict({ findings: [finding('needs-human', 'James\'s approval'), finding('environment', 'The signing certificate')] }))!;
    expect(parking.detail).toContain('Only you can provide:');
    expect(parking.detail).toContain('James\'s approval');
    expect(parking.detail).toContain('Missing setup on this computer:');
    expect(parking.detail).toContain('The signing certificate');
  });
});

describe('a verdict that contradicts itself', () => {
  it.each(['environment', 'needs-human'] as const)('refuses a %s finding that does not name the exact missing thing', kind => {
    expect(() => refuseInconsistentVerdict(verdict({ findings: [finding(kind)] }))).toThrow(/must name the exact missing thing/);
    expect(() => refuseInconsistentVerdict(verdict({ findings: [finding(kind, 'Node 22')] }))).not.toThrow();
  });
  it('accepts a code finding, or one stored without a kind, that names nothing', () => {
    expect(() => refuseInconsistentVerdict(verdict({ findings: [finding('code'), finding(undefined)] }))).not.toThrow();
  });
  it('refuses deferred checks without a criteria_total that covers them', () => {
    const deferredChecks = [{ title: 'a', whyDeferred: 'b' }, { title: 'c', whyDeferred: 'd' }];
    expect(() => refuseInconsistentVerdict(verdict({ deferredChecks }))).toThrow(/criteria_total/);
    expect(() => refuseInconsistentVerdict(verdict({ deferredChecks, criteriaTotal: 1 }))).toThrow(/criteria_total/);
    expect(() => refuseInconsistentVerdict(verdict({ deferredChecks, criteriaTotal: 2 }))).not.toThrow();
    expect(() => refuseInconsistentVerdict(verdict({}))).not.toThrow();
  });
});

describe('a passed plan is always closed', () => {
  it('refuses PASS with document_complete false for a plan only', () => {
    expect(() => refuseUnclosedPlanPass('plans', verdict({ verdict: 'PASS', documentComplete: false }))).toThrow(/always closed/);
    expect(() => refuseUnclosedPlanPass('plans', verdict({ verdict: 'PASS', documentComplete: true }))).not.toThrow();
    expect(() => refuseUnclosedPlanPass('plans', verdict({ verdict: 'FAIL', documentComplete: false }))).not.toThrow();
    expect(() => refuseUnclosedPlanPass('livetests', verdict({ verdict: 'PASS', documentComplete: false }))).not.toThrow();
  });
});

describe('deferral limit', () => {
  const deferred = (count: number) => Array.from({ length: count }, (_, i) => ({ title: `Check ${i}`, whyDeferred: 'Needs a rebuilt app.' }));
  it('sets a PASS aside when more than half of the criteria are deferred, and not at exactly half', () => {
    expect(parkingForDeferrals(verdict({ verdict: 'PASS', deferredChecks: deferred(3), criteriaTotal: 5 }))).toMatchObject({ reason: 'needs-james' });
    expect(parkingForDeferrals(verdict({ verdict: 'PASS', deferredChecks: deferred(2), criteriaTotal: 4 }))).toBeNull();
    expect(parkingForDeferrals(verdict({ verdict: 'PASS', deferredChecks: deferred(1), criteriaTotal: 4 }))).toBeNull();
  });
  it('ignores a verdict that defers nothing, an older verdict without the fields, and a FAIL', () => {
    expect(parkingForDeferrals(verdict({ verdict: 'PASS' }))).toBeNull();
    expect(parkingForDeferrals(verdict({ verdict: 'PASS', deferredChecks: [], criteriaTotal: 1 }))).toBeNull();
    expect(parkingForDeferrals(verdict({ verdict: 'FAIL', deferredChecks: deferred(3), criteriaTotal: 3 }))).toBeNull();
  });
});

describe('deferred checks against the report and the livetest document', () => {
  let dir: string;
  let plan: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'deferred-')); mkdirSync(dir, { recursive: true }); plan = join(dir, '2026-01-01-a_plan.md'); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const pass = (...titles: string[]) => verdict({ verdict: 'PASS', criteriaTotal: 9, deferredChecks: titles.map(title => ({ title, whyDeferred: 'z' })) });

  it('finds the livetest beside the plan under either naming', () => {
    expect(livetestPathsFor(plan).map(file => file.split('/').pop())).toEqual(['2026-01-01-a_plan_livetest.md', '2026-01-01-a_livetest.md']);
    expect(livetestPathsFor(join(dir, 'b_plan_completed.md')).map(file => file.split('/').pop())).toEqual(['b_plan_livetest.md', 'b_livetest.md']);
  });

  it('has nothing to say when no check is deferred', async () => {
    expect(await deferredPassProblems(pass(), null, plan)).toEqual([]);
    expect(await deferredPassProblems(verdict({ findings: [] }), null, plan)).toEqual([]);
  });

  it('refuses a deferred check the worker did not report', async () => {
    const problems = await deferredPassProblems(pass('Live check'), report('Another'), plan);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatchObject({ kind: 'code', summary: expect.stringContaining('"Live check"') });
    expect(await deferredPassProblems(pass('Live check'), null, plan)).toHaveLength(1);
  });

  it('refuses a deferred check missing from the livetest document, or a missing document', async () => {
    expect((await deferredPassProblems(pass('Live check'), report('Live check'), plan))[0].summary).toContain('No livetest document was found');
    writeFileSync(join(dir, '2026-01-01-a_plan_livetest.md'), '# Live checks\n\n## Something else\n');
    expect((await deferredPassProblems(pass('Live check'), report('Live check'), plan))[0].summary).toContain('does not contain this deferred check');
  });

  it('accepts a reported check written down under either livetest name, ignoring case and spacing', async () => {
    writeFileSync(join(dir, '2026-01-01-a_livetest.md'), '# Live checks\n\n## live   CHECK\n');
    expect(await deferredPassProblems(pass('Live check'), report('LIVE CHECK'), plan)).toEqual([]);
  });
});
