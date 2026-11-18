import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueControlPayload } from '@contracts/schemas/plan-queue';
import { gitExec } from '../workspace/git/git-exec';
import {
  LIVETEST_FIXTURE_LIMIT,
  PlanQueueLiveTestFixtureRemoveSchema,
  PlanQueueLiveTestFixtureStartSchema,
  PlanQueueLiveTestFixtures,
  type LiveTestFixtureCoordinator,
  type LiveTestFixtureRun,
} from './plan-queue-livetest-fixture';

const ROUTING = { workers: [{ provider: 'codex' }], verifiers: [{ provider: 'claude' }] };
const start = { parentInstanceId: 'parent-1', routing: ROUTING, workload: 'small' as const };

let dataPath: string | null;
let outside: string;
let runs: Map<string, LiveTestFixtureRun>;
let controls: PlanQueueControlPayload[];
let ids: number;
let coordinator: LiveTestFixtureCoordinator & { startRun: ReturnType<typeof vi.fn> };
let afterCancel: LiveTestFixtureRun['items'] | null;

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const make = (): PlanQueueLiveTestFixtures => new PlanQueueLiveTestFixtures({ coordinator, dataPath: () => dataPath, newId: () => uuid(++ids), now: () => 1_000 + ids });

beforeEach(() => {
  dataPath = realpathSync(mkdtempSync('/tmp/aio-lt-fixture-spec-'));
  outside = realpathSync(mkdtempSync('/tmp/aio-lt-fixture-outside-'));
  runs = new Map();
  controls = [];
  ids = 0;
  afterCancel = null;
  coordinator = {
    startRun: vi.fn(async (input: { workspaceCwd?: string }) => {
      const run: LiveTestFixtureRun = { id: `run-${runs.size + 1}`, status: 'running', items: [{ id: `item-${runs.size + 1}`, state: 'queued' }] };
      runs.set(run.id, run);
      expect(input.workspaceCwd).toBeTruthy();
      return { run, routingSetAside: [] as string[] };
    }),
    getRunDto: (runId: string) => runs.get(runId) ?? null,
    control: async (payload: PlanQueueControlPayload) => {
      controls.push(payload);
      if (payload.action === 'cancel') {
        const run = runs.get(payload.runId)!;
        runs.set(run.id, { ...run, status: 'cancelled', items: afterCancel ?? run.items.map(item => ({ ...item, state: 'parked' as const })) });
      } else if (payload.action === 'discard-item') {
        for (const run of runs.values()) {
          runs.set(run.id, { ...run, items: run.items.map(item => (item.id === payload.itemId ? { ...item, discardedAt: 5 } : item)) });
        }
      }
    },
  };
});

afterEach(() => {
  for (const dir of [dataPath, outside]) if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('test queue runs outside a live-test copy', () => {
  it('refuses to start, list or remove', async () => {
    dataPath = null;
    const fixtures = make();
    await expect(fixtures.start(start)).rejects.toThrow(/live-test copy/);
    expect(() => fixtures.list()).toThrow(/live-test copy/);
    await expect(fixtures.remove(uuid(1))).rejects.toThrow(/live-test copy/);
    expect(coordinator.startRun).not.toHaveBeenCalled();
  });
});

describe('starting a test queue run', () => {
  it('makes a repository inside the profile with a clean commit and an untracked plan, and starts the run on it', async () => {
    const summary = await make().start(start);
    const repo = join(dataPath!, 'queue-fixtures', uuid(1), 'repo');
    expect(summary).toMatchObject({ fixtureId: uuid(1), runId: 'run-1', runStatus: 'running', repo, repoExists: true, parentInstanceId: 'parent-1' });
    expect(await gitExec(['rev-parse', '--abbrev-ref', 'HEAD'], repo)).toBe('main');
    expect(await gitExec(['status', '--porcelain'], repo)).toBe('?? docs/');
    expect(readFileSync(summary.planPath, 'utf8')).toContain('queue fixture ok');
    expect(coordinator.startRun).toHaveBeenCalledWith({
      parentInstanceId: 'parent-1', kind: 'plans', workspaceCwd: repo, glob: 'docs/plans/queue-fixture_plan.md', routing: ROUTING,
      config: { keepOnThisMac: true },
    });
  });

  it('makes a longer plan for the long workload', async () => {
    const summary = await make().start({ ...start, workload: 'long' });
    expect(readFileSync(summary.planPath, 'utf8')).toContain('part-30.txt');
  });

  it('reports a saved routing list that took the place of the one asked for', async () => {
    coordinator.startRun.mockResolvedValueOnce({ run: { id: 'run-x', status: 'running', items: [] }, routingSetAside: ['workers'] });
    expect(await make().start(start)).toMatchObject({ routingSetAside: ['workers'] });
  });

  it('removes its folder and record when the queue refuses the run, and keeps the other fixtures', async () => {
    const fixtures = make();
    await fixtures.start(start);
    coordinator.startRun.mockRejectedValueOnce(new Error('No checker can check this worker'));
    await expect(fixtures.start(start)).rejects.toThrow(/No checker/);
    expect(existsSync(join(dataPath!, 'queue-fixtures', uuid(2)))).toBe(false);
    expect(fixtures.list().map(entry => entry.fixtureId)).toEqual([uuid(1)]);
  });

  it(`allows only ${LIVETEST_FIXTURE_LIMIT} at once, even when starts overlap`, async () => {
    const fixtures = make();
    await fixtures.start(start);
    await fixtures.start(start);
    const settled = await Promise.allSettled([fixtures.start(start), fixtures.start(start)]);
    expect(settled.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(fixtures.list()).toHaveLength(LIVETEST_FIXTURE_LIMIT);
  });

  it('is still listed, and removable, after the app restarts', async () => {
    await make().start(start);
    const restarted = make();
    expect(restarted.list().map(entry => entry.fixtureId)).toEqual([uuid(1)]);
    await restarted.remove(uuid(1));
    expect(restarted.list()).toEqual([]);
  });

  it('refuses a damaged record without changing it', async () => {
    const fixtures = make();
    await fixtures.start(start);
    const file = join(dataPath!, 'queue-fixtures', 'registry.json');
    writeFileSync(file, '{"nope":true}');
    await expect(fixtures.start(start)).rejects.toThrow(/damaged/);
    expect(readFileSync(file, 'utf8')).toBe('{"nope":true}');
  });
});

describe('removing a test queue run', () => {
  it('cancels a running run, discards its parked jobs, then deletes only that fixture', async () => {
    const fixtures = make();
    await fixtures.start(start);
    await fixtures.start(start);
    const result = await fixtures.remove(uuid(1));
    expect(result).toEqual({ fixtureId: uuid(1), cancelledRun: true, discardedJobs: 1 });
    expect(controls).toEqual([{ action: 'cancel', runId: 'run-1' }, { action: 'discard-item', itemId: 'item-1' }]);
    expect(existsSync(join(dataPath!, 'queue-fixtures', uuid(1)))).toBe(false);
    expect(existsSync(join(dataPath!, 'queue-fixtures', uuid(2), 'repo'))).toBe(true);
    expect(fixtures.list().map(entry => entry.fixtureId)).toEqual([uuid(2)]);
  });

  it('does not cancel a finished run again, and does not discard a job twice', async () => {
    const fixtures = make();
    await fixtures.start(start);
    runs.set('run-1', { id: 'run-1', status: 'cancelled', items: [{ id: 'item-1', state: 'parked', discardedAt: 3 }] });
    expect(await fixtures.remove(uuid(1))).toEqual({ fixtureId: uuid(1), cancelledRun: false, discardedJobs: 0 });
    expect(controls).toEqual([]);
  });

  it('refuses an id this copy never made and touches nothing', async () => {
    const fixtures = make();
    await fixtures.start(start);
    mkdirSync(join(dataPath!, 'queue-fixtures', uuid(9), 'repo'), { recursive: true });
    await expect(fixtures.remove(uuid(9))).rejects.toThrow(/made no test queue run/);
    expect(existsSync(join(dataPath!, 'queue-fixtures', uuid(9), 'repo'))).toBe(true);
    expect(controls).toEqual([]);
  });

  it('clears a stale record whose run and folder are already gone', async () => {
    const fixtures = make();
    await fixtures.start(start);
    runs.clear();
    rmSync(join(dataPath!, 'queue-fixtures', uuid(1)), { recursive: true });
    expect(fixtures.list()).toEqual([expect.objectContaining({ runStatus: null, repoExists: false })]);
    await fixtures.remove(uuid(1));
    expect(fixtures.list()).toEqual([]);
    expect(controls).toEqual([]);
  });

  it('keeps the folder and the record when a job is still running after the cancel', async () => {
    const fixtures = make();
    await fixtures.start(start);
    afterCancel = [{ id: 'item-1', state: 'working' }];
    await expect(fixtures.remove(uuid(1))).rejects.toThrow(/not stopped/);
    expect(existsSync(join(dataPath!, 'queue-fixtures', uuid(1), 'repo'))).toBe(true);
    expect(fixtures.list()).toHaveLength(1);
    afterCancel = null;
    runs.set('run-1', { ...runs.get('run-1')!, items: [{ id: 'item-1', state: 'parked' }] });
    await fixtures.remove(uuid(1));
    expect(fixtures.list()).toEqual([]);
  });

  it('will not delete a folder that has been replaced by a link elsewhere', async () => {
    const fixtures = make();
    await fixtures.start(start);
    writeFileSync(join(outside, 'precious.txt'), 'keep');
    const folder = join(dataPath!, 'queue-fixtures', uuid(1));
    rmSync(folder, { recursive: true });
    symlinkSync(outside, folder);
    runs.clear();
    await expect(fixtures.remove(uuid(1))).rejects.toThrow(/left alone/);
    expect(readFileSync(join(outside, 'precious.txt'), 'utf8')).toBe('keep');
    expect(fixtures.list()).toHaveLength(1);
  });
});

describe('fixture payloads', () => {
  it('needs workers and checkers named, and refuses a folder, a path or an unknown field', () => {
    expect(PlanQueueLiveTestFixtureStartSchema.safeParse(start).success).toBe(true);
    expect(PlanQueueLiveTestFixtureStartSchema.parse({ ...start, workload: undefined }).workload).toBe('small');
    expect(PlanQueueLiveTestFixtureStartSchema.safeParse({ ...start, routing: { workers: [], verifiers: [{ provider: 'claude' }] } }).success).toBe(false);
    expect(PlanQueueLiveTestFixtureStartSchema.safeParse({ ...start, routing: { workers: [{ provider: 'codex' }], verifiers: [] } }).success).toBe(false);
    expect(PlanQueueLiveTestFixtureStartSchema.safeParse({ ...start, workspaceCwd: '/Users/someone/real-project' }).success).toBe(false);
    expect(PlanQueueLiveTestFixtureStartSchema.safeParse({ ...start, workload: 'huge' }).success).toBe(false);
  });

  it('accepts only a fixture id of the form this module makes', () => {
    expect(PlanQueueLiveTestFixtureRemoveSchema.safeParse({ fixtureId: uuid(1) }).success).toBe(true);
    for (const fixtureId of ['../../etc', '/tmp/x', 'run-1', `${uuid(1)}/..`]) {
      expect(PlanQueueLiveTestFixtureRemoveSchema.safeParse({ fixtureId }).success).toBe(false);
    }
  });
});
