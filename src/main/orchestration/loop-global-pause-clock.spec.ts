import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GlobalPauseEntry } from '@contracts/schemas/global-pause';
import { defaultLoopConfig, type LoopState } from '../../shared/types/loop.types';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { InstanceManager } from '../instance/instance-manager';
import { createGlobalPauseRuntime } from '../global-pause/global-pause-runtime';
import { getWorkAdmission, WorkAdmission } from '../work-admission/work-admission';
import * as coordinatorModule from './loop-coordinator';
import { LoopCoordinator, type LoopChildResult } from './loop-coordinator';
import { buildRunCheckpoint } from './loop-checkpoint';
import { cleanupLoopCoordinatorSpec } from './loop-coordinator-test-cleanup';
import * as storeModule from './loop-store';
import { LoopStore } from './loop-store';
import { runLoopMigrations } from './loop-schema';
import { checkLoopHardCaps } from './loop-coordinator-state-helpers';
import * as loopControl from './loop-control';

vi.mock('../core/config/settings-manager', () => ({ getSettingsManager: () => ({
  getAll: () => ({ defaultCli: 'claude', loopModelByProvider: {}, auxiliaryLlmRoutingClassificationEnabled: false }),
  get: () => undefined,
}) }));
vi.mock('../cli/adapters/adapter-factory', () => ({ resolveCliType: async () => 'claude' }));
vi.mock('./invocation-model-resolver', () => ({ resolveLoopChildModel: async () => 'test-model' }));

describe('global pause loop wall-time clock through the runtime', () => {
  let coordinator: LoopCoordinator;
  let workspace: string;
  let db: SqliteDriver;
  let store: LoopStore;
  let now: number;
  let invocations: number;
  let finish: ((result: LoopChildResult | { error: string }) => void) | undefined;
  let cleanupTasks: Promise<void>[];
  const runtime = () => createGlobalPauseRuntime({ getAllInstances: () => [] } as unknown as InstanceManager);
  const engineEntry = (id: string): GlobalPauseEntry => ({
    id: 'loop-entry', kind: 'loop', targetId: id, displayName: 'Loop', workspace,
    provider: 'claude', originalInstanceId: null, historyThreadId: null, providerSessionId: null,
    wasBusy: true, noteText: null, noteKind: 'none', state: 'ready', voidReason: null,
    createdAt: now, updatedAt: now,
  });

  function bindCoordinator(): void {
    coordinator.on('loop:state-changed', ({ state }: { state: LoopState }) => {
      store.persistStateCheckpoint({ state, checkpoint: buildRunCheckpoint(coordinator, state, state.lastIteration) });
    });
    coordinator.on('loop:invoke-iteration', (payload: { callback: typeof finish }) => {
      invocations++;
      finish = payload.callback;
    });
    coordinator.on('loop:pause-for-restart', () => finish?.({ error: 'interrupted by global pause' }));
  }

  async function start(): Promise<LoopState> {
    const config = defaultLoopConfig(workspace, 'Check bounded scheduled work');
    config.audit.preflightMode = 'off';
    config.caps.maxWallTimeMs = 60_000;
    config.caps.capWrapUpIteration = false;
    return coordinator.startLoop('clock-chat', config);
  }

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'loop-global-clock-'));
    now = 1_000_000;
    invocations = 0;
    finish = undefined;
    cleanupTasks = [];
    const cleanup = loopControl.cleanupLoopControl;
    vi.spyOn(loopControl, 'cleanupLoopControl').mockImplementation(control => {
      const pending = cleanup(control);
      cleanupTasks.push(pending);
      return pending;
    });
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    db = new Database(':memory:') as unknown as SqliteDriver;
    runLoopMigrations(db);
    store = new LoopStore(db);
    coordinator = new LoopCoordinator();
    vi.spyOn(coordinatorModule, 'getLoopCoordinator').mockImplementation(() => coordinator);
    vi.spyOn(storeModule, 'getLoopStore').mockImplementation(() => store);
    bindCoordinator();
  });

  afterEach(async () => {
    finish?.({ error: 'test cleanup' });
    await cleanupLoopCoordinatorSpec({ coordinator });
    await Promise.all(cleanupTasks);
    db.close();
    await cleanupLoopCoordinatorSpec({ coordinator, workspace });
    WorkAdmission._resetForTesting();
    vi.restoreAllMocks();
  }, 20_000);

  it('resumes the real engine after repeated global pauses without renewing the cap', async () => {
    const state = await start();
    await vi.waitFor(() => expect(invocations).toBe(1));
    now += 20_000;
    await runtime().pauseEngines([{ kind: 'loop', id: state.id, displayName: 'Loop' }]);
    expect(store.getCheckpoint(state.id)?.state.globalPauseClock).toEqual({ pausedMs: 0, pausedAt: now });
    const snapshot = coordinator.getLoop(state.id)!;
    snapshot.globalPauseClock!.pausedMs = 999_999;
    expect(coordinator.getLoop(state.id)?.globalPauseClock?.pausedMs).toBe(0);
    now += 60_000;
    await runtime().pauseEngines([{ kind: 'loop', id: state.id, displayName: 'Loop' }]);
    now += 60_000;
    await runtime().resumeEngine(engineEntry(state.id));
    await vi.waitFor(() => expect(invocations).toBe(2));
    expect(store.getCheckpoint(state.id)?.state.globalPauseClock).toEqual({ pausedMs: 120_000 });
    await runtime().resumeEngine(engineEntry(state.id));
    now += 10_000;
    await runtime().pauseEngines([{ kind: 'loop', id: state.id, displayName: 'Loop' }]);
    now += 200_000;
    await runtime().resumeEngine(engineEntry(state.id));
    await vi.waitFor(() => expect(invocations).toBe(3));
    expect(coordinator.getLoop(state.id)).toMatchObject({
      status: 'running', startedAt: 1_000_000, config: { caps: { maxWallTimeMs: 60_000 } },
    });
    now += 29_999;
    expect(checkLoopHardCaps(coordinator.getLoop(state.id)!)).toBeNull();
    now++;
    expect(checkLoopHardCaps(coordinator.getLoop(state.id)!)).toBe('wall-time');
    await runtime().pauseEngines([{ kind: 'loop', id: state.id, displayName: 'Loop' }]);
    await runtime().resumeEngine(engineEntry(state.id));
    await vi.waitFor(() => expect(coordinator.getLoop(state.id)?.status).toBe('cap-reached'));
    expect(invocations).toBe(3);
  }, 20_000);

  it.each(['paused', 'running'] as const)('restores a globally paused %s checkpoint from SQLite before resuming the real runner', async (checkpointStatus) => {
    const state = await start();
    await vi.waitFor(() => expect(invocations).toBe(1));
    now += 20_000;
    await runtime().pauseEngines([{ kind: 'loop', id: state.id, displayName: 'Loop' }]);
    const saved = store.getCheckpoint(state.id)!;
    expect(saved.state.globalPauseClock).toEqual({ pausedMs: 0, pausedAt: now });
    saved.state.status = checkpointStatus;
    saved.status = checkpointStatus;
    store.persistStateCheckpoint({ state: saved.state, checkpoint: saved });
    // Preserve the durable paused checkpoint while disposing the old process's runner.
    coordinator.removeAllListeners('loop:state-changed');
    await cleanupLoopCoordinatorSpec({ coordinator });
    // An actual process restart cannot retain its old asynchronous fs.rm.
    // Drain that real cleanup before recreating the same control directory.
    await Promise.all(cleanupTasks);
    // The test driver is in-memory; reconstruct every runtime object while
    // retaining only the serialized SQLite rows, as the app does after restart.
    store = new LoopStore(db);
    coordinator = new LoopCoordinator();
    finish = undefined;
    bindCoordinator();
    now += 120_000;
    expect(coordinator.getLoop(state.id)).toBeUndefined();
    await runtime().resumeEngine(engineEntry(state.id));
    await vi.waitFor(() => expect(invocations).toBe(2));
    const restored = coordinator.getLoop(state.id)!;
    expect(restored).toMatchObject({ status: 'running', startedAt: 1_000_000, config: { caps: { maxWallTimeMs: 60_000 } } });
    expect(store.getCheckpoint(state.id)?.state.globalPauseClock).toEqual({ pausedMs: 120_000 });
    now += 40_000;
    expect(checkLoopHardCaps(restored)).toBe('wall-time');
  }, 20_000);

  it('does not spend the cap on a loop published after global pause starts', async () => {
    getWorkAdmission().setGlobalPhase('ready');
    let registered!: () => void;
    let publish!: (observations: string[]) => void;
    const reachedStartup = new Promise<void>(resolve => { registered = resolve; });
    const startup = new Promise<string[]>(resolve => { publish = resolve; });
    coordinator.setLoopMemoryStore({ recordLearning: () => undefined, surfaceLearnings: () => { registered(); return startup; } });
    const starting = start();
    await reachedStartup;
    expect(invocations).toBe(0);
    now += 120_000;
    publish([]);
    const state = await starting;
    // The only entry may be the scheduled job: its loop was unpublished at snapshot time.
    getWorkAdmission().setGlobalPhase('resuming');
    await runtime().resumeEngine(engineEntry(state.id));
    await vi.waitFor(() => expect(invocations).toBe(1));
    expect(coordinator.getLoop(state.id)).toMatchObject({ status: 'running', startedAt: 1_000_000 });
    now += 60_000;
    expect(checkLoopHardCaps(coordinator.getLoop(state.id)!)).toBe('wall-time');
  }, 20_000);

  it('keeps the clock paused when resumed while restart admission is still closed, and resumes it before the cap is checked', async () => {
    const state = await start();
    await vi.waitFor(() => expect(invocations).toBe(1));
    now += 20_000;
    await coordinator.pauseForGlobalPause(state.id);
    getWorkAdmission().setGlobalPhase('ready');
    now += 100_000;
    expect(coordinator.resumeLoop(state.id)).toBe(true);
    // Admission is closed, so the resume itself cannot restart the clock.
    expect(coordinator.getLoop(state.id)?.globalPauseClock?.pausedAt).toBeDefined();
    expect(checkLoopHardCaps(coordinator.getLoop(state.id)!)).toBeNull();
    getWorkAdmission().setGlobalPhase('resuming');
    await vi.waitFor(() => expect(invocations).toBe(2));
    expect(coordinator.getLoop(state.id)?.globalPauseClock).toEqual({ pausedMs: 100_000 });
    expect(checkLoopHardCaps(coordinator.getLoop(state.id)!)).toBeNull();
  }, 20_000);
});
