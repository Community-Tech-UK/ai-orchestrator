/**
 * A disposable Plan Queue run for live tests, in a live-test copy of Harness only.
 *
 * A live test of queue behaviour (a job stopped by a limit, kept parked across a restart, a fresh checker profile) needs a
 * real run: a git repository with a plan in it, a worker and a checker, and a way to take all of it away afterwards. The
 * ordinary start needs a repository chosen by the caller and leaves nothing that says the run was a test. This module
 * makes the repository itself, inside the copy's own profile folder, starts the run through the coordinator's normal
 * start, and records what it made so only that can be removed.
 *
 * Bounds: it refuses outside a verified live-test copy (`live-test-context.ts`); the caller never names a folder, so a
 * run can only be on a repository this module created; at most three fixtures exist at once; and removal accepts only a
 * fixture id this profile recorded, deleting only the folder it derives from that id, never one read from the record.
 * The record lives in the profile folder, so a fixture is still listed, and still removable, after the copy restarts.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { z } from 'zod';
import { PlanQueueRouteChoiceSchema, type PlanQueueControlPayload, type PlanQueueItemState, type PlanQueueRunStatus } from '@contracts/schemas/plan-queue';
import { harnessLiveTestDataPath } from '../app/live-test-context';
import { getLogger } from '../logging/logger';
import { gitExec } from '../workspace/git/git-exec';
import type { StartRunInput } from './plan-queue-coordinator';

const logger = getLogger('PlanQueueLiveTestFixture');

export const LIVETEST_FIXTURE_LIMIT = 3;
const FIXTURE_FOLDER = 'queue-fixtures';
const REGISTRY_FILE = 'registry.json';
const PLAN_RELATIVE_PATH = 'docs/plans/queue-fixture_plan.md';
const ID_PATTERN = /^[a-f0-9-]{36}$/;

export const PlanQueueLiveTestFixtureStartSchema = z.object({
  /** An ordinary session in this copy. It becomes the run's parent; the queue refuses one of its own sessions. */
  parentInstanceId: z.string().min(1).max(200),
  /** Named in full: the run never takes the copy's saved routing by accident. A saved list still wins, and the result says so. */
  routing: z.object({
    workers: z.array(PlanQueueRouteChoiceSchema).min(1).max(10),
    verifiers: z.array(PlanQueueRouteChoiceSchema).min(1).max(10),
    stepUp: PlanQueueRouteChoiceSchema.optional(),
  }).strict(),
  /** `small` finishes in a few minutes; `long` keeps a worker busy long enough for a limit or a restart to land mid-job. */
  workload: z.enum(['small', 'long']).default('small'),
}).strict();
export const PlanQueueLiveTestFixtureRemoveSchema = z.object({ fixtureId: z.string().regex(ID_PATTERN) }).strict();
export type PlanQueueLiveTestFixtureStart = z.infer<typeof PlanQueueLiveTestFixtureStartSchema>;

interface FixtureRecord { id: string; runId: string | null; parentInstanceId: string; workload: 'small' | 'long'; createdAt: number }

export interface LiveTestFixtureRun {
  id: string;
  status: PlanQueueRunStatus;
  items: ReadonlyArray<{ id: string; state: PlanQueueItemState; discardedAt?: number | null }>;
}

/** The coordinator calls the fixture uses; the real coordinator satisfies it as it is. */
export interface LiveTestFixtureCoordinator {
  startRun(input: StartRunInput): Promise<{ run: LiveTestFixtureRun; routingSetAside: readonly string[] }>;
  getRunDto(runId: string): LiveTestFixtureRun | null;
  control(payload: PlanQueueControlPayload): Promise<void>;
}

export interface LiveTestFixtureDeps {
  coordinator: LiveTestFixtureCoordinator;
  /** The verified live-test profile folder, or null outside a live-test copy. */
  dataPath: () => string | null;
  newId: () => string;
  now: () => number;
}

export interface LiveTestFixtureSummary {
  fixtureId: string;
  runId: string | null;
  /** null when the run is no longer in this copy's queue (stale record). */
  runStatus: PlanQueueRunStatus | null;
  parentInstanceId: string;
  workload: 'small' | 'long';
  repoExists: boolean;
  repo: string;
  planPath: string;
}

const isStillLive = (item: LiveTestFixtureRun['items'][number]): boolean =>
  !(item.state === 'skipped' || item.state === 'landed' || (item.state === 'parked' && item.discardedAt));

const PLANS: Record<'small' | 'long', string> = {
  small: [
    '# Queue fixture plan',
    '',
    '## Status',
    '',
    'Active. A disposable plan made by a live test of Plan Queue; nothing here is real work.',
    '',
    '## Acceptance',
    '',
    '- [ ] Create `fixture-output.txt` in the repository root containing exactly one line: `queue fixture ok`.',
    '',
  ].join('\n'),
  long: [
    '# Queue fixture plan (long)',
    '',
    '## Status',
    '',
    'Active. A disposable plan made by a live test of Plan Queue; nothing here is real work. It is long on purpose, so a limit or a restart can land while the job runs.',
    '',
    '## Acceptance',
    '',
    ...Array.from({ length: 30 }, (_, index) => {
      const number = String(index + 1).padStart(2, '0');
      return `- [ ] Create \`part-${number}.txt\` containing the line \`part ${number}\`, then run \`ls | wc -l\` and note the count before starting the next item. Do them one at a time, in order.`;
    }),
    '',
  ].join('\n'),
};

export class PlanQueueLiveTestFixtures {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: LiveTestFixtureDeps) {}

  /** Start and remove take turns, so two calls never read and write the record at once. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private base(): string {
    const dataPath = this.deps.dataPath();
    if (!dataPath) throw new Error('Test queue runs can only be made in a live-test copy of Harness. This is not one.');
    return join(dataPath, FIXTURE_FOLDER);
  }

  private registryPath(): string { return join(this.base(), REGISTRY_FILE); }
  private folderOf(id: string): string { return join(this.base(), id); }
  private repoOf(id: string): string { return join(this.folderOf(id), 'repo'); }

  private readRecords(): FixtureRecord[] {
    const file = this.registryPath();
    if (!existsSync(file)) return [];
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const records = (parsed as { fixtures?: unknown } | null)?.fixtures;
    if (!Array.isArray(records)) throw new Error('The test fixture record is damaged; it was not changed.');
    return records as FixtureRecord[];
  }

  private writeRecords(records: FixtureRecord[]): void {
    mkdirSync(this.base(), { recursive: true, mode: 0o700 });
    const file = this.registryPath();
    writeFileSync(`${file}.tmp`, `${JSON.stringify({ version: 1, fixtures: records })}\n`, { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  private summarise(record: FixtureRecord): LiveTestFixtureSummary {
    const repo = this.repoOf(record.id);
    return {
      fixtureId: record.id, runId: record.runId, parentInstanceId: record.parentInstanceId, workload: record.workload,
      runStatus: record.runId ? this.deps.coordinator.getRunDto(record.runId)?.status ?? null : null,
      repoExists: existsSync(repo), repo, planPath: join(repo, PLAN_RELATIVE_PATH),
    };
  }

  list(): LiveTestFixtureSummary[] {
    return this.readRecords().map(record => this.summarise(record));
  }

  start(input: PlanQueueLiveTestFixtureStart): Promise<LiveTestFixtureSummary & { routingSetAside: readonly string[] }> {
    return this.serial(async () => {
      this.base();
      const existing = this.readRecords();
      if (existing.length >= LIVETEST_FIXTURE_LIMIT) {
        throw new Error(`This copy already has ${existing.length} test queue runs. Remove one first (fixtureId: ${existing.map(r => r.id).join(', ')}).`);
      }
      const id = this.deps.newId();
      if (!ID_PATTERN.test(id)) throw new Error('A test fixture id must be a UUID.');
      const record: FixtureRecord = { id, runId: null, parentInstanceId: input.parentInstanceId, workload: input.workload, createdAt: this.deps.now() };
      // Recorded before anything is made, so a crash part-way still leaves a fixture that can be removed.
      this.writeRecords([...existing, record]);
      const repo = this.repoOf(id);
      let started: Awaited<ReturnType<LiveTestFixtureCoordinator['startRun']>>;
      try {
        mkdirSync(repo, { recursive: true, mode: 0o700 });
        await this.makeRepository(repo, input.workload);
        started = await this.deps.coordinator.startRun({
          parentInstanceId: input.parentInstanceId, kind: 'plans', workspaceCwd: repo, glob: PLAN_RELATIVE_PATH, routing: input.routing,
          // The repository exists only in this copy's profile, so no job may be sent to another computer.
          config: { keepOnThisMac: true },
        });
      } catch (error) {
        // The run was refused or never began, so nothing but this folder and its record exists.
        this.discardFolder(id);
        this.writeRecords(existing);
        throw error;
      }
      record.runId = started.run.id;
      this.writeRecords([...existing, record]);
      logger.info('Test queue run made', { fixtureId: id, runId: record.runId, workload: input.workload });
      return { ...this.summarise(record), routingSetAside: started.routingSetAside };
    });
  }

  /** Cancels the run, discards its jobs through the queue's own controls, then deletes the repository this module made. */
  remove(fixtureId: string): Promise<{ fixtureId: string; cancelledRun: boolean; discardedJobs: number }> {
    return this.serial(async () => {
      const records = this.readRecords();
      const record = records.find(candidate => candidate.id === fixtureId);
      if (!record) throw new Error(`This copy made no test queue run ${fixtureId}, so it will not remove one.`);
      let cancelledRun = false;
      let discardedJobs = 0;
      const run = record.runId ? this.deps.coordinator.getRunDto(record.runId) : null;
      if (record.runId && run) {
        if (run.status === 'running' || run.status === 'paused') {
          await this.deps.coordinator.control({ action: 'cancel', runId: record.runId });
          cancelledRun = true;
        }
        // A discarded job stays `parked` with a discard time; it is the discard that stops its sessions and clears its folder.
        for (const item of this.deps.coordinator.getRunDto(record.runId)?.items ?? []) {
          if (item.state !== 'parked' || item.discardedAt) continue;
          await this.deps.coordinator.control({ action: 'discard-item', itemId: item.id });
          discardedJobs += 1;
        }
        const left = (this.deps.coordinator.getRunDto(record.runId)?.items ?? []).filter(isStillLive);
        if (left.length > 0) {
          throw new Error(`The test queue run still has ${left.length} job(s) that are not stopped, so its folder was kept. Try again.`);
        }
      }
      this.discardFolder(fixtureId);
      this.writeRecords(records.filter(candidate => candidate.id !== fixtureId));
      logger.info('Test queue run removed', { fixtureId, cancelledRun, discardedJobs });
      return { fixtureId, cancelledRun, discardedJobs };
    });
  }

  private async makeRepository(repo: string, workload: 'small' | 'long'): Promise<void> {
    await gitExec(['init', '--quiet', '--initial-branch=main'], repo);
    writeFileSync(join(repo, 'README.md'), '# Queue fixture\n\nA disposable repository made by a live test of Plan Queue.\n');
    await gitExec(['add', 'README.md'], repo);
    await gitExec(['-c', 'user.name=Queue fixture', '-c', 'user.email=queue-fixture@invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Queue fixture'], repo);
    // Left uncommitted, like a real plan: planning documents are never part of the work's commits.
    mkdirSync(join(repo, 'docs', 'plans'), { recursive: true });
    writeFileSync(join(repo, PLAN_RELATIVE_PATH), PLANS[workload]);
  }

  /** Deletes the folder derived from the id, and only when it is a real folder inside the fixture folder. */
  private discardFolder(id: string): void {
    const folder = this.folderOf(id);
    if (!existsSync(folder)) return;
    const stat = lstatSync(folder);
    const plain = !stat.isSymbolicLink() && stat.isDirectory();
    if (!plain || !realpathSync(folder).startsWith(`${realpathSync(this.base())}${sep}`)) throw new Error(`The test fixture folder ${folder} is not a plain folder inside the fixture folder, so it was left alone.`);
    rmSync(folder, { recursive: true, force: true });
  }
}

let instance: PlanQueueLiveTestFixtures | null = null;

export function getPlanQueueLiveTestFixtures(coordinator: LiveTestFixtureCoordinator): PlanQueueLiveTestFixtures {
  instance ??= new PlanQueueLiveTestFixtures({ coordinator, dataPath: harnessLiveTestDataPath, newId: randomUUID, now: Date.now });
  return instance;
}

export function _resetForTesting(): void { instance = null; }
