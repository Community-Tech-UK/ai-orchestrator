/**
 * The shared fixture of the `plan-queue-coordinator*.spec.ts` files: a real Git repository and migrated
 * database per test, a scripted stand-in for the instance manager, and a coordinator wired to both.
 * Each spec file installs the module stand-ins in `plan-queue-coordinator.test-mocks.ts` itself, before
 * importing this, and imports these helpers; the hooks below run for every test in that file.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, vi } from 'vitest';
import { DEFAULT_PLAN_QUEUE_CONFIG, type PlanQueueFolderChecklist, type PlanQueueRouting } from '@contracts/schemas/plan-queue';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import type { ProviderAccountProfile } from '../../shared/types/provider-account.types';
import { CLAUDE_PINNED_MODELS } from '../../shared/types/provider.types';
import type { SqliteDriver } from '../db/sqlite-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { _resetReclaimHoldsForTesting } from '../process/reclaim-holds';
import { GitWriteQueue } from '../workspace/git/git-write-queue';
import { useGitRepoTemplate } from '../workspace/git/git-repo-template.test-helpers';
import { WorktreeManager } from '../workspace/git/worktree-manager';
import { InputTurnRegistry } from '../instance/input-turn-registry';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import { landing, machineGates } from './plan-queue-coordinator.test-mocks';
import type { PlanQueueInstanceRecord } from './plan-queue-host';
import { findRestoredSessionId } from './plan-queue-parent';
import type { PlanQueueRelaxation } from './plan-queue-relaxation';
import { PlanQueueStore } from './plan-queue-store';
import { _setReportRequiredProvidersForTesting } from './plan-queue-worker-report';
import type { VerifierSelectInput } from './plan-queue-verifier-select';

export let repo: string;
export let driver: SqliteDriver;
export let store: PlanQueueStore;
export let fake: FakeInstances;
export let coordinator: PlanQueueCoordinator;
export let personTurns: InputTurnRegistry;
/** James's saved Plan Queue routing and account pool, as the coordinator reads them. */
export let savedRouting: PlanQueueRouting;
/** James's saved checklist per folder, as the coordinator reads it. */
export let savedFolderChecklists: PlanQueueFolderChecklist[];
/** Providers whose choices have no usage left, for the ranked worker and checker lists. */
export let outOfUsage: string[];
export let installedProviders: string[];
export let poolProfiles: ProviderAccountProfile[];
export let verifierInputs: VerifierSelectInput[];
export let excludedProviders: string[];
/** History entries archived at a simulated shutdown, read by the restored-parent lookup. */
export let questionsToParent = false;
export let archivedEntries: { originalInstanceId: string; historyThreadId?: string }[];

/** Test bodies change the shared state through these: another module cannot assign an imported binding. */
export function setFake(value: FakeInstances): void { fake = value; }
export function setCoordinator(value: PlanQueueCoordinator): void { coordinator = value; }
export function setSavedRouting(value: PlanQueueRouting): void { savedRouting = value; }
export function setSavedFolderChecklists(value: PlanQueueFolderChecklist[]): void { savedFolderChecklists = value; }
export function setOutOfUsage(value: string[]): void { outOfUsage = value; }
export function setInstalledProviders(value: string[]): void { installedProviders = value; }
export function setPoolProfiles(value: ProviderAccountProfile[]): void { poolProfiles = value; }
export function setExcludedProviders(value: string[]): void { excludedProviders = value; }
export function setQuestionsToParent(value: boolean): void { questionsToParent = value; }

export function git(args: string[], cwd = repo): string {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    // `rev-parse -q --verify` exits 1 with no output when the ref is absent.
    if (args.includes('--verify')) return '';
    throw error;
  }
}

/** A project that defines every npm script the default checklists name, as this repository does. */
export function defineDefaultScripts(): void {
  const names = [...DEFAULT_PLAN_QUEUE_CONFIG.plans.verifierGates, ...DEFAULT_PLAN_QUEUE_CONFIG.plans.postMergeGate]
    .flatMap((command) => /^npm run (\S+)/.exec(command)?.[1] ?? []);
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: Object.fromEntries(names.map((name) => [name, 'true'])) }));
  writeFileSync(join(repo, 'tsconfig.json'), '{}');
}

export type Role = 'parent' | 'worker' | 'verifier' | 'triage';
export type Script = (instance: FakeInstance, message: string, fake: FakeInstances) => void | Promise<void>;

export interface FakeInstance extends PlanQueueInstanceRecord {
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
export class FakeInstances extends EventEmitter {
  readonly live = new Map<string, FakeInstance>();
  readonly created: FakeInstance[] = [];
  readonly inputs: { instanceId: string; message: string; internalSource?: string }[] = [];
  readonly notes: { instanceId: string; message: string }[] = [];
  readonly adoptions: { childId: string; parentId: string }[] = [];
  readonly scripts: Partial<Record<Role, Script>> = {};
  maxLive: Partial<Record<Role, number>> = {};
  restartFreshInstance = vi.fn(async () => undefined);

  addParent(): FakeInstance {
    const parent = this.make('parent', { workingDirectory: repo } as InstanceCreateConfig, 'claude', CLAUDE_PINNED_MODELS.SONNET_5);
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

export function writeDoc(relative: string, content: string): string {
  const full = join(repo, relative);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
  return full;
}

export function planDoc(stem: string): string {
  writeDoc(`docs/plans/${stem}_spec_planned.md`, `# Spec\n\n**Plan:** [plan](./${stem}_plan.md)\n`);
  return writeDoc(`docs/plans/${stem}_plan.md`, `# Plan\n\n**Spec:** [spec](./${stem}_spec_planned.md)\n\n- [ ] build it\n`);
}

/** Worker: write a feature file in its worktree and an as-built note in the root document. */
export const implement: Script = (instance) => {
  const documentLine = instance.config.initialPrompt?.match(/Your document is `([^`]+)`/)?.[1];
  const stem = documentLine ? documentLine.split('/').pop()!.replace(/\.md$/, '') : 'unknown';
  writeFileSync(join(instance.workingDirectory!, `${stem}.feature.txt`), `built ${stem}\n`);
  if (documentLine) appendFileSync(documentLine, '\nAs built: done.\n');
};

export const itemIdOf = (instance: FakeInstance) => instance.config.metadata?.['planQueueItemId'] as string;
export const pass: Script = (instance) => {
  coordinator.reportVerdict(instance.id, {
    item_id: itemIdOf(instance), verdict: 'PASS', findings: [], gates_run: [], document_complete: true, need_james: [], not_checked: [],
  });
};
export const triageAllReady: Script = (instance) => {
  const runId = instance.config.metadata?.['planQueueRunId'] as string;
  const run = coordinator.getRunDto(runId)!;
  const documents = instance.config.initialPrompt!.match(/<documents>\n([\s\S]*?)\n<\/documents>/)![1].split('\n');
  coordinator.reportTriage(instance.id, {
    run_id: runId,
    records: run.items.filter((i) => i.state === 'discovered' && documents.includes(i.sourceRef)).map((i) => ({ documentPath: i.sourceRef, disposition: 'ready' as const })),
  });
};

export async function waitForRun(runId: string, timeout = 30_000): Promise<void> {
  await vi.waitFor(() => {
    const status = coordinator.getRunDto(runId)?.status;
    if (status !== 'completed' && status !== 'cancelled') throw new Error(`run is ${status}`);
  }, { timeout, interval: 50 });
}

/** Every test starts from its own copy of this repository: one commit on `main`, worktrees ignored. */
const baseRepository = useGitRepoTemplate((dir) => {
  repo = dir;
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.name', 'Plan Queue Test']);
  git(['config', 'user.email', 'plan-queue@example.invalid']);
  git(['config', 'commit.gpgsign', 'false']);
  writeFileSync(join(repo, '.gitignore'), '.worktrees/\n');
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
});

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
  baseRepository.copyTo(repo);

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
  questionsToParent = false;
  fake = new FakeInstances();
  fake.scripts.triage = triageAllReady;
  fake.scripts.worker = implement;
  fake.scripts.verifier = pass;
  coordinator = startCoordinator(fake);
});

export function startCoordinator(
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
    postNote: (instanceId, message) => instances.notes.push({ instanceId, message }),
    questionsToParent: () => questionsToParent,
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

export const never: Script = () => new Promise<void>(() => undefined);



/**
 * Simulate an app restart: the old coordinator and every live instance are
 * gone; the database and the repository survive. By default the parent
 * session is restored with the same id. With `parentRestoredLater` it is
 * archived instead, as the app does: recovery runs without it, and the test
 * restores it under a new id with `FakeInstances.restoreParent`.
 */
export async function restart(
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

export async function waitForState(itemIndex: number, runId: string, state: string): Promise<void> {
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

export function queueWorktrees(): string[] {
  const dir = join(repo, '.worktrees', 'queue');
  return existsSync(dir) ? readdirSync(dir) : [];
}


export function poolAccount(id: string, provider: 'claude' | 'codex', overrides: Partial<ProviderAccountProfile> = {}): ProviderAccountProfile {
  return {
    id, provider, label: id.toUpperCase(), expectedIdentity: null, expectedAccountKey: null, planLabel: null,
    priority: poolProfiles.length, enabled: true, automationPolicy: 'allow-routed', isLegacy: false,
    createdAt: 0, updatedAt: 0, ...overrides,
  };
}
