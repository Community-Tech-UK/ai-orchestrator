/**
 * A Linear run starts only on the Plan Queue page. `createPlanQueueRun` is the one function both the
 * `plan_queue_start` tool and the page's ordinary Start end in, so refusing there covers both (step 2 of the Linear
 * discovery plan; Step 11 adds the separate function that makes a Linear run).
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlanQueueStartPayloadSchema, PlanQueueStartArgsSchema } from '@contracts/schemas/plan-queue';
import type { SqliteDriver } from '../db/sqlite-driver';
import { createSqliteWasmDatabase, initSqliteWasm } from '../db/sqlite-wasm-driver';
import { runLoopMigrations } from '../orchestration/loop-schema';
import { createPlanQueueToolDefinitions } from '../mcp/plan-queue-tools';
import { PlanQueueCoordinator } from './plan-queue-coordinator';
import * as queueGit from './plan-queue-git';
import type { PlanQueueInstanceRecord } from './plan-queue-host';
import { LINEAR_RUN_PAGE_ONLY_MESSAGE } from './plan-queue-run-create';
import { createPlanQueueToolOperations } from './plan-queue-tool-operations';
import { PlanQueueStore } from './plan-queue-store';
import { workSourceForRun } from './plan-queue-work-sources';

const SENTENCE = 'Linear runs start only on the Plan Queue page, where James ticks the tickets.';
const linearQuery = { projects: [{ projectId: 'proj-1', teamId: 'team-1' }], previewLoadedAt: 1, tickets: [{ linearId: 'lin-1', identifier: 'ORC-1', previewHash: 'a'.repeat(64) }] };

let root: string;
let db: SqliteDriver;
let store: PlanQueueStore;
let coordinator: PlanQueueCoordinator;
let createInstance: ReturnType<typeof vi.fn<() => Promise<{ id: string }>>>;

beforeAll(() => initSqliteWasm());
beforeEach(() => {
  PlanQueueCoordinator._resetForTesting();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'queue-linear-refusal-')));
  db = createSqliteWasmDatabase(':memory:');
  runLoopMigrations(db);
  store = new PlanQueueStore(db);
  const parent: PlanQueueInstanceRecord = { id: 'parent', status: 'idle', provider: 'claude', outputBuffer: [], workingDirectory: root };
  createInstance = vi.fn(async () => ({ id: 'unexpected-session' }));
  const instances = Object.assign(new EventEmitter(), {
    getInstance: (id: string) => id === parent.id ? parent : undefined, getAllInstances: () => [parent], createInstance,
    sendInput: vi.fn(async () => undefined), terminateInstance: vi.fn(async () => undefined),
    restartFreshInstance: vi.fn(async () => undefined), adoptOrphanInstance: () => false,
  });
  vi.spyOn(queueGit, 'repositoryRoot').mockResolvedValue(root);
  vi.spyOn(queueGit, 'currentBranch').mockResolvedValue('main');
  coordinator = PlanQueueCoordinator.getInstance();
  coordinator.initialize({
    store, instances, skipInstall: true, pumpIntervalMs: null, loadAverage: () => [9999, 9999, 9999],
    worktreeCreator: { createWorktree: vi.fn(), cleanupWorktree: vi.fn(), getAllSessions: () => [] },
    selectVerifier: async () => ({ ok: true, choice: { provider: 'codex' } }), folderChecklists: () => [],
    routing: { readSaved: () => ({ workers: [], verifiers: [] }), readAccountRules: () => ({ never: [], last: [] }), poolProfiles: () => [],
      copilotProfiles: () => [], copilotProfileFor: () => null, defaultProvider: () => null, checkerScopeKind: () => 'none',
      isProviderExcluded: () => false, listInstalledProviders: async () => ['claude', 'codex'] },
  });
});
afterEach(async () => {
  coordinator.shutdown();
  await coordinator._whenSettledForTesting();
  PlanQueueCoordinator._resetForTesting();
  vi.restoreAllMocks();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const tools = () => createPlanQueueToolDefinitions({ instanceId: 'parent', planQueueTools: createPlanQueueToolOperations(() => coordinator) });

const nothingHappened = () => {
  expect(store.listRunSnapshots(20)).toEqual([]);
  expect(createInstance).not.toHaveBeenCalled();
  // Refused before anything was read: not even the repository was looked up.
  expect(queueGit.repositoryRoot).not.toHaveBeenCalled();
};

describe('a Linear run is refused wherever the ordinary Start can reach', () => {
  it('uses the exact sentence', () => {
    expect(LINEAR_RUN_PAGE_ONLY_MESSAGE).toBe(SENTENCE);
  });

  it('createPlanQueueRun refuses kind tickets before discovery runs', async () => {
    await expect(coordinator.startRun({ parentInstanceId: 'parent', kind: 'tickets' })).rejects.toThrow(SENTENCE);
    nothingHappened();
  });

  it('createPlanQueueRun refuses a linear entry in the config of a plans run before discovery runs', async () => {
    await expect(coordinator.startRun({ parentInstanceId: 'parent', kind: 'plans', config: { linear: linearQuery } })).rejects.toThrow(SENTENCE);
    nothingHappened();
  });

  it('createPlanQueueRun refuses a linear entry in the config of a tickets run too', async () => {
    await expect(coordinator.startRun({ parentInstanceId: 'parent', kind: 'tickets', config: { linear: linearQuery } })).rejects.toThrow(SENTENCE);
    nothingHappened();
  });

  it('the page’s ordinary Start (its payload passes validation, then the coordinator refuses) creates no run', async () => {
    const payload = PlanQueueStartPayloadSchema.parse({ parentInstanceId: 'parent', kind: 'tickets', workspaceCwd: root });
    await expect(coordinator.startRun(payload)).rejects.toThrow(SENTENCE);
    const withConfig = PlanQueueStartPayloadSchema.parse({ parentInstanceId: 'parent', kind: 'plans', workspaceCwd: root, config: { linear: linearQuery } });
    await expect(coordinator.startRun(withConfig)).rejects.toThrow(SENTENCE);
    nothingHappened();
  });

  it('the plan_queue_start operation refuses kind tickets with the sentence and creates no run', async () => {
    const args = PlanQueueStartArgsSchema.parse({ kind: 'tickets' });
    await expect(createPlanQueueToolOperations(() => coordinator).start('parent', args)).rejects.toThrow(SENTENCE);
    nothingHappened();
  });

  it('the tool call itself, through its argument check, is refused the same way', async () => {
    const start = tools().find(tool => tool.name === 'plan_queue_start')!;
    await expect(start.handler({ kind: 'tickets' })).rejects.toThrow(SENTENCE);
    nothingHappened();
  });

  it('agents are not told the kind exists: the tool lists plans and livetests only, and names no Linear', () => {
    const start = tools().find(tool => tool.name === 'plan_queue_start');
    const kind = (start?.inputSchema as { properties: { kind: { enum: string[] } } }).properties.kind;
    expect(kind.enum).toEqual(['plans', 'livetests']);
    expect(JSON.stringify(start)).not.toMatch(/linear|ticket/i);
  });

  it('the markdown source is not quietly used for a tickets run', () => {
    expect(() => workSourceForRun({ kind: 'tickets' })).toThrow(/not built yet/);
    expect(workSourceForRun({ kind: 'plans' })).toBeDefined();
  });
});
