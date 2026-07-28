import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { RLM_MIGRATIONS_051_055 } from '../persistence/rlm/rlm-migrations-051-055';
import {
  COORDINATOR_TO_NODE_PARAM_SCHEMAS,
  LocalAiHealthCheckParamsSchema,
  LocalAiHealthDiagnoseParamsSchema,
  LocalAiHealthRepairParamsSchema,
} from '../remote-node/rpc-schemas';
import { collectAuxiliaryWorkerEndpoints } from '../rlm/auxiliary-discovery';
import type {
  LocalAiProbeResult,
  LocalAiRepairAction,
  LocalAiTargetConfig,
} from '../../shared/types/local-ai-guard.types';
import { LocalAiTargetConfigSchema } from '../../shared/validation/local-ai-guard.schemas';
import { LocalAiHealthEngine } from './local-ai-health-engine';
import { LocalAiHealthRepository } from './local-ai-health-repository';
import { LocalAiHealthScheduler } from './local-ai-health-scheduler';
import { LocalAiProbeService } from './local-ai-probe-service';
import { LocalAiRecoveryService } from './local-ai-recovery-service';
import { LocalAiTargetRepository } from './local-ai-target-repository';

const dbs: SqliteDriver[] = [];

function openDb(): SqliteDriver {
  const db = defaultDriverFactory(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  for (const name of ['054_local_ai_guard', '055_local_ai_recovery_attempts']) {
    const migration = RLM_MIGRATIONS_051_055.find((item) => item.name === name);
    if (!migration) throw new Error(`Missing migration ${name}`);
    db.exec(migration.up);
  }
  dbs.push(db);
  return db;
}

describe('worker physical target health translation', () => {
  afterEach(() => {
    vi.useRealTimers();
    for (const db of dbs.splice(0)) db.close();
  });

  it('rejects providers outside the typed Local AI worker contract', () => {
    expect(LocalAiHealthCheckParamsSchema.safeParse({
      provider: 'anthropic',
      endpointId: 'anthropic',
      expectedModels: [{ modelId: 'model-a', required: true }],
      canary: { contract: 'exact-token-v1', model: 'model-a' },
      kind: 'lightweight',
      latencyThresholdMs: 2_000,
      timeoutMs: 5_000,
    }).success).toBe(false);
  });

  it.each([
    {
      provider: 'ollama',
      port: 11_434,
      physicalId: 'worker:node-7:ollama:127.0.0.1:11434',
      workerEndpointId: 'ollama',
      action: 'restart-ollama',
    },
    {
      provider: 'openai-compatible',
      port: 1_234,
      physicalId: 'worker:node-7:openai-compatible:127.0.0.1:1234',
      workerEndpointId: 'openai-compatible',
      action: 'deep-check',
    },
  ] as const)(
    'keeps the $provider physical identity while scheduled and automatic health use its worker-local selector',
    async ({ provider, port, physicalId, workerEndpointId, action }) => {
      vi.useFakeTimers();
      vi.setSystemTime(2_000);
      const [discovered] = collectAuxiliaryWorkerEndpoints([{
        id: 'node-7',
        name: 'Studio worker',
        status: 'connected',
        capabilities: {
          localModelEndpoints: [{
            provider,
            endpointId: workerEndpointId,
            baseUrl: `http://127.0.0.1:${port}`,
            models: ['model-a'],
            healthy: true,
          }],
        },
      }] as never);
      if (!discovered) throw new Error('Expected one worker discovery');
      expect(discovered.endpoint.id).toBe(physicalId);
      if (!discovered.endpoint.workerNodeId) {
        throw new Error('Expected discovery to preserve the worker node identity');
      }
      if (
        discovered.endpoint.provider !== 'ollama'
        && discovered.endpoint.provider !== 'openai-compatible'
      ) {
        throw new Error('Expected a Local AI worker provider');
      }

      const config = LocalAiTargetConfigSchema.parse({
        lifecycle: 'enrolled',
        location: { type: 'worker', nodeId: discovered.endpoint.workerNodeId },
        provider: discovered.endpoint.provider,
        endpointId: discovered.endpoint.id,
        baseUrl: discovered.endpoint.baseUrl,
        expectedModels: [{ modelId: 'model-a', required: true }],
        canary: { model: 'model-a', timeoutMs: 5_000, intervalMs: 120_000 },
        endpointCheckIntervalMs: 30_000,
        freshnessLimitMs: 60_000,
        warningLatencyMs: 2_000,
        routingRoles: ['compression'],
        fallbackPolicy: 'notify-and-allow',
        slotFallbackPolicies: {},
        recovery: { automatic: true, maxAttempts: 2, cooldownMs: 60_000 },
      } satisfies LocalAiTargetConfig);
      const db = openDb();
      const targets = new LocalAiTargetRepository(db, undefined, () => 1_000);
      const created = targets.create(config);
      const persisted = targets.get(created.id);
      expect(persisted).toMatchObject({
        endpointId: physicalId,
        location: { type: 'worker', nodeId: 'node-7' },
      });
      if (!persisted) throw new Error('Expected persisted worker target');

      const rpcParams: { method: string; endpointId: string }[] = [];
      const sendServiceRpc = vi.fn(async (
        _nodeId: string,
        method: string,
        params: unknown,
      ): Promise<unknown> => {
        const schema = COORDINATOR_TO_NODE_PARAM_SCHEMAS[
          method as keyof typeof COORDINATOR_TO_NODE_PARAM_SCHEMAS
        ];
        if (!schema) throw new Error('Unexpected Local AI worker RPC method');
        const parsed = schema.safeParse(params);
        if (!parsed.success) throw new Error('Worker health RPC schema rejected its endpoint selector');
        const endpointId = (parsed.data as { endpointId: string }).endpointId;
        rpcParams.push({ method, endpointId });
        if (method === 'localAi.health.repair') {
          const repair = LocalAiHealthRepairParamsSchema.parse(parsed.data);
          return {
            targetId: repair.endpointId,
            action: repair.action,
            outcome: 'completed-not-recovered',
            supported: true,
            attempted: true,
            recovered: false,
            message: 'The fixed worker repair completed.',
            completedAt: 2_001,
          };
        }
        const check = method === 'localAi.health.diagnose'
          ? { ...LocalAiHealthDiagnoseParamsSchema.parse(parsed.data), kind: 'functional' as const }
          : LocalAiHealthCheckParamsSchema.parse(parsed.data);
        const sample: LocalAiProbeResult = {
          targetId: check.endpointId,
          layer: 'endpoint',
          checkType: check.kind,
          ok: true,
          required: true,
          affectedRoles: [],
          checkedAt: 2_002,
          durationMs: 2,
          evidence: { endpointReachable: true },
        };
        return method === 'localAi.health.diagnose'
          ? {
              targetId: check.endpointId,
              checkedAt: 2_002,
              samples: [sample],
              recommendedActions: [],
            }
          : [sample];
      });
      const probes = new LocalAiProbeService({ sendServiceRpc, now: () => Date.now() });
      const health = new LocalAiHealthRepository(db, undefined, () => Date.now());
      const incidents = { handleTransition: vi.fn() };
      let sampleId = 0;
      const scheduler = new LocalAiHealthScheduler({
        targets,
        health,
        probes,
        incidents,
        now: () => Date.now(),
        random: () => 0.5,
        createId: () => `scheduled-sample-${sampleId++}`,
      });
      scheduler.workerConnected('node-7');
      const scheduledStatus = await scheduler.recheck(created.id, 'lightweight');
      expect(scheduledStatus.state).toBe('healthy');
      scheduler.stop();

      const diagnosis = await probes.diagnose(persisted);
      expect(diagnosis.targetId).toBe(created.id);
      expect(diagnosis.samples).toEqual(expect.arrayContaining([
        expect.objectContaining({ layer: 'worker', ok: true }),
        expect.objectContaining({ layer: 'endpoint', ok: true }),
      ]));
      const recovery = new LocalAiRecoveryService({
        targets,
        health,
        probes,
        engine: new LocalAiHealthEngine(),
        incidents,
        now: () => Date.now(),
        platform: 'darwin',
        createId: () => 'attempt-1',
      });
      await expect(recovery.repair(
        created.id,
        action as LocalAiRepairAction,
        'automatic',
      )).resolves.toMatchObject({
        outcome: 'recovered',
        supported: true,
        attempted: true,
        recovered: true,
      });

      expect(rpcParams.length).toBeGreaterThanOrEqual(4);
      expect(rpcParams.every((entry) => entry.endpointId === workerEndpointId)).toBe(true);
      expect(targets.get(created.id)?.endpointId).toBe(physicalId);
    },
  );
});
