import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markdownWorkSource } from './plan-queue-markdown-source';
import { LANDING_COMMIT_PREFIXES, type WorkCandidate } from './plan-queue-work-source';
import { allWorkSources, workSourceFor, workSourceForRun } from './plan-queue-work-sources';
import type { PlanQueueRun } from './plan-queue.types';

const plan = { sourceRef: '/repo/docs/plans/2026-11-04-pq-d1-work-source-layer_plan.md', sourceKind: 'markdown' } as const;
const livetest = { sourceRef: '/repo/docs/plans/2026-10-18-checkout-timeout_livetest.md', sourceKind: 'markdown' } as const;
const run = (kind: PlanQueueRun['kind']) => ({ kind });

describe('the markdown work source: names and landing text', () => {
  it('names an item by its file, with and without the extension', () => {
    expect(markdownWorkSource.displayName(plan)).toBe('2026-11-04-pq-d1-work-source-layer_plan');
    expect(markdownWorkSource.fullName(plan)).toBe('2026-11-04-pq-d1-work-source-layer_plan.md');
  });

  it('reads a Windows path the same way as a Mac one', () => {
    expect(markdownWorkSource.displayName({ sourceRef: 'C:\\work\\shop\\docs\\a_plan.md' })).toBe('a_plan');
  });

  it('builds the branch slug without the plan and livetest suffix', () => {
    expect(markdownWorkSource.branchSlug(plan)).toBe('2026-11-04-pq-d1-work-source-layer');
    expect(markdownWorkSource.branchSlug(livetest)).toBe('2026-10-18-checkout-timeout');
  });

  it('ties a checkpoint commit to the document', () => {
    expect(markdownWorkSource.checkpointTrailer(plan)).toBe(`Document: ${plan.sourceRef}`);
  });

  it('starts the landing commit with Plan or Livetest, which the interrupted-landing recogniser accepts', () => {
    expect(markdownWorkSource.commitSubject(plan, run('plans'))).toBe('Plan: 2026-11-04-pq-d1-work-source-layer_plan');
    expect(markdownWorkSource.commitSubject(livetest, run('livetests'))).toBe('Livetest: 2026-10-18-checkout-timeout_livetest');
    for (const subject of [markdownWorkSource.commitSubject(plan, run('plans')), markdownWorkSource.commitSubject(livetest, run('livetests'))]) {
      expect(LANDING_COMMIT_PREFIXES.some(prefix => subject.startsWith(`${prefix}: `))).toBe(true);
    }
  });

  it('lists Ticket for the Linear source that is coming, so an interrupted landing of it is still recognised', () => {
    expect(LANDING_COMMIT_PREFIXES).toContain('Ticket');
  });
});

describe('the markdown work source: references and readiness', () => {
  it('resolves a reported path against the run folder', () => {
    const forRun = { workspaceCwd: '/repo' } as PlanQueueRun;
    expect(markdownWorkSource.resolveRef(forRun, 'docs/plans/a_plan.md')).toBe('/repo/docs/plans/a_plan.md');
    expect(markdownWorkSource.resolveRef(forRun, '/repo/docs/../docs/plans/a_plan.md')).toBe('/repo/docs/plans/a_plan.md');
  });

  it('holds back only a not-ready spec: it waits for its plan', () => {
    const candidate = (ref: string, readiness: WorkCandidate['readiness']): WorkCandidate => ({ ref, readiness });
    expect(markdownWorkSource.awaitsPlan(candidate('/r/a_spec.md', 'not-ready'))).toBe(true);
    expect(markdownWorkSource.awaitsPlan(candidate('/r/A_SPEC.MD', 'not-ready'))).toBe(true);
    expect(markdownWorkSource.awaitsPlan(candidate('/r/a_spec.md', 'candidate'))).toBe(false);
    expect(markdownWorkSource.awaitsPlan(candidate('/r/a_plan.md', 'not-ready'))).toBe(false);
  });
});

describe('the markdown work source: discovery', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'pq-markdown-source-')));
    for (const file of ['docs/plans/b_plan.md', 'docs/plans/a_plan.md', 'docs/plans/c_livetest.md', 'docs/plans/d_spec.md', 'docs/plans/e_plan_completed.md']) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), '# Doc\n');
    }
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('returns the documents as candidates with their absolute path as the reference, in path order', async () => {
    expect(await markdownWorkSource.discover(root, { kind: 'plans' })).toEqual([
      { ref: join(root, 'docs/plans/a_plan.md'), readiness: 'candidate', reason: undefined },
      { ref: join(root, 'docs/plans/b_plan.md'), readiness: 'candidate', reason: undefined },
      { ref: join(root, 'docs/plans/d_spec.md'), readiness: 'not-ready', reason: 'this spec has no implementation plan yet' },
    ]);
    expect((await markdownWorkSource.discover(root, { kind: 'livetests' })).map(candidate => candidate.ref)).toEqual([join(root, 'docs/plans/c_livetest.md')]);
  });

  it('honours the glob', async () => {
    expect((await markdownWorkSource.discover(root, { kind: 'plans', glob: 'docs/plans/b_*' })).map(candidate => candidate.ref)).toEqual([join(root, 'docs/plans/b_plan.md')]);
  });
});

describe('finding a work source', () => {
  it('uses markdown for a row or fixture written before sources existed', () => {
    expect(workSourceFor(undefined)).toBe(markdownWorkSource);
    expect(workSourceFor('markdown')).toBe(markdownWorkSource);
  });

  it('uses markdown for plan runs and livetest runs alike', () => {
    expect(workSourceForRun({ kind: 'plans' })).toBe(markdownWorkSource);
    expect(workSourceForRun({ kind: 'livetests' })).toBe(markdownWorkSource);
    expect(allWorkSources()).toEqual([markdownWorkSource]);
  });
});
