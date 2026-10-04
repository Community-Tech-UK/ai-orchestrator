import { z } from 'zod';
import type {
  LocalAiIncident,
  LocalAiTarget,
  LocalAiTargetPatch,
  LocalAiTargetStatus,
} from '../../shared/types/local-ai-guard.types';
import {
  LocalAiAggregateStatusSchema,
  LocalAiFailureCodeSchema,
  LocalAiHealthStateSchema,
  LocalAiIncidentSchema,
  LocalAiPublicEffectivenessSummarySchema,
  LocalAiTargetLifecycleSchema,
  LocalAiTargetPatchSchema,
  LocalAiTargetSchema,
} from '../../shared/validation/local-ai-guard.schemas';
import { LocalAiRoutingRoleSchema } from '../../shared/validation/local-ai-target-model.schemas';
import type { LocalAiGuardRuntime } from './local-ai-runtime';

const STATUS_TARGET_LIMIT = 1_000;
const STATUS_INCIDENT_LIMIT = 100;
const STATUS_LAYERS = ['worker', 'endpoint', 'model', 'inference'] as const;

const LayerSummarySchema = z.object({
  ok: z.boolean(),
  required: z.boolean(),
  checkedAt: z.number().int().nonnegative(),
  durationMs: z.number().int().nonnegative(),
  failureCode: LocalAiFailureCodeSchema.optional(),
}).strict();

/**
 * Per-target health as the Health Centre card shows it, reduced to bounded
 * fields. Probe messages and evidence are left out on purpose: the CLI output
 * is read by agents, and those fields can carry provider text.
 */
export const LocalAiCliTargetStatusSchema = z.object({
  id: z.string().min(1).max(256),
  label: z.string().min(1).max(256),
  lifecycle: LocalAiTargetLifecycleSchema,
  provider: z.enum(['ollama', 'openai-compatible']),
  state: LocalAiHealthStateSchema,
  routableRoles: z.array(LocalAiRoutingRoleSchema).max(50),
  consecutiveFailures: z.number().int().nonnegative(),
  checkedAt: z.number().int().nonnegative(),
  layers: z.object({
    worker: LayerSummarySchema.optional(),
    endpoint: LayerSummarySchema.optional(),
    model: LayerSummarySchema.optional(),
    inference: LayerSummarySchema.optional(),
  }).strict(),
}).strict();

export const LocalAiCliStatusSchema = z.object({
  aggregate: LocalAiAggregateStatusSchema,
  targets: z.array(LocalAiCliTargetStatusSchema).max(STATUS_TARGET_LIMIT),
  incidents: z.array(LocalAiIncidentSchema.extend({
    targetLabel: z.string().min(1).max(256).optional(),
  })).max(STATUS_INCIDENT_LIMIT),
}).strict();

export type LocalAiCliTargetStatus = z.infer<typeof LocalAiCliTargetStatusSchema>;
export type LocalAiCliStatus = z.infer<typeof LocalAiCliStatusSchema>;
export type LocalAiPublicEffectivenessSummary = z.infer<typeof LocalAiPublicEffectivenessSummarySchema>;

type ManagementRuntime = Pick<LocalAiGuardRuntime, 'targets' | 'scheduler' | 'engine' | 'health' | 'incidents'>
  & Partial<Pick<LocalAiGuardRuntime, 'notifyChanged'>>;

export interface LocalAiManagementDependencies {
  getRuntime: () => ManagementRuntime;
  now?: () => number;
}

/**
 * The Health Centre's read and maintenance actions (status, Run check, Edit,
 * Acknowledge, effectiveness figures) plus rename, for the `aio-mcp local-ai`
 * CLI. Each makes the same runtime call as the matching IPC handler in
 * `local-ai-guard-handlers.ts`, so agents can operate Local AI targets without
 * asking the operator to click through the UI.
 */
export interface LocalAiManagementOperations {
  status(): Promise<LocalAiCliStatus>;
  recheck(targetId: string, kind: 'lightweight' | 'functional'): Promise<LocalAiCliTargetStatus>;
  rename(targetId: string, label: string): Promise<LocalAiTarget>;
  update(targetId: string, patch: LocalAiTargetPatch): Promise<LocalAiTarget>;
  summary(window: '24h' | '7d' | '30d'): Promise<LocalAiPublicEffectivenessSummary>;
  acknowledgeIncident(incidentId: string): Promise<LocalAiIncident>;
}

export function createLocalAiManagementOperations(
  dependencies: LocalAiManagementDependencies,
): LocalAiManagementOperations {
  const now = () => {
    const value = (dependencies.now ?? Date.now)();
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  };
  const changed = <T>(runtime: ManagementRuntime, value: T): T => {
    runtime.notifyChanged?.();
    return value;
  };
  return {
    status: async () => {
      const runtime = dependencies.getRuntime();
      const targets = runtime.targets.list({ includeRetired: false })
        .filter((target) => target.lifecycle === 'enrolled' || target.lifecycle === 'paused')
        .slice(0, STATUS_TARGET_LIMIT);
      const statuses = targets.map((target) =>
        runtime.scheduler.getStatus(target.id) ?? runtime.engine.checking(target, now()));
      const labels = new Map(runtime.targets.list({ includeRetired: true })
        .map((target) => [target.id, target.label]));
      const incidents = [
        ...runtime.health.listIncidents({ state: 'open', limit: STATUS_INCIDENT_LIMIT }),
        ...runtime.health.listIncidents({ state: 'acknowledged', limit: STATUS_INCIDENT_LIMIT }),
      ].slice(0, STATUS_INCIDENT_LIMIT);
      return LocalAiCliStatusSchema.parse({
        aggregate: runtime.engine.aggregate(statuses),
        targets: targets.map((target, index) => cliTargetStatus(target, statuses[index]!)),
        incidents: incidents.map((incident) => ({
          ...incident,
          ...(labels.has(incident.targetId) ? { targetLabel: labels.get(incident.targetId) } : {}),
        })),
      });
    },
    recheck: async (targetId, kind) => {
      const runtime = dependencies.getRuntime();
      const target = requireTarget(runtime, targetId);
      const status = await runtime.scheduler.recheck(targetId, kind);
      return changed(runtime, LocalAiCliTargetStatusSchema.parse(cliTargetStatus(target, status)));
    },
    rename: async (targetId, label) => {
      const runtime = dependencies.getRuntime();
      return changed(runtime, LocalAiTargetSchema.parse(runtime.targets.rename(targetId, label)));
    },
    update: async (targetId, patch) => {
      const runtime = dependencies.getRuntime();
      const parsed = LocalAiTargetPatchSchema.parse(patch);
      return changed(runtime, LocalAiTargetSchema.parse(runtime.targets.update(targetId, parsed)));
    },
    summary: async (window) => LocalAiPublicEffectivenessSummarySchema.parse(
      dependencies.getRuntime().health.summarize(window),
    ),
    acknowledgeIncident: async (incidentId) => {
      const runtime = dependencies.getRuntime();
      const incident = runtime.incidents.acknowledge(incidentId);
      if (!incident) throw new Error(`Local AI incident not found: ${incidentId}`);
      return changed(runtime, LocalAiIncidentSchema.parse(incident));
    },
  };
}

function requireTarget(runtime: ManagementRuntime, targetId: string): LocalAiTarget {
  const target = runtime.targets.get(targetId);
  if (!target) throw new Error(`Local AI target not found: ${targetId}`);
  return target;
}

function cliTargetStatus(target: LocalAiTarget, status: LocalAiTargetStatus): LocalAiCliTargetStatus {
  const layers: LocalAiCliTargetStatus['layers'] = {};
  for (const layer of STATUS_LAYERS) {
    const result = status.layers[layer];
    if (!result) continue;
    layers[layer] = {
      ok: result.ok,
      required: result.required,
      checkedAt: result.checkedAt,
      durationMs: result.durationMs,
      ...(result.failureCode ? { failureCode: result.failureCode } : {}),
    };
  }
  return {
    id: target.id,
    label: target.label,
    lifecycle: target.lifecycle,
    provider: target.provider,
    state: status.state,
    routableRoles: [...status.routableRoles],
    consecutiveFailures: status.consecutiveFailures,
    checkedAt: status.checkedAt,
    layers,
  };
}
