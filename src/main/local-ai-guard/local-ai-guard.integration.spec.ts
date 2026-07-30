import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '@contracts/channels';
import type { SqliteDriver } from '../db/sqlite-driver';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type {
  LocalAiFallbackPolicy,
  LocalAiProbeResult,
  LocalAiTarget,
  LocalAiTargetConfig,
} from '../../shared/types/local-ai-guard.types';
import type { WorkerNodeInfo } from '../../shared/types/worker-node.types';
import { RLM_MIGRATIONS_051_055 } from '../persistence/rlm/rlm-migrations-051-055';
import type { IpcResponse } from '../ipc/validated-handler';
import { registerLocalAiGuardHandlers } from '../ipc/handlers/local-ai-guard-handlers';
import { LocalAiActivityRegistry } from './local-ai-activity-registry';
import { LocalAiFallbackApprovalService } from './local-ai-fallback-approval-service';
import { LocalAiHealthEngine } from './local-ai-health-engine';
import { LocalAiHealthRepository } from './local-ai-health-repository';
import { LocalAiHealthScheduler, type LocalAiSchedulerTimerPort } from './local-ai-health-scheduler';
import { LocalAiIncidentService } from './local-ai-incident-service';
import {
  _resetLocalAiGuardRuntimeForTesting,
  initializeLocalAiGuardRuntime,
  type LocalAiGuardRuntime,
} from './local-ai-runtime';
import { LocalAiRoutingGuard } from './local-ai-routing-guard';
import { LocalAiTargetRepository } from './local-ai-target-repository';
import { LocalAiProbeService } from './local-ai-probe-service';
import { WorkerLocalAiHealth } from '../../worker-agent/worker-local-ai-health';

type Handler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
const electron = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Handler) => electron.handlers.set(channel, handler)),
    removeHandler: vi.fn((channel: string) => electron.handlers.delete(channel)),
  },
}));

class ManualTimers implements LocalAiSchedulerTimerPort {
  private nextId = 0;
  private readonly pending = new Map<number, { callback: () => void; delayMs: number }>();

  schedule(callback: () => void, delayMs: number): number {
    const id = ++this.nextId;
    this.pending.set(id, { callback, delayMs });
    return id;
  }

  cancel(handle: unknown): void {
    this.pending.delete(handle as number);
  }

  runDue(maxDelayMs = 0): void {
    const due = [...this.pending.entries()]
      .filter(([, task]) => task.delayMs <= maxDelayMs)
      .sort(([left], [right]) => left - right);
    for (const [id, task] of due) {
      if (!this.pending.delete(id)) continue;
      task.callback();
    }
  }
}

class WorkerRoster extends EventEmitter {
  constructor(private readonly nodes: WorkerNodeInfo[]) {
    super();
  }

  getAllNodes(): WorkerNodeInfo[] {
    return this.nodes;
  }
}

interface IntegrationHarness {
  db: SqliteDriver;
  runtime: LocalAiGuardRuntime;
  targets: LocalAiTargetRepository;
  health: LocalAiHealthRepository;
  scheduler: LocalAiHealthScheduler;
  approvals: LocalAiFallbackApprovalService;
  routing: LocalAiRoutingGuard;
  probes: ReturnType<typeof vi.fn<(target: { id: string }, kind: string) => Promise<LocalAiProbeResult[]>>>;
  timers: ManualTimers;
  workers: WorkerRoster;
  notifyFallback: ReturnType<typeof vi.fn>;
  dispose(): void;
}

const harnesses: IntegrationHarness[] = [];
const tempDirectories: string[] = [];
const execFileAsync = promisify(execFile);
const electronPath = createRequire(import.meta.url)('electron') as string;
const restartProcessScript = String.raw`
  (async () => {
  require('tsx/cjs');
  const path = require('node:path');
  const [mode, filename] = process.argv.slice(1);
  const load = (relativePath) => require(path.join(process.cwd(), relativePath));
  const { defaultDriverFactory } = load('src/main/db/better-sqlite3-driver.ts');
  const { RLM_MIGRATIONS_051_055 } =
    load('src/main/persistence/rlm/rlm-migrations-051-055.ts');
  const { LocalAiTargetRepository } =
    load('src/main/local-ai-guard/local-ai-target-repository.ts');
  const { LocalAiHealthRepository } =
    load('src/main/local-ai-guard/local-ai-health-repository.ts');
  const { LocalAiHealthEngine } =
    load('src/main/local-ai-guard/local-ai-health-engine.ts');
  const { LocalAiHealthScheduler } =
    load('src/main/local-ai-guard/local-ai-health-scheduler.ts');
  const { LocalAiIncidentService } =
    load('src/main/local-ai-guard/local-ai-incident-service.ts');
  const { LocalAiFallbackApprovalService } =
    load('src/main/local-ai-guard/local-ai-fallback-approval-service.ts');
  const { LocalAiRoutingGuard } =
    load('src/main/local-ai-guard/local-ai-routing-guard.ts');

  const targetConfig = {
    lifecycle: 'enrolled',
    location: { type: 'worker', nodeId: 'worker-1' },
    provider: 'ollama',
    endpointId: 'worker-ollama',
    baseUrl: 'http://127.0.0.1:11434',
    expectedModels: [{ modelId: 'qwen3:14b', required: true }],
    canary: { model: 'qwen3:14b', timeoutMs: 5000, intervalMs: 600000 },
    endpointCheckIntervalMs: 60000,
    freshnessLimitMs: 120000,
    warningLatencyMs: 2000,
    routingRoles: ['compression'],
    fallbackPolicy: 'notify-and-allow',
    slotFallbackPolicies: {},
    recovery: { automatic: false, maxAttempts: 1, cooldownMs: 60000 },
  };
  const resultProbe = (targetId, at, ok) => [
    {
      targetId,
      layer: 'worker',
      checkType: 'lightweight',
      ok: true,
      required: true,
      affectedRoles: ['compression'],
      checkedAt: at,
      durationMs: 1,
      evidence: {},
    },
    {
      targetId,
      layer: 'endpoint',
      checkType: 'lightweight',
      ok,
      required: true,
      affectedRoles: ['compression'],
      checkedAt: at,
      durationMs: 1,
      ...(ok ? {} : { failureCode: 'authentication-error' }),
      evidence: {},
    },
  ];
  const db = defaultDriverFactory(filename);
  db.exec('PRAGMA foreign_keys = ON;');
  let now = mode === 'setup' ? 1000 : 1001;
  try {
    if (mode === 'setup') {
      for (const migrationName of ['054_local_ai_guard', '055_local_ai_recovery_attempts']) {
        const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === migrationName);
        if (!migration) throw new Error('Missing migration ' + migrationName);
        db.exec(migration.up);
      }
    }
    const targets = new LocalAiTargetRepository(db, undefined, () => now);
    const health = new LocalAiHealthRepository(db, undefined, () => now);
    const engine = new LocalAiHealthEngine();
    const incidents = new LocalAiIncidentService(
      health,
      { notify() {} },
      {
        resolveTargetIdentity: () => ({
          provider: 'ollama',
          location: 'worker',
          stableTargetId: 'restart-target',
        }),
        now: () => now,
        createId: () => 'restart-incident',
        schedule: () => 1,
        cancelScheduled() {},
      },
    );
    let probeCount = 0;
    const callbacks = [];
    const scheduler = new LocalAiHealthScheduler({
      targets,
      health,
      probes: {
        check: async (target) => {
          probeCount += 1;
          return resultProbe(target.id, now, mode !== 'setup');
        },
      },
      incidents,
      engine,
      now: () => now,
      timers: {
        schedule: (callback, delayMs) => {
          callbacks.push({ callback, delayMs });
          return callback;
        },
        cancel() {},
      },
      createId: (() => {
        let id = 0;
        return () => mode + '-sample-' + (++id);
      })(),
    });
    scheduler.workerConnected('worker-1');
    if (mode === 'setup') {
      const target = targets.create(targetConfig);
      await scheduler.recheck(target.id, 'lightweight');
      console.log('AIO_LOCAL_AI_RESTART:' + JSON.stringify({
        targetId: target.id,
        incidents: health.listIncidents({ targetId: target.id, state: 'open', limit: 10 }).length,
      }));
    } else {
      const target = targets.list()[0];
      scheduler.start();
      const before = scheduler.getStatus(target.id);
      const due = callbacks.filter((item) => item.delayMs === 0);
      for (const item of due) item.callback();
      while (scheduler.getStatus(target.id)?.consecutiveSuccesses !== 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const afterOne = scheduler.getStatus(target.id);
      now += 1;
      await scheduler.recheck(target.id, 'lightweight');
      const approvals = new LocalAiFallbackApprovalService(health, {
        now: () => now,
        schedule: () => 1,
        cancelScheduled() {},
      });
      const routing = new LocalAiRoutingGuard({
        targets,
        scheduler,
        health,
        approvals,
        settings: () => ({
          localAiGuardDefaultFallbackPolicy: 'notify-and-allow',
          localAiGuardDailyFallbackBudgetUsd: null,
          localAiGuardConfirmAboveInputTokens: null,
        }),
        now: () => now,
      });
      const verdict = await routing.evaluateLocalTarget({
        targetId: target.id,
        slot: 'compression',
      });
      console.log('AIO_LOCAL_AI_RESTART:' + JSON.stringify({
        targetId: target.id,
        incidents: health.listIncidents({ targetId: target.id, limit: 10 }).length,
        before,
        afterOne,
        afterTwo: scheduler.getStatus(target.id),
        verdict,
        probeCount,
      }));
      approvals.dispose();
      scheduler.stop();
    }
    incidents.dispose();
  } finally {
    db.close();
  }
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
`;

async function runRestartProcess<T>(mode: 'setup' | 'reopen', filename: string): Promise<T> {
  const { stdout } = await execFileAsync(electronPath, [
    '-e',
    restartProcessScript,
    mode,
    filename,
  ], {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  const prefix = 'AIO_LOCAL_AI_RESTART:';
  const resultLine = stdout.split('\n').reverse().find((line) => line.startsWith(prefix));
  if (!resultLine) throw new Error('Local AI restart process returned no result');
  return JSON.parse(resultLine.slice(prefix.length)) as T;
}

function targetConfig(
  policy: LocalAiFallbackPolicy = 'notify-and-allow',
  overrides: Partial<LocalAiTargetConfig> = {},
): LocalAiTargetConfig {
  return {
    lifecycle: 'enrolled',
    location: { type: 'worker', nodeId: 'worker-1' },
    provider: 'ollama',
    endpointId: 'worker-ollama',
    baseUrl: 'http://127.0.0.1:11434',
    expectedModels: [{ modelId: 'qwen3:14b', required: true }],
    canary: { model: 'qwen3:14b', timeoutMs: 5_000, intervalMs: 600_000 },
    endpointCheckIntervalMs: 60_000,
    freshnessLimitMs: 120_000,
    warningLatencyMs: 2_000,
    routingRoles: ['compression'],
    fallbackPolicy: policy,
    slotFallbackPolicies: {},
    recovery: { automatic: false, maxAttempts: 1, cooldownMs: 60_000 },
    ...overrides,
  };
}

function worker(status: WorkerNodeInfo['status'] = 'connected'): WorkerNodeInfo {
  return {
    id: 'worker-1',
    name: 'Paired worker',
    status,
    activeInstances: 0,
    capabilities: {
      platform: 'linux',
      arch: 'x64',
      cpuCores: 8,
      totalMemoryMB: 16_384,
      availableMemoryMB: 8_192,
      supportedClis: [],
      hasBrowserRuntime: false,
      hasBrowserMcp: false,
      hasAndroidMcp: false,
      hasDocker: false,
      maxConcurrentInstances: 2,
      workingDirectories: [],
      browsableRoots: [],
      discoveredProjects: [],
      localModelEndpoints: [{
        provider: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        models: ['qwen3:14b'],
        healthy: true,
      }],
    },
  };
}

function successSamples(targetId: string, checkedAt: number): LocalAiProbeResult[] {
  return [
    probe(targetId, checkedAt, 'worker'),
    probe(targetId, checkedAt, 'endpoint'),
    probe(targetId, checkedAt, 'model'),
  ];
}

function failureSamples(targetId: string, checkedAt: number): LocalAiProbeResult[] {
  return [
    probe(targetId, checkedAt, 'worker'),
    {
      ...probe(targetId, checkedAt, 'endpoint'),
      ok: false,
      failureCode: 'authentication-error',
    },
  ];
}

function probe(
  targetId: string,
  checkedAt: number,
  layer: LocalAiProbeResult['layer'],
): LocalAiProbeResult {
  return {
    targetId,
    layer,
    checkType: 'lightweight',
    ok: true,
    required: true,
    affectedRoles: ['compression'],
    checkedAt,
    durationMs: 5,
    evidence: {},
  };
}

function openDatabase(path = ':memory:'): SqliteDriver {
  const db = defaultDriverFactory(path);
  db.exec('PRAGMA foreign_keys = ON;');
  const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
  if (!migration) throw new Error('Missing migration 054_local_ai_guard');
  db.exec(migration.up);
  return db;
}

function createHarness(input: {
  db?: SqliteDriver;
  now?: { value: number };
  nodes?: WorkerNodeInfo[];
  probePlan?: (
    targetId: string,
    kind: string,
    checkedAt: number,
  ) => LocalAiProbeResult[];
  globalPolicy?: LocalAiFallbackPolicy;
  dailyBudgetUsd?: number | null;
} = {}): IntegrationHarness {
  const clock = input.now ?? { value: 1_000 };
  const db = input.db ?? openDatabase();
  const timers = new ManualTimers();
  const targets = new LocalAiTargetRepository(db, undefined, () => clock.value);
  const health = new LocalAiHealthRepository(db, undefined, () => clock.value);
  const engine = new LocalAiHealthEngine();
  const activity = new LocalAiActivityRegistry();
  const notifications = { notify: vi.fn() };
  const incidents = new LocalAiIncidentService(
    health,
    notifications as never,
    {
      resolveTargetIdentity: () => ({
        provider: 'ollama',
        location: 'worker',
        stableTargetId: 'stable-target',
      }),
      now: () => clock.value,
      createId: (() => {
        let id = 0;
        return () => `incident-${++id}`;
      })(),
      schedule: (callback, delayMs) => timers.schedule(callback, delayMs),
      cancelScheduled: (handle) => timers.cancel(handle),
    },
  );
  const probes = vi.fn(async (target: { id: string }, kind: string) => (
    input.probePlan?.(target.id, kind, clock.value) ?? successSamples(target.id, clock.value)
  ));
  const scheduler = new LocalAiHealthScheduler({
    targets,
    health,
    probes: { check: probes } as never,
    incidents,
    engine,
    activity,
    now: () => clock.value,
    timers,
    random: () => 0.5,
    createId: (() => {
      let id = 0;
      return () => `sample-${++id}`;
    })(),
  });
  const approvals = new LocalAiFallbackApprovalService(health, {
    now: () => clock.value,
    createId: (() => {
      let id = 0;
      return () => `approval-${++id}`;
    })(),
    schedule: (callback, delayMs) => timers.schedule(callback, delayMs),
    cancelScheduled: (handle) => timers.cancel(handle),
  });
  const notifyFallback = vi.fn();
  const routing = new LocalAiRoutingGuard({
    targets,
    scheduler,
    health,
    approvals,
    incidents,
    settings: () => ({
      localAiGuardDefaultFallbackPolicy: input.globalPolicy ?? 'notify-and-allow',
      localAiGuardDailyFallbackBudgetUsd: input.dailyBudgetUsd ?? null,
      localAiGuardConfirmAboveInputTokens: null,
    }),
    resolveFallbackModel: () => ({ provider: 'anthropic', model: 'claude-haiku-4-5' }),
    notifyFallback,
    now: () => clock.value,
    createId: (() => {
      let id = 0;
      return () => `routing-${++id}`;
    })(),
  });
  const workers = new WorkerRoster(input.nodes ?? [worker()]);
  const runtime = initializeLocalAiGuardRuntime({
    services: {
      targets,
      health,
      probes: { check: probes } as never,
      engine,
      incidents,
      recovery: {} as never,
      activity,
      scheduler,
      approvals,
      routing,
    },
    workers,
    registerCleanup: () => () => undefined,
  });
  const harness: IntegrationHarness = {
    db,
    runtime,
    targets,
    health,
    scheduler,
    approvals,
    routing,
    probes,
    timers,
    workers,
    notifyFallback,
    dispose: () => {
      runtime.dispose();
      db.close();
    },
  };
  harnesses.push(harness);
  return harness;
}

async function flushChecks(harness: IntegrationHarness): Promise<void> {
  harness.timers.runDue(0);
  await vi.waitFor(() => {
    expect(harness.probes.mock.results.every((result) => result.type !== 'incomplete')).toBe(true);
  });
  await Promise.resolve();
}

function registerIpc(harness: IntegrationHarness): void {
  registerLocalAiGuardHandlers({
    windowManager: { sendToRenderer: vi.fn() },
    ensureTrustedSender: () => null,
    getRuntime: () => harness.runtime,
    discoverCandidates: async () => [],
    now: () => 1_000,
    createId: () => 'validation-target',
  });
}

async function invoke<T = unknown>(channel: string, payload?: unknown): Promise<IpcResponse<T>> {
  const handler = electron.handlers.get(channel);
  if (!handler) throw new Error(`Missing IPC handler: ${channel}`);
  return handler({ senderFrame: { url: 'file:///trusted' } }, payload) as Promise<IpcResponse<T>>;
}

describe('Local AI Guard end-to-end composition', () => {
  beforeEach(() => {
    electron.handlers.clear();
    _resetLocalAiGuardRuntimeForTesting();
  });

  afterEach(() => {
    _resetLocalAiGuardRuntimeForTesting();
    for (const harness of harnesses.splice(0)) {
      if (!harness.runtime.isDisposed) harness.dispose();
    }
    for (const directory of tempDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps a paired but unenrolled worker neutral through runtime and IPC', async () => {
    const harness = createHarness();
    await flushChecks(harness);
    registerIpc(harness);

    expect(harness.probes).not.toHaveBeenCalled();
    expect(harness.health.listIncidents({ limit: 100 })).toEqual([]);
    await expect(invoke(IPC_CHANNELS.LOCAL_AI_GUARD_GET_SNAPSHOT)).resolves.toMatchObject({
      success: true,
      data: {
        aggregate: { state: 'not-configured', enrolled: 0 },
        targets: [],
        incidents: [],
      },
    });
  });

  it('validates without persistence, then enrols through IPC and starts monitoring', async () => {
    const harness = createHarness();
    registerIpc(harness);

    const validation = await invoke<LocalAiProbeResult[]>(
      IPC_CHANNELS.LOCAL_AI_GUARD_VALIDATE,
      { config: targetConfig() },
    );
    expect(validation).toMatchObject({
      success: true,
      data: [
        { targetId: 'validation-target', layer: 'worker', ok: true },
        { targetId: 'validation-target', layer: 'endpoint', ok: true },
        { targetId: 'validation-target', layer: 'model', ok: true },
      ],
    });
    expect(harness.targets.list()).toEqual([]);

    const created = await invoke<{ id: string }>(
      IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_CREATE,
      { config: targetConfig() },
    );
    expect(created.success).toBe(true);
    await flushChecks(harness);

    const targetId = created.data?.id;
    expect(targetId).toEqual(expect.any(String));
    expect(harness.targets.list()).toHaveLength(1);
    expect(harness.scheduler.getStatus(targetId!)).toMatchObject({
      state: 'healthy',
      routableRoles: ['compression'],
    });
  });

  it('removes a coordinator target from routing when loaded context is below its minimum', async () => {
    let loaded = false;
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/api/version')) {
        return new Response(JSON.stringify({ version: '0.12.1' }));
      }
      if (url.endsWith('/api/tags')) {
        return new Response(JSON.stringify({ models: [{ name: 'qwen3:14b' }] }));
      }
      if (url.endsWith('/api/generate')) {
        loaded = true;
        return new Response(JSON.stringify({ response: 'AIO_HEALTH_OK' }));
      }
      if (url.endsWith('/api/ps')) {
        return new Response(JSON.stringify({
          models: loaded ? [{ name: 'qwen3:14b', context_length: 4_096 }] : [],
        }));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const config = targetConfig('notify-and-allow', {
      location: { type: 'coordinator' },
      expectedModels: [{
        modelId: 'qwen3:14b',
        required: true,
        minContextLength: 8_192,
      }],
      routingRoles: ['compression'],
    });
    const target: LocalAiTarget = {
      ...config,
      id: 'context-target',
      label: 'Context target',
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    const samples = await new LocalAiProbeService({ fetch: fetchMock })
      .check(target, 'functional');
    const transition = new LocalAiHealthEngine().apply(target, undefined, samples, 1_000);

    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      'http://127.0.0.1:11434/api/version',
      'http://127.0.0.1:11434/api/tags',
      'http://127.0.0.1:11434/api/generate',
      'http://127.0.0.1:11434/api/ps',
    ]);
    expect(samples.find((sample) => sample.layer === 'model')).toMatchObject({
      failureCode: 'insufficient-context',
      required: true,
      affectedRoles: ['compression'],
    });
    expect(transition.current.routableRoles).toEqual([]);
  });

  it('quarantines every coordinator role when present context metadata is malformed', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '0.12.1' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: [{ name: 'qwen3:14b' }],
      })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: [{ name: 'qwen3:14b', context_length: 8_191.5 }],
      })));
    const config = targetConfig('notify-and-allow', {
      location: { type: 'coordinator' },
      expectedModels: [{
        modelId: 'qwen3:14b',
        required: true,
        minContextLength: 8_192,
      }],
      routingRoles: ['compression', 'titleGeneration'],
    });
    const target: LocalAiTarget = {
      ...config,
      id: 'malformed-context-target',
      label: 'Malformed context target',
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    const samples = await new LocalAiProbeService({ fetch: fetchMock })
      .check(target, 'lightweight');
    const transition = new LocalAiHealthEngine().apply(target, undefined, samples, 1_000);

    expect(samples.find((sample) => sample.failureCode === 'monitor-error')).toMatchObject({
      layer: 'endpoint',
      ok: false,
      required: true,
      affectedRoles: ['compression', 'titleGeneration'],
      evidence: { errorKind: 'monitor-error' },
    });
    expect(transition.current.routableRoles).toEqual([]);
    expect(transition.current.state).not.toBe('healthy');
  });

  it('keeps unrelated roles routable when a scoped optional worker model is missing', async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '0.12.1' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        models: [{ name: 'qwen3:14b' }],
      })));
    const workerHealth = new WorkerLocalAiHealth({ fetch: fetchMock, now: () => 1_000 });
    const probes = new LocalAiProbeService({
      now: () => 1_000,
      sendServiceRpc: async (_nodeId, _method, params) => workerHealth.check(params),
    });
    const config = targetConfig('notify-and-allow', {
      expectedModels: [
        { modelId: 'qwen3:14b', required: true },
        {
          modelId: 'optional-title-model',
          required: false,
          routingRoles: ['titleGeneration'],
        },
      ],
      routingRoles: ['compression', 'titleGeneration'],
    });
    const target: LocalAiTarget = {
      ...config,
      id: 'optional-model-target',
      label: 'Optional model target',
      createdAt: 1_000,
      updatedAt: 1_000,
    };
    const samples = await probes.check(target, 'lightweight');
    const transition = new LocalAiHealthEngine().apply(target, undefined, samples, 1_000);

    expect(samples.find((sample) => sample.layer === 'model')).toMatchObject({
      required: false,
      affectedRoles: ['titleGeneration'],
    });
    expect(transition.current.routableRoles).toEqual(['compression']);
  });

  it('keeps worker transport connected while endpoint failure opens an incident', async () => {
    const connected = worker('connected');
    const harness = createHarness({
      nodes: [connected],
      probePlan: (targetId, _kind, at) => failureSamples(targetId, at),
    });
    const target = harness.targets.create(targetConfig());
    await flushChecks(harness);

    expect(connected.status).toBe('connected');
    expect(harness.scheduler.getStatus(target.id)).toMatchObject({
      state: 'unavailable',
      routableRoles: [],
    });
    expect(harness.health.listIncidents({ targetId: target.id, state: 'open', limit: 10 }))
      .toMatchObject([{ targetId: target.id, failureCode: 'authentication-error' }]);
  });

  it('removes a target from routing on its first required endpoint failure', async () => {
    let healthy = true;
    const now = { value: 1_000 };
    const harness = createHarness({
      now,
      probePlan: (targetId, _kind, at) => (
        healthy ? successSamples(targetId, at) : failureSamples(targetId, at)
      ),
    });
    const target = harness.targets.create(targetConfig());
    await flushChecks(harness);
    await expect(harness.routing.evaluateLocalTarget({
      targetId: target.id,
      slot: 'compression',
    })).resolves.toMatchObject({ eligible: true });

    healthy = false;
    now.value += 1;
    await harness.scheduler.recheck(target.id, 'lightweight');

    expect(harness.scheduler.getStatus(target.id)?.routableRoles).toEqual([]);
    await expect(harness.routing.evaluateLocalTarget({
      targetId: target.id,
      slot: 'compression',
    })).resolves.toMatchObject({ eligible: false });
  });

  it('notifies and durably records an allowed fallback', async () => {
    const harness = createHarness();
    const target = harness.targets.create(targetConfig('notify-and-allow'));

    const verdict = await harness.routing.authorizeFallback({
      slot: 'compression',
      intendedTargetId: target.id,
      reason: 'endpoint-failed',
      estimatedInputTokens: 1_000,
      estimatedOutputTokens: 100,
      slotAllowsFrontier: true,
    });

    expect(verdict).toMatchObject({ allowed: true, disposition: 'allowed' });
    expect(harness.notifyFallback).toHaveBeenCalledOnce();
    expect(harness.health.getRoutingEvent(verdict.routingEventId)).toMatchObject({
      targetId: target.id,
      policy: 'notify-and-allow',
      disposition: 'allowed',
    });
  });

  it('keeps confirmation pending until the durable resolution is applied', async () => {
    const harness = createHarness();
    const target = harness.targets.create(targetConfig('require-confirmation'));
    let settled = false;
    const authorization = harness.routing.authorizeFallback({
      slot: 'compression',
      intendedTargetId: target.id,
      reason: 'endpoint-failed',
      estimatedInputTokens: 1_000,
      estimatedOutputTokens: 100,
      slotAllowsFrontier: true,
    }).then((result) => {
      settled = true;
      return result;
    });
    await vi.waitFor(() => expect(harness.approvals.listPending()).toHaveLength(1));
    expect(settled).toBe(false);

    harness.approvals.resolve('approval-1', 'allow-once');

    await expect(authorization).resolves.toMatchObject({
      allowed: true,
      disposition: 'allowed',
      routingEventId: 'routing-1',
    });
    expect(harness.health.getRoutingEvent('routing-1')).toMatchObject({
      disposition: 'allowed',
      actualRoute: 'frontier',
    });
  });

  it('turns a paid fallback into a durable block when the daily budget is exhausted', async () => {
    const harness = createHarness({ dailyBudgetUsd: 0 });

    const verdict = await harness.routing.authorizeFallback({
      slot: 'compression',
      reason: 'endpoint-failed',
      estimatedInputTokens: 1_000,
      estimatedOutputTokens: 100,
      slotAllowsFrontier: true,
    });
    harness.routing.markFallbackDispatched(verdict.routingEventId);

    expect(verdict).toMatchObject({ allowed: false, disposition: 'blocked' });
    expect(harness.health.getRoutingEvent(verdict.routingEventId)).toMatchObject({
      policy: 'block-paid-fallback',
      decisionReason: 'daily-budget',
      actualRoute: 'blocked',
    });
    expect(harness.health.getRoutingEvent(verdict.routingEventId)).not.toHaveProperty('completedAt');
  });

  it('requires two successful checks before restoring routing and resolving the incident', async () => {
    let healthy = false;
    const now = { value: 1_000 };
    const harness = createHarness({
      now,
      probePlan: (targetId, _kind, at) => (
        healthy ? successSamples(targetId, at) : failureSamples(targetId, at)
      ),
    });
    const target = harness.targets.create(targetConfig());
    await flushChecks(harness);
    expect(harness.scheduler.getStatus(target.id)?.state).toBe('unavailable');

    healthy = true;
    now.value += 1;
    await harness.scheduler.recheck(target.id, 'lightweight');
    expect(harness.scheduler.getStatus(target.id)).toMatchObject({
      state: 'unavailable',
      consecutiveSuccesses: 1,
      routableRoles: [],
    });

    now.value += 1;
    await harness.scheduler.recheck(target.id, 'lightweight');
    expect(harness.scheduler.getStatus(target.id)).toMatchObject({
      state: 'healthy',
      consecutiveSuccesses: 2,
      routableRoles: ['compression'],
    });
    expect(harness.health.listIncidents({ targetId: target.id, state: 'resolved', limit: 10 }))
      .toHaveLength(1);
  });

  it('reconstructs targets and incidents after restart but rechecks before routing', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'local-ai-guard-'));
    tempDirectories.push(directory);
    const databasePath = join(directory, 'guard.sqlite');
    const setup = await runRestartProcess<{
      targetId: string;
      incidents: number;
    }>('setup', databasePath);
    const reopened = await runRestartProcess<{
      targetId: string;
      incidents: number;
      before: { state: string; routableRoles: string[]; incidentOpen: boolean };
      afterOne: { state: string; consecutiveSuccesses: number; routableRoles: string[] };
      afterTwo: { state: string; consecutiveSuccesses: number; routableRoles: string[] };
      verdict: { eligible: boolean };
      probeCount: number;
    }>('reopen', databasePath);

    expect(setup).toMatchObject({ incidents: 1 });
    expect(reopened).toMatchObject({
      targetId: setup.targetId,
      incidents: 1,
      before: {
        state: 'unavailable',
        routableRoles: [],
        incidentOpen: true,
      },
      afterOne: {
        state: 'unavailable',
        consecutiveSuccesses: 1,
        routableRoles: [],
      },
      afterTwo: {
        state: 'healthy',
        consecutiveSuccesses: 2,
        routableRoles: ['compression'],
      },
      verdict: { eligible: true },
      probeCount: 2,
    });
  });

  it('aggregates old routing history before raw retention deletes it', () => {
    const now = 200 * 24 * 60 * 60_000;
    const harness = createHarness({ now: { value: now }, nodes: [] });
    const oldAt = now - 91 * 24 * 60 * 60_000;
    harness.health.appendRoutingEvent({
      id: 'old-local-event',
      slot: 'compression',
      intendedRoute: 'local',
      actualRoute: 'local',
      policy: 'notify-and-allow',
      disposition: 'allowed',
      decisionReason: 'health',
      model: 'qwen3:14b',
      inputTokens: 600,
      outputTokens: 100,
      estimatedCostUsd: 0.02,
      createdAt: oldAt,
      completedAt: oldAt,
    });

    const report = harness.health.runRetention(now);
    const aggregate = harness.db.prepareCached(`
      SELECT aggregate_json FROM local_ai_daily_aggregates
      WHERE day = ? LIMIT 1
    `).get<{ aggregate_json: string }>(new Date(oldAt).toISOString().slice(0, 10));

    expect(report).toMatchObject({ routingEventsDeleted: 1, daysAggregated: 1 });
    expect(harness.health.getRoutingEvent('old-local-event')).toBeUndefined();
    expect(JSON.parse(aggregate!.aggregate_json)).toMatchObject({
      localTasks: 1,
      localTokens: 700,
      avoidedEstimatedTokens: 700,
      avoidedEstimatedCostUsd: 0.02,
      byModel: { 'qwen3:14b': 1 },
      bySlot: { compression: 1 },
    });
  });
});
