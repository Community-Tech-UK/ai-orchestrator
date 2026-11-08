import { execFileSync } from 'node:child_process';
import { HarnessStopError } from '../../shared/utils/harness-stop';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import * as net from 'node:net';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueFolderChecklist, type PlanQueueRouting } from '@contracts/schemas/plan-queue';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type { ProviderAccountProfile } from '../../shared/types/provider-account.types';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { getLogger } from '../logging/logger';
import { _resetReclaimHoldsForTesting } from '../process/reclaim-holds';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { WorktreeCapacityError, WorktreeManager } from '../workspace/git/worktree-manager';
import { buildOrchestratorToolsMcpConfig } from '../mcp/orchestrator-tools-mcp-config';
import { InputTurnRegistry } from '../instance/input-turn-registry';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import { PlanQueueItemFlow } from './plan-queue-item-flow';
import type { PlanQueueInstanceRecord } from './plan-queue-host';
import { findRestoredSessionId } from './plan-queue-parent';
import { PlanQueueRelaxation } from './plan-queue-relaxation';
import * as readiness from './plan-queue-readiness';
import { SET_ASIDE_FOLDER_METADATA } from './plan-queue-set-aside';
import { PlanQueueStore } from './plan-queue-store';
import { _setReportRequiredProvidersForTesting, recordWorkerReport } from './plan-queue-worker-report';
import type { VerifierSelectInput } from './plan-queue-verifier-select';

const machineGates = vi.hoisted(() => ({ failItem: false, timeOutItem: false }));
// These repositories exercise Git and session ownership. Command execution is
// controlled here; the gate runner has its own execution and receipt coverage.
vi.mock('./plan-queue-gate-receipts', async original => {
  const actual = await original<typeof import('./plan-queue-gate-receipts')>();
  return { ...actual, PlanQueueGateRunner: class extends actual.PlanQueueGateRunner {
    constructor() { super(async (_command, cwd) => machineGates.timeOutItem && cwd.includes('/queue/')
      ? { exitCode: 1, output: '', timedOut: true }
      : machineGates.failItem && cwd.includes('/queue/')
      ? { exitCode: 1, output: 'src/feature.ts(1,1): error TS2322: New failure', timedOut: false }
      : { exitCode: 0, output: '✓ 1 files · 1 tests passed in 0s', timedOut: false }); }
  } };
});

const landing = vi.hoisted(() => ({ active: 0, max: 0, hang: false, hung: false, hangPromotion: false, hookTimeout: false, conflict: false, baseMovesOnce: null as (() => void) | null, mergeCheckTimeout: false, mergeChecks: 0 }));
vi.mock('./plan-queue-landing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plan-queue-landing')>();
  return {
    ...actual,
    runPostMergeGate: (...args: Parameters<typeof actual.runPostMergeGate>) => {
      landing.mergeChecks += 1;
      if (landing.mergeCheckTimeout) writeFileSync(`${args[1]}/left-by-killed-check.txt`, 'partial\n');
      return landing.mergeCheckTimeout
        ? Promise.resolve({ ok: false as const, command: 'npm run typecheck:spec', output: '', timedOut: true }) : actual.runPostMergeGate(...args);
    },
    landItemBranch: async (...args: Parameters<typeof actual.landItemBranch>) => {
      if (landing.hang) {
        landing.hung = true;
        return new Promise<never>(() => undefined);
      }
      if (landing.conflict) return { status: 'conflict' as const, conflictFiles: ['shared.txt'] };
      if (landing.baseMovesOnce) {
        const move = landing.baseMovesOnce;
        landing.baseMovesOnce = null;
        move();
        return { status: 'conflict' as const, conflictFiles: ['shared.txt'] };
      }
      if (landing.hookTimeout) {
        return { status: 'hook-failed' as const, output: '[plan queue] the pre-commit hook timed out after 3600000ms', timedOut: true };
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
let personTurns: InputTurnRegistry;
/** James's saved Plan Queue routing and account pool, as the coordinator reads them. */
let savedRouting: PlanQueueRouting;
/** James's saved checklist per folder, as the coordinator reads it. */
let savedFolderChecklists: PlanQueueFolderChecklist[];
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

/** A project that defines every npm script the default checklists name, as this repository does. */
function defineDefaultScripts(): void {
  const names = [...DEFAULT_PLAN_QUEUE_CONFIG.plans.verifierGates, ...DEFAULT_PLAN_QUEUE_CONFIG.plans.postMergeGate]
    .flatMap((command) => /^npm run (\S+)/.exec(command)?.[1] ?? []);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: Object.fromEntries(names.map((name) => [name, 'true'])) }));
  writeFileSync(join(repo, 'tsconfig.json'), '{}');
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
  restartFreshInstance = vi.fn(async () => undefined);

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
    item_id: itemIdOf(instance), verdict: 'PASS', findings: [], gates_run: [], document_complete: true, need_james: [], not_checked: [],
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
  machineGates.failItem = false;
  machineGates.timeOutItem = false;
  WorktreeManager._resetForTesting();
  GitWriteQueue._resetForTesting();
  PlanQueueCoordinator._resetForTesting();
  _resetReclaimHoldsForTesting();
  landing.active = 0;
  landing.max = 0;
  landing.hang = false;
  landing.hung = false;
  landing.hangPromotion = false;
  landing.hookTimeout = false;
  landing.mergeCheckTimeout = false;
  landing.mergeChecks = 0;
  landing.conflict = false;
  landing.baseMovesOnce = null;
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
  savedFolderChecklists = [];
  outOfUsage = [];
  installedProviders = ['claude', 'codex', 'cursor', 'copilot', 'opencode', 'gemini'];
  poolProfiles = [];
  verifierInputs = [];
  _setReportRequiredProvidersForTesting();
  excludedProviders = [];
  archivedEntries = [];
  personTurns = new InputTurnRegistry();
  fake = new FakeInstances();
  fake.scripts.triage = triageAllReady;
  fake.scripts.worker = implement;
  fake.scripts.verifier = pass;
  coordinator = startCoordinator(fake);
});

function startCoordinator(
  instances: FakeInstances,
  relaxation: PlanQueueRelaxation | null = null,
  extras: { whenOrchestratorToolsListening?: () => Promise<void>; now?: () => number; thisRepositoryRootCommit?: string } = {},
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
    folderChecklists: () => savedFolderChecklists,
    // Never this temporary repository's own first commit unless a test says it is this repository.
    thisRepositoryRootCommit: extras.thisRepositoryRootCommit ?? 'not-a-real-commit',
    loadAverage: () => [0, 0, 0],
    personTurns,
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

  it('moves a live owner\'s run for James (Move and aio-mcp plan-queue move) only once its work has stopped', async () => {
    const { parent, run } = await pendingRun();
    const taker = fake.addParent();
    const move = () => coordinator.control({ action: 'handover', runId: run.id, targetInstanceId: taker.id });
    await expect(move()).rejects.toThrow('Pause this run');
    expect(store.getRun(run.id)?.parentInstanceId).toBe(parent.id);

    await coordinator.control({ action: 'pause', runId: run.id });
    await move();
    expect(store.getRun(run.id)).toMatchObject({ parentInstanceId: taker.id, status: 'paused' });
    expect(fake.inputs.some(input => input.instanceId === taker.id && input.message.includes('You now own Plan Queue run'))).toBe(true);
    await vi.waitFor(() => expect(fake.inputs.some(input => input.instanceId === parent.id && input.message.includes('You no longer own it'))).toBe(true));
  });

  it('refuses a move queued behind a cancel that leaves the run with no set-aside work', async () => {
    const { parent, run } = await pendingRun();
    await coordinator.control({ action: 'pause', runId: run.id });
    const taker = fake.addParent();
    // The move is checked and queued while the run is still paused; the cancel finishes first.
    const cancel = coordinator.control({ action: 'cancel', runId: run.id });
    const move = coordinator.control({ action: 'handover', runId: run.id, targetInstanceId: taker.id });
    await cancel;
    await expect(move).rejects.toThrow('holds no set-aside work; there is nothing to move');
    expect(store.listItems(run.id).some(item => item.state === 'parked')).toBe(false);
    expect(store.getRun(run.id)).toMatchObject({ parentInstanceId: parent.id, status: 'cancelled' });
  });

  it('never makes a Set aside agent the owner of a run', async () => {
    const { parent, run } = await pendingRun();
    await coordinator.control({ action: 'pause', runId: run.id });
    const setAside = fake.addParent(); setAside.metadata = { [SET_ASIDE_FOLDER_METADATA]: repo };
    await expect(coordinator.control({ action: 'handover', runId: run.id, targetInstanceId: setAside.id }))
      .rejects.toThrow('A Set aside agent cannot own a Plan Queue run.');
    expect(store.getRun(run.id)?.parentInstanceId).toBe(parent.id);
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
    expect(store.getItem(run.items[0].id)).toMatchObject({ parkReason: 'missing-document', question: null, verdict: null });
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
      'docs/plans/2026-01-01-alpha_plan_closure_completed.json',
      'docs/plans/2026-01-01-alpha_plan_completed.md',
      'docs/plans/2026-01-01-alpha_spec_completed.md',
    ]);
    expect(git(['show', 'main:docs/plans/2026-01-01-alpha_spec_completed.md'])).toContain('2026-01-01-alpha_plan_completed.md');
    // Active names are retired; retain exactly the original inodes for late writers.
    expect(existsSync(join(repo, 'docs/plans/2026-01-01-alpha_plan.md'))).toBe(false);
    expect(existsSync(join(repo, 'docs/plans/2026-01-01-alpha_spec_planned.md'))).toBe(false);
    const retained = readdirSync(join(repo, 'docs/plans')).filter(name => name.includes('.aio-retained-')).sort();
    expect(retained).toEqual([
      expect.stringMatching(/^\.2026-01-01-alpha_plan\.md\.aio-retained-[0-9a-f-]{36}$/),
      expect.stringMatching(/^\.2026-01-01-alpha_spec_planned\.md\.aio-retained-[0-9a-f-]{36}$/),
    ]);
    expect(retained.map(name => readFileSync(join(repo, 'docs/plans', name), 'utf8'))).toEqual([
      '# Plan\n\n**Spec:** [spec](./2026-01-01-alpha_spec_planned.md)\n\n- [ ] build it\n\nAs built: done.\n',
      '# Spec\n\n**Plan:** [plan](./2026-01-01-alpha_plan.md)\n',
    ]);
    expect(git(['status', '--porcelain', '--untracked-files=all']).split('\n').sort())
      .toEqual(retained.map(name => `?? docs/plans/${name}`));
    expect(readFileSync(join(repo, 'docs/plans/2026-01-01-alpha_plan_completed.md'), 'utf8'))
      .toBe('# Plan\n\n**Spec:** [spec](./2026-01-01-alpha_spec_completed.md)\n\n- [ ] build it\n\nAs built: done.\n');
    expect(queueWorktrees()).toEqual([]);
    expect(git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/queue/'])).toBe('');

    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(worker.config).toMatchObject({ parentId: parent.id, provider: 'claude', modelOverride: 'claude-sonnet-5', yoloMode: true });
    const verifier = fake.created.find((i) => i.role === 'verifier')!;
    expect(verifier.config).toMatchObject({ parentId: parent.id, provider: 'codex' });
    // The parent got the end-of-run summary.
    expect(fake.inputs.some((m) => m.instanceId === parent.id && m.message.includes('Landed 1'))).toBe(true);

    // What Queue health is computed from: both sessions' start and end with provider and model, and the landing's steps.
    const timings = (reason: string) => driver.prepare('SELECT detail_head AS detail FROM plan_queue_item_events WHERE reason = ? ORDER BY rowid')
      .all<{ detail: string }>(reason).map((row) => JSON.parse(row.detail) as Record<string, unknown>);
    expect(timings('session-start')).toEqual([
      { role: 'worker', instanceId: worker.id, provider: 'claude', model: 'claude-sonnet-5' },
      { role: 'checker', instanceId: verifier.id, provider: 'codex', model: null },
    ]);
    expect(timings('session-end')).toEqual([{ role: 'checker', instanceId: verifier.id }, { role: 'worker', instanceId: worker.id }]);
    expect(timings('landing-timing')).toEqual([expect.objectContaining({ outcome: 'landed', commitCheckMs: expect.any(Number),
      publishMs: expect.any(Number), totalMs: expect.any(Number), loadStart: expect.any(Number), loadEnd: expect.any(Number) })]);
    expect(coordinator.getQueueHealth()).toMatchObject({ attemptsLanded: { count: 1, of: 1 }, firstCheckPassed: { count: 1, of: 1 },
      landingTime: { count: 1 }, checkTime: { count: 1 } });

    // Where full test runs went comes from the remote checks folder, when there is one.
    const machine = join(repo, 'remote-checks-folder');
    mkdirSync(machine);
    writeFileSync(join(machine, 'config.json'), '{"host":"pc","label":"the PC"}');
    try {
      vi.stubEnv('AIO_REMOTE_CHECKS_DIR', machine);
      expect(coordinator.getQueueHealth().testMachine).toMatchObject({ label: 'the PC', unreachable: false });
      vi.stubEnv('AIO_REMOTE_CHECKS_DIR', join(repo, 'no-such-folder'));
      expect(coordinator.getQueueHealth()).not.toHaveProperty('testMachine');
    } finally {
      vi.unstubAllEnvs();
    }
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
        gates_run: [], document_complete: true, need_james: [], not_checked: [],
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
        findings: [{ severity: 'medium', confidence: 70, summary: 'Still wrong.' }], gates_run: [], document_complete: true, need_james: [], not_checked: [],
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
            item_id: itemIdOf(instance), verdict: 'PASS', findings: [], gates_run: [], document_complete: true, need_james: [], not_checked: [],
          });
          attempts.push('accepted');
        } catch (error) {
          attempts.push(String(error));
        }
      }
      coordinator.reportVerdict(instance.id, {
        item_id: itemIdOf(instance), verdict: 'FAIL', findings: [], gates_run: [], document_complete: true, need_james: [], not_checked: [],
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

  it.each([
    { label: 'records a checked port for a livetest item that had none', hadPort: false },
    { label: 'keeps the port a livetest item already had, without re-checking it', hadPort: true },
  ])('after a restart, $label', async ({ hadPort }) => {
    writeDoc('docs/plans/2026-01-01-alpha_livetest.md', '# L\n');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests' });
    await waitForState(0, run.id, 'working');
    const itemId = coordinator.getRunDto(run.id)!.items[0].id;
    // The worker that died may still hold its dev app's port; a check-free would wrongly move the item off it.
    // Any free port does: a fixed one collides when full runs overlap on a machine.
    const holder = hadPort ? net.createServer() : null;
    await new Promise<void>((resolve, reject) => { if (!holder) return resolve(); holder.once('error', reject); holder.listen({ port: 0, host: '127.0.0.1' }, resolve); });
    // As if the app died before the port was saved (null), or with it saved (a number).
    const recorded = holder ? (holder.address() as net.AddressInfo).port : null;
    store.upsertItem({ ...store.getItem(itemId)!, livetestPort: recorded });
    try {
      // The respawned worker stays idle: the test ends as soon as it exists, and a worker that kept
      // building would write into a working folder the teardown has already removed.
      const next = await restart(null, { scripts: { worker: never } });
      await vi.waitFor(() => { if (!next.created.some((i) => i.role === 'worker')) throw new Error('no respawned worker yet'); });
      verifyRestartPort(next);
    } finally { await new Promise<void>((resolve) => { if (!holder) return resolve(); holder.close(() => resolve()); }); }

    function verifyRestartPort(next: FakeInstances): void {
      const port = store.getItem(itemId)!.livetestPort;
      if (recorded === null) {
        expect(port).toBeGreaterThanOrEqual(9500);
        expect(port).toBeLessThan(9900);
      } else expect(port).toBe(recorded);
      expect(next.created.find((i) => i.role === 'worker')!.config.initialPrompt).toContain(`--remote-debugging-port=${port}`);
    }
  });

  describe('a turn Harness stopped on purpose (Decision 16a)', () => {
    /** The provider error a Codex round raises when it passes its token ceiling. */
    const stoppedByHarness: Script = (instance, _message, instances) => {
      instances.emit('provider:normalized-event', {
        eventId: 'e', seq: 0, timestamp: 0, provider: 'codex', instanceId: instance.id,
        event: {
          kind: 'error', recoverable: false, message: 'Stopped by Harness: this turn passed 300M tokens.',
          details: { stoppedByHarness: { reason: 'turn-token-ceiling', tokens: 301_000_000, thresholdTokens: 300_000_000 } },
        },
      });
    };

    it('parks the worker as stopped-by-harness without starting a replacement or a checker', async () => {
      planDoc('2026-01-01-alpha');
      const parent = fake.addParent();
      fake.scripts.worker = stoppedByHarness;

      const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
      await waitForRun(run.id);

      expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({
        state: 'parked', parkReason: 'stopped-by-harness', detail: expect.stringContaining('Stopped by Harness: this turn passed 300M tokens.'),
      });
      expect(fake.created.filter((i) => i.role === 'worker')).toHaveLength(1);
      expect(fake.created.filter((i) => i.role === 'verifier')).toHaveLength(0);
    });

    it('does not start a replacement worker when a fix-round send fails with the stop', async () => {
      planDoc('2026-01-01-alpha');
      const parent = fake.addParent();
      let verifications = 0;
      fake.scripts.verifier = (instance) => {
        verifications += 1;
        coordinator.reportVerdict(instance.id, {
          item_id: itemIdOf(instance), verdict: 'FAIL',
          findings: [{ severity: 'medium', confidence: 70, summary: 'Needs another round.' }], gates_run: [], document_complete: true, need_james: [], not_checked: [],
        });
      };
      let workerTurns = 0;
      fake.scripts.worker = (instance, message, instances) => {
        workerTurns += 1;
        return workerTurns === 1 ? implement(instance, message, instances) : stoppedByHarness(instance, message, instances);
      };
      const send = fake.sendInput.bind(fake);
      // The real adapter ends the failed send with the typed stop error.
      fake.sendInput = async (id, message, attachments, options) => {
        await send(id, message, attachments, options);
        if (fake.getInstance(id)?.role === 'worker') {
          throw new HarnessStopError({ reason: 'turn-token-ceiling', tokens: 301_000_000, thresholdTokens: 300_000_000 });
        }
      };

      const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 3 } });
      await waitForRun(run.id);

      expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'stopped-by-harness' });
      expect(fake.created.filter((i) => i.role === 'worker')).toHaveLength(1);
      expect(verifications).toBe(1);
    });

    it('parks a stopped checker instead of counting an errored round and trying again', async () => {
      planDoc('2026-01-01-alpha');
      const parent = fake.addParent();
      fake.scripts.verifier = stoppedByHarness;

      const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
      await waitForRun(run.id);

      expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'stopped-by-harness', erroredRounds: 0 });
      expect(fake.created.filter((i) => i.role === 'verifier')).toHaveLength(1);
    });

    it('parks a stopped readiness check on the first stop rather than retrying it', async () => {
      planDoc('2026-01-01-alpha');
      const parent = fake.addParent();
      fake.scripts.triage = stoppedByHarness;

      const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
      await waitForRun(run.id);

      expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'stopped-by-harness' });
      expect(fake.created.filter((i) => i.role === 'triage')).toHaveLength(1);
    });
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
            item_id: itemIdOf(instance), verdict: 'PASS', findings: [], gates_run: [], document_complete: true, need_james: [], not_checked: [],
          });
          attempts.push('accepted');
        } catch (error) {
          attempts.push(String(error));
        }
      }
      coordinator.reportVerdict(instance.id, {
        item_id: itemIdOf(instance), verdict: 'FAIL', findings: [], gates_run: [], document_complete: true, need_james: [], not_checked: [],
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

  it('finishes parking a job Harness stopped when the app ended mid-park, without respawning its worker', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForState(0, run.id, 'working');
    // The first step of parking a Harness stop is to record it; the app then ended before the rest happened.
    store.upsertItem({ ...store.getItem(run.items[0].id)!, parkReason: 'stopped-by-harness', detail: 'Stopped by Harness: this turn passed 300M tokens.' });

    const next = await restart();
    await vi.waitFor(() => expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('parked'));

    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ parkReason: 'stopped-by-harness', detail: expect.stringContaining('300M tokens') });
    expect(next.created.filter((i) => i.role === 'worker')).toHaveLength(0);
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
        not_checked: [],
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
    // The dev app's port is one the queue checked free and recorded on the item.
    const recorded = store.getItem(coordinator.getRunDto(run.id)!.items[0].id)!.livetestPort;
    expect(recorded).toBeGreaterThanOrEqual(9500);
    expect(recorded).toBeLessThan(9900);
    expect(worker.config.initialPrompt).toContain(`--remote-debugging-port=${recorded}`);

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
      'docs/plans/2026-01-01-alpha_livetest_closure_completed.json',
      'docs/plans/2026-01-01-alpha_livetest_completed.md',
    ]);
  });

  it('refuses to start a run whose checks would use a different Node than the project pins, before creating any work', async () => {
    writeFileSync(join(repo, '.nvmrc'), 'v1.0.0\n');
    writeDoc('docs/plans/2026-01-01-alpha_livetest.md', '# L\n');
    const parent = fake.addParent();

    await expect(coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests' })).rejects.toThrow(/This run cannot start: the project's checks would run on Node v\d+.*asks for Node v1\.0\.0/);
    expect(coordinator.listRunDtos()).toEqual([]);
  });

  it('starts a project that lacks the default scripts with no checklist, so the verifier uses its documented checks', async () => {
    writeDoc('docs/plans/2026-01-01-alpha_livetest.md', '# L\n');
    const parent = fake.addParent();
    fake.scripts.verifier = livetestVerdict(false);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests' });
    expect(run.config).toMatchObject({ verifierGates: [], postMergeGate: [] });
    // A caller who names its own gates still gets them.
    const named = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests', config: { verifierGates: ['make check'] } });
    expect(named.run.config.verifierGates).toEqual(['make check']);
  });

  it('uses the livetest defaults: one worker at a time and the light verifier gate list', async () => {
    // This temporary repository stands in for this repository: its first commit is the one that earns the built-in checklists.
    PlanQueueCoordinator._resetForTesting();
    coordinator = startCoordinator(fake, null, { thisRepositoryRootCommit: git(['rev-list', '--max-parents=0', 'HEAD']) });
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { lint: 'true', typecheck: 'true', 'typecheck:spec': 'true' } }));
    writeFileSync(join(repo, 'tsconfig.json'), '{}');
    git(['add', 'package.json', 'tsconfig.json']);
    git(['commit', '-qm', 'project scripts']);
    writeDoc('docs/plans/2026-01-01-alpha_livetest.md', '# L\n');
    writeDoc('docs/plans/2026-01-02-beta_livetest.md', '# L\n');
    const parent = fake.addParent();
    fake.scripts.verifier = livetestVerdict(false);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests' });
    expect(run.config).toMatchObject({ workerSlots: 1, verificationSlots: 1, verifierGates: ['npx tsc --noEmit', 'npm run lint'] });
    await waitForRun(run.id);
    expect(fake.maxLive.worker).toBe(1);
  });

  it('gives a different project no checklist, even one that copies this repository\'s package name, scripts and tsconfig', async () => {
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'harness', scripts: { lint: 'true', typecheck: 'true', 'typecheck:spec': 'true' } }));
    writeFileSync(join(repo, 'tsconfig.json'), '{}');
    git(['add', 'package.json', 'tsconfig.json']);
    git(['commit', '-qm', 'project scripts']);
    writeDoc('docs/plans/2026-01-01-alpha_livetest.md', '# L\n');
    const parent = fake.addParent();
    fake.scripts.verifier = livetestVerdict(false);

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'livetests' });
    expect(run.config).toMatchObject({ verifierGates: [], postMergeGate: [] });
  });
});

describe('PlanQueueCoordinator — operator actions', { timeout: 30_000 }, () => {
  async function parkedAtRoundLimit(): Promise<{ runId: string; itemId: string; branch: string; parentId: string }> {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = (instance) => {
      coordinator.reportVerdict(instance.id, {
        item_id: itemIdOf(instance), verdict: 'FAIL', findings: [], gates_run: [], document_complete: true, need_james: [], not_checked: [],
      });
    };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await waitForRun(run.id);
    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item.state).toBe('parked');
    return { runId: run.id, itemId: item.id, branch: item.branchName!, parentId: parent.id };
  }

  it('the Set aside agent clears only an empty job and cannot skip or adopt', async () => {
    const { runId, itemId, branch } = await parkedAtRoundLimit();
    const agent = fake.addParent();
    agent.metadata = { [SET_ASIDE_FOLDER_METADATA]: repo };
    const events: unknown[] = [];
    coordinator.on('state-changed', (event) => events.push(event));

    expect(await coordinator.setAsideAgents.clear(agent.id)).toMatchObject({ cleared: 0, left: 1 });
    expect(git(['rev-parse', '--verify', branch])).toBeTruthy();
    await expect(coordinator.control({ action: 'skip-item', itemId }, agent.id)).rejects.toThrow('may only retry');
    await expect(coordinator.control({ action: 'adopt', runId }, agent.id)).rejects.toThrow('may only retry');
    await expect(coordinator.startRun({ parentInstanceId: agent.id, kind: 'plans' })).rejects.toThrow('Set aside session');

    git(['merge', '-q', '--no-edit', branch]);
    expect(await coordinator.setAsideAgents.clear(agent.id)).toMatchObject({ cleared: 0, left: 1 });
    const fresh = fake.addParent();
    fresh.metadata = { [SET_ASIDE_FOLDER_METADATA]: repo };
    events.length = 0;
    expect(await coordinator.setAsideAgents.clear(fresh.id)).toMatchObject({ cleared: 1, left: 0 });
    expect(events).toEqual([{ runId }]);
    expect(coordinator.getRunDto(runId)!.items[0]).toMatchObject({ branchName: null });
    expect(coordinator.getRunDto(runId)!.items[0].discardedBy).toContain('the Set aside agent');
  });

  it('the Set aside agent can discard a job holding work, and bring it back', async () => {
    const { runId, itemId, branch } = await parkedAtRoundLimit();
    const agent = fake.addParent();
    agent.metadata = { [SET_ASIDE_FOLDER_METADATA]: repo };

    await coordinator.control({ action: 'discard-item', itemId }, agent.id);

    expect(git(['branch', '--list', branch])).toBe('');
    expect(coordinator.getRunDto(runId)!.items[0].discardedBy).toContain('the Set aside agent');

    await coordinator.control({ action: 'restore-discarded', itemId }, agent.id);

    expect(git(['branch', '--list', branch])).not.toBe('');
    expect(coordinator.getRunDto(runId)!.items[0]).toMatchObject({ state: 'parked', discardedAt: null });
  });

  it('lets another session discard a job while its owner is alive, and records who did', async () => {
    const { runId, itemId, branch } = await parkedAtRoundLimit();
    const other = fake.addParent();

    await coordinator.control({ action: 'discard-item', itemId }, other.id);

    expect(git(['branch', '--list', branch])).toBe('');
    expect(coordinator.getRunDto(runId)!.items[0].discardedBy).toBe(`session ${other.id}`);
  });

  it('refuses a Set aside agent\'s invalid retry before anything changes', async () => {
    const { runId, itemId } = await parkedAtRoundLimit();
    const agent = fake.addParent();
    agent.metadata = { [SET_ASIDE_FOLDER_METADATA]: repo };
    const before = coordinator.getRunDto(runId)!.items[0];

    await expect(coordinator.control({ action: 'retry-landing', itemId }, agent.id)).rejects.toThrow('Only a land-blocked parked item');
    expect(coordinator.getRunDto(runId)!.items[0]).toMatchObject({ state: 'parked', parkReason: before.parkReason, branchName: before.branchName });
  });

  it('lets the Set aside agent merge a job without checks, and records that it did', async () => {
    const { runId, itemId } = await parkedAtRoundLimit();
    const agent = fake.addParent();
    agent.metadata = { [SET_ASIDE_FOLDER_METADATA]: repo };

    await coordinator.control({ action: 'land-anyway', itemId }, agent.id);
    await coordinator._whenSettledForTesting();

    const landed = coordinator.getRunDto(runId)!.items[0];
    expect(landed.state).toBe('landed');
    expect(landed.detail).toContain(`Landed without a verifier PASS by the Set aside agent (session ${agent.id})`);
    expect(git(['log', '-1', '--format=%s', 'main'])).toBe('Plan: 2026-01-01-alpha_plan');
  });

  describe('a document with another merged attempt', () => {
    async function withMergedAttempt(startedAfterParked: number) {
      const parked = await parkedAtRoundLimit();
      const item = coordinator.getItem(parked.itemId);
      store.upsertRun({ ...coordinator.getRun(parked.runId), id: 'run-that-merged' });
      store.upsertItem({ ...item, id: 'merged-attempt', runId: 'run-that-merged', state: 'landed', createdAt: item.createdAt + startedAfterParked });
      return parked;
    }

    it('refuses the Set aside agent\'s Land anyway over a newer merged attempt, which stays James\'s choice', async () => {
      const { itemId } = await withMergedAttempt(1);
      const agent = fake.addParent();
      agent.metadata = { [SET_ASIDE_FOLDER_METADATA]: repo };
      await expect(coordinator.control({ action: 'land-anyway', itemId }, agent.id)).rejects.toThrow('A newer attempt at this document has already merged');
      expect(coordinator.getItem(itemId).state).toBe('parked');
    });

    it.each(['resume-item', 'retry-landing'] as const)('refuses %s once a newer attempt has merged', async (action) => {
      const { itemId } = await withMergedAttempt(1);
      await expect(coordinator.control({ action, itemId })).rejects.toThrow('already merged');
      expect(coordinator.getItem(itemId).state).toBe('parked');
    });

    it('still refuses after a routine save moves the job\'s last-updated time past the merge', async () => {
      const { itemId } = await withMergedAttempt(1);
      const item = coordinator.getItem(itemId);
      store.upsertItem({ ...item, updatedAt: item.updatedAt + 1_000_000 });
      await expect(coordinator.control({ action: 'resume-item', itemId })).rejects.toThrow('already merged');
    });

    it('lets a newer attempt continue after an older one merged', async () => {
      const { itemId } = await withMergedAttempt(-1);
      await coordinator.control({ action: 'resume-item', itemId });
      expect(coordinator.getItem(itemId).state).not.toBe('parked');
    });
  });

  it('the Set aside agent resumes a job through the normal path', async () => {
    const { runId, itemId } = await parkedAtRoundLimit();
    const agent = fake.addParent();
    agent.metadata = { [SET_ASIDE_FOLDER_METADATA]: repo };
    fake.scripts.verifier = pass;
    await coordinator.control({ action: 'resume-item', itemId }, agent.id);
    await waitForRun(runId);
    expect(coordinator.getRunDto(runId)!.items[0].state).toBe('landed');
  });

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

  it('Resume on a discarded job carries on from its kept work and lands it', async () => {
    const { runId, itemId, branch } = await parkedAtRoundLimit();
    fake.scripts.verifier = pass;
    await coordinator.control({ action: 'discard-item', itemId });
    expect(git(['branch', '--list', branch])).toBe('');

    await coordinator.control({ action: 'resume-item', itemId });
    await waitForRun(runId);

    expect(coordinator.getRunDto(runId)!.items[0]).toMatchObject({ state: 'landed', discardedAt: null });
    expect(fake.created.filter((i) => i.role === 'worker').at(-1)!.config.initialPrompt).toContain(branch);
  });

  it('Resume sends the worker the findings the item was parked with', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.verifier = (instance) => {
      coordinator.reportVerdict(instance.id, {
        item_id: itemIdOf(instance), verdict: 'FAIL', gates_run: [], document_complete: false, need_james: [], not_checked: [],
        findings: [{ severity: 'high', confidence: 90, summary: 'The retry path never resets the attempt counter.' }],
      });
    };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 1 } });
    await waitForRun(run.id);
    const parked = coordinator.getRunDto(run.id)!.items[0];
    expect(parked.state).toBe('parked');
    fake.scripts.verifier = pass;

    await coordinator.control({ action: 'resume-item', itemId: parked.id });
    await waitForRun(run.id);

    const resumedWorker = fake.created.filter((i) => i.role === 'worker').at(-1)!;
    expect(resumedWorker.config.initialPrompt).toContain('James resumed this parked item');
    expect(resumedWorker.config.initialPrompt).toContain('The retry path never resets the attempt counter.');
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
    // The operator edits a.txt in the main folder while the first landing's hook runs: after the pre-commit overlap
    // check (which would make the landing wait before the hook), so only promotion sees it and the candidate exists.
    writeFileSync(join(hooks, 'pre-commit'),
      `#!/bin/sh\nn=$(cat "${counter}" 2>/dev/null || echo 0); echo $((n+1)) > "${counter}"\n[ "$n" = 0 ] && echo 'operator work' > "${join(repo, 'a.txt')}"\nexit 0\n`);
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    git(['config', 'core.hooksPath', hooks]);
    fake.scripts.worker = (instance) => {
      writeFileSync(join(instance.workingDirectory!, 'a.txt'), 'first version\n');
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    // Promotion refuses the edit, so the landing waits; it has waited the full 24 hours by the next pump.
    await vi.waitFor(() => expect(store.getItem(run.items[0].id)?.landingWaitPaths).toEqual(['a.txt']), { timeout: 30_000 });
    store.upsertItem({ ...store.getItem(run.items[0].id)!, landingWaitSince: Date.now() - 25 * 60 * 60_000 });
    coordinator.requestPump();
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

  describe('Land anyway from the session that started the run', () => {
    /** The park time comes from the queue's event record; a person's message is typed relative to it. */
    const parkedAt = (itemId: string): number => store.history.lastParkedAt(itemId)!;
    /** A person's message in the parent session that has started its turn. */
    function personMessage(parentId: string, typedAt: number, messageId = 'msg-1'): void {
      personTurns.setReportsTurnStarts(parentId, true);
      personTurns.noteInput(parentId, { messageId, personTypedAt: typedAt });
      personTurns.noteTurnStarted(parentId, 'harness-send');
    }
    async function expectStillParked(runId: string, itemId: string, branch: string): Promise<void> {
      await coordinator._whenSettledForTesting();
      expect(coordinator.getRunDto(runId)!.items[0].state).toBe('parked');
      expect(store.getItem(itemId)!.state).toBe('parked');
      expect(git(['branch', '--list', branch])).not.toBe('');
    }

    it('lands in the turn a person\'s message started after the item parked, names the actor and keeps a reference, not the text', async () => {
      const { runId, itemId, parentId } = await parkedAtRoundLimit();
      personMessage(parentId, parkedAt(itemId) + 60_000);

      await coordinator.control({ action: 'land-anyway', itemId }, parentId);
      await coordinator._whenSettledForTesting();

      const item = coordinator.getRunDto(runId)!.items[0];
      expect(item.state).toBe('landed');
      expect(item.detail).toMatch(/^Landed without a verifier PASS by the session that started the run, after James's message at \d\d:\d\d; the document was left open\./);
      expect(item.detail).not.toContain('by James');
      const note = store.history.listEvents(itemId).find((event) => event.reason === 'land-anyway-authorised')!;
      expect(JSON.parse(note.detailHead!)).toEqual({ actor: 'session', instanceId: parentId, messageId: 'msg-1', typedAt: parkedAt(itemId) + 60_000 });
      expect(existsSync(join(repo, 'docs/plans/2026-01-01-alpha_plan.md'))).toBe(true);
    });

    it('the Plan Queue page still lands, with no message needed, and says so', async () => {
      const { runId, itemId } = await parkedAtRoundLimit();

      await coordinator.control({ action: 'land-anyway', itemId });
      await coordinator._whenSettledForTesting();

      expect(coordinator.getRunDto(runId)!.items[0].detail).toMatch(/^Landed without a verifier PASS from the Plan Queue page; the document was left open\./);
      expect(JSON.parse(store.history.listEvents(itemId).find((event) => event.reason === 'land-anyway-authorised')!.detailHead!)).toEqual({ actor: 'page' });
    });

    it.each([
      ['the latest input after the message was an automation prompt, another agent\'s message, a queue notice or a steer',
        (parentId: string) => personTurns.noteInput(parentId, { messageId: 'notice', personTypedAt: null }), /wasn't a message James typed or spoke/],
      ['a turn started by itself after the message (Claude CLI background job, Codex goal turn)',
        (parentId: string) => personTurns.noteTurnStarted(parentId, 'provider'), /Another turn has started since/],
      ['the provider cannot report turn starts',
        (parentId: string) => personTurns.setReportsTurnStarts(parentId, false), /can't report when a turn starts/],
    ])('refuses when %s', async (_label, interfere, reason) => {
      const { runId, itemId, branch, parentId } = await parkedAtRoundLimit();
      personMessage(parentId, parkedAt(itemId) + 60_000);
      interfere(parentId);

      await expect(coordinator.control({ action: 'land-anyway', itemId }, parentId)).rejects.toThrow(reason);

      await expectStillParked(runId, itemId, branch);
      expect(store.history.listEvents(itemId).some((event) => event.reason === 'land-anyway-authorised')).toBe(false);
    });

    it('refuses a message from before the item parked', async () => {
      const { runId, itemId, branch, parentId } = await parkedAtRoundLimit();
      personMessage(parentId, parkedAt(itemId) - 60_000);

      await expect(coordinator.control({ action: 'land-anyway', itemId }, parentId)).rejects.toThrow(/before this item parked/);

      await expectStillParked(runId, itemId, branch);
    });

    it('refuses a parent with no message at all, which is also how it stands after a restart', async () => {
      const { runId, itemId, branch, parentId } = await parkedAtRoundLimit();
      personTurns.setReportsTurnStarts(parentId, true);

      await expect(coordinator.control({ action: 'land-anyway', itemId }, parentId)).rejects.toThrow(/no message from James in this session/);

      await expectStillParked(runId, itemId, branch);
    });

    it('refuses a queue session, even when a person\'s message is on record for it', async () => {
      const { runId, itemId, branch, parentId } = await parkedAtRoundLimit();
      personMessage(parentId, parkedAt(itemId) + 60_000);
      const worker = fake.addParent();
      worker.metadata = { planQueueRole: 'worker' };
      personMessage(worker.id, parkedAt(itemId) + 60_000);

      await expect(coordinator.control({ action: 'land-anyway', itemId }, worker.id)).rejects.toThrow(/queue worker or checker can't land work/);

      await expectStillParked(runId, itemId, branch);
    });

    it('refuses the stranded-run rescuer, which has its own person message on record', async () => {
      const { runId, itemId, branch, parentId } = await parkedAtRoundLimit();
      const rescuer = fake.addParent();
      personMessage(rescuer.id, parkedAt(itemId) + 60_000);
      fake.live.delete(parentId);

      await expect(coordinator.control({ action: 'land-anyway', itemId }, rescuer.id)).rejects.toThrow(/isn't a rescue action/);

      await expectStillParked(runId, itemId, branch);
    });

    it('refuses another session while the parent is alive', async () => {
      const { runId, itemId, branch, parentId } = await parkedAtRoundLimit();
      const other = fake.addParent();
      personMessage(other.id, parkedAt(itemId) + 60_000);

      await expect(coordinator.control({ action: 'land-anyway', itemId }, other.id)).rejects.toThrow(/Only the session that started this Plan Queue run/);

      await expectStillParked(runId, itemId, branch);
      expect(parentId).not.toBe(other.id);
    });

    it('a message that was typed before the park but sent after it does not count, because the typed time is what is checked', async () => {
      const { runId, itemId, branch, parentId } = await parkedAtRoundLimit();
      // Sent after the park (the registry records it now) but typed before it, while the session was busy.
      personMessage(parentId, parkedAt(itemId) - 1);

      await expect(coordinator.control({ action: 'land-anyway', itemId }, parentId)).rejects.toThrow(/before this item parked/);

      await expectStillParked(runId, itemId, branch);
    });
  });

  it('Discard deletes only the parked branch, and only on request', async () => {
    const { runId, itemId, branch } = await parkedAtRoundLimit();
    expect(git(['branch', '--list', branch])).not.toBe('');

    await coordinator.control({ action: 'discard-item', itemId });

    expect(git(['branch', '--list', branch])).toBe('');
    expect(coordinator.getRunDto(runId)!.items[0]).toMatchObject({ discardedBy: 'James', branchName: null });
    await expect(coordinator.control({ action: 'skip-item', itemId })).rejects.toThrow(/has not started/);
  });

  it('brings discarded work back, and refuses a job that was never discarded', async () => {
    const { runId, itemId, branch } = await parkedAtRoundLimit();
    const tip = git(['rev-parse', branch]);
    await expect(coordinator.control({ action: 'restore-discarded', itemId })).rejects.toThrow('Only a discarded job');

    await coordinator.control({ action: 'discard-item', itemId });
    expect(git(['branch', '--list', branch])).toBe('');
    await coordinator.control({ action: 'restore-discarded', itemId });

    expect(git(['rev-parse', branch])).toBe(tip);
    expect(coordinator.getRunDto(runId)!.items[0]).toMatchObject({ state: 'parked', branchName: branch, discardedAt: null, discardedBy: null });
    expect(git(['for-each-ref', 'refs/plan-queue/discarded/'])).toBe('');
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
    // A session the queue spawned can never rescue, and the rescue covers only adopt and cancel.
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
    expect(coordinator.getRunDto(runId)!.items[0].discardedBy).toBe(`session ${rescuer.id}`);
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

  it('sends a landing that keeps hitting a base conflict back to the worker three times, then parks it', async () => {
    landing.conflict = true;
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { maxRounds: 10 } });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'merge-conflict' });
    expect(item.detail).toContain('already sent this back to the worker 3 times');
    expect(store.getItem(item.id)!.baseConflicts).toBe(0);
    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(fake.inputs.filter((m) => m.instanceId === worker.id && m.message.includes('shared.txt'))).toHaveLength(3);
    expect(git(['log', '--format=%s', 'main'])).toBe('base');
  });

  it('checks and builds again, with no worker, when main moved during landing but merges cleanly', async () => {
    landing.baseMovesOnce = () => {
      writeFileSync(join(repo, 'other.txt'), 'other\n');
      git(['add', 'other.txt']);
      git(['commit', '-q', '--no-verify', '-m', 'other work']);
    };
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'landed', round: 1 });
    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(fake.inputs.filter((m) => m.instanceId === worker.id && m.message.includes('shared.txt'))).toHaveLength(0);
    expect(landing.mergeChecks).toBe(1);
    expect(git(['log', '--format=%s', 'main']).split('\n')).toEqual(['Plan: 2026-01-01-alpha_plan', 'other work', 'base']);
  });

  it('keeps the pass and starts no worker when the check after merging runs out of time', async () => {
    landing.mergeCheckTimeout = true;
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    const review = fake.scripts.verifier!;
    fake.scripts.verifier = (instance, message, f) => {
      // Main moves during review, so landing has to merge it and run the check after merging.
      writeFileSync(join(repo, 'other.txt'), 'other\n');
      git(['add', 'other.txt']);
      git(['commit', '-q', '--no-verify', '-m', 'other work']);
      return review(instance, message, f);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'land-blocked', verdict: { verdict: 'PASS' } });
    expect(item.detail).toContain('ran out of time');
    expect(store.getItem(item.id)!.baseConflicts).toBe(0);
    const workers = fake.created.filter((i) => i.role === 'worker');
    expect(workers).toHaveLength(1);
    expect(fake.inputs.filter((m) => m.instanceId === workers[0].id)).toHaveLength(0);

    // Trying again finds main already merged, but the check on that merge never finished.
    landing.mergeCheckTimeout = false;
    await coordinator.control({ action: 'retry-landing', itemId: item.id });
    await waitForRun(run.id);
    expect(landing.mergeChecks).toBe(2);
    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('landed');
  });

  it('never sends a timed-out check to a worker, and stops the job as hung after two', async () => {
    machineGates.timeOutItem = true;
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { verifierGates: ['echo check'] } });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'check-hung', round: 0, verdict: null });
    const workers = fake.created.filter((i) => i.role === 'worker');
    expect(workers).toHaveLength(1);
    expect(fake.inputs.filter((m) => m.instanceId === workers[0].id)).toHaveLength(0);
    expect(fake.created.filter((i) => i.role === 'verifier')).toHaveLength(0);
  });

  it('parks at once, with no worker round, when the hook runs out of time', async () => {
    landing.hookTimeout = true;
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'land-blocked', round: 1 });
    expect(item.detail).toContain('ran out of time');
    expect(store.getItem(item.id)!.landingRefusals).toBe(0);
    // Only the first worker turn: nothing was sent back to a worker for the timeout.
    const workers = fake.created.filter((i) => i.role === 'worker');
    expect(workers).toHaveLength(1);
    expect(fake.inputs.filter((m) => m.instanceId === workers[0].id)).toHaveLength(0);
    expect(git(['log', '--format=%s', 'main'])).toBe('base');
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
    // A tracked planning file is outside the move rule: an edit to it is committed, then refused at landing.
    writeFileSync(join(repo, 'scratch_plan.md'), '# scratch\n');
    git(['add', 'scratch_plan.md']); git(['commit', '--no-verify', '-qm', 'base']);
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    // The worker keeps editing the tracked scratch plan in its tree.
    fake.scripts.worker = (instance, message, f) => {
      writeFileSync(join(instance.workingDirectory!, 'scratch_plan.md'), '# scratch, edited\n');
      return implement(instance, message, f);
    };

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    const item = coordinator.getRunDto(run.id)!.items[0];
    expect(item).toMatchObject({ state: 'parked', parkReason: 'land-blocked' });
    expect(item.detail).toContain('scratch_plan.md');
    const worker = fake.created.find((i) => i.role === 'worker')!;
    expect(fake.inputs.some((m) => m.instanceId === worker.id && m.message.includes('scratch_plan.md'))).toBe(true);
    expect(git(['log', '--format=%s', 'main'])).toBe('base\nbase');
  });

  it('moves a worker-created planning file to the root checkout and lands the rest', async () => {
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = (instance, message, f) => {
      writeFileSync(join(instance.workingDirectory!, 'scratch_history.md'), '# scratch journal\n');
      return implement(instance, message, f);
    };
    fake.scripts.verifier = pass;

    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);

    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed' });
    expect(readFileSync(join(repo, 'scratch_history.md'), 'utf8')).toBe('# scratch journal\n');
    expect(git(['ls-tree', '-r', '--name-only', 'main']).split('\n').some((name) => name.includes('scratch_history'))).toBe(false);
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
    expect(verifierInputs.at(-1)).toMatchObject({ workerProvider: 'codex', workerModel: 'gpt-6.1-sol' });
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

  it('holds the run with the real reason, and sets no document aside, when triage cannot start', async () => {
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
    // Refused starts wait 1, then 5 minutes; the third matching one holds the run.
    await vi.waitFor(() => {
      clock += 60_000;
      coordinator.requestPump();
      expect(coordinator.getRunDto(run.id)!.holdReason).toContain('claude has been added to the "never auto-pick these providers" list');
    }, { timeout: 15_000, interval: 30 });

    expect(fake.created.some((i) => i.role === 'triage')).toBe(false);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'discovered', parkReason: null });
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
      findings: [{ severity: 'high', confidence: 80, summary: 'Retry never resets.' }], gates_run: [], document_complete: false, need_james: [], not_checked: [],
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
    expect(verifierInputs.map((input) => [input.workerProvider, input.workerModel])).toEqual([['claude', 'haiku'], ['claude', 'haiku'], ['claude', 'opus']]);

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
  it('refuses an impossible checker before persisting or spawning any work', async () => {
    planDoc('2026-01-01-no-checker');
    vi.spyOn(coordinator, 'selectVerifier').mockResolvedValue({ ok: false, reason: 'No allowed second model' });
    await expect(coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' })).rejects.toThrow('No allowed second model');
    expect(store.listRuns()).toEqual([]);
    expect(fake.created.filter(instance => instance.role !== 'parent')).toEqual([]);
  });

  it('never spawns a checker or lands work when Harness finds a new red gate', async () => {
    planDoc('2026-01-01-red-checks');
    defineDefaultScripts();
    machineGates.failItem = true;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans',
      config: { maxRounds: 1, verifierGates: DEFAULT_PLAN_QUEUE_CONFIG.plans.verifierGates } });
    await waitForRun(run.id);
    expect(store.listItems(run.id)[0]).toMatchObject({ state: 'parked', parkReason: 'round-limit', verdict: { verdict: 'FAIL' } });
    expect(fake.created.filter(instance => instance.role === 'verifier')).toEqual([]);
    expect(store.history.listVerdicts(run.items[0].id)).toMatchObject([{ verdict: 'FAIL' }]);
    expect(git(['log', '--format=%s', 'main'])).toBe('base');
  });
  it('waits for capacity and starts on a later pump, while real preparation failures still park', async () => {
    planDoc('2026-01-01-capacity');
    fake.scripts.worker = never;
    const prepare = vi.spyOn(coordinator.worktrees, 'prepare').mockRejectedValue(new WorktreeCapacityError('Maximum concurrent worktrees (5) reached'));
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    const waiting = store.listItems(run.id)[0];
    expect(waiting).toMatchObject({ state: 'queued', round: 0, parkReason: null, detail: 'Waiting for a free work folder (0 in use)' });
    prepare.mockRestore();
    const later = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 31_000);
    coordinator.requestPump();
    await coordinator._whenSettledForTesting();
    expect(store.getItem(waiting.id)).toMatchObject({ state: 'working', detail: null });
    later.mockRestore();
    prepare.mockRestore();
  });

  it('starts queue work while the shared worktree limit is full, and its checkouts never use that limit up', async () => {
    planDoc('2026-01-01-limit-one');
    planDoc('2026-01-01-limit-two');
    fake.scripts.worker = never;
    const manager = WorktreeManager.getInstance();
    manager.configure({ maxConcurrent: 1 });
    const options = { repoRoot: repo, baseBranch: 'main', skipInstall: true };
    // Something else (a loop, say) already holds the only shared place.
    const holder = await manager.createWorktree('loop-holder', 'loop holder', options);

    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', config: { workerSlots: 2 } });
    await vi.waitFor(() => expect(store.listItems(run.id).map((item) => item.state)).toEqual(['working', 'working']), { timeout: 15_000, interval: 50 });

    // With two queue checkouts in use, the place the loop frees is still available to the next loop.
    await expect(manager.createWorktree('loop-blocked', 'loop blocked', options)).rejects.toBeInstanceOf(WorktreeCapacityError);
    await manager.cleanupWorktree(holder.id, { force: true });
    await expect(manager.createWorktree('loop-next', 'loop next', options)).resolves.toBeDefined();
  });

  it('finishes failed gate comparisons when queue folders exceed the shared worktree limit', async () => {
    defineDefaultScripts();
    planDoc('2026-01-01-gates-one');
    planDoc('2026-01-01-gates-two');
    machineGates.failItem = true;
    WorktreeManager.getInstance().configure({ maxConcurrent: 1 });
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans',
      config: { workerSlots: 2, maxRounds: 1, verifierGates: DEFAULT_PLAN_QUEUE_CONFIG.plans.verifierGates } });
    await waitForRun(run.id);
    expect(store.listItems(run.id)).toHaveLength(2);
    for (const item of store.listItems(run.id)) {
      expect(item).toMatchObject({ state: 'parked', parkReason: 'round-limit', round: 1, verdict: { verdict: 'FAIL' } });
      expect(store.history.listVerdicts(item.id)[0].gatesRun).toEqual(expect.arrayContaining([
        expect.objectContaining({ baseline: 'new', exitCode: 1 }),
      ]));
    }
  });

  it('starts queue work when the shared worktree limit is unlimited', async () => {
    planDoc('2026-01-01-unlimited');
    fake.scripts.worker = never;
    WorktreeManager.getInstance().configure({ maxConcurrent: 0 });
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await vi.waitFor(() => expect(store.listItems(run.id)[0].state).toBe('working'), { timeout: 15_000, interval: 50 });
  });

  it('clears the note older builds saved while waiting for a worktree when the item starts', async () => {
    planDoc('2026-01-01-legacy-note');
    fake.scripts.worker = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', config: { workerSlots: 1 } });
    await vi.waitFor(() => expect(store.listItems(run.id)[0].state).toBe('working'), { timeout: 15_000, interval: 50 });
    await coordinator.control({ action: 'pause', runId: run.id });
    await coordinator._whenSettledForTesting();
    const held = store.listItems(run.id)[0];
    store.upsertItem({ ...held, detail: 'Waiting for a free worktree (Harness allows 5 at once).' });

    await coordinator.control({ action: 'resume', runId: run.id });
    await vi.waitFor(() => expect(store.getItem(held.id)).toMatchObject({ state: 'working', detail: null }), { timeout: 15_000, interval: 50 });
  });

  it('keeps genuine preparation errors parked', async () => {
    planDoc('2026-01-01-prepare-failure');
    vi.spyOn(coordinator.worktrees, 'prepare').mockRejectedValueOnce(new Error('disk unavailable'));
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await coordinator._whenSettledForTesting();
    expect(store.listItems(run.id)[0]).toMatchObject({ state: 'parked', parkReason: 'worktree-error', detail: 'Could not prepare the worktree: disk unavailable' });
  });
});

it('holds a worker that hits a usage limit mid-turn to wait for usage instead of parking it for James', async () => {
  planDoc('2026-01-01-worker-usage-limit');
  fake.scripts.worker = (instance, _message, source) => {
    source.say(instance, 'Claude usage limit reached.');
    source.setStatus(instance, 'idle');
  };
  const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
  const itemId = store.listItems(run.id)[0].id;
  await vi.waitFor(() => expect(store.getItem(itemId)?.detail).toMatch(/^Waiting for usage: /), { timeout: 15_000, interval: 50 });
  expect(store.getItem(itemId)).toMatchObject({ state: 'queued', parkReason: null });
  // The wait is not a round, and the pump leaves the item alone until it ends.
  expect(store.getItem(itemId)!.round).toBe(0);
  expect(fake.created.filter((i) => i.role === 'worker')).toHaveLength(1);
  // The limited session was stopped, and the wait is recorded so it can be counted.
  expect(store.getItem(itemId)!.workerInstanceId).toBeNull();
  expect(store.history.listEvents(itemId).filter((event) => event.reason === 'worker-usage-limit-hold')).toHaveLength(1);
  // Pause clears the wait: Resume tries the item at once, and the worker gets the work again.
  await coordinator.control({ action: 'pause', runId: run.id });
  fake.scripts.worker = implement;
  fake.scripts.verifier = pass;
  await coordinator.control({ action: 'resume', runId: run.id });
  await waitForRun(run.id);
  expect(store.getItem(itemId)).toMatchObject({ state: 'landed' });
  expect(fake.created.filter((i) => i.role === 'worker').length).toBeGreaterThan(1);
}, 30_000);

it('keeps a worker waiting through repeated usage limits, and does not park it within the day', async () => {
  planDoc('2026-01-01-worker-usage-limit-repeats');
  fake.scripts.worker = (instance, _message, source) => {
    source.say(instance, 'Claude usage limit reached.');
    source.setStatus(instance, 'idle');
  };
  const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
  const itemId = store.listItems(run.id)[0].id;
  for (let hold = 1; hold <= 4; hold += 1) {
    await vi.waitFor(() => expect(store.history.listEvents(itemId).filter((e) => e.reason === 'worker-usage-limit-hold')).toHaveLength(hold), { timeout: 15_000, interval: 50 });
    await vi.waitFor(() => expect(store.getItem(itemId)).toMatchObject({ state: 'queued', workerInstanceId: null }), { timeout: 15_000, interval: 50 });
    // Pause then Resume gives the item a fresh try at once, which hits the limit again.
    await coordinator.control({ action: 'pause', runId: run.id });
    await coordinator.control({ action: 'resume', runId: run.id });
  }
  expect(store.getItem(itemId)).toMatchObject({ parkReason: null });
  expect(store.getItem(itemId)!.state).not.toBe('parked');
}, 60_000);

it('counts a verifier asking a question as a failed round with a specific reason', async () => {
  planDoc('2026-01-01-specific-verifier-stop');
  fake.scripts.verifier = (instance, _message, source) => { source.setStatus(instance, 'waiting_for_input'); };
  const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
  await waitForRun(run.id);
  expect(store.listItems(run.id)[0]).toMatchObject({ state: 'parked', parkReason: 'verifier-unreliable', erroredRounds: 2,
    detail: 'the verifier asked a question instead of reporting a verdict' });
}, 30_000);

it('waits when a checker hits its usage limit, which judged nothing and is not a failed round', async () => {
  planDoc('2026-01-01-checker-usage-limit');
  fake.scripts.verifier = (instance, _message, source) => {
    source.say(instance, 'Claude usage limit reached.');
    source.setStatus(instance, 'idle');
  };
  const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
  const itemId = store.listItems(run.id)[0].id;
  await vi.waitFor(() => expect(store.getItem(itemId)?.detail).toMatch(/^Waiting for usage: /), { timeout: 15_000, interval: 50 });
  expect(store.getItem(itemId)).toMatchObject({ state: 'awaiting-slot', parkReason: null, erroredRounds: 0, round: 0 });
  expect(store.history.listEvents(itemId).filter((event) => event.reason === 'worker-usage-limit-hold')).toHaveLength(1);
}, 30_000);

it('holds a run when jobs keep failing the same way, without stopping or setting aside the jobs still waiting', async () => {
  for (const name of ['one', 'two', 'three', 'four']) planDoc(`2026-01-01-${name}`);
  const prepare = vi.spyOn(coordinator.worktrees, 'prepare').mockRejectedValue(new Error('fatal: disk unavailable'));
  const parent = fake.addParent();
  const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans', config: { workerSlots: 1 } });
  await vi.waitFor(() => expect(coordinator.getRunDto(run.id)!.holdReason).toContain('disk unavailable'), { timeout: 20_000, interval: 25 });
  await coordinator._whenSettledForTesting();
  const dto = coordinator.getRunDto(run.id)!;
  expect(dto.status).toBe('running');
  expect(dto.items.filter(item => item.state === 'parked')).toHaveLength(3);
  expect(dto.items.filter(item => item.state === 'queued')).toHaveLength(1);
  prepare.mockRestore();
  await coordinator.control({ action: 'resume', runId: run.id });
  expect(coordinator.getRunDto(run.id)!.holdReason).toBeNull();
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
      verdict: verificationCount === 1 ? 'FAIL' : 'PASS', findings: [], gates_run: [], document_complete: true, need_james: [], not_checked: [] });
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

it('closes a worker with a saved conversation while its work waits for a check, and reopens it for the fix', async () => {
  planDoc('2026-01-01-close-while-checking');
  fake.scripts.worker = async (instance, message, source) => {
    instance.providerSessionId = `conversation-${instance.id}`;
    await implement(instance, message, source);
  };
  let checks = 0;
  fake.scripts.verifier = (instance) => {
    checks += 1;
    const item = store.getItem(itemIdOf(instance))!;
    // The first worker is gone and no session is left linked to the item while it is checked.
    expect(item.workerInstanceId).toBeNull();
    expect(fake.getAllInstances().filter((i) => i.role === 'worker')).toEqual([]);
    coordinator.reportVerdict(instance.id, {
      item_id: itemIdOf(instance), verdict: checks === 1 ? 'FAIL' : 'PASS',
      findings: checks === 1 ? [{ severity: 'high', confidence: 90, summary: 'Retry guard is missing.' }] : [],
      gates_run: [], document_complete: true, need_james: [], not_checked: [],
    });
  };
  const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', config: { maxRounds: 3 } });
  await waitForRun(run.id);

  expect(store.listItems(run.id)[0]).toMatchObject({ state: 'landed', round: 2 });
  const workers = fake.created.filter((i) => i.role === 'worker');
  expect(workers).toHaveLength(2);
  // The fix round reopened the first worker's conversation with the findings, rather than starting over.
  expect(workers[1].config).toMatchObject({ sessionId: `conversation-${workers[0].id}`, resume: true });
  expect(workers[1].config.initialPrompt).toContain('Retry guard is missing.');
  expect(fake.inputs.filter((m) => workers.some((w) => w.id === m.instanceId))).toEqual([]);
}, 30_000);

it('parks the item, rather than leaving it stuck, when its worker cannot be closed for the check', async () => {
  planDoc('2026-01-01-close-fails');
  fake.scripts.worker = async (instance, message, source) => {
    instance.providerSessionId = `conversation-${instance.id}`;
    await implement(instance, message, source);
  };
  const terminate = fake.terminateInstance.bind(fake);
  vi.spyOn(fake, 'terminateInstance').mockImplementation(async (id) => {
    if (fake.getInstance(id)?.role === 'worker') throw new Error('archive failed');
    await terminate(id);
  });
  const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
  await vi.waitFor(() => expect(store.listItems(run.id)[0].state).toBe('parked'), { timeout: 15_000, interval: 50 });

  const item = store.listItems(run.id)[0];
  expect(item).toMatchObject({ parkReason: 'worker-error', workerInstanceId: fake.created.find((i) => i.role === 'worker')!.id });
  expect(item.detail).toContain('Could not close the worker while its work waits for a check: archive failed');
  expect(fake.created.filter((i) => i.role === 'verifier')).toEqual([]);
}, 30_000);

describe('PlanQueueCoordinator — a saved checklist for the folder', { timeout: 30_000 }, () => {
  const saved = (): PlanQueueFolderChecklist => ({ folder: repo, verifierGates: ['npm run saved-check'], postMergeGate: ['npm run saved-merge-check'] });
  const callerGates = { verifierGates: ['echo caller-check'], postMergeGate: ['echo caller-merge'] };
  /** Gates are only declared here; the stubbed runner never executes them. */
  const start = (config?: Parameters<typeof coordinator.startRun>[0]['config']) =>
    coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', config });

  beforeEach(() => {
    planDoc('2026-01-01-folder-checklist');
    fake.scripts.worker = never;
    writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { 'saved-check': 'true', 'saved-merge-check': 'true' } }));
  });

  it('replaces the gates a session passes to plan_queue_start, both the checks and the post-merge commands', async () => {
    savedFolderChecklists = [saved()];
    const { run, checklistSetAside } = await start(callerGates);
    expect(checklistSetAside).toBe(true);
    expect(store.getRun(run.id)!.config).toMatchObject({ verifierGates: ['npm run saved-check'], postMergeGate: ['npm run saved-merge-check'] });
  });

  it('applies when the session passes nothing, even where the project would otherwise start with no checks', async () => {
    savedFolderChecklists = [saved()];
    const { run, checklistSetAside } = await start();
    expect(checklistSetAside).toBe(false);
    expect(store.getRun(run.id)!.config).toMatchObject({ verifierGates: ['npm run saved-check'], postMergeGate: ['npm run saved-merge-check'] });
  });

  it('lets a session name its own gates when the folder has no saved checklist', async () => {
    savedFolderChecklists = [{ ...saved(), folder: join(repo, 'elsewhere') }];
    const { run, checklistSetAside } = await start(callerGates);
    expect(checklistSetAside).toBe(false);
    expect(store.getRun(run.id)!.config).toMatchObject(callerGates);
  });

  it('applies an entry for the sub-folder the run was started in, and ignores one for a sub-folder it was not', async () => {
    const sub = join(repo, 'packages', 'app');
    mkdirSync(sub, { recursive: true });
    savedFolderChecklists = [{ ...saved(), folder: sub }];
    const started = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans', workspaceCwd: sub });
    expect(store.getRun(started.run.id)!.config).toMatchObject({ verifierGates: ['npm run saved-check'], postMergeGate: ['npm run saved-merge-check'] });
    const other = await start(callerGates);
    expect(other.checklistSetAside).toBe(false);
    expect(store.getRun(other.run.id)!.config).toMatchObject(callerGates);
  });

  it('keeps the saved gates on the stored run, so a later edit of the list does not change a run already started', async () => {
    savedFolderChecklists = [saved()];
    const { run } = await start(callerGates);
    savedFolderChecklists = [];
    expect(store.getRun(run.id)!.config.verifierGates).toEqual(['npm run saved-check']);
    expect(coordinator.getRun(run.id).config.postMergeGate).toEqual(['npm run saved-merge-check']);
  });
});

describe('PlanQueueCoordinator worker completion report', { timeout: 30_000 }, () => {
  const REPORT_ARGS = { summary: 'Built it.', as_built: 'Edited the feature file.', checks_run: [{ command: 'npm run lint', exitCode: 0 }], deferred_checks: [], follow_ups: [] };
  const report = (instance: FakeInstance, summary = REPORT_ARGS.summary) =>
    recordWorkerReport(coordinator, instance.id, { item_id: itemIdOf(instance), ...REPORT_ARGS, summary });
  const worker = () => fake.created.filter((i) => i.role === 'worker').at(-1)!;
  const workerInputs = () => fake.inputs.filter((m) => m.instanceId === worker().id).map((m) => m.message);
  const reportOf = (itemId: string) => store.getItem(itemId)!.workerReport ?? null;

  /** A fresh coordinator whose workers on `claude` (the fake's default provider) must report. */
  function requireReports(providers: string[] = ['claude']): void {
    PlanQueueCoordinator._resetForTesting();
    _setReportRequiredProvidersForTesting(new Set(providers));
    fake = new FakeInstances();
    fake.scripts.triage = triageAllReady;
    fake.scripts.worker = implement;
    fake.scripts.verifier = pass;
    coordinator = startCoordinator(fake);
  }

  it('accepts a report only from the item\'s current worker, while it works', async () => {
    requireReports();
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    const refused: string[] = [];
    let seenOnRow: unknown = null;
    fake.scripts.worker = (instance, message, f) => {
      implement(instance, message, f);
      for (const caller of [parent.id, 'someone-else']) {
        try { recordWorkerReport(coordinator, caller, { item_id: itemIdOf(instance), ...REPORT_ARGS }); } catch (error) { refused.push((error as Error).message); }
      }
      expect(reportOf(itemIdOf(instance))).toBeNull();
      report(instance);
    };
    fake.scripts.verifier = (instance, message, f) => {
      // The report is on the item row while the checker works, and neither checker nor worker can add another then.
      seenOnRow = coordinator.getRunDto(store.getItem(itemIdOf(instance))!.runId)!.items[0].workerReport;
      expect(() => report(worker())).toThrow(/Only the worker currently assigned/);
      expect(() => recordWorkerReport(coordinator, instance.id, { item_id: itemIdOf(instance), ...REPORT_ARGS })).toThrow(/Only the worker currently assigned/);
      pass(instance, message, f);
    };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);
    expect(refused).toHaveLength(2);
    expect(refused.every((message) => /Only the worker currently assigned/.test(message))).toBe(true);
    expect(seenOnRow).toEqual({ summary: 'Built it.', asBuilt: 'Edited the feature file.', checksRun: [{ command: 'npm run lint', exitCode: 0 }], deferredChecks: [], followUps: [] });
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed', erroredRounds: 0 });
    // The worker reported, so it was never reminded.
    expect(workerInputs().filter((message) => message.startsWith('Plan Queue reminder'))).toEqual([]);
  });

  it('reminds a worker whose turn ends without a report, then counts the turn as failed', async () => {
    requireReports();
    planDoc('2026-01-01-alpha');
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForRun(run.id);
    expect(workerInputs().map((message) => message.split(':')[0])).toEqual(['Plan Queue reminder 1 of 2', 'Plan Queue reminder 2 of 2']);
    expect(workerInputs()[0]).toContain('orchestrator.tool_search');
    expect(workerInputs()[0]).toContain('plan_queue_report_ready');
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'worker-error' });
    expect(coordinator.getRunDto(run.id)!.items[0].detail).toContain('without reporting its work ready, after 2 reminders');
    expect(fake.created.some((i) => i.role === 'verifier')).toBe(false);
  });

  it('hands the work over once a reminder is answered with a report, from the same session', async () => {
    requireReports();
    planDoc('2026-01-01-alpha');
    fake.scripts.worker = (instance, message, f) => {
      implement(instance, message, f);
      if (message.startsWith('Plan Queue reminder 1 of 2')) report(instance);
    };
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed' });
    expect(fake.created.filter((i) => i.role === 'worker')).toHaveLength(1);
    expect(workerInputs()).toHaveLength(1);
  });

  it('reminds, and does not check, a worker whose background job was still running when its turn ended', async () => {
    requireReports();
    planDoc('2026-01-01-alpha');
    const observed: { state: string; verifiers: number; reminder: string }[] = [];
    fake.scripts.worker = (instance, message, f) => {
      implement(instance, message, f);
      if (!message.startsWith('Plan Queue reminder')) { f.say(instance, 'The tests are still running in the background; I will check them next.'); return; }
      observed.push({ state: coordinator.getRunDto(store.getItem(itemIdOf(instance))!.runId)!.items[0].state, verifiers: f.created.filter((i) => i.role === 'verifier').length, reminder: message });
      report(instance);
    };
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForRun(run.id);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ state: 'working', verifiers: 0 });
    expect(observed[0].reminder).toContain('A command you start in the background');
    expect(observed[0].reminder).toContain('Background commands may have stopped when your turn ended');
    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('landed');
  });

  it('clears the report when a worker turn starts, so a fix round never reuses the last one', async () => {
    requireReports();
    planDoc('2026-01-01-alpha');
    let verifications = 0;
    const atFixStart: unknown[] = [];
    fake.scripts.worker = (instance, message, f) => {
      implement(instance, message, f);
      if (message.includes('An independent verifier failed your work')) atFixStart.push(reportOf(itemIdOf(instance)));
      // The fix round never reports, so only a reused old report could satisfy the requirement.
      if (!message.includes('An independent verifier failed your work') && !message.startsWith('Plan Queue reminder')) report(instance, 'Round one.');
    };
    fake.scripts.verifier = (instance) => {
      verifications += 1;
      coordinator.reportVerdict(instance.id, { item_id: itemIdOf(instance), verdict: 'FAIL', findings: [{ severity: 'high', confidence: 85, summary: 'Missing retry test.' }], gates_run: [], document_complete: true, need_james: [], not_checked: [] });
    };
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForRun(run.id);
    expect(verifications).toBe(1);
    expect(atFixStart).toEqual([null]);
    expect(workerInputs().filter((message) => message.startsWith('Plan Queue reminder')).map((message) => message.split(':')[0])).toEqual(['Plan Queue reminder 1 of 2', 'Plan Queue reminder 2 of 2']);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'parked', parkReason: 'worker-error' });
  });

  it('gives the fix round its own full set of reminders', async () => {
    requireReports();
    planDoc('2026-01-01-alpha');
    let verifications = 0;
    fake.scripts.worker = (instance, message, f) => {
      implement(instance, message, f);
      const fix = message.includes('An independent verifier failed your work');
      // First turn: report after the second reminder. Fix turn: report only after its own first reminder.
      if (message.startsWith('Plan Queue reminder 2 of 2') || (fix === false && message.startsWith('Plan Queue reminder 1 of 2') && verifications > 0)) report(instance, 'Fix round.');
    };
    fake.scripts.verifier = (instance, message, f) => {
      verifications += 1;
      if (verifications === 1) coordinator.reportVerdict(instance.id, { item_id: itemIdOf(instance), verdict: 'FAIL', findings: [{ severity: 'high', confidence: 85, summary: 'Missing retry test.' }], gates_run: [], document_complete: true, need_james: [], not_checked: [] });
      else pass(instance, message, f);
    };
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed' });
    expect(workerInputs().filter((message) => message.startsWith('Plan Queue reminder 1 of 2'))).toHaveLength(2);
  });

  it('keeps the turn ending as the signal for a provider that has not passed its live check', async () => {
    requireReports(['codex']);
    planDoc('2026-01-01-alpha');
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed' });
    expect(workerInputs()).toEqual([]);
  });

  it('keeps every provider on the turn-ending signal until one is added to the list in code', async () => {
    planDoc('2026-01-01-alpha');
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' });
    await waitForRun(run.id);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed' });
  });

  it('crash window: a report stored before a restart is cleared for the worker that resumes, which must report again', async () => {
    requireReports();
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    fake.scripts.worker = (instance, message, f) => { implement(instance, message, f); report(instance, 'Before the crash.'); return never(instance, message, f); };
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await vi.waitFor(() => expect(reportOf(run.items[0].id)?.summary).toBe('Before the crash.'));
    const seenAtResume: unknown[] = [];
    await restart(null, { scripts: { worker: (instance, message, f) => {
      implement(instance, message, f);
      seenAtResume.push(reportOf(itemIdOf(instance)));
      report(instance, 'After the crash.');
    } } });
    await waitForRun(run.id);
    expect(seenAtResume).toEqual([null]);
    expect(coordinator.getRunDto(run.id)!.items[0]).toMatchObject({ state: 'landed' });
    expect(reportOf(run.items[0].id)?.summary).toBe('After the crash.');
  });

  it('clears a stored report when a resumed item gets a new worker session', async () => {
    requireReports();
    planDoc('2026-01-01-alpha');
    const parent = fake.addParent();
    const { run } = await coordinator.startRun({ parentInstanceId: parent.id, kind: 'plans' });
    await waitForRun(run.id);
    const itemId = run.items[0].id;
    expect(coordinator.getRunDto(run.id)!.items[0].state).toBe('parked');
    store.upsertItem({ ...store.getItem(itemId)!, workerReport: { summary: 'Old.', asBuilt: 'Old.', checksRun: [], deferredChecks: [], followUps: [] } });
    const seen: unknown[] = [];
    fake.scripts.worker = (instance, message, f) => { implement(instance, message, f); seen.push(reportOf(itemIdOf(instance))); report(instance); };
    await coordinator.control({ action: 'resume-item', itemId }, parent.id);
    await waitForRun(run.id);
    expect(seen).toEqual([null]);
  });
});

describe('PlanQueueCoordinator deferred checks and finding kinds (step 5.2)', { timeout: 30_000 }, () => {
  const DEFERRED = { title: 'Each provider calls the report tool', steps: 'Start a run on each provider.', expectedResult: 'Each reports.', whyDeferred: 'Needs a rebuilt app.' };
  const STEM = '2026-01-01-alpha';
  const verdictArgs = (instance: FakeInstance, extra: Record<string, unknown>) => ({
    item_id: itemIdOf(instance), verdict: 'PASS' as const, findings: [], gates_run: [], document_complete: true, need_james: [], not_checked: [], ...extra,
  });
  const failWith = (findings: Array<Record<string, unknown>>): Script => (instance) => {
    coordinator.reportVerdict(instance.id, verdictArgs(instance, { verdict: 'FAIL', findings }) as Parameters<typeof coordinator.reportVerdict>[1]);
  };
  const passDeferring = (titles: string[], criteriaTotal: number): Script => (instance) => {
    coordinator.reportVerdict(instance.id, verdictArgs(instance, {
      deferred_checks: titles.map((title) => ({ title, whyDeferred: 'Needs a rebuilt app.' })), criteria_total: criteriaTotal,
    }) as Parameters<typeof coordinator.reportVerdict>[1]);
  };
  /** A worker that reports its deferred checks, and writes them beside the plan when asked to. */
  const deferringWorker = (options: { writeLivetest?: boolean; report?: boolean } = {}): Script => (instance, message, f) => {
    implement(instance, message, f);
    if (options.report !== false) {
      recordWorkerReport(coordinator, instance.id, { item_id: itemIdOf(instance), summary: 'Built it.', as_built: 'Done.', checks_run: [], deferred_checks: [DEFERRED], follow_ups: [] });
    }
    if (options.writeLivetest !== false) writeDoc(`docs/plans/${STEM}_plan_livetest.md`, `# Live checks\n\n## ${DEFERRED.title}\n\nSteps: ${DEFERRED.steps}\n`);
  };
  const workers = () => fake.created.filter((i) => i.role === 'worker');
  const item0 = (runId: string) => coordinator.getRunDto(runId)!.items[0];
  const startPlans = async () => {
    planDoc(STEM);
    return (await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'plans' })).run;
  };

  it('refuses PASS with document_complete false for a plan, and says what to do instead', async () => {
    let refusal = '';
    fake.scripts.verifier = (instance, message, f) => {
      try { coordinator.reportVerdict(instance.id, verdictArgs(instance, { document_complete: false }) as Parameters<typeof coordinator.reportVerdict>[1]); } catch (error) { refusal = (error as Error).message; }
      pass(instance, message, f);
    };
    const run = await startPlans();
    await waitForRun(run.id);
    expect(refusal).toMatch(/always closed/);
    expect(refusal).toMatch(/report FAIL with findings/);
    expect(refusal).toMatch(/deferred_checks/);
    expect(item0(run.id).state).toBe('landed');
    expect(existsSync(join(repo, `docs/plans/${STEM}_plan_completed.md`))).toBe(true);
  });

  it('still lets a livetest pass with checks open and its document left under its active name', async () => {
    const doc = writeDoc('docs/plans/2026-01-01-beta_livetest.md', '# Livetest\n\n- [ ] check 1\n');
    fake.scripts.verifier = (instance) => {
      coordinator.reportVerdict(instance.id, verdictArgs(instance, { document_complete: false,
        need_james: [{ check: 'Check 2: Face ID unlock', classification: 'real', reason: 'Needs a physical iPhone.' }] }) as Parameters<typeof coordinator.reportVerdict>[1]);
    };
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'livetests' });
    await waitForRun(run.id);
    expect(item0(run.id).state).toBe('landed');
    expect(existsSync(doc)).toBe(true);
  });

  it('refuses, through the verdict tool, a non-code finding that names nothing missing and deferred checks without a total', async () => {
    const refusals: string[] = [];
    fake.scripts.verifier = (instance, message, f) => {
      const attempt = (extra: Record<string, unknown>) => {
        try { coordinator.reportVerdict(instance.id, verdictArgs(instance, extra) as Parameters<typeof coordinator.reportVerdict>[1]); } catch (error) { refusals.push((error as Error).message); }
      };
      attempt({ verdict: 'FAIL', findings: [{ severity: 'high', kind: 'needs-human', confidence: 90, summary: 'Needs someone.' }] });
      attempt({ deferred_checks: [{ title: 'a', whyDeferred: 'b' }] });
      pass(instance, message, f);
    };
    const run = await startPlans();
    await waitForRun(run.id);
    expect(refusals).toHaveLength(2);
    expect(refusals[0]).toContain('exact missing thing');
    expect(refusals[1]).toContain('criteria_total');
    expect(item0(run.id).state).toBe('landed');
  });

  it('lands a plan with deferred checks that are reported and written down, and closes the document', async () => {
    fake.scripts.worker = deferringWorker();
    fake.scripts.verifier = passDeferring([DEFERRED.title], 4);
    const run = await startPlans();
    await waitForRun(run.id);
    expect(item0(run.id)).toMatchObject({ state: 'landed', verdict: { verdict: 'PASS', deferredChecks: [{ title: DEFERRED.title }], criteriaTotal: 4 } });
    expect(existsSync(join(repo, `docs/plans/${STEM}_plan_completed.md`))).toBe(true);
  });

  it('turns a PASS into a FAIL when a deferred check is not in the worker\'s report, and the next round lands it', async () => {
    let turn = 0;
    fake.scripts.worker = (instance, message, f) => { turn += 1; return deferringWorker({ report: turn > 1 })(instance, message, f); };
    fake.scripts.verifier = passDeferring([DEFERRED.title], 4);
    const run = await startPlans();
    await waitForRun(run.id);
    const rows = store.getItem(run.items[0].id)!;
    expect(rows.state).toBe('landed');
    expect(fake.created.filter((i) => i.role === 'verifier')).toHaveLength(2);
    expect(workers()).toHaveLength(1);
    const fixPrompt = fake.inputs.filter((m) => m.instanceId === workers()[0].id).map((m) => m.message).find((m) => m.includes('An independent verifier failed your work'))!;
    expect(fixPrompt).toContain('does not list');
    expect(fixPrompt).toContain(DEFERRED.title);
  });

  it('turns a PASS into a FAIL when the livetest document does not hold the deferred check', async () => {
    let turn = 0;
    fake.scripts.worker = (instance, message, f) => { turn += 1; return deferringWorker({ writeLivetest: turn > 1 })(instance, message, f); };
    fake.scripts.verifier = passDeferring([DEFERRED.title], 4);
    const run = await startPlans();
    await waitForRun(run.id);
    expect(item0(run.id).state).toBe('landed');
    const fixPrompt = fake.inputs.map((m) => m.message).find((m) => m.includes('An independent verifier failed your work'))!;
    expect(fixPrompt).toContain('No livetest document was found');
    expect(workers()).toHaveLength(1);
  });

  it('sets a PASS aside for James, unmerged, when more than half of the criteria are deferred', async () => {
    fake.scripts.worker = deferringWorker();
    fake.scripts.verifier = passDeferring([DEFERRED.title], 1);
    const run = await startPlans();
    await waitForRun(run.id);
    expect(item0(run.id)).toMatchObject({ state: 'parked', parkReason: 'needs-james' });
    expect(item0(run.id).detail).toContain('1 of 1 acceptance criteria');
    expect(existsSync(join(repo, `docs/plans/${STEM}_plan.md`))).toBe(true);
    expect(git(['log', '--oneline', 'main']).split('\n')).toHaveLength(1);
  });

  it('lands a PASS that defers exactly half of its criteria', async () => {
    fake.scripts.worker = deferringWorker();
    fake.scripts.verifier = passDeferring([DEFERRED.title], 2);
    const run = await startPlans();
    await waitForRun(run.id);
    expect(item0(run.id).state).toBe('landed');
  });

  it('sets a FAIL aside as needs-setup, with no new worker round, when every finding is an environment problem', async () => {
    fake.scripts.verifier = failWith([{ severity: 'high', kind: 'environment', confidence: 95, summary: 'The signing gate cannot run here.', missing: 'The CODESIGN_IDENTITY variable' }]);
    const run = await startPlans();
    await waitForRun(run.id);
    expect(item0(run.id)).toMatchObject({ state: 'parked', parkReason: 'needs-setup', round: 1 });
    expect(item0(run.id).detail).toContain('The CODESIGN_IDENTITY variable');
    expect(item0(run.id).verdict?.findings[0].kind).toBe('environment');
    expect(workers()).toHaveLength(1);
    expect(fake.inputs.filter((m) => m.instanceId === workers()[0].id)).toHaveLength(0);
  });

  it('sets a FAIL aside as needs-james when a finding needs a human', async () => {
    fake.scripts.verifier = failWith([
      { severity: 'high', kind: 'environment', confidence: 90, summary: 'No test device.', missing: 'A paired iPhone' },
      { severity: 'high', kind: 'needs-human', confidence: 90, summary: 'The release needs a decision.', missing: 'James\'s approval to publish' },
    ]);
    const run = await startPlans();
    await waitForRun(run.id);
    expect(item0(run.id)).toMatchObject({ state: 'parked', parkReason: 'needs-james' });
    expect(item0(run.id).detail).toContain('James\'s approval to publish');
    expect(item0(run.id).detail).toContain('A paired iPhone');
    expect(workers()).toHaveLength(1);
  });

  it('keeps the fix round when any finding is code, and tells the worker the others are not its to fix', async () => {
    let round = 0;
    fake.scripts.verifier = (instance, message, f) => {
      round += 1;
      if (round > 1) { pass(instance, message, f); return; }
      failWith([
        { severity: 'high', kind: 'code', confidence: 90, summary: 'The counter is never reset.' },
        { severity: 'medium', kind: 'environment', confidence: 90, summary: 'The signing gate cannot run.', missing: 'The signing certificate' },
      ])(instance, message, f);
    };
    const run = await startPlans();
    await waitForRun(run.id);
    expect(item0(run.id).state).toBe('landed');
    const fixPrompt = fake.inputs.map((m) => m.message).find((m) => m.includes('An independent verifier failed your work'))!;
    expect(fixPrompt).toContain('environment: needs The signing certificate');
    expect(fixPrompt).toContain('do not work around it');
  });

  it('reads a FAIL finding with no kind as a code finding, as stored verdicts from before kinds do', async () => {
    let round = 0;
    fake.scripts.verifier = (instance, message, f) => {
      round += 1;
      if (round > 1) { pass(instance, message, f); return; }
      failWith([{ severity: 'high', confidence: 90, summary: 'The counter is never reset.' }])(instance, message, f);
    };
    const run = await startPlans();
    await waitForRun(run.id);
    expect(item0(run.id).state).toBe('landed');
    expect(workers()).toHaveLength(1);
    expect(store.getItem(run.items[0].id)!.round).toBe(2);
    // The verdict is stored with the kind filled in.
    expect(store.history.listVerdicts(run.items[0].id)[0].findings.map((f) => f.kind)).toEqual(['code']);
  });

  it('keeps a needs-setup stop across a restart, starts no worker for it, and Resume sends it back to a worker', async () => {
    fake.scripts.verifier = failWith([{ severity: 'high', kind: 'environment', confidence: 95, summary: 'The gate cannot run here.', missing: 'Node 22 on the PATH' }]);
    const run = await startPlans();
    await waitForRun(run.id);
    const itemId = run.items[0].id;
    const parentId = fake.created.find((i) => i.role === 'parent')!.id;
    expect(item0(run.id)).toMatchObject({ state: 'parked', parkReason: 'needs-setup' });
    const next = await restart();
    await waitForRun(run.id);
    expect(store.getItem(itemId)).toMatchObject({ state: 'parked', parkReason: 'needs-setup' });
    expect(next.created.filter((i) => i.role === 'worker' || i.role === 'verifier')).toHaveLength(0);
    next.scripts.verifier = pass;
    await coordinator.control({ action: 'resume-item', itemId }, parentId);
    await waitForRun(run.id);
    expect(store.getItem(itemId)!.state).toBe('landed');
  });

  it('replays stored PASS verdicts with needJames entries and no finding kinds', async () => {
    const doc = writeDoc('docs/plans/2026-01-01-gamma_livetest.md', '# Livetest\n\n- [ ] check 1\n');
    fake.scripts.verifier = never;
    const { run } = await coordinator.startRun({ parentInstanceId: fake.addParent().id, kind: 'livetests' });
    // Wait for the verifier session too: the coordinator saves the item again once it exists, and under load that
    // late save overwrote the stored verdict below, so the restart re-verified instead of replaying it.
    await vi.waitFor(() => {
      expect(store.getItem(run.items[0].id)!.state).toBe('verifying');
      expect(fake.created.some((i) => i.role === 'verifier')).toBe(true);
      expect(store.getItem(run.items[0].id)!.verifierInstanceId).toBeTruthy();
    });
    // What an earlier app version stored: no `kind` on a finding, no deferred checks, open checks classified.
    const stored = JSON.parse(JSON.stringify({
      verdict: 'PASS', findings: [{ severity: 'low', confidence: 70, summary: 'A note from before kinds existed.' }], gatesRun: [], documentComplete: false,
      needJames: [{ check: 'Check 2: Face ID unlock', classification: 'real', reason: 'Needs a physical iPhone.' },
        { check: 'Check 3: Computer Use click', classification: 'policy-gated', reason: 'Blocked by a setting.' }],
      notChecked: [],
    }));
    store.upsertItem({ ...store.getItem(run.items[0].id)!, state: 'landing', verdict: stored });
    const next = await restart();
    next.scripts.verifier = pass;
    await waitForRun(run.id);
    const dto = item0(run.id);
    expect(dto.state).toBe('landed');
    expect(dto.verdict?.needJames).toHaveLength(2);
    expect(dto.verdict?.findings[0].kind).toBeUndefined();
    expect(existsSync(doc)).toBe(true);
    expect(existsSync(doc.replace('_livetest.md', '_livetest_completed.md'))).toBe(false);
  });
});
