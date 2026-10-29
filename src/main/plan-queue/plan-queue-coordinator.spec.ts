import { execFileSync } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlanQueueRouting } from '@contracts/schemas/plan-queue';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type { ProviderAccountProfile } from '../../shared/types/provider-account.types';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { getLogger } from '../logging/logger';
import { _resetReclaimHoldsForTesting } from '../process/reclaim-holds';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { WorktreeCapacityError, WorktreeManager } from '../workspace/git/worktree-manager';
import { buildOrchestratorToolsMcpConfig } from '../mcp/orchestrator-tools-mcp-config';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import type { PlanQueueInstanceRecord } from './plan-queue-host';
import { findRestoredSessionId } from './plan-queue-parent';
import { PlanQueueRelaxation } from './plan-queue-relaxation';
import * as readiness from './plan-queue-readiness';
import { PlanQueueStore } from './plan-queue-store';
import type { VerifierSelectInput } from './plan-queue-verifier-select';

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
/** James's saved Plan Queue routing and account pool, as the coordinator reads them. */
let savedRouting: PlanQueueRouting;
/** Providers whose choices have no usage left, for the ranked worker and checker lists. */
let outOfUsage: string[];
let installedProviders: string[];
let poolProfiles: ProviderAccountProfile[];
let verifierInputs: VerifierSelectInput[];
let excludedProviders: string[];
/** History entries archived at a simulated shutdown, read by the restored-parent lookup. */
let archivedEntries: { originalInstanceId: string; historyThreadId?: string }[];

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

/** Ids stay unique across simulated restarts, as a restored session's new id would be. */
let fakeInstanceSeq = 0;

/**
 * Scripted stand-in for InstanceManager. Each role's script decides what the
 * "agent" does with a prompt; the fake then emits the event sequence a real
 * turn produces (busy → assistant output → idle).
 */
class FakeInstances extends EventEmitter {
  readonly live = new Map<string, FakeInstance>();
  readonly created: FakeInstance[] = [];
  readonly inputs: { instanceId: string; message: string; internalSource?: string }[] = [];
  readonly adoptions: { childId: string; parentId: string }[] = [];
  readonly scripts: Partial<Record<Role, Script>> = {};
  maxLive: Partial<Record<Role, number>> = {};

  addParent(): FakeInstance {
    const parent = this.make('parent', { workingDirectory: repo } as InstanceCreateConfig, 'claude', 'claude-sonnet-5');
    parent.status = 'idle';
    parent.historyThreadId = `thread-${parent.id}`;
    return parent;
  }

  /** History restore: the same conversation (thread) back under a new id, announced as created. */
  restoreParent(previous: FakeInstance): FakeInstance {
    const parent = this.addParent();
    parent.historyThreadId = previous.historyThreadId;
    this.emit('instance:event', {
      eventId: 'e', seq: 0, timestamp: 0, instanceId: parent.id,
      event: { kind: 'created', status: parent.status, provider: 'claude', parentId: null, workingDirectory: repo },
    });
    return parent;
  }

  private make(role: Role, config: InstanceCreateConfig, provider: string, model?: string): FakeInstance {
    fakeInstanceSeq += 1;
    const instance: FakeInstance = {
      id: `${role}-${fakeInstanceSeq}`,
      status: 'initializing',
      outputBuffer: [],
      provider,
      currentModel: model,
      workingDirectory: config.workingDirectory,
      metadata: config.metadata,
      parentId: config.parentId ?? null,
      createdAt: fakeInstanceSeq,
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

  getAllInstances(): FakeInstance[] {
    return [...this.live.values()];
  }

  adoptOrphanInstance(childId: string, parentId: string): boolean {
    const child = this.live.get(childId);
    const current = child?.parentId ? this.live.get(child.parentId) : undefined;
    if (!child || !this.live.has(parentId) || child.parentId === parentId) return false;
    if (current && current.status !== 'superseded') return false;
    child.parentId = parentId;
    this.adoptions.push({ childId, parentId });
    return true;
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
  const documents = instance.config.initialPrompt!.match(/<documents>\n([\s\S]*?)\n<\/documents>/)![1].split('\n');
  coordinator.reportTriage(instance.id, {
    run_id: runId,
    records: run.items.filter((i) => i.state === 'discovered' && documents.includes(i.documentPath)).map((i) => ({ documentPath: i.documentPath, disposition: 'ready' as const })),
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
  savedRouting = { workers: [], verifiers: [] };
  outOfUsage = [];
  installedProviders = ['claude', 'codex', 'cursor', 'copilot', 'opencode', 'gemini'];
  poolProfiles = [];
  verifierInputs = [];
  excludedProviders = [];
  archivedEntries = [];
  fake = new FakeInstances();
  fake.scripts.triage = triageAllReady;
  fake.scripts.worker = implement;
  fake.scripts.verifier = pass;
  coordinator = startCoordinator(fake);
});

function startCoordinator(
  instances: FakeInstances,
  relaxation: PlanQueueRelaxation | null = null,
  extras: { whenOrchestratorToolsListening?: () => Promise<void>; now?: () => number } = {},
): PlanQueueCoordinator {
  const created = PlanQueueCoordinator.getInstance();
  created.initialize({
    store,
    instances,
    worktreeCreator: WorktreeManager.getInstance(),
    skipInstall: true,
    selectVerifier: async (input) => {
      verifierInputs.push(input);
      return { ok: true, choice: { provider: 'codex' } };
    },
    routing: {
      readSaved: () => savedRouting,
      readAccountRules: () => ({ never: [], last: [] }),
      copilotProfileFor: () => null,
      poolProfiles: () => poolProfiles,
      copilotProfiles: () => [],
      isProviderExcluded: (provider) => excludedProviders.includes(provider),
      defaultProvider: () => null,
      checkerScopeKind: () => 'none',
      listInstalledProviders: async () => installedProviders,
      routeUsage: async (choice) => ({ usable: !outOfUsage.includes(choice.provider), resumeAt: null }),
    },
    loadAverage: () => [0, 0, 0],
    relaxation,
    pumpIntervalMs: null,
    findRestoredSession: (instanceId) => findRestoredSessionId(instanceId, archivedEntries, instances.getAllInstances()),
    ...(extras.whenOrchestratorToolsListening
      ? { whenOrchestratorToolsListening: extras.whenOrchestratorToolsListening }
      : {}),
    ...(extras.now ? { now: extras.now } : {}),
  });
  return created;
}

const never: Script = () => new Promise<void>(() => undefined);

describe('PlanQueueCoordinator parent thread recovery and adoption', { timeout: 30_000 }, () => {
  async function pendingRun() {
    planDoc('2026-01-01-parent-recovery');
    const parent = fake.addParent();
    parent.historyThreadId = 'history-parent';
    fake.scripts.triage = never;
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    return { parent, run };
  }

  it('records the parent history thread and rebinds summaries to its restored session', async () => {
    const { parent, run } = await pendingRun();
    expect(store.getRun(run.id)?.parentHistoryThreadId).toBe('history-parent');
    fake.live.delete(parent.id);
    const restored = fake.addParent();
    restored.historyThreadId = 'history-parent';
    coordinator.notifyParent(coordinator.getRun(run.id), 'Recovery summary');
    expect(fake.inputs).toContainEqual({ instanceId: restored.id, message: 'Recovery summary', internalSource: 'plan-queue' });
    expect(store.getRun(run.id)?.parentInstanceId).toBe(restored.id);
  });

  it('lets the restored thread owner answer and owns its new worker', async () => {
    const { parent, run } = await pendingRun();
    const item = store.getItem(run.items[0].id)!;
    store.upsertItem({ ...item, state: 'needs-answer', question: {
      question: 'Which account should this work use?', options: [{ id: 'continue', label: 'Account A' }, { id: 'skip', label: 'Leave it' }],
    } });
    fake.live.delete(parent.id);
    const restored = fake.addParent(); restored.historyThreadId = 'history-parent';
    await coordinator.answer(item.id, 'continue', restored.id);
    await waitForState(0, run.id, 'working');
    await vi.waitFor(() => expect(fake.created.some((instance) => instance.role === 'worker')).toBe(true));
    expect(store.getRun(run.id)?.parentInstanceId).toBe(restored.id);
    expect(fake.created.find((instance) => instance.role === 'worker')?.config.parentId).toBe(restored.id);
  });

  it.each(['scheduler', 'notification', 'control', 'answer', 'worker-nesting'] as const)(
    'replays waiting questions once when %s first resolves the restored parent', async (entry) => {
      const { parent, run } = await pendingRun();
      const item = store.getItem(run.items[0].id)!;
      store.upsertItem({ ...item, state: 'needs-answer', question: {
        question: 'Which owner should approve this work?', options: [{ id: 'continue', label: 'Owner A' }, { id: 'skip', label: 'Leave it' }],
      } });
      fake.live.delete(parent.id);
      const restored = fake.addParent(); restored.historyThreadId = 'history-parent';
      if (entry === 'notification') coordinator.notifyParent(coordinator.getRun(run.id), 'Unrelated progress update');
      else if (entry === 'control') await coordinator.control({ action: 'pause', runId: run.id }, restored.id);
      else if (entry === 'answer') await expect(coordinator.answer(item.id, 'invalid-option', restored.id)).rejects.toThrow(/no open question/);
      else if (entry === 'worker-nesting') expect(new PlanQueueItemFlow(coordinator).liveParentId(coordinator.getRun(run.id))).toBe(restored.id);
      coordinator.requestPump();
      await coordinator._whenSettledForTesting();
      expect(store.getRun(run.id)?.parentInstanceId).toBe(restored.id);
      expect(fake.inputs.filter((input) => input.instanceId === restored.id && input.message.includes('Which owner should approve this work?'))).toHaveLength(1);
      const messages = fake.inputs.filter((input) => input.instanceId === restored.id).length;
      coordinator.requestPump(); await coordinator._whenSettledForTesting();
      expect(fake.inputs.filter((input) => input.instanceId === restored.id)).toHaveLength(messages);
    });

  it('replays a pending question once after authenticated adoption', async () => {
    const { parent, run } = await pendingRun();
    const item = store.getItem(run.items[0].id)!;
    store.upsertItem({ ...item, state: 'needs-answer', question: {
      question: 'May this work expand its scope?', options: [{ id: 'continue', label: 'Approve' }, { id: 'skip', label: 'Leave it' }],
    } });
    fake.live.delete(parent.id);
    const adopter = fake.addParent();
    await coordinator.control({ action: 'adopt', runId: run.id }, adopter.id);
    await coordinator._whenSettledForTesting();
    expect(fake.inputs.filter((input) => input.instanceId === adopter.id && input.message.includes('May this work expand its scope?'))).toHaveLength(1);
    coordinator.requestPump(); await coordinator._whenSettledForTesting();
    expect(fake.inputs.filter((input) => input.instanceId === adopter.id && input.message.includes('May this work expand its scope?'))).toHaveLength(1);
  });

  it('delivers a new readiness question once when its notification restores ownership', async () => {
    const { parent, run } = await pendingRun();
    const triage = fake.created.find((instance) => instance.role === 'triage')!;
    fake.live.delete(parent.id);
    const restored = fake.addParent(); restored.historyThreadId = 'history-parent';
    coordinator.reportTriage(triage.id, { run_id: run.id, records: [{
      documentPath: run.items[0].documentPath, disposition: 'needs-answer', question: {
        question: 'May this work expand its scope?', options: [{ id: 'continue', label: 'Approve' }, { id: 'skip', label: 'Leave it' }],
        decision: { kind: 'human-authority', reason: 'Scope requires human authority.' },
      },
    }] });
    await coordinator._whenSettledForTesting();
    expect(store.getRun(run.id)?.parentInstanceId).toBe(restored.id);
    expect(fake.inputs.filter((input) => input.instanceId === restored.id && input.message.includes('May this work expand its scope?'))).toHaveLength(1);
  });

  it('retries a failed replay on the next scheduler pass without duplicating successful delivery', async () => {
    const { parent, run } = await pendingRun();
    const item = store.getItem(run.items[0].id)!;
    store.upsertItem({ ...item, state: 'needs-answer', question: {
      question: 'Which owner should approve this work?', options: [{ id: 'continue', label: 'Owner A' }],
    } });
    fake.live.delete(parent.id);
    const restored = fake.addParent(); restored.historyThreadId = 'history-parent';
    vi.spyOn(fake, 'sendInput').mockRejectedValueOnce(new Error('Parent temporarily unavailable'));
    coordinator.notifyParent(coordinator.getRun(run.id), 'Unrelated progress update');
    await coordinator._whenSettledForTesting();
    expect(fake.inputs.filter((input) => input.message.includes('Which owner should approve this work?'))).toHaveLength(0);
    coordinator.requestPump(); await coordinator._whenSettledForTesting();
    expect(fake.inputs.filter((input) => input.instanceId === restored.id && input.message.includes('Which owner should approve this work?'))).toHaveLength(1);
    coordinator.requestPump(); await coordinator._whenSettledForTesting();
    expect(fake.inputs.filter((input) => input.message.includes('Which owner should approve this work?'))).toHaveLength(1);
  });

  it('keeps one replay in flight while multiple resolver paths inspect the restored owner', async () => {
    const { parent, run } = await pendingRun();
    const item = store.getItem(run.items[0].id)!;
    store.upsertItem({ ...item, state: 'needs-answer', question: {
      question: 'Which owner should approve this work?', options: [{ id: 'continue', label: 'Owner A' }],
    } });
    fake.live.delete(parent.id);
    const restored = fake.addParent(); restored.historyThreadId = 'history-parent';
    let release!: () => void;
    const sending = new Promise<void>((resolve) => { release = resolve; });
    const send = fake.sendInput.bind(fake);
    let attempts = 0;
    vi.spyOn(fake, 'sendInput').mockImplementation(async (...args) => {
      if (args[1].includes('Which owner should approve this work?')) { attempts += 1; await sending; }
      await send(...args);
    });
    coordinator.notifyParent(coordinator.getRun(run.id), 'Unrelated progress update');
    await coordinator.control({ action: 'pause', runId: run.id }, restored.id);
    coordinator.requestPump(); await coordinator._whenSettledForTesting();
    expect(attempts).toBe(1);
    release(); await coordinator._whenSettledForTesting();
    coordinator.requestPump(); await coordinator._whenSettledForTesting();
    expect(fake.inputs.filter((input) => input.message.includes('Which owner should approve this work?'))).toHaveLength(1);
  });

  it('does not let a failed old-owner send reset delivery to a newer restored owner', async () => {
    const { parent, run } = await pendingRun();
    const item = store.getItem(run.items[0].id)!;
    store.upsertItem({ ...item, state: 'needs-answer', question: {
      question: 'Which owner should approve this work?', options: [{ id: 'continue', label: 'Owner A' }],
    } });
    fake.live.delete(parent.id);
    const first = fake.addParent(); first.historyThreadId = 'history-parent';
    let reject!: (error: Error) => void;
    const sending = new Promise<void>((_resolve, rejectSend) => { reject = rejectSend; });
    const send = fake.sendInput.bind(fake);
    vi.spyOn(fake, 'sendInput').mockImplementation(async (...args) => {
      if (args[0] === first.id && args[1].includes('Which owner should approve this work?')) return sending;
      await send(...args);
    });
    coordinator.resolveRunParent(coordinator.getRun(run.id));
    fake.live.delete(first.id);
    const second = fake.addParent(); second.historyThreadId = 'history-parent';
    coordinator.resolveRunParent(coordinator.getRun(run.id));
    await coordinator._whenSettledForTesting();
    reject(new Error('Old owner disappeared')); await coordinator._whenSettledForTesting();
    coordinator.requestPump(); await coordinator._whenSettledForTesting();
    expect(fake.inputs.filter((input) => input.instanceId === second.id && input.message.includes('Which owner should approve this work?'))).toHaveLength(1);
  });

  it('delivers a new worker question once when its notification restores ownership', async () => {
    planDoc('2026-01-01-worker-question-recovery');
    const parent = fake.addParent(); parent.historyThreadId = 'history-parent';
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');
    const worker = fake.created.find((instance) => instance.role === 'worker')!;
    await vi.waitFor(() => expect(worker.status).toBe('busy'));
    fake.live.delete(parent.id);
    const restored = fake.addParent(); restored.historyThreadId = 'history-parent';
    fake.say(worker, 'Which retention period has James approved?');
    fake.setStatus(worker, 'waiting_for_input');
    await coordinator._whenSettledForTesting();
    expect(store.getItem(run.items[0].id)?.question?.question).toBe('Which retention period has James approved?');
    const messages = fake.inputs.filter((input) => input.instanceId === restored.id && input.message.includes('Which retention period has James approved?'));
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toContain('the worker for');
    coordinator.requestPump(); await coordinator._whenSettledForTesting();
    expect(fake.inputs.filter((input) => input.instanceId === restored.id && input.message.includes('Which retention period has James approved?'))).toHaveLength(1);
  });

  it('does not replay questions when an in-flight resolver discovers a restored parent after shutdown', async () => {
    const { parent, run } = await pendingRun();
    const item = store.getItem(run.items[0].id)!;
    store.upsertItem({ ...item, state: 'needs-answer', question: {
      question: 'Which owner should approve this work?', options: [{ id: 'continue', label: 'Owner A' }],
    } });
    coordinator.shutdown();
    fake.live.delete(parent.id);
    const restored = fake.addParent(); restored.historyThreadId = 'history-parent';
    coordinator.resolveRunParent(coordinator.getRun(run.id));
    coordinator.notifyParent(coordinator.getRun(run.id), 'Late progress update');
    coordinator.requestPump(); await coordinator._whenSettledForTesting();
    expect(fake.inputs.filter((input) => input.instanceId === restored.id)).toHaveLength(0);
  });

  it('adopts a stranded run and keeps its queued item moving', async () => {
    const { parent, run } = await pendingRun();
    const item = store.getItem(run.items[0].id)!;
    fake.live.delete(parent.id);
    const adopter = fake.addParent(); adopter.historyThreadId = 'adopter-thread';
    await coordinator.control({ action: 'adopt', runId: run.id }, adopter.id);
    expect(store.getRun(run.id)).toMatchObject({ parentInstanceId: adopter.id, parentHistoryThreadId: 'adopter-thread', status: 'running' });
    expect(fake.inputs.some((input) => input.instanceId === adopter.id && input.message.includes('You now own Plan Queue run')
      && input.message.includes('1 items waiting, 0 in progress'))).toBe(true);
    store.upsertItem({ ...item, state: 'queued' });
    coordinator.requestPump();
    await waitForState(0, run.id, 'working');
    await vi.waitFor(() => expect(fake.created.find((instance) => instance.role === 'worker')?.config.parentId).toBe(adopter.id));
  });

  it.each(['original', 'restored'] as const)('refuses adoption while the %s parent is live', async (kind) => {
    const { parent, run } = await pendingRun();
    const adopter = fake.addParent();
    if (kind === 'restored') {
      fake.live.delete(parent.id);
      const restored = fake.addParent(); restored.historyThreadId = 'history-parent';
    }
    await expect(coordinator.control({ action: 'adopt', runId: run.id }, adopter.id)).rejects.toThrow(/live parent|still exists/);
    expect(store.getRun(run.id)?.parentInstanceId).not.toBe(adopter.id);
  });

  it('refuses queue-spawned sessions and absent callers as adopters', async () => {
    const { parent, run } = await pendingRun();
    fake.live.delete(parent.id);
    const worker = fake.addParent(); worker.metadata = { planQueueRole: 'worker' }; worker.historyThreadId = 'history-parent';
    await expect(coordinator.control({ action: 'adopt', runId: run.id }, worker.id)).rejects.toThrow();
    await expect(coordinator.control({ action: 'adopt', runId: run.id }, 'missing-caller')).rejects.toThrow();
    await expect(coordinator.control({ action: 'adopt', runId: run.id })).rejects.toThrow();
    expect(store.getRun(run.id)?.parentInstanceId).toBe(parent.id);
  });
});

/**
 * Simulate an app restart: the old coordinator and every live instance are
 * gone; the database and the repository survive. By default the parent
 * session is restored with the same id. With `parentRestoredLater` it is
 * archived instead, as the app does: recovery runs without it, and the test
 * restores it under a new id with `FakeInstances.restoreParent`.
 */
async function restart(
  relaxation: PlanQueueRelaxation | null = null,
  options: { parentRestoredLater?: boolean; parentArchived?: boolean; scripts?: Partial<Record<Role, Script>> } = {},
): Promise<FakeInstances> {
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
  Object.assign(next.scripts, options.scripts);
  if (options.parentRestoredLater) {
    // A crash or force quit archives nothing.
    if (options.parentArchived !== false) {
      archivedEntries.push({ originalInstanceId: parent.id, historyThreadId: parent.historyThreadId });
    }
  } else {
    next.live.set(parent.id, { ...parent, outputBuffer: [] });
  }
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

describe('PlanQueueCoordinator — autonomous readiness and current documents', { timeout: 30_000 }, () => {
  it('does not report settlement while a filesystem-backed scheduler pass is pending', async () => {
    planDoc('2026-01-01-alpha');
    fake.scripts.triage = never;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const reconcile = readiness.reconcileWaitingDocuments;
    const inspection = vi.spyOn(readiness, 'reconcileWaitingDocuments').mockImplementationOnce(async (...args) => {
      await gate;
      await reconcile(...args);
    });
    let settled = false;
    let settling: Promise<void> | undefined;
    try {
      await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
      settling = coordinator._whenSettledForTesting().then(() => { settled = true; });
      // A pending disk operation can outlive any fixed number of event-loop turns.
      for (let turn = 0; turn < 50; turn += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      expect(settled).toBe(false);
    } finally {
      release();
      await settling;
      inspection.mockRestore();
      await coordinator._whenSettledForTesting();
    }
    expect(settled).toBe(true);
  });

  it('classifies 29 documents in four batches while work on reported documents starts', async () => {
    for (let index = 0; index < 29; index += 1) planDoc(`2026-01-01-${String(index).padStart(2, '0')}`);
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', config: { workerSlots: 1 } });
    await vi.waitFor(() => expect(store.listItems(run.id).some((item) => item.state === 'discovered')).toBe(false), { timeout: 10_000 });
    const sessions = fake.created.filter((instance) => instance.role === 'triage');
    expect(sessions).toHaveLength(4);
    expect(sessions.map((instance) => instance.config.initialPrompt!.match(/<documents>\n([\s\S]*?)\n<\/documents>/)![1].split('\n').length)).toEqual([8, 8, 8, 5]);
    await waitForState(0, run.id, 'working');
  });

  const question = {
    question: 'Which existing service should implement this check?',
    options: [{ id: 'existing', label: 'Use the existing service' }, { id: 'skip', label: 'Leave this document' }],
  };

  it('answers an evidenced technical choice and passes the agent decision to the worker', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.triage = (instance) => {
      const runId = instance.config.metadata!['planQueueRunId'] as string;
      const doc = coordinator.getRunDto(runId)!.items[0].documentPath;
      coordinator.reportTriage(instance.id, { run_id: runId, records: [{
        documentPath: doc, disposition: 'needs-answer', question: { ...question, decision: {
          kind: 'technical', recommendedOptionId: 'existing', reason: 'The existing service owns the runtime path.',
          evidence: 'src/service.ts:10 exposes the required operation.',
        } },
      }] });
    };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await vi.waitFor(() => expect(fake.created.some((i) => i.role === 'worker')).toBe(true), { timeout: 5_000 });
    await waitForRun(run.id);
    const final = coordinator.getRunDto(run.id)!.items[0];
    expect(final.state).toBe('landed');
    expect(final.question).toBeNull();
    expect(final.answer).toContain('Automatic technical decision');
    expect(final.answer).toContain('Use the existing service');
    expect(final.answer).toContain('src/service.ts:10');
    expect(fake.created.find((i) => i.role === 'worker')!.config.initialPrompt).toContain(final.answer!);
    expect(final.answer).toContain(question.question);
    expect(fake.created.find((i) => i.role === 'worker')!.config.initialPrompt).toContain(question.question);
    expect(fake.inputs.filter((i) => i.instanceId === parent.id).some((i) => i.message.includes('needs James to decide'))).toBe(false);
  });

  it.each(['human-authority', 'human-input', undefined] as const)('keeps %s questions pending', async (kind) => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.triage = (instance) => {
      const runId = instance.config.metadata!['planQueueRunId'] as string;
      coordinator.reportTriage(instance.id, { run_id: runId, records: [{
        documentPath: coordinator.getRunDto(runId)!.items[0].documentPath,
        disposition: 'needs-answer', question: { ...question, ...(kind ? { decision: { kind, reason: 'A real human boundary remains.' } } : {}) },
      }] });
    };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'needs-answer');
    expect(fake.created.some((i) => i.role === 'worker')).toBe(false);
    expect(coordinator.getRunDto(run.id)!.items[0].answer).toBeNull();
  });

  it('recovers a persisted technical question automatically after a restart', async () => {
    planDoc('2026-01-01-alpha');
    fake.scripts.triage = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    store.upsertItem({ ...store.getItem(run.items[0].id)!, state: 'needs-answer', question: {
      ...question, decision: { kind: 'technical', recommendedOptionId: 'existing',
        reason: 'Use the existing runtime owner.', evidence: 'src/service.ts:10' },
    } });
    const next = await restart();
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed', question: null });
    expect(next.created.find((i) => i.role === 'worker')!.config.initialPrompt).toContain('Automatic technical decision');
    expect(next.created.some((i) => i.role === 'triage')).toBe(false);
  });

  it('reconciles a completed replacement before a recovered queued item starts', async () => {
    const doc = planDoc('2026-01-01-alpha');
    fake.scripts.triage = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    store.upsertItem({ ...store.getItem(run.items[0].id)!, state: 'queued' });
    renameSync(doc, doc.replace('_plan.md', '_plan_completed.md'));
    const next = await restart();
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'skipped', question: null, verdict: null });
    expect(next.created.some((i) => i.role === 'worker')).toBe(false);
  });

  it('parks repeated triage failure without inventing an answer for James', async () => {
    planDoc('2026-01-01-alpha');
    fake.scripts.triage = () => undefined;
    const parent = fake.addParent();
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'triage-failed', question: null });
    expect(fake.created.filter((i) => i.role === 'triage')).toHaveLength(2);
    expect(fake.created.some((i) => i.role === 'worker')).toBe(false);
    expect(fake.inputs.some((i) => i.instanceId === parent.id && i.message.includes('needs James to decide'))).toBe(false);
  });

  it('sends missing-spec investigation to triage rather than inventing a human question', async () => {
    writeDoc('docs/plans/2026-01-01-orphan_plan.md', '**Spec:** [spec](./missing_spec_planned.md)\n');
    fake.scripts.triage = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    expect(run.items[0].state).toBe('discovered');
    expect(run.items[0].question).toBeNull();
    expect(run.items[0].detail).toContain('missing_spec_planned.md');
  });

  it('leaves an unplanned spec open without queueing a worker against an obsolete planning path', async () => {
    const doc = writeDoc('docs/plans/2026-01-01-new_spec.md', '# Open scope needing an implementation plan\n');
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'skipped', question: null, answer: null, verdict: null });
    expect(coordinator.getRunDto(run.id)!.items[0].detail).toContain('spec remains open');
    expect(readFileSync(doc, 'utf8')).toBe('# Open scope needing an implementation plan\n');
    expect(existsSync(doc.replace('_spec.md', '_spec_completed.md'))).toBe(false);
    expect(fake.created.some((i) => i.role === 'worker' || i.role === 'triage')).toBe(false);
  });

  it('retires a stale readiness question when its document has an exact completed replacement', async () => {
    const doc = planDoc('2026-01-01-alpha');
    fake.scripts.triage = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    const item = store.getItem(run.items[0].id)!;
    store.upsertItem({ ...item, state: 'needs-answer', question });
    renameSync(doc, doc.replace('_plan.md', '_plan_completed.md'));
    coordinator.requestPump();
    await vi.waitFor(() => expect(store.getItem(item.id)?.state).toBe('skipped'), { timeout: 5_000 });
    const final = store.getItem(item.id)!;
    expect(final.question).toBeNull();
    expect(final.verdict).toBeNull();
    expect(final.detail).toContain('completed replacement');
    expect(fake.created.some((i) => i.role === 'worker')).toBe(false);
    expect(readFileSync(doc.replace('_plan.md', '_plan_completed.md'), 'utf8')).not.toContain('As built');
  });

  it('parks a disappeared document without a replacement as an error, not a question', async () => {
    const doc = planDoc('2026-01-01-alpha');
    fake.scripts.triage = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    rmSync(doc);
    coordinator.requestPump();
    await vi.waitFor(() => expect(store.getItem(run.items[0].id)?.state).toBe('parked'), { timeout: 5_000 });
    expect(store.getItem(run.items[0].id)).toMatchObject({ parkReason: 'worker-error', question: null, verdict: null });
    expect(store.getItem(run.items[0].id)!.detail).toContain('missing');
    expect(fake.created.some((i) => i.role === 'worker')).toBe(false);
  });

  it('keeps an active source when a completed filename also exists', async () => {
    const doc = planDoc('2026-01-01-alpha');
    writeFileSync(doc.replace('_plan.md', '_plan_completed.md'), '# Earlier campaign\n');
    fake.scripts.triage = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    expect(store.getItem(run.items[0].id)!.state).toBe('discovered');
  });
});

describe('PlanQueueCoordinator — whole run against a temp repo', { timeout: 30_000 }, () => {
  it('does not spawn a readiness session when tools become ready after shutdown', async () => {
    planDoc('2026-01-01-alpha');
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { release = resolve; });
    PlanQueueCoordinator._resetForTesting();
    coordinator = startCoordinator(fake, null, { whenOrchestratorToolsListening: () => ready });
    await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    coordinator.shutdown();
    release();
    await coordinator._whenSettledForTesting();
    expect(fake.created.filter((instance) => instance.role === 'triage')).toHaveLength(0);
  });

  it('does not spawn triage when tools become ready after Close all', async () => {
    planDoc('2026-01-01-alpha');
    let release!: () => void;
    const ready = new Promise<void>(resolve => { release = resolve; });
    PlanQueueCoordinator._resetForTesting();
    coordinator = startCoordinator(fake, null, { whenOrchestratorToolsListening: () => ready });
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    coordinator.noteUserClosing([], 'all');
    release();
    await coordinator._whenSettledForTesting();
    expect(store.getRun(run.id)?.status).toBe('paused');
    expect(fake.created.filter(instance => instance.role === 'triage')).toHaveLength(0);
    expect(store.listItems(run.id)[0].state).toBe('discovered');
  });

  it('pauses every running run before a user close and parks the closed worker without refilling', async () => {
    planDoc('2026-01-01-alpha'); planDoc('2026-01-02-beta');
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', config: { workerSlots: 1 } });
    await waitForState(0, run.id, 'working');
    const worker = fake.created.find(instance => instance.role === 'worker')!;
    expect(coordinator.noteUserClosing([worker.id], 'all')).toBe(1);
    await fake.terminateInstance(worker.id);
    await waitForState(0, run.id, 'parked');
    await coordinator._whenSettledForTesting();
    expect(store.getRun(run.id)?.status).toBe('paused');
    expect(store.getItem(run.items[0].id)).toMatchObject({ parkReason: 'cancelled', detail: expect.stringContaining('you closed its session') });
    expect(fake.created.filter(instance => instance.role === 'worker')).toHaveLength(1);
  });

  it('a single user close cancels that worker while the run continues', async () => {
    planDoc('2026-01-01-alpha'); fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForState(0, run.id, 'working');
    const worker = fake.created.find(instance => instance.role === 'worker')!;
    expect(coordinator.noteUserClosing([worker.id], 'one')).toBe(0);
    expect(store.getRun(run.id)?.status).toBe('running');
    await fake.terminateInstance(worker.id); await waitForState(0, run.id, 'parked');
    expect(store.getItem(run.items[0].id)?.parkReason).toBe('cancelled');
  });

  it('a user-closed verifier consumes no errored round and waits for resume', async () => {
    planDoc('2026-01-01-alpha'); fake.scripts.verifier = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForState(0, run.id, 'verifying');
    await vi.waitFor(() => expect(fake.created.some(instance => instance.role === 'verifier')).toBe(true));
    const verifier = fake.created.find(instance => instance.role === 'verifier')!;
    coordinator.noteUserClosing([verifier.id], 'all');
    await fake.terminateInstance(verifier.id); await waitForState(0, run.id, 'awaiting-slot');
    expect(store.getItem(run.items[0].id)).toMatchObject({ erroredRounds: 0, round: 0, detail: 'Its checker was closed; it will be checked again.' });
  });

  it('leaves a removed worker working during app shutdown and starts no further item', async () => {
    planDoc('2026-01-01-alpha');
    planDoc('2026-01-02-beta');
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', config: { workerSlots: 1 } });
    await waitForState(0, run.id, 'working');
    await vi.waitFor(() => expect(fake.created.filter((instance) => instance.role === 'worker')).toHaveLength(1));
    coordinator.shutdown();
    await fake.terminateInstance(fake.created.find((instance) => instance.role === 'worker')!.id);
    coordinator.requestPump();
    await coordinator._whenSettledForTesting();
    expect(store.getItem(run.items[0].id)?.state).toBe('working');
    expect(store.getRun(run.id)?.status).toBe('running');
    expect(fake.created.filter((instance) => instance.role === 'worker')).toHaveLength(1);
  });

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
    const verifiers = fake.created.filter((i) => i.role === 'verifier');
    expect(verifiers).toHaveLength(2);
    // Each silent verifier was reminded before its round counted as unusable.
    for (const verifier of verifiers) {
      expect(fake.inputs.filter((m) => m.instanceId === verifier.id).map((m) => m.message.split(':')[0]))
        .toEqual(['Plan Queue reminder 1 of 2', 'Plan Queue reminder 2 of 2']);
    }
  });

  it('reminds a verifier that ended its turn without a verdict and accepts its verdict from the same session', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = (instance, message) => {
      if (message.startsWith('Plan Queue reminder 1 of 2')) pass(instance, message, fake);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed', erroredRounds: 0 });
    const verifiers = fake.created.filter((i) => i.role === 'verifier');
    expect(verifiers).toHaveLength(1);
    const reminders = fake.inputs.filter((m) => m.instanceId === verifiers[0].id);
    expect(reminders).toHaveLength(1);
    expect(reminders[0].internalSource).toBe('plan-queue');
    expect(reminders[0].message).toContain('orchestrator.tool_search');
    expect(reminders[0].message).toContain('never end your turn while a gate is still running');
  });

  it('does not remind a verifier that changed the tree or failed', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    let verifications = 0;
    fake.scripts.verifier = (instance) => {
      verifications += 1;
      if (verifications === 1) writeFileSync(join(instance.workingDirectory!, 'a.txt'), 'verifier edit\n');
      else fake.setStatus(instance, 'error');
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'verifier-unreliable', erroredRounds: 2 });
    const verifiers = fake.created.filter((i) => i.role === 'verifier');
    expect(verifiers).toHaveLength(2);
    expect(fake.inputs.filter((m) => verifiers.some((v) => v.id === m.instanceId))).toEqual([]);
    expect(git(['show', 'main:a.txt'])).toBe('base');
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

  it('asks James about a genuine authority boundary and starts it after his answer', async () => {
    writeDoc('docs/plans/2026-01-01-orphan_plan.md', '# Plan\n\n**Spec:** [spec](./2026-01-01-orphan_spec_planned.md)\n');
    fake.scripts.triage = (instance) => {
      const runId = instance.config.metadata!['planQueueRunId'] as string;
      coordinator.reportTriage(instance.id, { run_id: runId, records: [{
        documentPath: coordinator.getRunDto(runId)!.items[0].documentPath,
        disposition: 'needs-answer', question: {
          question: 'May this work expand the approved scope?',
          options: [{ id: 'proceed', label: 'Approve the scope' }, { id: 'skip', label: 'Leave it' }],
          decision: { kind: 'human-authority', reason: 'This changes the approved scope.' },
        },
      }] });
    };
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'needs-answer');
    const item = coordinator.getRunDto(run.id)!.items[0];
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

  it('follows a parent restored under a new id: adopts the respawned worker and nests and reports to it', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');

    // As in the app: recovery respawns the worker before the parent is restored.
    let release!: () => void;
    const released = new Promise<void>((resolve) => { release = resolve; });
    const held: Script = async (instance, message, f) => {
      await implement(instance, message, f);
      await released;
    };
    const next = await restart(null, { parentRestoredLater: true, scripts: { worker: held } });
    const worker = next.created.find((i) => i.role === 'worker')!;
    expect(worker.config.parentId).toBeUndefined();

    // No scheduler pass: the restored parent is followed the moment it appears.
    const restored = next.restoreParent(parent);

    expect(restored.id).not.toBe(parent.id);
    expect(store.getRun(run.id)!.parentInstanceId).toBe(restored.id);
    expect(next.adoptions).toEqual([{ childId: worker.id, parentId: restored.id }]);

    release();
    await waitForRun(run.id);
    expect(next.created.find((i) => i.role === 'verifier')!.config.parentId).toBe(restored.id);
    expect(next.inputs.some((input) => input.instanceId === restored.id && input.internalSource === 'plan-queue')).toBe(true);
  });

  it('records the parent\'s thread and finds the restored parent by it after a crash archived nothing', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    expect(store.getRun(run.id)!.parentHistoryThreadId).toBe(parent.historyThreadId);
    await waitForState(0, run.id, 'working');

    const next = await restart(null, { parentRestoredLater: true, parentArchived: false, scripts: { worker: never } });
    const worker = next.created.find((i) => i.role === 'worker')!;
    const restored = next.restoreParent(parent);

    expect(store.getRun(run.id)!.parentInstanceId).toBe(restored.id);
    expect(next.adoptions).toEqual([{ childId: worker.id, parentId: restored.id }]);
  });

  it('finds the parent of a run recorded without a thread through history, then records the thread', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');
    driver.prepare('UPDATE plan_queue_runs SET parent_history_thread_id = NULL').run();

    const next = await restart(null, { parentRestoredLater: true, scripts: { worker: never } });
    const restored = next.restoreParent(parent);

    expect(store.getRun(run.id)).toMatchObject({ parentInstanceId: restored.id, parentHistoryThreadId: parent.historyThreadId });
  });

  it('keeps the recorded thread current when the parent starts a fresh thread, and still finds it after a restart', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');

    // "Restart fresh" keeps the session id and mints a new thread.
    parent.historyThreadId = 'thread-after-fresh-restart';
    coordinator.requestPump();
    await coordinator._whenSettledForTesting();
    expect(store.getRun(run.id)!.parentHistoryThreadId).toBe('thread-after-fresh-restart');

    const next = await restart(null, { parentRestoredLater: true, scripts: { worker: never } });
    const restored = next.restoreParent(parent);
    expect(store.getRun(run.id)!.parentInstanceId).toBe(restored.id);
  });

  it('falls back to the history archived from the old id when the recorded thread is stale', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');
    // The thread moved after the last follow, just before shutdown.
    parent.historyThreadId = 'thread-moved-at-shutdown';

    const next = await restart(null, { parentRestoredLater: true, scripts: { worker: never } });
    const restored = next.restoreParent(parent);

    expect(store.getRun(run.id)).toMatchObject({ parentInstanceId: restored.id, parentHistoryThreadId: 'thread-moved-at-shutdown' });
  });

  it('moves the run and its sessions to the replacement when the parent is edited and resent', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');
    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(worker.parentId).toBe(parent.id);

    // Edit-and-resend, in the app's order: the replacement appears on the
    // same thread, then the source (kept in memory, hidden) is superseded.
    const replacement = fake.restoreParent(parent);
    expect(store.getRun(run.id)!.parentInstanceId).toBe(parent.id);
    fake.setStatus(parent, 'superseded');

    expect(store.getRun(run.id)!.parentInstanceId).toBe(replacement.id);
    expect(fake.adoptions).toEqual([{ childId: worker.id, parentId: replacement.id }]);
    await coordinator.control({ action: 'pause', runId: run.id }, replacement.id);
    expect(coordinator.getRunDto(run.id)!.status).toBe('paused');
  });

  it('finds the edit replacement on the source\'s current thread when the recorded one is stale', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');

    // Restart fresh, then an edit-and-resend with no follow in between to
    // record the new thread (the replacement is not announced here).
    parent.historyThreadId = 'thread-after-fresh-restart';
    const replacement = fake.addParent();
    replacement.historyThreadId = parent.historyThreadId;
    fake.setStatus(parent, 'superseded');

    expect(store.getRun(run.id)).toMatchObject({ parentInstanceId: replacement.id, parentHistoryThreadId: 'thread-after-fresh-restart' });
  });

  it('accepts control from a parent restored under a new id', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');

    const next = await restart(null, { parentRestoredLater: true, scripts: { worker: never } });
    const restored = next.restoreParent(parent);
    await coordinator.control({ action: 'pause', runId: run.id }, restored.id);

    expect(coordinator.getRunDto(run.id)).toMatchObject({ status: 'paused', parentInstanceId: restored.id });
  });

  it('follows the restored parent without re-saving a stale run snapshot', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');

    const next = await restart(null, { parentRestoredLater: true, scripts: { worker: never } });
    // A spawn path holds this snapshot across awaits while James pauses the run.
    const stale = store.getRun(run.id)!;
    await coordinator.control({ action: 'pause', runId: run.id });
    const restored = next.restoreParent(parent);

    expect(coordinator.liveParentId(stale)).toBe(restored.id);
    expect(store.getRun(run.id)).toMatchObject({ status: 'paused', parentInstanceId: restored.id });
  });

  it('keeps a run whose parent was not restored on the recorded parent, its sessions unparented', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');

    const next = await restart(null, { parentRestoredLater: true, scripts: { worker: never } });
    next.addParent(); // an unrelated session: a different conversation thread
    coordinator.requestPump();
    await coordinator._whenSettledForTesting();

    expect(store.getRun(run.id)!.parentInstanceId).toBe(parent.id);
    expect(next.adoptions).toEqual([]);
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

  it('defers a recovered verifier until orchestrator tools are listening (LT-700)', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'verifying');

    let release!: () => void;
    const listening = new Promise<void>((resolve) => { release = resolve; });
    await Promise.race([
      coordinator._whenSettledForTesting(),
      new Promise((resolve) => setTimeout(resolve, 1_000)),
    ]);
    fake.live.clear();
    PlanQueueCoordinator._resetForTesting();
    WorktreeManager._resetForTesting();
    const next = new FakeInstances();
    next.scripts.triage = triageAllReady;
    next.scripts.worker = implement;
    next.scripts.verifier = pass;
    next.live.set(parent.id, { ...parent, outputBuffer: [] });
    fake = next;
    coordinator = startCoordinator(next, null, { whenOrchestratorToolsListening: () => listening });
    const recovering = coordinator.recover();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(next.created.filter((instance) => instance.role === 'verifier')).toHaveLength(0);

    release();
    await recovering;
    await vi.waitFor(() => {
      expect(next.created.filter((instance) => instance.role === 'verifier')).toHaveLength(1);
    });
    const verifier = next.created.find((instance) => instance.role === 'verifier')!;
    const mcp = buildOrchestratorToolsMcpConfig({
      aioMcpCliPath: '/Applications/Harness.app/Contents/Resources/aio-mcp-cli/aio-mcp',
      socketPath: '/tmp/harness/ot-test.sock',
      instanceId: verifier.id,
      capabilityToken: 'cap-test-token',
      provider: verifier.provider,
      exists: () => true,
    });
    expect(mcp).toContain('"orchestrator"');
    expect(mcp).toContain('orchestrator-tools');
    expect(mcp).toContain('/tmp/harness/ot-test.sock');
    expect(mcp).toContain(verifier.id);
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

    const pending = store.getItem(run.items[2].id)!;
    store.upsertItem({ ...pending, state: 'needs-answer', question: {
      question: 'Which human-owned account should this campaign use?',
      options: [{ id: 'proceed', label: 'Account A' }, { id: 'skip', label: 'Leave it' }],
      decision: { kind: 'human-input', reason: 'The account is not specified in available sources.' },
    } });

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
    }, { timeout: 10_000 });
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

  it('Resume checks a held item out again when its folder was half-removed, then checks and lands it', async () => {
    appendFileSync(join(repo, '.gitignore'), '_scratch/\n');
    git(['commit', '-qam', 'ignore scratch']);
    const { runId, itemId, branch } = await parkedAtRoundLimit();
    // As on 26 Oct: paused while waiting for its checker, its folder reduced to an ignored _scratch.
    const leftover = join(repo, '.worktrees', branch);
    mkdirSync(join(leftover, '_scratch'), { recursive: true });
    writeFileSync(join(leftover, '_scratch', 'notes.txt'), 'scratch\n');
    store.upsertItem({ ...store.getItem(itemId)!, state: 'awaiting-slot', worktreePath: leftover, round: 0, verdict: null, parkReason: null, detail: 'Paused', heldAt: Date.now() });
    store.upsertRun({ ...store.getRun(runId)!, status: 'paused', endedAt: null });
    fake.scripts.verifier = pass;

    await coordinator.control({ action: 'resume', runId });
    await waitForRun(runId);

    expect(store.getItem(itemId)).toMatchObject({ state: 'landed' });
    expect(git(['show', 'main:2026-01-01-alpha_plan.feature.txt'])).toBe('built 2026-01-01-alpha_plan');
    const [moved] = readdirSync(join(repo, '.worktrees/queue-quarantine'));
    expect(readFileSync(join(repo, '.worktrees/queue-quarantine', moved!, 'leftover/_scratch/notes.txt'), 'utf8')).toBe('scratch\n');
  });

  it.each([
    { change: 'code repair', resume: 'explicit resume' },
    { change: 'document only', resume: 'explicit resume' },
    { change: 'code repair', resume: 'legacy awaiting verification' },
    { change: 'document only', resume: 'legacy awaiting verification' },
  ] as const)('$resume rebuilds a blocked candidate for $change', async ({ change, resume }) => {
    const doc = planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    const hooks = join(repo, '.git', 'hooks');
    const counter = join(repo, '.git', 'landing-hook-runs');
    writeFileSync(join(hooks, 'pre-commit'),
      `#!/bin/sh\nn=$(cat "${counter}" 2>/dev/null || echo 0); echo $((n+1)) > "${counter}"\n`);
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    git(['config', 'core.hooksPath', hooks]);
    writeFileSync(join(repo, 'a.txt'), 'operator work\n');
    fake.scripts.worker = (instance) => {
      writeFileSync(join(instance.workingDirectory!, 'a.txt'), 'first version\n');
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);
    const before = store.getItem(run.items[0].id)!;
    expect(before).toMatchObject({ state: 'parked', parkReason: 'land-blocked' });
    expect(before.landedCommit).not.toBeNull();
    expect(git(['show', `${before.landedCommit}:a.txt`])).toBe('first version');
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('operator work\n');
    expect(readFileSync(counter, 'utf8').trim()).toBe('1');
    appendFileSync(doc, '\nNew acceptance evidence from the resumed round.\n');
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    const repair = (worktreePath: string) => {
      if (change === 'code repair') {
        writeFileSync(join(worktreePath, 'a.txt'), 'repaired version\n');
        writeFileSync(join(worktreePath, 'repair.txt'), 'required new repair\n');
      }
    };
    fake.scripts.worker = (instance) => repair(instance.workingDirectory!);
    fake.scripts.verifier = (instance, message, instances) => {
      expect(store.getItem(before.id)!.landedCommit).toBeNull();
      return pass(instance, message, instances);
    };

    if (resume === 'explicit resume') {
      await coordinator.control({ action: 'resume-item', itemId: before.id }, parent.id);
      expect(store.getItem(before.id)).toMatchObject({ landedCommit: null, verdict: null, verifiedMainCommit: null });
    } else {
      // Persisted state from the old app: its worker already checkpointed the
      // repair, but left the original prepared candidate in the item row.
      let waiting = await coordinator.worktrees.reattach(before, repo);
      repair(waiting.worktreePath!);
      waiting = await coordinator.worktrees.checkpoint(waiting, 'legacy worker finished');
      store.upsertItem({ ...waiting, state: 'awaiting-slot', landedCommit: before.landedCommit });
      store.upsertRun({ ...store.getRun(run.id)!, status: 'running', endedAt: null });
      coordinator.requestPump();
    }
    await waitForRun(run.id);

    const after = store.getItem(before.id)!;
    expect(after).toMatchObject({ state: 'landed', branchName: null, worktreePath: null });
    expect(after.landedCommit).not.toBe(before.landedCommit);
    expect(git(['rev-parse', 'main'])).toBe(after.landedCommit);
    expect(git(['show', 'main:a.txt'])).toBe(change === 'code repair' ? 'repaired version' : 'first version');
    if (change === 'code repair') {
      expect(git(['show', 'main:repair.txt'])).toBe('required new repair');
      expect(after.checkpointCommit).not.toBe(before.checkpointCommit);
    } else {
      expect(after.checkpointCommit).toBe(before.checkpointCommit);
    }
    expect(git(['show', 'main:docs/plans/2026-01-01-alpha_plan_completed.md']))
      .toContain('New acceptance evidence from the resumed round.');
    expect(readFileSync(counter, 'utf8').trim()).toBe('2');
    expect(git(['log', '--format=%s', 'main']).split('\n')).toEqual(['Plan: 2026-01-01-alpha_plan', 'base']);
    expect(git(['branch', '--list', before.branchName!])).toBe('');
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

  it('lets another session cancel a run whose parent session is gone, and records who did it', async () => {
    writeDoc('docs/plans/2026-01-01-orphan_plan.md', '# Plan\n\n**Spec:** [spec](./2026-01-01-orphan_spec_planned.md)\n');
    const parent = fake.addParent();
    const rescuer = fake.addParent();
    fake.scripts.triage = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    store.upsertItem({ ...store.getItem(run.items[0].id)!, state: 'needs-answer', question: {
      question: 'May this campaign expand its scope?',
      options: [{ id: 'proceed', label: 'Approve' }, { id: 'skip', label: 'Leave it' }],
      decision: { kind: 'human-authority', reason: 'New scope requires approval.' },
    } });
    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('needs-answer');

    // While the parent lives, the run is still the parent's alone.
    await expect(coordinator.control({ action: 'cancel', runId: run.id }, rescuer.id)).rejects.toThrow(/Only the session that started/);

    fake.live.delete(parent.id);
    // A session the queue spawned can never rescue, and the rescue covers only cancel and discard.
    fake.live.set('worker-other-run', { ...rescuer, id: 'worker-other-run', metadata: { planQueueRole: 'worker' } });
    await expect(coordinator.control({ action: 'cancel', runId: run.id }, 'worker-other-run')).rejects.toThrow(/Only the session that started/);
    await expect(coordinator.control({ action: 'pause', runId: run.id }, rescuer.id)).rejects.toThrow(/Use action "adopt" to take over/);
    await expect(coordinator.answer(run.items[0].id, 'proceed', rescuer.id)).rejects.toThrow(/Only the session that started/);
    expect(coordinator.getRunDto(run.id)!.status).toBe('running');

    await coordinator.control({ action: 'cancel', runId: run.id }, rescuer.id);

    const cancelled = coordinator.getRunDto(run.id)!;
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.items[0].state).toBe('skipped');
    expect(cancelled.items[0].detail).toBe(
      `Run cancelled by session ${rescuer.id}, because the session that started the run (${parent.id}) no longer exists.`,
    );
    // Its documents are free again: a new run claims them.
    const next = await coordinator.startRun({ parentInstanceId: rescuer.id, kind: 'plans' });
    expect(next.excluded).toEqual([]);
    expect(next.run.items).toHaveLength(1);
  });

  it('lets another session discard a stranded run\'s parked item, and nothing else', async () => {
    const { runId, itemId, branch, parentId } = await parkedAtRoundLimit();
    const rescuer = fake.addParent();
    fake.live.delete(parentId);

    await expect(coordinator.control({ action: 'resume-item', itemId }, rescuer.id)).rejects.toThrow(/Use action "adopt" to take over/);
    await expect(coordinator.control({ action: 'land-anyway', itemId }, rescuer.id)).rejects.toThrow(/Use action "adopt" to take over/);
    expect(git(['branch', '--list', branch])).not.toBe('');

    await coordinator.control({ action: 'discard-item', itemId }, rescuer.id);

    expect(git(['branch', '--list', branch])).toBe('');
    expect(coordinator.getRunDto(runId)!.items[0].detail).toContain(
      `Discarded by session ${rescuer.id}, because the session that started the run (${parentId}) no longer exists.`,
    );
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

function poolAccount(id: string, provider: 'claude' | 'codex', overrides: Partial<ProviderAccountProfile> = {}): ProviderAccountProfile {
  return {
    id, provider, label: id.toUpperCase(), expectedIdentity: null, expectedAccountKey: null, planLabel: null,
    priority: poolProfiles.length, enabled: true, automationPolicy: 'allow-routed', isLegacy: false,
    createdAt: 0, updatedAt: 0, ...overrides,
  };
}

describe('PlanQueueCoordinator — providers and accounts', { timeout: 30_000 }, () => {
  it('gives workers the starting session\'s account and routes every queue session as automatic work', async () => {
    planDoc('2026-01-01-alpha');
    poolProfiles = [poolAccount('max-a', 'claude'), poolAccount('max-b', 'claude')];
    const parent = fake.addParent();
    parent.accountProfileId = 'max-b';

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    expect(run.config.routing).toEqual({
      workers: [{ provider: 'claude', model: 'claude-sonnet-5', accountProfileIds: ['max-b'] }],
      verifiers: [],
    });
    await waitForRun(run.id);

    const triage = fake.created.find((i) => i.role === 'triage')!;
    expect(triage.config).toMatchObject({ provider: 'claude', accountRouteOrigin: 'automation', allowedAccountProfileIds: ['max-b'] });
    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(worker.config).toMatchObject({ provider: 'claude', accountRouteOrigin: 'automation', allowedAccountProfileIds: ['max-b'] });
    const verifier = fake.created.find((i) => i.role === 'verifier')!;
    expect(verifier.config.accountRouteOrigin).toBe('verification');
    expect(verifier.config.allowedAccountProfileIds).toBeUndefined();
  });

  it('does not inherit an account James kept for manual use', async () => {
    planDoc('2026-01-01-alpha');
    poolProfiles = [poolAccount('max-a', 'claude', { automationPolicy: 'manual-only' })];
    const parent = fake.addParent();
    parent.accountProfileId = 'max-a';

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    expect(run.config.routing?.workers).toEqual([{ provider: 'claude', model: 'claude-sonnet-5' }]);
    await waitForRun(run.id);
    expect(fake.created.find((i) => i.role === 'worker')!.config.allowedAccountProfileIds).toBeUndefined();
  });

  it('uses the saved choice over the starting session, and passes the saved checkers to verifier selection', async () => {
    planDoc('2026-01-01-alpha');
    poolProfiles = [poolAccount('pro-1', 'codex'), poolAccount('pro-2', 'codex')];
    savedRouting = {
      workers: [{ provider: 'codex', model: 'gpt-6.1-sol', accountProfileIds: ['pro-2'] }],
      verifiers: [{ provider: 'claude' }],
    };
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    expect(run.workerProvider).toBe('codex');
    expect(run.config.routing?.checkersChosenBy).toBe('saved');
    await waitForRun(run.id);

    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(worker.config).toMatchObject({ provider: 'codex', modelOverride: 'gpt-6.1-sol', allowedAccountProfileIds: ['pro-2'] });
    expect(verifierInputs[0]).toMatchObject({ choices: [{ provider: 'claude' }], choicesOverrideLicence: true });
  });

  it('keeps James\'s saved lists over a run\'s own choices, and says which were set aside', async () => {
    planDoc('2026-01-01-alpha');
    savedRouting = { workers: [{ provider: 'codex' }], verifiers: [{ provider: 'claude' }] };
    const parent = fake.addParent();

    const { run, routingSetAside } = await coordinator.startRun({
      parentInstanceId: parent.id,
      kind: 'plans',
      routing: { workers: [{ provider: 'cursor' }], verifiers: [] },
    });
    expect(run.config.routing).toEqual({ workers: [{ provider: 'codex' }], verifiers: [{ provider: 'claude' }], checkersChosenBy: 'saved' });
    expect(routingSetAside).toEqual(['workers', 'checkers']);
    await waitForRun(run.id);
    expect(fake.created.find((i) => i.role === 'worker')!.config.provider).toBe('codex');
    expect(verifierInputs[0]?.choices).toEqual([{ provider: 'claude' }]);
  });

  it('records a worker\'s provider only once it is known, never the "auto" it starts with', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = (instance, message, f) => {
      instance.provider = 'auto';
      return implement(instance, message, f);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);
    expect(store.listItems(run.id)[0]).not.toHaveProperty('workerProvider');
  });

  it('refuses to start a run whose list names a CLI that is not installed, rather than running another provider', async () => {
    planDoc('2026-01-01-alpha');
    installedProviders = ['claude'];
    savedRouting = { workers: [{ provider: 'claude' }, { provider: 'codex' }], verifiers: [] };
    const parent = fake.addParent();

    await expect(coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' }))
      .rejects.toThrow('Plan Queue: codex is not installed. Install its CLI or choose another provider.');
    expect(coordinator.listRunDtos()).toEqual([]);
  });

  it('uses a run\'s own choices where James saved none', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();

    const { run, routingSetAside } = await coordinator.startRun({
      parentInstanceId: parent.id,
      kind: 'plans',
      routing: { workers: [{ provider: 'cursor' }], verifiers: [{ provider: 'claude' }] },
    });
    expect(run.config.routing).toEqual({ workers: [{ provider: 'cursor' }], verifiers: [{ provider: 'claude' }], checkersChosenBy: 'run' });
    expect(routingSetAside).toEqual([]);
    await waitForRun(run.id);
    expect(fake.created.find((i) => i.role === 'worker')!.config.provider).toBe('cursor');
  });

  it('starts new sessions on the first worker choice with usage left, and records what each worker ran on', async () => {
    planDoc('2026-01-01-alpha');
    savedRouting = { workers: [{ provider: 'claude', model: 'claude-opus-5' }, { provider: 'codex', model: 'gpt-6.1-sol' }], verifiers: [] };
    outOfUsage = ['claude'];
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    expect(fake.created.find((i) => i.role === 'triage')!.config).toMatchObject({ provider: 'codex', modelOverride: 'gpt-6.1-sol' });
    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(worker.config).toMatchObject({ provider: 'codex', modelOverride: 'gpt-6.1-sol' });
    // The checker is chosen against the worker that actually ran, not the run's first choice.
    expect(verifierInputs[0]).toMatchObject({ workerProvider: 'codex', workerModel: 'gpt-6.1-sol' });
    expect(store.listItems(run.id)[0]).toMatchObject({ workerProvider: 'codex', workerModel: 'gpt-6.1-sol' });
  });

  it('never starts a worker on a provider with no usage left: the document waits, then runs once usage is back', async () => {
    planDoc('2026-01-01-alpha');
    savedRouting = { workers: [{ provider: 'claude', model: 'claude-opus-5' }], verifiers: [] };
    const parent = fake.addParent();
    // Triage runs; then Claude reaches its limit before the worker starts.
    fake.scripts.triage = (instance, message, f) => {
      outOfUsage = ['claude'];
      return triageAllReady(instance, message, f);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await vi.waitFor(() => expect(store.listItems(run.id)[0]).toMatchObject({
      state: 'queued', detail: expect.stringContaining('Waiting for usage: claude (claude-opus-5) has no usage left'),
    }), { timeout: 15_000, interval: 25 });
    coordinator.requestPump();
    await coordinator._whenSettledForTesting();
    expect(fake.created.some((i) => i.role === 'worker')).toBe(false);
    expect(store.listItems(run.id)[0]).toMatchObject({ state: 'queued', parkReason: null, round: 0 });

    outOfUsage = [];
    const realNow = Date.now.bind(Date);
    const later = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6 * 60_000);
    try {
      coordinator.requestPump();
      await waitForRun(run.id);
    } finally {
      later.mockRestore();
    }
    expect(store.listItems(run.id)[0].state).toBe('landed');
    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(worker.config).toMatchObject({ provider: 'claude', modelOverride: 'claude-opus-5' });
    expect(worker.config.initialPrompt).toContain('it waited for usage to come back on its provider');
  });

  it('never starts a checker on a provider with no usage left: the check waits without counting a round', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = (instance, message, f) => {
      outOfUsage = ['codex'];
      return implement(instance, message, f);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await vi.waitFor(() => expect(store.listItems(run.id)[0]).toMatchObject({
      state: 'awaiting-slot', detail: expect.stringContaining('Waiting for usage: codex has no usage left'),
    }), { timeout: 15_000, interval: 25 });
    coordinator.requestPump();
    await coordinator._whenSettledForTesting();
    expect(fake.created.some((i) => i.role === 'verifier')).toBe(false);
    expect(store.listItems(run.id)[0]).toMatchObject({ state: 'awaiting-slot', erroredRounds: 0, round: 0 });

    outOfUsage = [];
    const realNow = Date.now.bind(Date);
    const later = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 6 * 60_000);
    try {
      coordinator.requestPump();
      await waitForRun(run.id);
    } finally {
      later.mockRestore();
    }
    expect(store.listItems(run.id)[0].state).toBe('landed');
  });

  it('refuses a run on a never-auto-pick provider unless the run relaxes that list', async () => {
    planDoc('2026-01-01-alpha');
    excludedProviders = ['claude'];
    const parent = fake.addParent();

    await expect(coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' }))
      .rejects.toThrow('Plan Queue worker: claude is on the "never auto-pick these providers" list');
    expect(coordinator.listRunDtos()).toEqual([]);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { relaxSettings: true } });
    expect(run.config.routing?.workers[0]?.provider).toBe('claude');
    await waitForRun(run.id);
  });

  it('parks a worker, with the reason, when its provider joins the never-auto-pick list mid-run', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.triage = (instance, message, f) => {
      excludedProviders = ['claude'];
      return triageAllReady(instance, message, f);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    expect(fake.created.some((i) => i.role === 'worker')).toBe(false);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({
      state: 'parked',
      parkReason: 'worker-error',
      detail: expect.stringContaining('claude has been added to the "never auto-pick these providers" list since this run started'),
    });
  });

  it('parks undecided documents with the real reason when triage cannot start', async () => {
    planDoc('2026-01-01-alpha');
    // Hold every spawn until the exclusion is in place, so the order is deterministic.
    let openTools!: () => void;
    const listening = new Promise<void>((resolve) => { openTools = resolve; });
    let clock = 1_000_000;
    PlanQueueCoordinator._resetForTesting();
    coordinator = startCoordinator(fake, null, { whenOrchestratorToolsListening: () => listening, now: () => clock });
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    excludedProviders = ['claude'];
    openTools();
    // A refused start is retried no sooner than a minute later; three refusals park it.
    await vi.waitFor(() => {
      clock += 60_000;
      coordinator.requestPump();
      expect(coordinator.getRunDto(run.id)!.items[0]?.state).toBe('parked');
    }, { timeout: 15_000, interval: 30 });

    expect(fake.created.some((i) => i.role === 'triage')).toBe(false);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({
      state: 'parked',
      parkReason: 'triage-failed',
      detail: expect.stringContaining('could not start after three tries: claude has been added to the "never auto-pick these providers" list since this run started, so the queue will not start another session on it'),
    });
  });

  it('refuses to start a run whose saved choice names an account the queue may not use', async () => {
    planDoc('2026-01-01-alpha');
    poolProfiles = [poolAccount('max-a', 'claude', { enabled: false })];
    savedRouting = { workers: [{ provider: 'claude', accountProfileIds: ['max-a'] }], verifiers: [] };
    const parent = fake.addParent();

    await expect(coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' }))
      .rejects.toThrow('the claude account "MAX-A" is turned off');
    expect(coordinator.listRunDtos()).toEqual([]);
  });
});

describe('PlanQueueCoordinator — handing a stuck document to the step-up worker', { timeout: 30_000 }, () => {
  const haiku = { provider: 'claude', model: 'haiku' };
  const opus = { provider: 'claude', model: 'opus' };
  const fail: Script = (instance) => {
    coordinator.reportVerdict(instance.id, {
      item_id: itemIdOf(instance), verdict: 'FAIL',
      findings: [{ severity: 'high', confidence: 80, summary: 'Retry never resets.' }], gates_run: [], document_complete: false, need_james: [],
    });
  };
  /** FAIL the first `failures` checks, then PASS. */
  const failThenPass = (failures: number): Script => {
    let checks = 0;
    return (instance, message, f) => { checks += 1; return checks <= failures ? fail(instance, message, f) : pass(instance, message, f); };
  };
  const workers = (instances = fake) => instances.created.filter((i) => i.role === 'worker');
  const steppedUp = (instance: FakeInstance) => instance.config.metadata?.['planQueueSteppedUp'] === true;
  const parentMessages = (parent: FakeInstance) => fake.inputs.filter((m) => m.instanceId === parent.id).map((m) => m.message);

  beforeEach(() => {
    savedRouting = { workers: [haiku], verifiers: [], stepUp: opus };
  });

  it('hands a document that failed every round to the step-up worker once, which then lands it', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = failThenPass(1);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await waitForRun(run.id);

    const [first, second] = workers();
    expect(workers()).toHaveLength(2);
    expect(first.config).toMatchObject({ provider: 'claude', modelOverride: 'haiku' });
    expect(steppedUp(first)).toBe(false);
    expect(second.config).toMatchObject({ provider: 'claude', modelOverride: 'opus' });
    expect(steppedUp(second)).toBe(true);
    // The cheap worker was stopped before the step-up worker started; its work stayed on the branch.
    expect(fake.live.has(first.id)).toBe(false);
    expect(second.config.initialPrompt).toContain('An earlier, cheaper attempt did not pass after 1 verification round(s).');
    expect(second.config.initialPrompt).toContain('Retry never resets.');
    // Its checker was chosen against what the step-up worker ran on.
    expect(verifierInputs.map((input) => [input.workerProvider, input.workerModel])).toEqual([['claude', 'haiku'], ['claude', 'opus']]);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'landed', round: 1, erroredRounds: 0 });
    expect(item.steppedUpAt).toEqual(expect.any(Number));
    expect(git(['show', 'main:2026-01-01-alpha_plan.feature.txt'])).toBe('built 2026-01-01-alpha_plan');
    expect(parentMessages(parent).filter((m) => m.includes('handed to the stronger worker'))).toEqual([
      expect.stringContaining('2026-01-01-alpha_plan.md failed its checks in all 1 verification round(s), so it was handed to the stronger worker James chose (claude / opus).'),
    ]);
  });

  it('parks a document the step-up worker could not pass either, never handing it over twice, and Resume keeps the step-up worker', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = fail;

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 2 } });
    await waitForRun(run.id);

    const parked = coordinator.getRunDto(run.id)!.items[0];
    expect(parked).toMatchObject({ state: 'parked', parkReason: 'round-limit', round: 2 });
    expect(parked.detail).toMatch(/^Still failing after the step-up worker's 2 verification round\(s\): \[high, confidence 80\] Retry never resets\./);
    expect(workers().map(steppedUp)).toEqual([false, true]);
    expect(parentMessages(parent).filter((m) => m.includes('handed to the stronger worker'))).toHaveLength(1);

    // James resumes it: the next worker is the step-up worker again.
    fake.scripts.verifier = pass;
    await coordinator.control({ action: 'resume-item', itemId: parked.id });
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed', steppedUpAt: parked.steppedUpAt });
    expect(workers()).toHaveLength(3);
    expect(workers()[2].config).toMatchObject({ provider: 'claude', modelOverride: 'opus' });
    expect(steppedUp(workers()[2])).toBe(true);
  });

  it('parks as before when the run has no step-up choice', async () => {
    savedRouting = { workers: [haiku], verifiers: [] };
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = fail;

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'round-limit', steppedUpAt: null });
    expect(item.detail).toMatch(/^Still failing after 1 verification round\(s\)/);
    expect(workers()).toHaveLength(1);
  });

  it.each([
    ['verifier-unreliable', { verifier: (() => undefined) as Script }],
    ['worker-error', { worker: ((instance, _message, f) => { f.setStatus(instance, 'error'); }) as Script }],
  ])('never hands over a document parked as %s', async (reason, scripts) => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    Object.assign(fake.scripts, scripts);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: reason, steppedUpAt: null });
    expect(workers().some(steppedUp)).toBe(false);
  });

  it('starts the step-up worker after a restart that came between recording the handover and starting it', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = fail;
    // The step-up worker's session never comes up before the app goes down.
    const create = fake.createInstance.bind(fake);
    fake.createInstance = (config) => (config.metadata?.['planQueueSteppedUp'] === true ? new Promise<never>(() => undefined) : create(config));

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await vi.waitFor(() => {
      const item = store.getItem(run.items[0].id)!;
      if (item.state !== 'fixing' || !item.steppedUpAt) throw new Error(`item is ${item.state}`);
    }, { timeout: 15_000, interval: 25 });
    const recorded = store.getItem(run.items[0].id)!;
    expect(recorded.workerInstanceId).toBeNull();

    const next = await restart(null, { scripts: { verifier: fail } });
    await waitForRun(run.id);

    expect(workers(next)).toHaveLength(1);
    expect(workers(next)[0].config).toMatchObject({ provider: 'claude', modelOverride: 'opus' });
    expect(steppedUp(workers(next)[0])).toBe(true);
    // It failed too, and there was no second handover.
    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'round-limit', steppedUpAt: recorded.steppedUpAt });
    expect(item.detail).toContain('the step-up worker\'s 1 verification round(s)');
  });

  it('holds a document paused while its step-up worker was starting, and Resume carries on with the step-up worker', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = failThenPass(1);
    const create = fake.createInstance.bind(fake);
    let paused = false;
    fake.createInstance = async (config) => {
      if (config.metadata?.['planQueueSteppedUp'] !== true || paused) return create(config);
      paused = true;
      // Pause lands while the new session is still coming up.
      void coordinator.control({ action: 'pause', runId: config.metadata['planQueueRunId'] as string });
      await vi.waitFor(() => { if (store.getRun(config.metadata!['planQueueRunId'] as string)!.status !== 'paused') throw new Error('not paused'); });
      return create(config);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await vi.waitFor(() => {
      const item = store.getItem(run.items[0].id)!;
      if (!item.heldAt || !item.steppedUpAt) throw new Error(`item is ${item.state}`);
    }, { timeout: 15_000, interval: 25 });
    await coordinator._whenSettledForTesting();
    // The session that came up during the pause was not leaked.
    expect(workers().filter((w) => fake.live.has(w.id))).toEqual([]);
    expect(store.getItem(run.items[0].id)!.pendingInstruction).toContain('An earlier, cheaper attempt did not pass');

    await coordinator.control({ action: 'resume', runId: run.id });
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed' });
    const resumed = workers().at(-1)!;
    expect(resumed.config).toMatchObject({ provider: 'claude', modelOverride: 'opus' });
    expect(steppedUp(resumed)).toBe(true);
    expect(resumed.config.initialPrompt).toContain('An earlier, cheaper attempt did not pass after 1 verification round(s).');
  });
  it('parks a document whose step-up worker could not start, says so, and Resume tries the step-up worker again', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = failThenPass(1);
    const create = fake.createInstance.bind(fake);
    let refused = false;
    fake.createInstance = async (config) => {
      if (config.metadata?.['planQueueSteppedUp'] === true && !refused) { refused = true; throw new Error('CLI missing'); }
      return create(config);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await waitForRun(run.id);

    const parked = coordinator.getRunDto(run.id)!.items[0];
    expect(parked).toMatchObject({ state: 'parked', parkReason: 'worker-error' });
    expect(parked.steppedUpAt).toEqual(expect.any(Number));
    const handover = parentMessages(parent).filter((m) => m.includes('handed to the stronger worker'));
    expect(handover).toEqual([expect.stringContaining('That worker could not start, so the document is parked; Resume continues with the stronger worker.')]);
    expect(handover[0]).not.toContain('more round(s)');

    await coordinator.control({ action: 'resume-item', itemId: parked.id });
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed', steppedUpAt: parked.steppedUpAt });
    expect(workers().at(-1)!.config).toMatchObject({ provider: 'claude', modelOverride: 'opus' });
  });
});

describe('queue spend reductions', { timeout: 30_000 }, () => {
  it('waits for capacity and starts on a later pump, while real preparation failures still park', async () => {
    planDoc('2026-01-01-capacity');
    fake.scripts.worker = never;
    const prepare = vi.spyOn(coordinator.worktrees, 'prepare').mockRejectedValue(new WorktreeCapacityError('Maximum concurrent worktrees (5) reached'));
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    const waiting = store.listItems(run.id)[0];
    expect(waiting).toMatchObject({ state: 'queued', round: 0, parkReason: null, detail: 'Waiting for a free worktree (Harness allows 5 at once).' });
    prepare.mockRestore();
    coordinator.requestPump();
    await coordinator._whenSettledForTesting();
    expect(store.getItem(waiting.id)).toMatchObject({ state: 'working', detail: null });
    prepare.mockRestore();
  });

  it('keeps genuine preparation errors parked', async () => {
    planDoc('2026-01-01-prepare-failure');
    vi.spyOn(coordinator.worktrees, 'prepare').mockRejectedValueOnce(new Error('disk unavailable'));
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    expect(store.listItems(run.id)[0]).toMatchObject({ state: 'parked', parkReason: 'worktree-error', detail: 'Could not prepare the worktree: disk unavailable' });
  });
});

it.each([
  ['provider-limit', 'the verifier stopped at a usage limit before reporting a verdict'],
  ['needs-input', 'the verifier asked a question instead of reporting a verdict'],
] as const)('counts verifier %s failures with a specific reason', async (kind, detail) => {
  planDoc('2026-01-01-specific-verifier-stop');
  fake.scripts.verifier = (instance, _message, source) => {
    if (kind === 'needs-input') source.setStatus(instance, 'waiting_for_input');
    else {
      source.say(instance, 'Claude usage limit reached.');
      source.setStatus(instance, 'idle');
    }
  };
  const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
  await waitForRun(run.id);
  expect(store.listItems(run.id)[0]).toMatchObject({ state: 'parked', parkReason: 'verifier-unreliable', erroredRounds: 2, detail });
}, 30_000);

it('clears the former conversation before handing work to the step-up worker', async () => {
  savedRouting = { workers: [{ provider: 'claude', model: 'haiku' }], verifiers: [], stepUp: { provider: 'claude', model: 'opus' } };
  planDoc('2026-01-01-session-step-up');
  let sawInitialSession = false;
  let sawClearedSession = false;
  fake.scripts.worker = async (instance, message, source) => {
    const current = store.getItem(itemIdOf(instance))!;
    if (instance.currentModel === 'opus') {
      expect(current.workerSession).toBeUndefined();
      sawClearedSession = true;
    }
    instance.providerSessionId = `conversation-${instance.id}`;
    await implement(instance, message, source);
  };
  let verificationCount = 0;
  const verify: Script = (instance) => {
    verificationCount++;
    coordinator.reportVerdict(instance.id, { item_id: itemIdOf(instance),
      verdict: verificationCount === 1 ? 'FAIL' : 'PASS', findings: [], gates_run: [], document_complete: true, need_james: [] });
  };
  fake.scripts.verifier = async (instance, message, source) => {
    expect(store.getItem(itemIdOf(instance))?.workerSession?.providerSessionId).toBeTruthy();
    sawInitialSession = true;
    await verify(instance, message, source);
  };
  const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', config: { maxRounds: 1 } });
  await waitForRun(run.id);
  expect(sawInitialSession).toBe(true);
  expect(sawClearedSession).toBe(true);
  expect(store.listItems(run.id)[0].workerSession).toBeUndefined();
}, 30_000);
