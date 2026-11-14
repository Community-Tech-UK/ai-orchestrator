/**
 * A real Plan Queue coordinator and item flow with a plan job placed on another computer: the computer is the worker's
 * real `QueueJobHost` (real git, real folders) reached through its dispatcher, and the agent is a scripted fake that
 * works in the far folders it is given.
 */
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type { QueueJobComputer } from '../../shared/types/plan-queue-computers.types';
import type { WorkerNodeCapabilities } from '../../shared/types/worker-node.types';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { _resetReclaimHoldsForTesting } from '../process/reclaim-holds';
import { runQueueJobCall } from '../../worker-agent/queue-jobs/queue-job-dispatch';
import { makeFixture, type Fixture } from '../../worker-agent/queue-jobs/queue-job-fixture.test-helpers';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { WorktreeManager } from '../workspace/git/worktree-manager';
import { InputTurnRegistry } from '../instance/input-turn-registry';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import { _setPlanQueueDataDirForTesting } from './plan-queue-data-dir';
import type { PlanQueueInstanceRecord } from './plan-queue-host';
import { PlanQueueStore } from './plan-queue-store';
import { _setReportRequiredProvidersForTesting } from './plan-queue-worker-report';
import { RpcQueueJobLink } from './remote/queue-job-link';
import { RemoteQueueJobs } from './remote/queue-job-remote';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

vi.mock('./plan-queue-gate-receipts', async original => {
  const actual = await original<typeof import('./plan-queue-gate-receipts')>();
  return { ...actual, PlanQueueGateRunner: class extends actual.PlanQueueGateRunner {
    constructor() { super(async () => ({ exitCode: 0, output: '✓ 1 files · 1 tests passed in 0s', timedOut: false })); }
  } };
});

type Role = 'parent' | 'worker' | 'verifier' | 'triage';
type Script = (instance: FakeInstance, message: string) => void | Promise<void>;
interface FakeInstance extends PlanQueueInstanceRecord { outputBuffer: { type: string; content: string }[]; config: InstanceCreateConfig; role: Role }

let repo: string;
let driver: SqliteDriver;
let store: PlanQueueStore;
let fake: FakeInstances;
let coordinator: PlanQueueCoordinator;
let far: Fixture;
let connected: boolean;
let computers: QueueJobComputer[];
let dataDir: string;
let seq = 0;

const git = (args: string[], cwd = repo): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

class FakeInstances extends EventEmitter {
  readonly live = new Map<string, FakeInstance>();
  readonly created: FakeInstance[] = [];
  readonly inputs: { instanceId: string; message: string }[] = [];
  readonly scripts: Partial<Record<Role, Script>> = {};
  restartFreshInstance = vi.fn(async () => undefined);
  private make(role: Role, config: InstanceCreateConfig, provider: string): FakeInstance {
    seq += 1;
    const instance: FakeInstance = { id: `${role}-${seq}`, status: 'initializing', outputBuffer: [], provider, workingDirectory: config.workingDirectory,
      metadata: config.metadata, parentId: config.parentId ?? null, createdAt: seq, config, role };
    this.live.set(instance.id, instance); this.created.push(instance);
    return instance;
  }
  addParent(): FakeInstance { const parent = this.make('parent', { workingDirectory: repo } as InstanceCreateConfig, 'claude'); parent.status = 'idle'; parent.historyThreadId = `thread-${parent.id}`; return parent; }
  async createInstance(config: InstanceCreateConfig): Promise<{ id: string }> {
    const instance = this.make((config.metadata?.['planQueueRole'] as Role | undefined) ?? 'worker', config, config.provider ?? 'claude');
    setImmediate(() => void this.turn(instance, config.initialPrompt ?? ''));
    return { id: instance.id };
  }
  async sendInput(instanceId: string, message: string): Promise<void> {
    const instance = this.live.get(instanceId);
    if (!instance) throw new Error(`no instance ${instanceId}`);
    this.inputs.push({ instanceId, message });
    if (instance.role !== 'parent') setImmediate(() => void this.turn(instance, message));
  }
  async terminateInstance(instanceId: string): Promise<void> {
    const instance = this.live.get(instanceId);
    if (!instance) return;
    this.setStatus(instance, 'terminated'); this.live.delete(instanceId); this.emit('instance:removed', instanceId);
  }
  getInstance(id: string): FakeInstance | undefined { return this.live.get(id); }
  getAllInstances(): FakeInstance[] { return [...this.live.values()]; }
  adoptOrphanInstance(): boolean { return false; }
  setStatus(instance: FakeInstance, status: FakeInstance['status']): void {
    const previousStatus = instance.status; instance.status = status;
    this.emit('instance:event', { eventId: 'e', seq: 0, timestamp: 0, instanceId: instance.id, event: { kind: 'status_changed', previousStatus, status } });
  }
  private async turn(instance: FakeInstance, message: string): Promise<void> {
    if (!this.live.has(instance.id)) return;
    this.setStatus(instance, 'busy');
    await this.scripts[instance.role]?.(instance, message);
    if (!this.live.has(instance.id) || instance.status !== 'busy') return;
    instance.outputBuffer.push({ type: 'assistant', content: `${instance.role} finished` });
    this.emit('provider:normalized-event', { eventId: 'e', seq: 0, timestamp: 0, provider: 'claude', instanceId: instance.id, event: { kind: 'output', messageType: 'assistant', content: `${instance.role} finished` } });
    this.setStatus(instance, 'idle');
  }
}

const write = (file: string, text: string): void => { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, text); };
const itemIdOf = (instance: FakeInstance): string => instance.config.metadata?.['planQueueItemId'] as string;
const STEM = '2026-01-01-alpha';
const DEFERRED = { title: 'Run it on the real app', steps: 'Start it.', expectedResult: 'It works.', whyDeferred: 'Needs a rebuilt app.' };

function planDoc(): string {
  write(join(repo, `docs/plans/${STEM}_spec_planned.md`), `# Spec\n\n**Plan:** [plan](./${STEM}_plan.md)\n`);
  const plan = join(repo, `docs/plans/${STEM}_plan.md`);
  write(plan, `# Plan\n\n**Spec:** [spec](./${STEM}_spec_planned.md)\n\n- [ ] build it\n`);
  return plan;
}

/** The agent on the other computer: works in the folders its prompt names, and writes its report file. */
function farWorker(options: { deferred?: boolean; report?: boolean } = {}): Script {
  return instance => {
    const prompt = instance.config.initialPrompt ?? '';
    const document = /Your document is `([^`]+)`/.exec(prompt)?.[1];
    const reportFile = /JSON file at `([^`]+)`/.exec(prompt)?.[1];
    write(join(instance.workingDirectory!, 'alpha.feature.txt'), 'built alpha\n');
    if (document) write(document, `${readFileSync(document, 'utf8')}\nAs built: done on the PC.\n`);
    if (options.deferred && document) write(join(dirname(document), `${STEM}_plan_livetest.md`), `# Live checks\n\n## ${DEFERRED.title}\n\nSteps: ${DEFERRED.steps}\n`);
    if (options.report !== false && reportFile) {
      write(reportFile, JSON.stringify({ item_id: itemIdOf(instance), summary: 'Built it on the PC.', as_built: 'Done.', checks_run: [{ command: 'npm run lint', exitCode: 0 }],
        deferred_checks: options.deferred ? [DEFERRED] : [], follow_ups: [] }));
    }
  };
}
const pass: Script = instance => {
  coordinator.reportVerdict(instance.id, { item_id: itemIdOf(instance), verdict: 'PASS', findings: [], gates_run: [], document_complete: true, need_james: [], not_checked: [] });
};
const passDeferring: Script = instance => {
  coordinator.reportVerdict(instance.id, { item_id: itemIdOf(instance), verdict: 'PASS', findings: [], gates_run: [], document_complete: true, need_james: [], not_checked: [],
    deferred_checks: [{ title: DEFERRED.title, whyDeferred: DEFERRED.whyDeferred }], criteria_total: 4 } as Parameters<typeof coordinator.reportVerdict>[1]);
};
const triageReady: Script = instance => {
  const runId = instance.config.metadata?.['planQueueRunId'] as string;
  const documents = instance.config.initialPrompt!.match(/<documents>\n([\s\S]*?)\n<\/documents>/)![1].split('\n');
  coordinator.reportTriage(instance.id, { run_id: runId, records: coordinator.getRunDto(runId)!.items.filter(i => i.state === 'discovered' && documents.includes(i.sourceRef))
    .map(i => ({ documentPath: i.sourceRef, disposition: 'ready' as const })) } as Parameters<typeof coordinator.reportTriage>[1]);
};
const waitForRun = (runId: string): Promise<void> => vi.waitFor(() => {
  const status = coordinator.getRunDto(runId)?.status;
  if (status !== 'completed' && status !== 'cancelled') throw new Error(`run is ${status}`);
}, { timeout: 40_000, interval: 50 });

beforeEach(() => {
  WorktreeManager._resetForTesting(); GitWriteQueue._resetForTesting(); PlanQueueCoordinator._resetForTesting(); _resetReclaimHoldsForTesting();
  // These agents end their turn instead of calling the report tool; the report file is what is under test here.
  _setReportRequiredProvidersForTesting(new Set());
  connected = true;
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-remote-')));
  git(['init', '-q', '-b', 'main']); git(['config', 'user.name', 'Plan Queue Test']); git(['config', 'user.email', 'plan-queue@example.invalid']); git(['config', 'commit.gpgsign', 'false']);
  write(join(repo, '.gitignore'), '.worktrees/\n'); write(join(repo, 'a.txt'), 'base\n');
  git(['add', '-A']); git(['commit', '-q', '-m', 'base']);
  // The far side's own folder maker, so this test process's one WorktreeManager stays the Mac's alone.
  far = makeFixture({ createWorktree: async request => {
    const folder = join(request.installedPath, '..', '..', 'queue-worktrees', ...request.branch.split('/'));
    mkdirSync(dirname(folder), { recursive: true });
    git(['worktree', 'add', '-q', '-b', request.branch, folder, request.commit], request.installedPath);
    return folder;
  } });
  dataDir = join(far.dir, 'data');
  _setPlanQueueDataDirForTesting(dataDir);
  driver = new Database(':memory:') as unknown as SqliteDriver;
  driver.exec('PRAGMA foreign_keys = ON');
  runLoopMigrations(driver);
  store = new PlanQueueStore(driver);
  fake = new FakeInstances();
  fake.scripts.triage = triageReady; fake.scripts.worker = farWorker(); fake.scripts.verifier = pass;
  const jobs = new RemoteQueueJobs(new RpcQueueJobLink({
    getNode: () => ({ name: 'the Windows PC', status: connected ? 'connected' : 'disconnected', capabilities: { queueJobs: 1 } } as never),
    send: (_nodeId, method, params) => runQueueJobCall(far.host, method, params),
  }));
  computers = [{ nodeId: 'pc', label: 'the Windows PC', takesJobs: true, paused: false, jobsAtOnce: 2, projects: { [jobs.projectKey(repo)]: { ok: true, checkedAt: 1, problem: null, summary: 'fine' } } }];
  coordinator = PlanQueueCoordinator.getInstance();
  coordinator.initialize({
    store, instances: fake, worktreeCreator: WorktreeManager.getInstance(), skipInstall: true,
    selectVerifier: async () => ({ ok: true, choice: { provider: 'codex' } }),
    routing: { readSaved: () => ({ workers: [], verifiers: [] }), readAccountRules: () => ({ never: [], last: [] }), copilotProfileFor: () => null, poolProfiles: () => [],
      copilotProfiles: () => [], isProviderExcluded: () => false, defaultProvider: () => null, checkerScopeKind: () => 'none', listInstalledProviders: async () => ['claude', 'codex'],
      routeUsage: async () => ({ usable: true, resumeAt: null }) },
    folderChecklists: () => [], thisRepositoryRootCommit: 'not-a-real-commit', loadAverage: () => [0, 0, 0], personTurns: new InputTurnRegistry(), relaxation: null, pumpIntervalMs: null,
    remote: {
      jobs, computers: () => ({ list: () => computers }),
      nodes: { isConnected: () => connected, capabilities: () => ({ queueJobs: 1, signIns: [{ provider: 'claude', profileId: 'legacy', state: 'signed-in' }] }) as WorkerNodeCapabilities },
      removalsFile: join(dataDir, 'removals.json'), awayLimitMs: 200, awayCheckMs: 20,
    },
  });
});
afterEach(() => { _setReportRequiredProvidersForTesting(); coordinator.shutdown(); _setPlanQueueDataDirForTesting(null); far.dispose(); rmSync(repo, { recursive: true, force: true }); });

const start = async (config: object = {}) => (await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', config } as never)).run;
const workers = (): FakeInstance[] => fake.created.filter(i => i.role === 'worker');

describe('a plan job that runs on another computer', { timeout: 60_000 }, () => {
  it('works there, comes back, is checked and lands on main here, and the computer is cleaned up', async () => {
    planDoc();
    const run = await start();
    await waitForRun(run.id);
    // The run is done when the job lands; taking its copy off the computer follows straight after.
    await vi.waitFor(() => expect(store.listItems(run.id)[0]!.remote ?? null).toBeNull(), { timeout: 10_000, interval: 25 });
    const item = store.listItems(run.id)[0]!;
    expect(item).toMatchObject({ state: 'landed' });
    const worker = workers()[0]!;
    expect(worker.config.forceNodeId).toBe('pc');
    expect(worker.config.workingDirectory).toContain(far.root);
    expect(worker.config.initialPrompt).toContain('This job runs on the Windows PC');
    expect(worker.config.initialPrompt).not.toContain('ROOT checkout');
    expect(git(['show', 'main:alpha.feature.txt'])).toBe('built alpha');
    expect(existsSync(join(repo, `docs/plans/${STEM}_plan_completed.md`))).toBe(true);
    expect(readFileSync(join(repo, `docs/plans/${STEM}_plan_completed.md`), 'utf8')).toContain('As built: done on the PC.');
    expect(item.workerReport).toMatchObject({ summary: 'Built it on the PC.' });
    expect(existsSync(worker.config.workingDirectory!)).toBe(false);
    expect(git(['status', '--porcelain', '--untracked-files=all', '--', 'docs'])).not.toContain('.from-queue');
  });

  it('lands a plan with a deferred check reported in the file and written down beside the plan', async () => {
    fake.scripts.worker = farWorker({ deferred: true });
    fake.scripts.verifier = passDeferring;
    planDoc();
    const run = await start();
    await waitForRun(run.id);
    expect(store.listItems(run.id)[0]).toMatchObject({ state: 'landed', verdict: { verdict: 'PASS', deferredChecks: [{ title: DEFERRED.title }] } });
  });

  it('turns a PASS into a FAIL when the file does not list the deferred check, naming the file, and the next round lands it', async () => {
    let turn = 0;
    fake.scripts.worker = (instance, message) => { turn += 1; return farWorker({ deferred: true, report: turn > 1 })(instance, message); };
    fake.scripts.verifier = passDeferring;
    planDoc();
    const run = await start();
    await waitForRun(run.id);
    expect(store.listItems(run.id)[0]!.state).toBe('landed');
    const fix = [...fake.inputs, ...workers().map(w => ({ instanceId: w.id, message: w.config.initialPrompt ?? '' }))].map(m => m.message).find(m => m.includes('An independent verifier failed your work'))!;
    expect(fix).toContain('does not list');
    expect(fix).toContain('your report file');
    expect(fix).not.toContain('plan_queue_report_ready under deferred_checks');
    expect(fix).toContain('handed over when your turn ends');
  });

  it('keeps a live-test run, and a run kept on this Mac, on this Mac', async () => {
    planDoc();
    const run = await start({ keepOnThisMac: true });
    await waitForRun(run.id);
    expect(workers()[0]!.config.forceNodeId).toBeUndefined();
    expect(workers()[0]!.config.workingDirectory).toContain('.worktrees');
    expect(store.listItems(run.id)[0]).toMatchObject({ state: 'landed' });
  });

  it('runs a job here, with the reason on its timeline, when the computer has not passed the project check', async () => {
    computers[0]!.projects = {};
    planDoc();
    const run = await start();
    await waitForRun(run.id);
    expect(workers()[0]!.config.forceNodeId).toBeUndefined();
    const note = store.history.listRunEvents(run.id, 100).find(event => event.reason === 'job-placement');
    expect(note?.detailHead).toContain("hasn't been checked for this project yet");
    expect(store.listItems(run.id)[0]!.state).toBe('landed');
  });

  it('keeps a plan James changed here while the job was away, beside the job\'s copy, and holds the job', async () => {
    const plan = planDoc();
    fake.scripts.worker = instance => {
      farWorker()(instance, '');
      writeFileSync(plan, `${readFileSync(plan, 'utf8')}\nJames edited this here.\n`);
    };
    const run = await start();
    await vi.waitFor(() => expect(store.listItems(run.id)[0]!.heldAt).toBeTruthy(), { timeout: 30_000, interval: 50 });
    // It stays held: the scheduler starts no checker for it and nothing lands, however long it waits.
    await new Promise(resolve => setTimeout(resolve, 1_500));
    const held = store.listItems(run.id)[0]!;
    expect(held).toMatchObject({ state: 'awaiting-slot' });
    expect(held.heldAt).toBeTruthy();
    expect(fake.created.some(instance => instance.role === 'verifier')).toBe(false);
    expect(held.detail).toBe('the plan changed here while the job was on the Windows PC');
    expect(readFileSync(plan, 'utf8')).toContain('James edited this here.');
    expect(readFileSync(plan, 'utf8')).not.toContain('done on the PC');
    expect(git(['status', '--porcelain', '--untracked-files=all', '--', 'docs'])).toContain('.from-queue-');
  });

  it('carries on here from the last checkpoint when the computer goes away and stays away', async () => {
    planDoc();
    fake.scripts.worker = async instance => {
      if (instance.config.forceNodeId) {
        connected = false;
        instance.status = 'error';
        fake.emit('instance:event', { eventId: 'e', seq: 0, timestamp: 0, instanceId: instance.id, event: { kind: 'status_changed', previousStatus: 'busy', status: 'error' } });
        return;
      }
      farWorker()(instance, '');
    };
    const run = await start();
    await waitForRun(run.id);
    const item = store.listItems(run.id)[0]!;
    expect(item.state).toBe('landed');
    expect(workers().some(w => !w.config.forceNodeId)).toBe(true);
    expect(git(['show', 'main:alpha.feature.txt'])).toBe('built alpha');
  });
});
