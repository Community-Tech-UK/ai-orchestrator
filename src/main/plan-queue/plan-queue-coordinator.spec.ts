import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { getLogger } from '../logging/logger';
import { _resetReclaimHoldsForTesting } from '../process/reclaim-holds';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { WorktreeManager } from '../workspace/git/worktree-manager';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import type { PlanQueueInstanceRecord } from './plan-queue-host';
import { PlanQueueRelaxation } from './plan-queue-relaxation';
import { PlanQueueStore } from './plan-queue-store';

const landing = vi.hoisted(() => ({ active: 0, max: 0, hang: false, hung: false, hangPromotion: false }));
vi.mock('./plan-queue-landing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plan-queue-landing')>();
  return {
    ...actual,
    landItemBranch: async (...args: Parameters<typeof actual.landItemBranch>) => {
      if (landing.hang) {
        landing.hung = true;
        return new Promise<never>(() => undefined);
      }
      landing.active += 1;
      landing.max = Math.max(landing.max, landing.active);
      try {
        return await actual.landItemBranch(...args);
      } finally {
        landing.active -= 1;
      }
    },
  };
});

// A crash after the landing commit was built and recorded, before it reached the base branch.
vi.mock('../workspace/git/worktree-integration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/git/worktree-integration')>();
  return {
    ...actual,
    promoteIntegrationBranch: async (...args: Parameters<typeof actual.promoteIntegrationBranch>) => {
      if (landing.hangPromotion) {
        landing.hung = true;
        return new Promise<never>(() => undefined);
      }
      return actual.promoteIntegrationBranch(...args);
    },
  };
});

let repo: string;
let driver: SqliteDriver;
let store: PlanQueueStore;
let fake: FakeInstances;
let coordinator: PlanQueueCoordinator;

function git(args: string[], cwd = repo): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    // `rev-parse -q --verify` exits 1 with no output when the ref is absent.
    if (args.includes('--verify')) return '';
    throw error;
  }
}

type Role = 'parent' | 'worker' | 'verifier' | 'triage';
type Script = (instance: FakeInstance, message: string, fake: FakeInstances) => void | Promise<void>;

interface FakeInstance extends PlanQueueInstanceRecord {
  outputBuffer: { type: string; content: string }[];
  config: InstanceCreateConfig;
  role: Role;
}

/**
 * Scripted stand-in for InstanceManager. Each role's script decides what the
 * "agent" does with a prompt; the fake then emits the event sequence a real
 * turn produces (busy → assistant output → idle).
 */
class FakeInstances extends EventEmitter {
  readonly live = new Map<string, FakeInstance>();
  readonly created: FakeInstance[] = [];
  readonly inputs: { instanceId: string; message: string; internalSource?: string }[] = [];
  readonly scripts: Partial<Record<Role, Script>> = {};
  maxLive: Partial<Record<Role, number>> = {};
  private next = 0;

  addParent(): FakeInstance {
    const parent = this.make('parent', { workingDirectory: repo } as InstanceCreateConfig, 'claude', 'claude-sonnet-5');
    parent.status = 'idle';
    return parent;
  }

  private make(role: Role, config: InstanceCreateConfig, provider: string, model?: string): FakeInstance {
    this.next += 1;
    const instance: FakeInstance = {
      id: `${role}-${this.next}`,
      status: 'initializing',
      outputBuffer: [],
      provider,
      currentModel: model,
      workingDirectory: config.workingDirectory,
      metadata: config.metadata,
      config,
      role,
    };
    this.live.set(instance.id, instance);
    this.created.push(instance);
    const count = [...this.live.values()].filter((i) => i.role === role).length;
    this.maxLive[role] = Math.max(this.maxLive[role] ?? 0, count);
    return instance;
  }

  async createInstance(config: InstanceCreateConfig): Promise<{ id: string }> {
    const role = (config.metadata?.['planQueueRole'] as Role | undefined) ?? 'worker';
    const instance = this.make(role, config, config.provider ?? 'claude', config.modelOverride);
    setImmediate(() => void this.turn(instance, config.initialPrompt ?? ''));
    return { id: instance.id };
  }

  async sendInput(
    instanceId: string,
    message: string,
    _attachments?: undefined,
    options?: { internalSource?: string },
  ): Promise<void> {
    const instance = this.live.get(instanceId);
    if (!instance) throw new Error(`no instance ${instanceId}`);
    this.inputs.push({ instanceId, message, internalSource: options?.internalSource });
    if (instance.role === 'parent') return;
    setImmediate(() => void this.turn(instance, message));
  }

  async terminateInstance(instanceId: string): Promise<void> {
    const instance = this.live.get(instanceId);
    if (!instance) return;
    this.setStatus(instance, 'terminated');
    this.live.delete(instanceId);
    this.emit('instance:removed', instanceId);
  }

  getInstance(instanceId: string): FakeInstance | undefined {
    return this.live.get(instanceId);
  }

  say(instance: FakeInstance, content: string): void {
    instance.outputBuffer.push({ type: 'assistant', content });
    this.emit('provider:normalized-event', {
      eventId: 'e', seq: 0, timestamp: 0, provider: 'claude', instanceId: instance.id,
      event: { kind: 'output', messageType: 'assistant', content },
    });
  }

  setStatus(instance: FakeInstance, status: FakeInstance['status']): void {
    const previousStatus = instance.status;
    instance.status = status;
    this.emit('instance:event', {
      eventId: 'e', seq: 0, timestamp: 0, instanceId: instance.id,
      event: { kind: 'status_changed', previousStatus, status },
    });
  }

  private async turn(instance: FakeInstance, message: string): Promise<void> {
    if (!this.live.has(instance.id)) return;
    this.setStatus(instance, 'busy');
    const script = this.scripts[instance.role];
    await script?.(instance, message, this);
    if (!this.live.has(instance.id) || instance.status !== 'busy') return;
    this.say(instance, `${instance.role} finished`);
    this.setStatus(instance, 'idle');
  }
}

function writeDoc(relative: string, content: string): string {
  const full = join(repo, relative);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
}

function planDoc(stem: string): string {
  writeDoc(`docs/plans/${stem}_spec_planned.md`, `# Spec\n\n**Plan:** [plan](./${stem}_plan.md)\n`);
  return writeDoc(`docs/plans/${stem}_plan.md`, `# Plan\n\n**Spec:** [spec](./${stem}_spec_planned.md)\n\n- [ ] build it\n`);
}

/** Worker: write a feature file in its worktree and an as-built note in the root document. */
const implement: Script = (instance) => {
  const documentLine = instance.config.initialPrompt?.match(/Your document is `([^`]+)`/)?.[1];
  const stem = documentLine ? documentLine.split('/').pop()!.replace(/\.md$/, '') : 'unknown';
  writeFileSync(join(instance.workingDirectory!, `${stem}.feature.txt`), `built ${stem}\n`);
  if (documentLine) appendFileSync(documentLine, '\nAs built: done.\n');
};

const itemIdOf = (instance: FakeInstance) => instance.config.metadata?.['planQueueItemId'] as string;
const pass: Script = (instance) => {
  coordinator.reportVerdict(instance.id, {
    item_id: itemIdOf(instance), verdict: 'PASS', findings: [], gates_run: [], document_complete: true, need_james: [],
  });
};
const triageAllReady: Script = (instance) => {
  const runId = instance.config.metadata?.['planQueueRunId'] as string;
  const run = coordinator.getRunDto(runId)!;
  coordinator.reportTriage(instance.id, {
    run_id: runId,
    records: run.items.filter((i) => i.state === 'discovered').map((i) => ({ documentPath: i.documentPath, disposition: 'ready' as const })),
  });
};

async function waitForRun(runId: string, timeout = 30_000): Promise<void> {
  await vi.waitFor(() => {
    const status = coordinator.getRunDto(runId)?.status;
    if (status !== 'completed' && status !== 'cancelled') throw new Error(`run is ${status}`);
  }, { timeout, interval: 50 });
}

beforeEach(() => {
  WorktreeManager._resetForTesting();
  GitWriteQueue._resetForTesting();
  PlanQueueCoordinator._resetForTesting();
  _resetReclaimHoldsForTesting();
  landing.active = 0;
  landing.max = 0;
  landing.hang = false;
  landing.hung = false;
  landing.hangPromotion = false;
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'plan-queue-coord-')));
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Plan Queue Test']);
  git(['config', 'user.email', 'plan-queue@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);

  driver = new Database(':memory:') as unknown as SqliteDriver;
  driver.exec('PRAGMA foreign_keys = ON');
  runLoopMigrations(driver);
  store = new PlanQueueStore(driver);
  fake = new FakeInstances();
  fake.scripts.triage = triageAllReady;
  fake.scripts.worker = implement;
  fake.scripts.verifier = pass;
  coordinator = startCoordinator(fake);
});

function startCoordinator(instances: FakeInstances, relaxation: PlanQueueRelaxation | null = null): PlanQueueCoordinator {
  const created = PlanQueueCoordinator.getInstance();
  created.initialize({
    store,
    instances,
    worktreeCreator: WorktreeManager.getInstance(),
    skipInstall: true,
    selectVerifier: async () => ({ ok: true, choice: { provider: 'codex' } }),
    loadAverage: () => [0, 0, 0],
    relaxation,
    pumpIntervalMs: null,
  });
  return created;
}

const never: Script = () => new Promise<void>(() => undefined);

/**
 * Simulate an app restart: the old coordinator and every live instance are
 * gone; the database and the repository survive. The parent session is
 * restored with the same id.
 */
async function restart(relaxation: PlanQueueRelaxation | null = null): Promise<FakeInstances> {
  const parent = fake.created.find((i) => i.role === 'parent')!;
  // Let the old coordinator reach a resting point (a hung landing never does),
  // then every session of the old process dies with it.
  await Promise.race([coordinator._whenSettledForTesting(), new Promise((resolve) => setTimeout(resolve, 1_000))]);
  fake.live.clear();
  PlanQueueCoordinator._resetForTesting();
  WorktreeManager._resetForTesting();
  const next = new FakeInstances();
  next.scripts.triage = triageAllReady;
  next.scripts.worker = implement;
  next.scripts.verifier = pass;
  next.live.set(parent.id, { ...parent, outputBuffer: [] });
  fake = next;
  coordinator = startCoordinator(next, relaxation);
  await coordinator.recover();
  return next;
}

async function waitForState(itemIndex: number, runId: string, state: string): Promise<void> {
  await vi.waitFor(() => {
    const current = coordinator.getRunDto(runId)!.items[itemIndex].state;
    if (current !== state) throw new Error(`item is ${current}`);
  }, { timeout: 15_000, interval: 25 });
}

afterEach(async () => {
  // Let trailing work (branch deletion after `landed`, the run summary) finish
  // before the repository and database go away.
  await Promise.race([coordinator._whenSettledForTesting(), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  PlanQueueCoordinator._resetForTesting();
  driver.close();
  rmSync(repo, { recursive: true, force: true });
  WorktreeManager._resetForTesting();
  GitWriteQueue._resetForTesting();
});

function queueWorktrees(): string[] {
  const dir = join(repo, '.worktrees', 'queue');
  return existsSync(dir) ? readdirSync(dir) : [];
}

describe('PlanQueueCoordinator — whole run against a temp repo', { timeout: 30_000 }, () => {
  it('lands one verified plan as a squash commit, closes its documents and leaves no worktree', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    expect(run.items.map((i) => i.state)).toEqual(['discovered']);
    await waitForRun(run.id);

    const final = coordinator.getRunDto(run.id)!;
    expect(final.items[0]).toMatchObject({ state: 'landed', round: 1, worktreePath: null, branchName: null });
    // One commit, made with hooks, carries the code AND the closed documents.
    const log = git(['log', '--format=%s', 'main']).split('\n');
    expect(log).toEqual(['Plan: 2026-01-01-alpha_plan', 'base']);
    expect(git(['show', '--name-only', '--format=', 'main']).split('\n').sort()).toEqual([
      '2026-01-01-alpha_plan.feature.txt',
      'docs/plans/2026-01-01-alpha_plan_completed.md',
      'docs/plans/2026-01-01-alpha_spec_completed.md',
    ]);
    expect(git(['show', 'main:docs/plans/2026-01-01-alpha_spec_completed.md'])).toContain('2026-01-01-alpha_plan_completed.md');
    // The superseded untracked root copies were retired; the working tree is clean.
    expect(existsSync(join(repo, 'docs/plans/2026-01-01-alpha_plan.md'))).toBe(false);
    expect(existsSync(join(repo, 'docs/plans/2026-01-01-alpha_spec_planned.md'))).toBe(false);
    expect(git(['status', '--porcelain'])).toBe('');
    expect(queueWorktrees()).toEqual([]);
    expect(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/queue/'])).toBe('');

    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(worker.config).toMatchObject({ parentId: parent.id, provider: 'claude', modelOverride: 'claude-sonnet-5', yoloMode: true });
    const verifier = fake.created.find((i) => i.role === 'verifier')!;
    expect(verifier.config).toMatchObject({ parentId: parent.id, provider: 'codex' });
    // The parent got the end-of-run summary.
    expect(fake.inputs.some((m) => m.instanceId === parent.id && m.message.includes('Landed 1'))).toBe(true);
  });

  it('runs three items with two worker slots, one verification and one landing at a time', async () => {
    for (const stem of ['2026-01-01-a', '2026-01-02-b', '2026-01-03-c']) planDoc(stem);
    const parent = fake.addParent();
    const slowWorker: Script = async (instance, message, f) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await implement(instance, message, f);
    };
    fake.scripts.worker = slowWorker;

    const { run } = await coordinator.startRun({
      parentInstanceId: parent.id,
      kind: 'plans',
      config: { workerSlots: 2, verificationSlots: 1, postMergeGate: [] },
    });
    await waitForRun(run.id, 60_000);

    expect(coordinator.getRunDto(run.id)!.items.map((i) => i.state)).toEqual(['landed', 'landed', 'landed']);
    expect(fake.maxLive.worker).toBeLessThanOrEqual(2);
    expect(fake.maxLive.verifier).toBe(1);
    expect(landing.max).toBe(1);
    expect(git(['log', '--format=%s', 'main']).split('\n').filter((s) => s.startsWith('Plan: '))).toHaveLength(3);
  }, 60_000);

  it('shares verification slots across runs without starving a run whose own cap is smaller', async () => {
    planDoc('2026-01-01-alpha');
    writeDoc('docs/plans/2026-01-02-beta_livetest.md', '# L\n');
    const parent = fake.addParent();
    const hold: Script = never;
    fake.scripts.verifier = hold;
    // plans run (2 shared slots) with one verification in flight...
    const plans = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, plans.run.id, 'verifying');
    // ...then a livetests run (its own cap is 1) must still get a verifier.
    const livetests = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests' });
    await waitForState(0, livetests.run.id, 'verifying');
    // The state flips first; the verifier session is spawned a few awaits later.
    await vi.waitFor(() => {
      if (fake.created.filter((i) => i.role === 'verifier').length < 2) throw new Error('livetest verifier not spawned');
    }, { timeout: 15_000, interval: 25 });
    expect(fake.maxLive.verifier).toBe(2);
  });

  it('sends FAIL findings back to the same worker and lands after a later PASS', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    let verifications = 0;
    fake.scripts.verifier = (instance) => {
      verifications += 1;
      coordinator.reportVerdict(instance.id, {
        item_id: itemIdOf(instance),
        verdict: verifications === 1 ? 'FAIL' : 'PASS',
        findings: verifications === 1 ? [{ severity: 'high', confidence: 85, summary: 'Missing retry test.', file: 'a.txt:1' }] : [],
        gates_run: [], document_complete: true, need_james: [],
      });
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'landed', round: 2 });
    const workers = fake.created.filter((i) => i.role === 'worker');
    expect(workers).toHaveLength(1);
    const fix = fake.inputs.find((m) => m.instanceId === workers[0].id);
    expect(fix?.message).toContain('Missing retry test.');
    expect(fix?.message).toContain('verification round 1 of 3');
    // LT-657: queue-authored worker and parent messages are Harness input, never the user's.
    expect(fix?.internalSource).toBe('plan-queue');
    const parentMessages = fake.inputs.filter((m) => m.instanceId === parent.id);
    expect(parentMessages.length).toBeGreaterThan(0);
    expect(parentMessages.every((m) => m.internalSource === 'plan-queue')).toBe(true);
  });

  it('parks at the round limit, keeps the branch and names it in the document', async () => {
    const doc = planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = (instance) => {
      coordinator.reportVerdict(instance.id, {
        item_id: itemIdOf(instance), verdict: 'FAIL',
        findings: [{ severity: 'medium', confidence: 70, summary: 'Still wrong.' }], gates_run: [], document_complete: true, need_james: [],
      });
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 2 } });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'round-limit', round: 2, worktreePath: null });
    expect(item.branchName).toMatch(/^queue\//);
    expect(git(['rev-list', '--count', `main..${item.branchName}`])).not.toBe('0');
    expect(readFileSync(doc, 'utf8')).toContain(`Plan Queue parked work: \`${item.branchName}\``);
    expect(queueWorktrees().flatMap((d) => readdirSync(join(repo, '.worktrees', 'queue', d)))).toEqual([]);
    expect(git(['log', '--format=%s', 'main'])).toBe('base');
  });

  it('parks as verifier-unreliable after two verifiers end without a verdict', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = () => undefined;

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'verifier-unreliable', erroredRounds: 2 });
    expect(fake.created.filter((i) => i.role === 'verifier')).toHaveLength(2);
  });

  it('refuses a verdict from anyone but the assigned verifier', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    const attempts: string[] = [];
    fake.scripts.verifier = (instance) => {
      // While the item is verifying, its worker and the parent both try to report.
      const worker = fake.created.find((i) => i.role === 'worker')!;
      for (const caller of [worker.id, parent.id]) {
        try {
          coordinator.reportVerdict(caller, {
            item_id: itemIdOf(instance), verdict: 'PASS', findings: [], gates_run: [], document_complete: true, need_james: [],
          });
          attempts.push('accepted');
        } catch (error) {
          attempts.push(String(error));
        }
      }
      coordinator.reportVerdict(instance.id, {
        item_id: itemIdOf(instance), verdict: 'FAIL', findings: [], gates_run: [], document_complete: true, need_james: [],
      });
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await waitForRun(run.id);
    expect(attempts).toHaveLength(2);
    expect(attempts.every((a) => a.includes('Only the verifier currently assigned'))).toBe(true);
    // Only the real verifier's FAIL counted.
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'round-limit' });
    expect(() => coordinator.reportTriage(parent.id, { run_id: run.id, records: [{ documentPath: 'x', disposition: 'ready' }] }))
      .toThrow(/Only the triage agent/);
  });

  it('discards a verdict from a verifier that changed the tree, reverts it, and verifies again', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    let verifications = 0;
    fake.scripts.verifier = (instance) => {
      verifications += 1;
      if (verifications === 1) writeFileSync(join(instance.workingDirectory!, 'a.txt'), 'verifier edit\n');
      pass(instance, '', fake);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed', erroredRounds: 1 });
    expect(git(['show', 'main:a.txt'])).toBe('base');
  });

  it('asks James about a not-ready document and starts it after his answer', async () => {
    writeDoc('docs/plans/2026-01-01-orphan_plan.md', '# Plan\n\n**Spec:** [spec](./2026-01-01-orphan_spec_planned.md)\n');
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    const item = run.items[0];
    expect(item.state).toBe('needs-answer');
    expect(fake.inputs.find((m) => m.instanceId === parent.id)?.message).toContain(`item_id "${item.id}"`);

    await expect(coordinator.answer(item.id, 'proceed', 'someone-else')).rejects.toThrow(/Only the session that started/);
    await coordinator.answer(item.id, 'proceed', parent.id);
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('landed');
  });

  it('parks in-flight work and skips the rest when James cancels', async () => {
    planDoc('2026-01-01-alpha');
    planDoc('2026-01-02-beta');
    const parent = fake.addParent();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    fake.scripts.worker = async (instance, message, f) => {
      await implement(instance, message, f);
      await blocked;
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { workerSlots: 1 } });
    await vi.waitFor(() => {
      if (!coordinator.getRunDto(run.id)!.items.some((i) => i.state === 'working')) throw new Error('not working yet');
    });
    await coordinator.control({ action: 'cancel', runId: run.id });
    release();

    const items = coordinator.getRunDto(run.id)!.items;
    expect(coordinator.getRunDto(run.id)!.status).toBe('cancelled');
    expect(items.map((i) => [i.state, i.parkReason])).toEqual([['parked', 'cancelled'], ['skipped', null]]);
    // The parked item's work was checkpointed onto its branch before teardown.
    expect(git(['show', `${items[0].branchName}:2026-01-01-alpha_plan.feature.txt`])).toBe('built 2026-01-01-alpha_plan');
    expect(queueWorktrees().flatMap((d) => readdirSync(join(repo, '.worktrees', 'queue', d)))).toEqual([]);
  });
});

describe('PlanQueueCoordinator — boot recovery', { timeout: 30_000 }, () => {
  it('respawns a worker for a working item whose session died, keeping its pre-restart work', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = async (instance, message, f) => {
      await implement(instance, message, f);
      await never(instance, message, f);
    };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');

    const next = await restart();
    await waitForRun(run.id);

    const newWorker = next.created.find((i) => i.role === 'worker')!;
    expect(newWorker.config.initialPrompt).toContain('the app restarted');
    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('landed');
    expect(git(['show', 'main:2026-01-01-alpha_plan.feature.txt'])).toBe('built 2026-01-01-alpha_plan');
  });

  it('re-verifies an item that was verifying with a fresh verifier, discarding the dead verifier\'s edits', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = async (instance, message, f) => {
      // The verifier breaks the rules and then the app dies mid-verification.
      writeFileSync(join(instance.workingDirectory!, 'a.txt'), 'verifier edit\n');
      writeFileSync(join(instance.workingDirectory!, 'verifier-scratch.txt'), 'x\n');
      execFileSync('git', ['add', 'verifier-scratch.txt'], { cwd: instance.workingDirectory! });
      await never(instance, message, f);
    };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'verifying');

    const next = await restart();
    await waitForRun(run.id);
    expect(next.created.filter((i) => i.role === 'verifier')).toHaveLength(1);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed', erroredRounds: 0 });
    expect(git(['show', 'main:a.txt'])).toBe('base');
    expect(git(['ls-tree', '--name-only', 'main'])).not.toContain('verifier-scratch.txt');
    expect(git(['ls-tree', '--name-only', 'main'])).toContain('2026-01-01-alpha_plan.feature.txt');
  });

  it('resumes an interrupted landing', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    landing.hang = true;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    // The "crashed" process must really be stuck inside the landing call.
    await vi.waitFor(() => { if (!landing.hung) throw new Error('landing not reached'); }, { timeout: 15_000 });

    landing.hang = false;
    await restart();
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('landed');
    expect(git(['log', '--format=%s', 'main']).split('\n').filter((line) => line.startsWith('Plan: '))).toHaveLength(1);
  });

  it('prepares a worktree for an item that died in preparing, re-triages discovered items, and leaves questions open', async () => {
    planDoc('2026-01-01-alpha');
    planDoc('2026-01-02-beta');
    writeDoc('docs/plans/2026-01-03-orphan_plan.md', '**Spec:** [s](./missing_spec_planned.md)\n');
    const parent = fake.addParent();
    fake.scripts.triage = never;
    const { run } = await coordinator.startRun({
      parentInstanceId: parent.id, kind: 'plans', config: { postMergeGate: [] },
    });
    const [alpha] = coordinator.getRunDto(run.id)!.items;
    // Simulate a crash straight after alpha's row moved to preparing.
    store.upsertItem({ ...store.getItem(alpha.id)!, state: 'queued' });
    store.upsertItem({ ...store.getItem(alpha.id)!, state: 'preparing' });

    const next = await restart();
    await waitForState(0, run.id, 'landed');
    await waitForState(1, run.id, 'landed');
    expect(next.created.filter((i) => i.role === 'triage')).toHaveLength(1);
    expect(coordinator.getRunDto(run.id)!.items[2].state).toBe('needs-answer');
    expect(coordinator.getRunDto(run.id)!.status).toBe('running');
  });

  it('keeps settings relaxed while any relaxed run is active, handing the true originals to the run that outlives the first', async () => {
    const values = new Map<string, unknown>([['computerUseAutonomyLevel', 'guarded'], ['providersExcludedFromAutomation', ['copilot']]]);
    const relaxation = new PlanQueueRelaxation({ get: (k) => values.get(k), set: (k, v) => { values.set(k, v); } });
    PlanQueueCoordinator._resetForTesting();
    coordinator = startCoordinator(fake, relaxation);
    planDoc('2026-01-01-alpha');
    planDoc('2026-01-02-beta');
    const parent = fake.addParent();
    let releaseBeta!: () => void;
    const betaGate = new Promise<void>((done) => { releaseBeta = done; });
    fake.scripts.worker = async (instance, message, f) => {
      if (instance.workingDirectory!.includes('beta')) await betaGate;
      await implement(instance, message, f);
    };

    const audit = vi.spyOn(getLogger('PlanQueueItemFlow'), 'info');
    const first = await coordinator.startRun({
      parentInstanceId: parent.id, kind: 'plans', glob: 'docs/plans/2026-01-01-*', config: { relaxSettings: true },
    });
    const second = await coordinator.startRun({
      parentInstanceId: parent.id, kind: 'plans', glob: 'docs/plans/2026-01-02-*', config: { relaxSettings: true },
    });
    expect(store.getRun(second.run.id)!.relaxation).toBeNull();
    expect(second.run.relaxedSettings).toEqual(['computerUseAutonomyLevel', 'providersExcludedFromAutomation']);
    // The sharing run holds no snapshot, but its workers are audited as running relaxed too.
    await vi.waitFor(() => {
      const audited = audit.mock.calls
        .filter(([message]) => message === 'Plan queue worker runs under relaxed settings')
        .map(([, data]) => (data as { runId: string }).runId);
      if (!audited.includes(second.run.id)) throw new Error('sharing run not audited yet');
    });
    audit.mockRestore();

    await waitForRun(first.run.id);
    // The second run is still working: its relaxation must still be in force.
    expect(values.get('computerUseAutonomyLevel')).toBe('unrestricted');
    expect(store.getRun(second.run.id)!.relaxation?.entries.map((e) => e.original)).toEqual(['guarded', ['copilot']]);
    expect(store.getRun(first.run.id)!.relaxation).toBeNull();

    releaseBeta();
    await waitForRun(second.run.id);
    expect(values.get('computerUseAutonomyLevel')).toBe('guarded');
    expect(values.get('providersExcludedFromAutomation')).toEqual(['copilot']);
  });

  it('hands the snapshot to a paused relaxed run when the holder is cancelled, and restores when that run ends', async () => {
    const values = new Map<string, unknown>([['computerUseAutonomyLevel', 'guarded'], ['providersExcludedFromAutomation', ['copilot']]]);
    const relaxation = new PlanQueueRelaxation({ get: (k) => values.get(k), set: (k, v) => { values.set(k, v); } });
    PlanQueueCoordinator._resetForTesting();
    coordinator = startCoordinator(fake, relaxation);
    planDoc('2026-01-01-alpha');
    planDoc('2026-01-02-beta');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const holder = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', glob: 'docs/plans/2026-01-01-*', config: { relaxSettings: true } });
    const heir = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', glob: 'docs/plans/2026-01-02-*', config: { relaxSettings: true } });
    await coordinator.control({ action: 'pause', runId: heir.run.id });

    await coordinator.control({ action: 'cancel', runId: holder.run.id });

    expect(values.get('computerUseAutonomyLevel')).toBe('unrestricted');
    expect(store.getRun(heir.run.id)!.relaxation?.entries.map((e) => e.original)).toEqual(['guarded', ['copilot']]);
    await coordinator.control({ action: 'cancel', runId: heir.run.id });
    expect(values.get('computerUseAutonomyLevel')).toBe('guarded');
    expect(values.get('providersExcludedFromAutomation')).toEqual(['copilot']);
  });

  it('after a restart with two relaxed runs active, exactly one holds the true originals', async () => {
    const values = new Map<string, unknown>([['computerUseAutonomyLevel', 'guarded'], ['providersExcludedFromAutomation', ['copilot']]]);
    const relaxation = new PlanQueueRelaxation({ get: (k) => values.get(k), set: (k, v) => { values.set(k, v); } });
    PlanQueueCoordinator._resetForTesting();
    coordinator = startCoordinator(fake, relaxation);
    planDoc('2026-01-01-alpha');
    planDoc('2026-01-02-beta');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const first = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', glob: 'docs/plans/2026-01-01-*', config: { relaxSettings: true } });
    const second = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', glob: 'docs/plans/2026-01-02-*', config: { relaxSettings: true } });
    await waitForState(0, first.run.id, 'working');
    await waitForState(0, second.run.id, 'working');

    await restart(relaxation);

    const holders = [first.run.id, second.run.id].map((id) => store.getRun(id)!.relaxation).filter(Boolean);
    expect(holders).toHaveLength(1);
    expect(holders[0]!.entries.map((e) => e.original)).toEqual(['guarded', ['copilot']]);
    expect(values.get('computerUseAutonomyLevel')).toBe('unrestricted');
    await coordinator.control({ action: 'cancel', runId: first.run.id });
    await coordinator.control({ action: 'cancel', runId: second.run.id });
    expect(values.get('computerUseAutonomyLevel')).toBe('guarded');
  });

  it('restores relaxed settings on boot and re-applies them for a run that is still active', async () => {
    const values = new Map<string, unknown>([['computerUseAutonomyLevel', 'guarded'], ['providersExcludedFromAutomation', ['copilot']]]);
    const relaxation = new PlanQueueRelaxation({ get: (k) => values.get(k), set: (k, v) => { values.set(k, v); } });
    PlanQueueCoordinator._resetForTesting();
    coordinator = startCoordinator(fake, relaxation);
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { relaxSettings: true } });
    expect(values.get('computerUseAutonomyLevel')).toBe('unrestricted');
    expect(store.getRun(run.id)!.relaxation?.entries.map((e) => e.original)).toEqual(['guarded', ['copilot']]);
    await waitForState(0, run.id, 'working');

    await restart(relaxation);
    expect(values.get('computerUseAutonomyLevel')).toBe('unrestricted');
    await waitForRun(run.id);
    expect(values.get('computerUseAutonomyLevel')).toBe('guarded');
    expect(values.get('providersExcludedFromAutomation')).toEqual(['copilot']);
    expect(store.getRun(run.id)!.relaxation).toBeNull();
    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('landed');
  });
});

describe('PlanQueueCoordinator — livetest mode', { timeout: 30_000 }, () => {
  function livetestVerdict(documentComplete: boolean): Script {
    return (instance) => {
      coordinator.reportVerdict(instance.id, {
        item_id: itemIdOf(instance),
        verdict: 'PASS',
        findings: [],
        gates_run: [{ command: 'npx tsc --noEmit', exitCode: 0 }],
        document_complete: documentComplete,
        need_james: [
          { check: 'Check 2: Face ID unlock', classification: 'real', reason: 'Needs a physical iPhone.' },
          { check: 'Check 3: Computer Use click', classification: 'policy-gated', reason: 'Blocked by computerUseAutonomyLevel.' },
          { check: 'Check 4: worker offline', classification: 'stale', reason: 'The worker is back online.' },
        ],
      });
    };
  }

  it('lands honest evidence but leaves a document with open checks under its active name', async () => {
    const doc = writeDoc('docs/plans/2026-01-01-alpha_livetest.md', '# Livetest\n\n- [ ] check 1\n');
    const parent = fake.addParent();
    fake.scripts.verifier = livetestVerdict(false);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests' });
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('landed');
    expect(existsSync(doc)).toBe(true);
    expect(existsSync(doc.replace('_livetest.md', '_livetest_completed.md'))).toBe(false);
    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(worker.config.initialPrompt).toContain('AIO_DEV_USER_DATA_PATH=/tmp/aio-lt-queue-');
    expect(worker.config.initialPrompt).toContain('livetest-campaign-runbook.md');

    const summary = fake.inputs.filter((m) => m.instanceId === parent.id).at(-1)!.message;
    expect(summary).toContain('Checks that genuinely need James:');
    expect(summary).toContain('Check 2: Face ID unlock — Needs a physical iPhone.');
    expect(summary).not.toContain('Check 4');
    expect(summary).toContain('1 further check(s) are policy-gated');
  });

  it('renames a livetest whose every check passed to _livetest_completed and commits the rename', async () => {
    const doc = writeDoc('docs/plans/2026-01-01-alpha_livetest.md', '# Livetest\n');
    const parent = fake.addParent();
    fake.scripts.verifier = livetestVerdict(true);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests' });
    await waitForRun(run.id);

    expect(existsSync(doc)).toBe(false);
    expect(existsSync(doc.replace('_livetest.md', '_livetest_completed.md'))).toBe(true);
    expect(git(['log', '-1', '--format=%s', 'main'])).toBe('Livetest: 2026-01-01-alpha_livetest');
    expect(git(['show', '--name-only', '--format=', 'main']).split('\n').sort()).toEqual([
      '2026-01-01-alpha_livetest.feature.txt',
      'docs/plans/2026-01-01-alpha_livetest_completed.md',
    ]);
  });

  it('uses the livetest defaults: one worker at a time and the light verifier gate list', async () => {
    writeDoc('docs/plans/2026-01-01-alpha_livetest.md', '# L\n');
    writeDoc('docs/plans/2026-01-02-beta_livetest.md', '# L\n');
    const parent = fake.addParent();
    fake.scripts.verifier = livetestVerdict(false);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests' });
    expect(run.config).toMatchObject({ workerSlots: 1, verificationSlots: 1, verifierGates: ['npx tsc --noEmit', 'npm run lint'] });
    await waitForRun(run.id);
    expect(fake.maxLive.worker).toBe(1);
  });
});

describe('PlanQueueCoordinator — operator actions', { timeout: 30_000 }, () => {
  async function parkedAtRoundLimit(): Promise<{ runId: string; itemId: string; branch: string; parentId: string }> {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = (instance) => {
      coordinator.reportVerdict(instance.id, {
        item_id: itemIdOf(instance), verdict: 'FAIL', findings: [], gates_run: [], document_complete: true, need_james: [],
      });
    };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await waitForRun(run.id);
    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item.state).toBe('parked');
    return { runId: run.id, itemId: item.id, branch: item.branchName!, parentId: parent.id };
  }

  it('Resume re-opens the run, reattaches the parked branch and lands it', async () => {
    const { runId, itemId, branch } = await parkedAtRoundLimit();
    fake.scripts.verifier = pass;

    await coordinator.control({ action: 'resume-item', itemId });
    await waitForRun(runId);

    const item = coordinator.getRunDto(runId)!.items[0];
    expect(item).toMatchObject({ state: 'landed', parkReason: null });
    const resumedWorker = fake.created.filter((i) => i.role === 'worker').at(-1)!;
    expect(resumedWorker.config.initialPrompt).toContain('James resumed this parked item');
    expect(resumedWorker.config.initialPrompt).toContain(branch);
    expect(git(['show', 'main:2026-01-01-alpha_plan.feature.txt'])).toBe('built 2026-01-01-alpha_plan');
  });

  it('Land anyway squashes the parked branch without closing the document', async () => {
    const { runId, itemId } = await parkedAtRoundLimit();

    await coordinator.control({ action: 'land-anyway', itemId });
    await coordinator._whenSettledForTesting();

    const item = coordinator.getRunDto(runId)!.items[0];
    expect(item.state).toBe('landed');
    expect(item.detail).toContain('without a verifier PASS');
    expect(git(['log', '-1', '--format=%s', 'main'])).toBe('Plan: 2026-01-01-alpha_plan');
    expect(existsSync(join(repo, 'docs/plans/2026-01-01-alpha_plan.md'))).toBe(true);
    expect(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/queue/'])).toBe('');
  });

  it('Discard deletes only the parked branch, and only on request', async () => {
    const { runId, itemId, branch } = await parkedAtRoundLimit();
    expect(git(['branch', '--list', branch])).not.toBe('');

    await coordinator.control({ action: 'discard-item', itemId });

    expect(git(['branch', '--list', branch])).toBe('');
    expect(coordinator.getRunDto(runId)!.items[0].detail).toContain('Discarded by James.');
    await expect(coordinator.control({ action: 'skip-item', itemId })).rejects.toThrow(/has not started/);
  });

  it('surfaces a worker waiting for input as a question and resumes it on "continue"', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    let asked = false;
    fake.scripts.worker = async (instance, message, f) => {
      if (!asked) {
        asked = true;
        f.say(instance, 'Should the retention period be 30 or 90 days?');
        f.setStatus(instance, 'waiting_for_input');
        return;
      }
      await implement(instance, message, f);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await vi.waitFor(() => {
      if (!coordinator.getRunDto(run.id)!.items[0].question) throw new Error('no question yet');
    });
    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item.question?.question).toContain('retention period');
    expect(item.question?.options.map((o) => o.id)).toEqual(['continue', 'park']);
    expect(fake.inputs.some((m) => m.instanceId === parent.id && m.message.includes(`item_id "${item.id}"`))).toBe(true);

    await coordinator.answer(item.id, 'continue');
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed', question: null });
  });
});

describe('PlanQueueCoordinator — merge conflicts are never committed unresolved', { timeout: 40_000 }, () => {
  const CONFLICT = 'merge has conflicts';
  const whichItem = (instance: FakeInstance) => (instance.workingDirectory!.includes('alpha') ? 'alpha' : 'beta');

  /** Both items add shared.txt; alpha lands first, so beta's pre-verification merge conflicts. */
  function conflictingWorkers(onConflict: Script): void {
    fake.scripts.worker = async (instance, message, f) => {
      if (message.includes(CONFLICT)) {
        await onConflict(instance, message, f);
        return;
      }
      await implement(instance, message, f);
      writeFileSync(join(instance.workingDirectory!, 'shared.txt'), `${whichItem(instance)}\n`);
    };
  }

  const resolve: Script = (instance) => {
    writeFileSync(join(instance.workingDirectory!, 'shared.txt'), 'alpha+beta\n');
    execFileSync('git', ['add', 'shared.txt'], { cwd: instance.workingDirectory! });
  };

  async function startConflict(onConflict: Script): Promise<{ runId: string; beta: () => ReturnType<PlanQueueCoordinator['getRunDto']> }> {
    planDoc('2026-01-01-alpha');
    planDoc('2026-01-02-beta');
    const parent = fake.addParent();
    conflictingWorkers(onConflict);
    const { run } = await coordinator.startRun({
      parentInstanceId: parent.id, kind: 'plans', config: { workerSlots: 2, verificationSlots: 1, postMergeGate: [] },
    });
    await vi.waitFor(() => {
      if (!fake.inputs.some((m) => m.message.includes(CONFLICT))) throw new Error('no conflict yet');
    }, { timeout: 20_000, interval: 25 });
    return { runId: run.id, beta: () => coordinator.getRunDto(run.id) };
  }

  /** The item whose pre-verification merge conflicted (whichever verified second). */
  function conflicted(runId: string) {
    const input = fake.inputs.find((m) => m.message.includes(CONFLICT))!;
    const itemId = fake.created.find((i) => i.id === input.instanceId)!.config.metadata!['planQueueItemId'];
    return coordinator.getRunDto(runId)!.items.find((i) => i.id === itemId)!;
  }

  it('parks on cancel mid-resolution without committing the markers, and Resume re-sends the conflict', async () => {
    const { runId } = await startConflict(never);
    const worktree = conflicted(runId).worktreePath!;

    await coordinator.control({ action: 'cancel', runId });

    const beta = conflicted(runId);
    expect(beta).toMatchObject({ state: 'parked', parkReason: 'cancelled', worktreePath: worktree });
    expect(beta.detail).toContain('still in progress');
    expect(existsSync(worktree)).toBe(true);
    expect(git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], worktree)).not.toBe('');
    // The branch holds the worker's pre-merge checkpoint, never the markers.
    expect(git(['show', `${beta.branchName}:shared.txt`])).toMatch(/^(alpha|beta)$/);

    conflictingWorkers(resolve);
    await coordinator.control({ action: 'resume-item', itemId: beta.id });
    await waitForRun(runId);
    const resumed = fake.created.filter((i) => i.role === 'worker').at(-1)!;
    expect(resumed.config.initialPrompt).toContain(CONFLICT);
    expect(git(['show', 'main:shared.txt'])).toBe('alpha+beta');
  });

  it('parks as merge-conflict when the worker ends its turn with the merge unresolved', async () => {
    const { runId } = await startConflict(() => undefined);
    await waitForRun(runId);

    const beta = conflicted(runId);
    expect(beta).toMatchObject({ state: 'parked', parkReason: 'merge-conflict' });
    expect(beta.detail).toContain('shared.txt');
    expect(existsSync(beta.worktreePath!)).toBe(true);
    expect(git(['show', `${beta.branchName}:shared.txt`])).toMatch(/^(alpha|beta)$/);
    expect(git(['show', 'main:shared.txt'])).toMatch(/^(alpha|beta)$/);
  });

  it('after a restart mid-resolution, the new worker gets the conflict again and the resolution lands', async () => {
    const { runId } = await startConflict(never);
    const next = await restart();
    next.scripts.worker = async (instance, message, f) => {
      if (message.includes(CONFLICT)) await resolve(instance, message, f);
    };

    await waitForRun(runId);
    expect(next.created.find((i) => i.role === 'worker')!.config.initialPrompt).toContain(CONFLICT);
    expect(coordinator.getRunDto(runId)!.items.map((i) => i.state)).toEqual(['landed', 'landed']);
    expect(git(['show', 'main:shared.txt'])).toBe('alpha+beta');
  });

  it('clears a merge left behind by a crash before the item reached fixing, then redoes it', async () => {
    const { runId } = await startConflict(never);
    const beta = conflicted(runId);
    // The crash window: the merge failed but the row still says verifying.
    store.upsertItem({ ...store.getItem(beta.id)!, state: 'verifying', verifierInstanceId: null });

    const next = await restart();
    next.scripts.worker = async (instance, message, f) => {
      if (message.includes(CONFLICT)) await resolve(instance, message, f);
    };
    await waitForRun(runId);

    expect(coordinator.getRunDto(runId)!.items.map((i) => i.state)).toEqual(['landed', 'landed']);
    expect(git(['show', 'main:shared.txt'])).toBe('alpha+beta');
  });

  it('sends a stale PASS back to the worker when the landing-time merge conflicts, then lands the resolution', async () => {
    planDoc('2026-01-01-alpha');
    planDoc('2026-01-02-beta');
    const parent = fake.addParent();
    conflictingWorkers(resolve);
    // Both items verify at the same time, so the second PASS is judged against
    // a main the first then moves: the conflict appears inside landing.
    let verifying = 0;
    let bothVerifying!: () => void;
    const gate = new Promise<void>((done) => { bothVerifying = done; });
    fake.scripts.verifier = async (instance, message, f) => {
      verifying += 1;
      if (verifying === 2) bothVerifying();
      if (verifying <= 2) await gate;
      await pass(instance, message, f);
    };

    const { run } = await coordinator.startRun({
      parentInstanceId: parent.id, kind: 'plans', config: { workerSlots: 2, verificationSlots: 2, postMergeGate: [] },
    });
    await waitForRun(run.id);

    const second = conflicted(run.id);
    expect(fake.inputs.filter((m) => m.message.includes(CONFLICT))).toHaveLength(1);
    expect(second).toMatchObject({ state: 'landed', round: 2 });
    expect(git(['show', 'main:shared.txt'])).toBe('alpha+beta');
  });

  it('Land anyway on an item parked mid-merge re-sends the conflict instead of landing the markers', async () => {
    const { runId } = await startConflict(() => undefined);
    await waitForRun(runId);
    const parked = conflicted(runId);
    expect(parked.parkReason).toBe('merge-conflict');

    conflictingWorkers(resolve);
    await coordinator.control({ action: 'land-anyway', itemId: parked.id });
    await vi.waitFor(() => {
      if (coordinator.getRunDto(runId)!.items.some((i) => i.state !== 'landed')) throw new Error('not landed yet');
    }, { timeout: 20_000, interval: 25 });

    // The parked item's worker was retired, so a fresh worker gets the conflict as its first prompt.
    expect(fake.created.filter((i) => i.role === 'worker').at(-1)!.config.initialPrompt).toContain(CONFLICT);
    expect(git(['show', 'main:shared.txt'])).toBe('alpha+beta');
    expect(git(['log', '-p', 'main'])).not.toContain('<<<<<<<');
  });
});

describe('PlanQueueCoordinator — the landing commit runs the repository hooks', { timeout: 40_000 }, () => {
  /** A repo-local pre-commit hook; `counter` lets a script fail only its first N runs. */
  function installHook(script: string): void {
    const hooks = join(repo, 'test-hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'pre-commit'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    git(['config', 'core.hooksPath', hooks]);
    appendFileSync(join(repo, '.git', 'info', 'exclude'), 'test-hooks/\n');
  }

  it('sends a hook refusal back to the worker with the output, then lands once it passes', async () => {
    const counter = join(repo, '.git', 'hook-runs');
    // Fail the first landing commit only.
    installHook(`n=$(cat "${counter}" 2>/dev/null || echo 0); echo $((n+1)) > "${counter}"; if [ "$n" = 0 ]; then echo "related test failed: retry.spec.ts" >&2; exit 1; fi`);
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'landed', round: 2 });
    const worker = fake.created.find((i) => i.role === 'worker')!;
    const bounce = fake.inputs.find((m) => m.instanceId === worker.id);
    expect(bounce?.message).toContain('related test failed: retry.spec.ts');
    expect(git(['log', '--format=%s', 'main']).split('\n')).toEqual(['Plan: 2026-01-01-alpha_plan', 'base']);
  });

  it('parks, landing nothing, when the hook refuses the landing a second time', async () => {
    installHook('echo "generator drift" >&2; exit 1');
    const doc = planDoc('2026-01-01-alpha');
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'land-blocked' });
    expect(item.detail).toContain('generator drift');
    expect(git(['log', '--format=%s', 'main'])).toBe('base');
    expect(existsSync(doc)).toBe(true);
    expect(git(['rev-list', '--count', `main..${item.branchName}`])).not.toBe('0');
  });

  it('still parks on the second refusal when the app restarts between the two', async () => {
    const counter = join(repo, '.git', 'hook-runs');
    installHook(`n=$(cat "${counter}" 2>/dev/null || echo 0); echo $((n+1)) > "${counter}"; echo "generator drift" >&2; exit 1`);
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    let turns = 0;
    // The worker never finishes the fix turn the first refusal sends it.
    fake.scripts.worker = (instance, message, f) => (++turns === 1 ? implement(instance, message, f) : never(instance, message, f));

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    const itemId = coordinator.getRunDto(run.id)!.items[0].id;
    await vi.waitFor(() => {
      const item = store.getItem(itemId)!;
      if (item.state !== 'fixing' || item.landingRefusals !== 1) throw new Error(`item is ${item.state}/${item.landingRefusals}`);
    }, { timeout: 30_000 });

    await restart();
    await waitForRun(run.id);
    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'land-blocked' });
    expect(item.detail).toContain('generator drift');
    expect(store.getItem(itemId)!.landingRefusals).toBe(0);
    // Exactly two landing attempts: a counter lost in the restart would allow a third.
    expect(readFileSync(counter, 'utf-8').trim()).toBe('2');
    expect(git(['log', '--format=%s', 'main'])).toBe('base');
  });

  it('parks when the branch carries active planning documents a second time', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    // The worker keeps a scratch plan in its tree and never removes it.
    fake.scripts.worker = (instance, message, f) => {
      writeFileSync(join(instance.workingDirectory!, 'scratch_plan.md'), '# scratch\n');
      return implement(instance, message, f);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'land-blocked' });
    expect(item.detail).toContain('scratch_plan.md');
    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(fake.inputs.some((m) => m.instanceId === worker.id && m.message.includes('scratch_plan.md'))).toBe(true);
    expect(git(['log', '--format=%s', 'main'])).toBe('base');
  });

  it('promotes a recorded landing commit after a restart without closing the documents again', async () => {
    const doc = planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    landing.hangPromotion = true;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    const itemId = coordinator.getRunDto(run.id)!.items[0].id;
    await vi.waitFor(() => { if (!landing.hung) throw new Error('promotion not reached'); }, { timeout: 30_000 });
    expect(store.getItem(itemId)!.landedCommit).not.toBeNull();

    // The active documents disappear before the restart; the recorded commit
    // already carries the closed copies, so they are not needed again.
    rmSync(doc);
    rmSync(doc.replace(/_plan\.md$/, '_spec_planned.md'));
    landing.hangPromotion = false;
    await restart();
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('landed');
    expect(git(['ls-tree', '-r', '--name-only', 'main'])).toContain('docs/plans/2026-01-01-alpha_plan_completed.md');
    expect(git(['log', '--format=%s', 'main']).split('\n').filter((line) => line.startsWith('Plan: '))).toHaveLength(1);
  });

  it('rebuilds a recorded landing commit, documents included, when the base moved before it was promoted', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    landing.hangPromotion = true;
    const { run } = await coordinator.startRun({
      parentInstanceId: parent.id, kind: 'plans', config: { postMergeGate: [] },
    });
    const itemId = coordinator.getRunDto(run.id)!.items[0].id;
    await vi.waitFor(() => { if (!landing.hung) throw new Error('promotion not reached'); }, { timeout: 30_000 });
    const stale = store.getItem(itemId)!.landedCommit;
    expect(stale).not.toBeNull();

    // Someone else lands on main while this process is stuck; the recorded commit is now stale.
    writeFileSync(join(repo, 'other.txt'), 'other\n');
    git(['add', 'other.txt']);
    git(['commit', '-q', '--no-verify', '-m', 'other work']);
    landing.hangPromotion = false;
    await restart();
    await waitForRun(run.id);

    const item = store.getItem(itemId)!;
    expect(item.state).toBe('landed');
    expect(item.landedCommit).not.toBe(stale);
    expect(git(['log', '--format=%s', 'main']).split('\n')).toEqual(['Plan: 2026-01-01-alpha_plan', 'other work', 'base']);
    const landed = git(['show', '--name-only', '--format=', 'main']).split('\n');
    expect(landed).toContain('docs/plans/2026-01-01-alpha_plan_completed.md');
    expect(landed).toContain('docs/plans/2026-01-01-alpha_spec_completed.md');
  });

  it('parks before anything lands when the document cannot be closed', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = (instance, message, f) => {
      // The completed name gets taken while the item is being verified.
      writeDoc('docs/plans/2026-01-01-alpha_plan_completed.md', 'someone else\n');
      return pass(instance, message, f);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'land-blocked' });
    expect(item.detail).toContain('Nothing was landed');
    expect(git(['log', '--format=%s', 'main'])).toBe('base');
  });
});
