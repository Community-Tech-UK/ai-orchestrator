import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { NotificationService } from '../notifications/notification-service';
import { RLM_MIGRATIONS_051_055 } from '../persistence/rlm/rlm-migrations-051-055';
import type {
  LocalAiDiagnosticReport,
  LocalAiHealthSample,
  LocalAiProbeResult,
  LocalAiRepairAction,
  LocalAiRepairResult,
  LocalAiTarget,
  LocalAiTargetConfig,
} from '../../shared/types/local-ai-guard.types';
import { LocalAiHealthEngine } from './local-ai-health-engine';
import { LocalAiHealthRepository } from './local-ai-health-repository';
import { LocalAiIncidentService } from './local-ai-incident-service';
import {
  LocalAiRecoveryService,
  type LocalAiRecoveryProbePort,
} from './local-ai-recovery-service';
import { LocalAiTargetRepository } from './local-ai-target-repository';

const dbs: SqliteDriver[] = [];
const incidentServices: LocalAiIncidentService[] = [];

function openDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === '054_local_ai_guard');
  if (!migration) throw new Error('Missing migration 054_local_ai_guard');
  db.exec(migration.up);
  db.exec('ALTER TABLE local_ai_incidents ADD COLUMN unpriced_dispatch_count INTEGER NOT NULL DEFAULT 0;');
  const recoveryMigration = RLM_MIGRATIONS_051_055.find(
    (item) => item.name === '055_local_ai_recovery_attempts',
  );
  if (!recoveryMigration) throw new Error('Missing migration 055_local_ai_recovery_attempts');
  db.exec(recoveryMigration.up);
  dbs.push(db);
  return db;
}

function targetRepository(db: SqliteDriver): LocalAiTargetRepository {
  return new LocalAiTargetRepository(db, { warn: () => undefined }, () => 1_000);
}

function config(overrides: Partial<LocalAiTargetConfig> = {}): LocalAiTargetConfig {
  return {
    lifecycle: 'enrolled',
    location: { type: 'coordinator' },
    provider: 'ollama',
    endpointId: 'ollama-main',
    baseUrl: 'http://127.0.0.1:11434',
    expectedModels: [{ modelId: 'qwen3:14b', required: true }],
    canary: { model: 'qwen3:14b', timeoutMs: 30_000, intervalMs: 600_000 },
    endpointCheckIntervalMs: 60_000,
    freshnessLimitMs: 120_000,
    warningLatencyMs: 2_000,
    routingRoles: ['compression'],
    fallbackPolicy: 'notify-and-allow',
    slotFallbackPolicies: {},
    recovery: { automatic: true, maxAttempts: 2, cooldownMs: 60_000 },
    ...overrides,
  };
}

function probe(
  targetId: string,
  kind: 'lightweight' | 'functional',
  checkedAt: number,
  overrides: Partial<LocalAiProbeResult> = {},
): LocalAiProbeResult {
  return {
    targetId,
    layer: kind === 'functional' ? 'inference' : 'endpoint',
    checkType: kind,
    ok: true,
    required: true,
    affectedRoles: ['compression'],
    checkedAt,
    durationMs: 5,
    evidence: {
      endpointVersion: 'Bearer SECRET_PLACEHOLDER',
      canaryOutputValid: true,
    },
    message: 'prompt/model output SECRET_PLACEHOLDER',
    ...overrides,
  };
}

class ProbeHarness implements LocalAiRecoveryProbePort {
  repairCount = 0;
  checkCount = 0;
  diagnosis?: LocalAiDiagnosticReport;
  repairResult?: LocalAiRepairResult;
  repairError?: Error;
  checkResults: LocalAiProbeResult[][] = [];

  async diagnose(target: LocalAiTarget): Promise<LocalAiDiagnosticReport> {
    return this.diagnosis ?? {
      targetId: target.id,
      checkedAt: target.updatedAt,
      samples: [],
      recommendedActions: ['deep-check'],
    };
  }

  async repair(target: LocalAiTarget, action: LocalAiRepairAction): Promise<LocalAiRepairResult> {
    this.repairCount += 1;
    if (this.repairError) throw this.repairError;
    return this.repairResult ?? {
      targetId: target.id,
      action,
      outcome: 'recovered',
      supported: true,
      attempted: true,
      recovered: true,
      message: 'Fixed named repair completed.',
      completedAt: target.updatedAt + 1,
    };
  }

  async check(
    _target: LocalAiTarget,
    _kind: 'lightweight' | 'functional',
  ): Promise<LocalAiProbeResult[]> {
    const result = this.checkResults[this.checkCount] ?? [];
    this.checkCount += 1;
    return result;
  }
}

function createService(input: {
  targetRepository: LocalAiTargetRepository;
  healthRepository: LocalAiHealthRepository;
  probes: ProbeHarness;
  now: () => number;
  platform?: NodeJS.Platform;
  incidentService?: Pick<LocalAiIncidentService, 'handleTransition'>;
  createId?: () => string;
}): LocalAiRecoveryService {
  return new LocalAiRecoveryService({
    targets: input.targetRepository,
    health: input.healthRepository,
    probes: input.probes,
    engine: new LocalAiHealthEngine(),
    incidents: input.incidentService ?? { handleTransition: () => undefined },
    now: input.now,
    platform: input.platform ?? 'darwin',
    createId: input.createId ?? (() => 'attempt-1'),
  });
}

describe('LocalAiRecoveryService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    for (const service of incidentServices.splice(0)) service.dispose();
    for (const db of dbs.splice(0)) db.close();
  });

  it('returns the functional diagnosis and its classified named actions', async () => {
    const db = openDb();
    const targets = targetRepository(db);
    const target = targets.create(config());
    const health = new LocalAiHealthRepository(db);
    const probes = new ProbeHarness();
    probes.diagnosis = {
      targetId: target.id,
      checkedAt: 2_000,
      samples: [probe(target.id, 'functional', 2_000, {
        ok: false,
        failureCode: 'connection-refused',
      })],
      recommendedActions: ['deep-check', 'restart-ollama'],
    };

    await expect(createService({
      targetRepository: targets,
      healthRepository: health,
      probes,
      now: () => 2_000,
    }).diagnose(target.id)).resolves.toEqual(probes.diagnosis);
  });

  it('returns exact safe guided platform steps without executing or consuming an attempt', async () => {
    const db = openDb();
    const targets = targetRepository(db);
    const target = targets.create(config());
    const health = new LocalAiHealthRepository(db);
    const probes = new ProbeHarness();

    const result = await createService({
      targetRepository: targets,
      healthRepository: health,
      probes,
      now: () => 2_000,
      platform: 'darwin',
    }).repair(target.id, 'restart-ollama', 'guided');

    expect(result).toEqual({
      targetId: target.id,
      action: 'restart-ollama',
      outcome: 'guided',
      supported: true,
      attempted: false,
      recovered: false,
      message: 'Quit Ollama, then open Ollama from the Applications folder.',
      completedAt: 2_000,
    });
    expect(result).toHaveProperty('outcome', 'guided');
    expect(probes.repairCount).toBe(0);
    expect(probes.checkCount).toBe(0);
    expect(health.listRecoveryAttempts(target.id)).toEqual([]);
  });

  it('represents an unsupported guided Ollama action as unsupported', async () => {
    const db = openDb();
    const targets = targetRepository(db);
    const target = targets.create(config({
      provider: 'openai-compatible',
      endpointId: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:1234',
    }));
    const health = new LocalAiHealthRepository(db);
    const probes = new ProbeHarness();

    const result = await createService({
      targetRepository: targets,
      healthRepository: health,
      probes,
      now: () => 2_000,
    }).repair(target.id, 'restart-ollama', 'guided');

    expect(result).toMatchObject({
      outcome: 'unsupported',
      supported: false,
      attempted: false,
      recovered: false,
      message: 'This target is not an Ollama endpoint.',
    });
    expect(probes.repairCount).toBe(0);
    expect(health.listRecoveryAttempts(target.id)).toEqual([]);
  });

  it('does not execute automatic repair unless the target explicitly opts in', async () => {
    const db = openDb();
    const targets = targetRepository(db);
    const target = targets.create(config({
      recovery: { automatic: false, maxAttempts: 2, cooldownMs: 60_000 },
    }));
    const health = new LocalAiHealthRepository(db);
    const probes = new ProbeHarness();

    const result = await createService({
      targetRepository: targets,
      healthRepository: health,
      probes,
      now: () => 2_000,
    }).repair(target.id, 'restart-ollama', 'automatic');

    expect(result).toMatchObject({
      supported: true,
      attempted: false,
      recovered: false,
      message: 'Automatic Local AI repair is disabled for this target.',
    });
    expect(result).toHaveProperty('outcome', 'not-attempted');
    expect(probes.repairCount).toBe(0);
    expect(health.listRecoveryAttempts(target.id)).toEqual([]);
  });

  it('rejects automatic named restart on an unsupported coordinator platform without consuming an attempt', async () => {
    const db = openDb();
    const targets = targetRepository(db);
    const target = targets.create(config());
    const health = new LocalAiHealthRepository(db);
    const probes = new ProbeHarness();

    const result = await createService({
      targetRepository: targets,
      healthRepository: health,
      probes,
      now: () => 2_000,
      platform: 'aix',
    }).repair(target.id, 'restart-ollama', 'automatic');

    expect(result).toMatchObject({
      supported: false,
      attempted: false,
      recovered: false,
      message: 'Ollama restart is not supported on this platform.',
    });
    expect(result).toHaveProperty('outcome', 'unsupported');
    expect(probes.repairCount).toBe(0);
    expect(health.listRecoveryAttempts(target.id)).toEqual([]);
  });

  it('records a supported adapter refusal without claiming that execution occurred', async () => {
    const db = openDb();
    const targets = targetRepository(db);
    const target = targets.create(config());
    const health = new LocalAiHealthRepository(db);
    const probes = new ProbeHarness();
    probes.repairResult = {
      targetId: target.id,
      action: 'restart-ollama',
      outcome: 'not-attempted',
      supported: true,
      attempted: false,
      recovered: false,
      message: 'Adapter declined execution.',
      completedAt: 2_001,
    };

    const result = await createService({
      targetRepository: targets,
      healthRepository: health,
      probes,
      now: () => 2_000,
    }).repair(target.id, 'restart-ollama', 'automatic');

    expect(result).toMatchObject({
      supported: true,
      attempted: false,
      recovered: false,
      message: 'The named repair did not execute.',
    });
    expect(result).toHaveProperty('outcome', 'not-attempted');
    expect(probes.checkCount).toBe(0);
    expect(health.listRecoveryAttempts(target.id)).toEqual([
      expect.objectContaining({
        outcome: 'failed',
        supported: true,
        attempted: false,
        recovered: false,
      }),
    ]);
  });

  it('enforces durable cooldown and maximum attempts across service restart', async () => {
    const db = openDb();
    const targets = targetRepository(db);
    const target = targets.create(config());
    const health = new LocalAiHealthRepository(db);
    const probes = new ProbeHarness();
    probes.checkResults = [[], [], [], []];
    let now = 1_000;
    let attemptId = 0;
    const service = () => createService({
      targetRepository: targets,
      healthRepository: new LocalAiHealthRepository(db),
      probes,
      now: () => now,
      createId: () => `attempt-${++attemptId}`,
    });

    const first = await service().repair(target.id, 'restart-ollama', 'automatic');
    expect(first).toMatchObject({ attempted: true, recovered: false });
    now = 60_999;
    expect(await service().repair(target.id, 'restart-ollama', 'automatic')).toMatchObject({
      attempted: false,
      message: 'Automatic Local AI repair is in cooldown until 61000.',
    });
    now = 61_000;
    const second = await service().repair(target.id, 'restart-ollama', 'automatic');
    expect(second).toMatchObject({ attempted: true, recovered: false });
    now = 200_000;
    expect(await service().repair(target.id, 'restart-ollama', 'automatic')).toMatchObject({
      attempted: false,
      message: 'Automatic Local AI repair has reached its maximum attempt count.',
    });
    expect(health.listRecoveryAttempts(target.id)).toHaveLength(2);
    const recoverySamples = health.latestSamples(target.id)
      .filter((sample) => sample.origin === 'recovery');
    expect(recoverySamples).toHaveLength(4);
    expect(recoverySamples.every((sample) =>
      sample.required
      && !sample.ok
      && sample.failureCode === 'monitor-error'
      && sample.message === undefined
      && Object.keys(sample.evidence).length === 0)).toBe(true);
  });

  it('verifies a named restart with both probe kinds, persists metadata only, and resolves the incident', async () => {
    const db = openDb();
    const targets = targetRepository(db);
    const target = targets.create(config());
    const health = new LocalAiHealthRepository(db);
    health.upsertIncident({
      kind: 'open-or-update',
      incident: {
        id: 'incident-1',
        targetId: target.id,
        state: 'open',
        severity: 'critical',
        failureCode: 'authentication-error',
        affectedLayers: ['endpoint'],
        affectedRoles: ['compression'],
        openedAt: 1_000,
        updatedAt: 1_000,
        fallbackCount: 0,
        knownCostUsd: 0,
        estimatedCostUsd: 0,
        unpricedDispatchCount: 0,
      },
    });
    const now = 2_000;
    const notifications = new NotificationService({
      desktop: { isSupported: () => false, show: () => undefined },
      now: () => now,
    });
    const incidents = new LocalAiIncidentService(health, notifications, {
      resolveTargetIdentity: () => undefined,
      now: () => now,
      schedule: () => 1,
      cancelScheduled: () => undefined,
    });
    incidentServices.push(incidents);
    const probes = new ProbeHarness();
    probes.checkResults = [
      [probe(target.id, 'lightweight', 2_001)],
      [probe(target.id, 'functional', 2_002)],
    ];

    const result = await createService({
      targetRepository: targets,
      healthRepository: health,
      probes,
      now: () => now,
      incidentService: incidents,
    }).repair(target.id, 'restart-ollama', 'automatic');

    expect(result).toMatchObject({
      supported: true,
      attempted: true,
      recovered: true,
      message: 'The named repair completed and required health checks passed.',
    });
    expect(result).toHaveProperty('outcome', 'recovered');
    expect(probes.repairCount).toBe(1);
    expect(probes.checkCount).toBe(2);
    const recoverySamples = health.latestSamples(target.id)
      .filter((sample): sample is LocalAiHealthSample => sample.origin === 'recovery');
    expect(recoverySamples).toHaveLength(2);
    expect(recoverySamples.map((sample) => sample.checkType).sort()).toEqual(['functional', 'lightweight']);
    expect(recoverySamples.every((sample) =>
      sample.message === undefined && Object.keys(sample.evidence).length === 0)).toBe(true);
    expect(JSON.stringify(recoverySamples)).not.toMatch(/Bearer|SECRET_PLACEHOLDER|prompt|model output/i);
    expect(health.listIncidents({ targetId: target.id, limit: 10 })[0]).toMatchObject({
      id: 'incident-1',
      state: 'resolved',
      resolvedAt: 2_002,
    });
    const attempts = health.listRecoveryAttempts(target.id);
    expect(attempts).toEqual([
      expect.objectContaining({
        action: 'restart-ollama',
        outcome: 'recovered',
        supported: true,
        attempted: true,
        recovered: true,
      }),
    ]);
    expect(JSON.stringify(attempts)).not.toMatch(
      /command|Bearer|secret|evidence|message|prompt|modelOutput|baseUrl/i,
    );
  });

  it('does not report recovery when the restart succeeds but a required functional probe fails', async () => {
    const db = openDb();
    const targets = targetRepository(db);
    const target = targets.create(config());
    const health = new LocalAiHealthRepository(db);
    const probes = new ProbeHarness();
    probes.checkResults = [
      [probe(target.id, 'lightweight', 2_001)],
      [probe(target.id, 'functional', 2_002, {
        ok: false,
        failureCode: 'malformed-inference-output',
      })],
    ];

    const result = await createService({
      targetRepository: targets,
      healthRepository: health,
      probes,
      now: () => 2_002,
    }).repair(target.id, 'restart-ollama', 'automatic');

    expect(result).toMatchObject({
      attempted: true,
      recovered: false,
      message: 'The named repair completed, but required health checks did not pass.',
    });
    expect(result).toHaveProperty('outcome', 'completed-not-recovered');
  });

  it('returns an explicit execution-failed outcome when the named adapter throws', async () => {
    const db = openDb();
    const targets = targetRepository(db);
    const target = targets.create(config());
    const health = new LocalAiHealthRepository(db);
    const probes = new ProbeHarness();
    probes.repairError = new Error('private adapter detail');

    const result = await createService({
      targetRepository: targets,
      healthRepository: health,
      probes,
      now: () => 2_000,
    }).repair(target.id, 'restart-ollama', 'automatic');

    expect(result).toHaveProperty('outcome', 'execution-failed');
    expect(result.message).toBe('The bounded Local AI repair could not be completed.');
    expect(JSON.stringify(result)).not.toContain('private adapter detail');
  });

  it('persists a typed adapter execution failure without running recovery verification', async () => {
    const db = openDb();
    const targets = targetRepository(db);
    const target = targets.create(config());
    const health = new LocalAiHealthRepository(db);
    const probes = new ProbeHarness();
    probes.repairResult = {
      targetId: target.id,
      action: 'restart-ollama',
      outcome: 'execution-failed',
      supported: true,
      attempted: true,
      recovered: false,
      message: 'Private adapter failure detail.',
      completedAt: 2_001,
    };
    probes.checkResults = [
      [probe(target.id, 'lightweight', 2_002)],
      [probe(target.id, 'functional', 2_003)],
    ];

    const result = await createService({
      targetRepository: targets,
      healthRepository: health,
      probes,
      now: () => 2_000,
    }).repair(target.id, 'restart-ollama', 'automatic');

    expect(result).toEqual({
      targetId: target.id,
      action: 'restart-ollama',
      outcome: 'execution-failed',
      supported: true,
      attempted: true,
      recovered: false,
      message: 'The bounded Local AI repair could not be completed.',
      completedAt: 2_001,
    });
    expect(probes.repairCount).toBe(1);
    expect(probes.checkCount).toBe(0);
    expect(health.listRecoveryAttempts(target.id)).toEqual([
      expect.objectContaining({
        action: 'restart-ollama',
        completedAt: 2_001,
        outcome: 'failed',
        supported: true,
        attempted: true,
        recovered: false,
      }),
    ]);
  });

  it('turns malformed probe identity into metadata-only monitor failures', async () => {
    const db = openDb();
    const targets = targetRepository(db);
    const target = targets.create(config());
    const health = new LocalAiHealthRepository(db);
    const probes = new ProbeHarness();
    probes.checkResults = [
      [probe('foreign-target SECRET_PLACEHOLDER', 'lightweight', 2_001)],
      [probe(target.id, 'lightweight', 2_002)],
    ];

    const result = await createService({
      targetRepository: targets,
      healthRepository: health,
      probes,
      now: () => 2_002,
    }).repair(target.id, 'restart-ollama', 'automatic');

    expect(result.recovered).toBe(false);
    const recoverySamples = health.latestSamples(target.id)
      .filter((sample) => sample.origin === 'recovery');
    expect(recoverySamples).toHaveLength(2);
    expect(recoverySamples.every((sample) =>
      sample.failureCode === 'monitor-error'
      && sample.ok === false
      && Object.keys(sample.evidence).length === 0)).toBe(true);
    expect(JSON.stringify(recoverySamples)).not.toContain('SECRET_PLACEHOLDER');
  });
});
