import { randomUUID } from 'node:crypto';
import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain } from 'electron';
import type { ZodType } from 'zod';
import { IPC_CHANNELS } from '@contracts/channels';
import {
  AUXILIARY_DISCOVERY_MAX_CANDIDATES,
  AUXILIARY_DISCOVERY_MAX_MODELS,
  type AuxiliaryLlmCandidate,
} from '../../../shared/types/auxiliary-llm.types';
import type {
  LocalAiDiscoveredEndpoint,
  LocalAiEndpointIdentity,
  LocalAiGuardSnapshot,
  LocalAiProbeResult,
  LocalAiTarget,
} from '../../../shared/types/local-ai-guard.types';
import {
  LocalAiEmptyRequestSchema,
  LocalAiDiscoveredEndpointSchema,
  LocalAiDiscoveredEndpointsSchema,
  LocalAiFallbackRequestSchema,
  LocalAiFallbackResolveRequestSchema,
  LocalAiGuardSnapshotSchema,
  LocalAiIncidentSchema,
  LocalAiIncidentAcknowledgeRequestSchema,
  LocalAiPendingFallbackRequestsSchema,
  LocalAiProbeResultsSchema,
  LocalAiPublicDiagnosticReportSchema,
  LocalAiPublicEffectivenessSummarySchema,
  LocalAiRecheckRequestSchema,
  LocalAiRepairResultSchema,
  LocalAiRepairRequestSchema,
  LocalAiSummaryRequestSchema,
  LocalAiTargetSchema,
  LocalAiTargetCreateRequestSchema,
  LocalAiTargetLifecycleRequestSchema,
  LocalAiTargetRequestSchema,
  LocalAiTargetStatusSchema,
  LocalAiTargetUpdateRequestSchema,
  LocalAiValidateRequestSchema,
} from '../../../shared/validation/local-ai-guard.schemas';
import {
  getLocalAiGuardRuntime,
  type LocalAiGuardRuntime,
} from '../../local-ai-guard/local-ai-runtime';
import { getLogger } from '../../logging/logger';
import { getAuxiliaryLlmService } from '../../rlm/auxiliary-llm-service';
import { registerCleanup } from '../../util/cleanup-registry';
import type { WindowManager } from '../../window-manager';
import { validatedHandler, type IpcResponse } from '../validated-handler';

const logger = getLogger('LocalAiGuardHandlers');
const SNAPSHOT_INCIDENT_LIMIT = 100;
const SNAPSHOT_TARGET_LIMIT = 1_000;
const SNAPSHOT_FALLBACK_LIMIT = 1_000;
const SNAPSHOT_RECOVERY_ATTEMPT_LIMIT = 1_000;
const SNAPSHOT_BUILD_MAX_ATTEMPTS = 3;

type EnsureTrustedSender = (
  event: IpcMainInvokeEvent,
  channel: string,
) => IpcResponse | null;

export interface LocalAiGuardHandlerDependencies {
  windowManager: Pick<WindowManager, 'sendToRenderer'>;
  ensureTrustedSender: EnsureTrustedSender;
  getRuntime?: () => LocalAiGuardRuntime;
  discoverCandidates?: () => Promise<AuxiliaryLlmCandidate[]>;
  now?: () => number;
  createId?: () => string;
}

let activeCleanup: (() => void) | null = null;

export function registerLocalAiGuardHandlers(
  dependencies: LocalAiGuardHandlerDependencies,
): () => void {
  activeCleanup?.();
  const getRuntime = dependencies.getRuntime ?? getLocalAiGuardRuntime;
  let runtime: LocalAiGuardRuntime;
  try {
    runtime = getRuntime();
    if (runtime.isDisposed) throw new Error('disposed');
  } catch {
    logger.warn('Local AI Guard IPC registered in unavailable mode', {
      reason: 'runtime-unavailable',
    });
    return registerUnavailableHandlers(dependencies.ensureTrustedSender);
  }

  const discoverCandidates = dependencies.discoverCandidates
    ?? (() => getAuxiliaryLlmService().discoverCandidates());
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? randomUUID;

  register(
    IPC_CHANNELS.LOCAL_AI_GUARD_GET_SNAPSHOT,
    LocalAiEmptyRequestSchema,
    async () => runtimeOperation(
      runtime,
      'LOCAL_AI_GUARD_SNAPSHOT_FAILED',
      async () => success(buildSnapshot(runtime, now())),
    ),
  );
  register(
    IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_CREATE,
    LocalAiTargetCreateRequestSchema,
    async ({ config }) => mutate(
      runtime,
      () => runtime.targets.create(config),
      LocalAiTargetSchema,
    ),
    dependencies.ensureTrustedSender,
  );
  register(
    IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_UPDATE,
    LocalAiTargetUpdateRequestSchema,
    async ({ targetId, patch }) => mutate(
      runtime,
      () => runtime.targets.update(targetId, patch),
      LocalAiTargetSchema,
    ),
    dependencies.ensureTrustedSender,
  );
  register(
    IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_SET_LIFECYCLE,
    LocalAiTargetLifecycleRequestSchema,
    async ({ targetId, lifecycle, pausedUntil }) => mutate(
      runtime,
      () => runtime.targets.setLifecycle(
        targetId,
        lifecycle,
        ...(pausedUntil === undefined ? [] : [{ pausedUntil }]),
      ),
      LocalAiTargetSchema,
    ),
    dependencies.ensureTrustedSender,
  );
  register(
    IPC_CHANNELS.LOCAL_AI_GUARD_DISCOVER,
    LocalAiEmptyRequestSchema,
    async () => runtimeOperation(
      runtime,
      'LOCAL_AI_GUARD_DISCOVERY_FAILED',
      async () => ({
        success: true,
        data: sanitizeCandidates(
          await discoverCandidates(),
          (identity) => runtime.targets.findByEndpoint(identity)?.id,
        ),
      }),
    ),
    dependencies.ensureTrustedSender,
  );
  register(
    IPC_CHANNELS.LOCAL_AI_GUARD_VALIDATE,
    LocalAiValidateRequestSchema,
    async ({ config }) => runtimeOperation(
      runtime,
      'LOCAL_AI_GUARD_VALIDATION_FAILED',
      async () => {
        const checkedAt = safeTimestamp(now());
        const target: LocalAiTarget = {
          ...config,
          id: createId(),
          label: 'Validation target',
          createdAt: checkedAt,
          updatedAt: checkedAt,
        };
        const samples = await runtime.probes.check(target, 'functional');
        return {
          success: true,
          data: LocalAiProbeResultsSchema.parse(sanitizeProbeResults(samples)),
        };
      },
    ),
    dependencies.ensureTrustedSender,
  );
  register(
    IPC_CHANNELS.LOCAL_AI_GUARD_RECHECK,
    LocalAiRecheckRequestSchema,
    async ({ targetId, kind }) => mutate(
      runtime,
      () => runtime.scheduler.recheck(targetId, kind),
      LocalAiTargetStatusSchema,
    ),
    dependencies.ensureTrustedSender,
  );
  register(
    IPC_CHANNELS.LOCAL_AI_GUARD_INCIDENT_ACKNOWLEDGE,
    LocalAiIncidentAcknowledgeRequestSchema,
    async ({ incidentId }) => mutate(runtime, () => {
      const incident = runtime.incidents.acknowledge(incidentId);
      if (!incident) throw new Error('not-found');
      return incident;
    }, LocalAiIncidentSchema),
    dependencies.ensureTrustedSender,
  );
  register(
    IPC_CHANNELS.LOCAL_AI_GUARD_DIAGNOSE,
    LocalAiTargetRequestSchema,
    async ({ targetId }) => runtimeOperation(
      runtime,
      'LOCAL_AI_GUARD_DIAGNOSIS_FAILED',
      async () => ({
        success: true,
        data: LocalAiPublicDiagnosticReportSchema.parse(
          await runtime.recovery.diagnose(targetId),
        ),
      }),
    ),
    dependencies.ensureTrustedSender,
  );
  register(
    IPC_CHANNELS.LOCAL_AI_GUARD_REPAIR,
    LocalAiRepairRequestSchema,
    async ({ targetId, action, mode }) => mutate(
      runtime,
      () => runtime.recovery.repair(targetId, action, mode),
      LocalAiRepairResultSchema,
    ),
    dependencies.ensureTrustedSender,
  );
  register(
    IPC_CHANNELS.LOCAL_AI_GUARD_SUMMARY_QUERY,
    LocalAiSummaryRequestSchema,
    async ({ window }) => runtimeOperation(
      runtime,
      'LOCAL_AI_GUARD_SUMMARY_FAILED',
      async () => ({
        success: true,
        data: LocalAiPublicEffectivenessSummarySchema.parse(
          runtime.health.summarize(window),
        ),
      }),
    ),
  );
  register(
    IPC_CHANNELS.LOCAL_AI_GUARD_PENDING_FALLBACK_LIST,
    LocalAiEmptyRequestSchema,
    async () => runtimeOperation(
      runtime,
      'LOCAL_AI_GUARD_PENDING_FALLBACK_LIST_FAILED',
      async () => ({
        success: true,
        data: LocalAiPendingFallbackRequestsSchema.parse(
          runtime.approvals.listPending().slice(0, SNAPSHOT_FALLBACK_LIMIT),
        ),
      }),
    ),
  );
  register(
    IPC_CHANNELS.LOCAL_AI_GUARD_PENDING_FALLBACK_RESOLVE,
    LocalAiFallbackResolveRequestSchema,
    async ({ requestId, resolution }) => mutate(
      runtime,
      () => runtime.approvals.resolve(requestId, resolution),
      LocalAiFallbackRequestSchema,
    ),
    dependencies.ensureTrustedSender,
  );

  let acceptingDeltas = true;
  let deltaQueued = false;
  const unsubscribe = runtime.subscribe(() => {
    if (!acceptingDeltas || deltaQueued) return;
    deltaQueued = true;
    queueMicrotask(() => {
      deltaQueued = false;
      if (!acceptingDeltas || runtime.isDisposed) return;
      try {
        dependencies.windowManager.sendToRenderer(
          IPC_CHANNELS.LOCAL_AI_GUARD_STATUS_DELTA,
          buildSnapshot(runtime, now()),
        );
      } catch {
        logger.warn('Local AI Guard status delta failed', { reason: 'snapshot-unavailable' });
      }
    });
  });

  return installCleanup(() => {
    acceptingDeltas = false;
    unsubscribe();
  });
}

function registerUnavailableHandlers(
  ensureTrustedSender: EnsureTrustedSender,
): () => void {
  const unavailable = async (): Promise<IpcResponse<never>> => ({
    success: false,
    error: {
      code: 'LOCAL_AI_GUARD_RUNTIME_UNAVAILABLE',
      message: 'Local AI Guard is unavailable for this session.',
      timestamp: Date.now(),
    },
  });
  for (const [channel, schema] of registrations()) {
    register(
      channel,
      schema,
      unavailable,
      TRUSTED_OPERATION_CHANNELS.has(channel) ? ensureTrustedSender : undefined,
    );
  }
  return installCleanup();
}

function register<T, TOutput = unknown>(
  channel: string,
  schema: ZodType<T>,
  handler: (
    validated: T,
    event: IpcMainInvokeEvent,
  ) => Promise<IpcResponse<TOutput>>,
  ensureTrustedSender?: EnsureTrustedSender,
): void {
  ipcMain.handle(
    channel,
    validatedHandler(channel, schema, handler, {
      ...(ensureTrustedSender ? { ensureTrustedSender } : {}),
      errorCode: 'LOCAL_AI_GUARD_OPERATION_FAILED',
    }),
  );
}

function buildSnapshot(runtime: LocalAiGuardRuntime, now: number): LocalAiGuardSnapshot {
  if (runtime.isDisposed) throw new Error('runtime-unavailable');
  for (let attempt = 0; attempt < SNAPSHOT_BUILD_MAX_ATTEMPTS; attempt += 1) {
    const revision = runtime.revision;
    const targetConfigs = runtime.targets.list({ includeRetired: false })
      .filter((target) => target.lifecycle === 'enrolled' || target.lifecycle === 'paused')
      .slice(0, SNAPSHOT_TARGET_LIMIT);
    const targets = targetConfigs.map((target) =>
        runtime.scheduler.getStatus(target.id)
        ?? runtime.engine.checking(target, safeTimestamp(now)));
    const snapshot = {
      revision,
      aggregate: runtime.engine.aggregate(targets),
      targets,
      targetConfigs,
      incidents: runtime.health.listIncidents({ limit: SNAPSHOT_INCIDENT_LIMIT }),
      recoveryAttempts: targetConfigs.flatMap((target) =>
        runtime.health.listRecoveryAttempts(target.id).slice(-10))
        .slice(-SNAPSHOT_RECOVERY_ATTEMPT_LIMIT),
      pendingFallbacks: runtime.approvals.listPending().slice(0, SNAPSHOT_FALLBACK_LIMIT),
    };
    if (revision === runtime.revision) {
      return LocalAiGuardSnapshotSchema.parse(snapshot);
    }
  }
  throw new Error('snapshot-changed-during-build');
}

async function mutate<T>(
  runtime: LocalAiGuardRuntime,
  operation: () => unknown | Promise<unknown>,
  outputSchema: ZodType<T>,
): Promise<IpcResponse<T>> {
  return runtimeOperation(runtime, 'LOCAL_AI_GUARD_MUTATION_FAILED', async () => {
    const data = outputSchema.parse(await operation());
    runtime.notifyChanged();
    return { success: true, data };
  });
}

async function runtimeOperation<T>(
  runtime: LocalAiGuardRuntime,
  code: string,
  operation: () => Promise<IpcResponse<T>>,
): Promise<IpcResponse<T>> {
  if (runtime.isDisposed) return unavailableResponse();
  return safeOperation(code, operation);
}

async function safeOperation<T>(
  code: string,
  operation: () => Promise<IpcResponse<T>>,
): Promise<IpcResponse<T>> {
  try {
    return await operation();
  } catch {
    return {
      success: false,
      error: {
        code,
        message: 'The Local AI Guard operation could not be completed.',
        timestamp: Date.now(),
      },
    };
  }
}

function unavailableResponse<T>(): IpcResponse<T> {
  return {
    success: false,
    error: {
      code: 'LOCAL_AI_GUARD_RUNTIME_UNAVAILABLE',
      message: 'Local AI Guard is unavailable for this session.',
      timestamp: Date.now(),
    },
  };
}

function success<T>(data: T): IpcResponse<T> {
  return { success: true, data };
}

function sanitizeCandidates(
  candidates: AuxiliaryLlmCandidate[],
  findEnrolledTargetId: (identity: LocalAiEndpointIdentity) => string | undefined,
): LocalAiDiscoveredEndpoint[] {
  const sanitized: LocalAiDiscoveredEndpoint[] = [];
  for (const candidate of candidates) {
    if (sanitized.length >= AUXILIARY_DISCOVERY_MAX_CANDIDATES) break;
    try {
      const { endpoint } = candidate;
      if (endpoint.provider !== 'ollama' && endpoint.provider !== 'openai-compatible') continue;
      const location = endpoint.source === 'worker-node' && endpoint.workerNodeId
        ? { type: 'worker' as const, nodeId: endpoint.workerNodeId }
        : { type: 'coordinator' as const };
      const parsed = LocalAiDiscoveredEndpointSchema.safeParse({
        identity: {
          location,
          provider: endpoint.provider,
          endpointId: endpoint.id,
          baseUrl: endpoint.baseUrl,
        },
        label: endpoint.label,
        models: candidate.models
          .slice(0, AUXILIARY_DISCOVERY_MAX_MODELS)
          .map((model) => model.id),
        healthy: candidate.healthy,
      });
      if (!parsed.success) continue;
      const enrolledTargetId = findEnrolledTargetId(parsed.data.identity);
      sanitized.push({
        ...parsed.data,
        ...(enrolledTargetId ? { enrolledTargetId } : {}),
      });
    } catch {
      continue;
    }
  }
  return LocalAiDiscoveredEndpointsSchema.parse(sanitized);
}

function sanitizeProbeResults(samples: LocalAiProbeResult[]): LocalAiProbeResult[] {
  return samples.slice(0, 10).map((sample) => ({
    ...sample,
    ...(sample.message ? { message: 'The Local AI health check reported a failure.' } : {}),
  }));
}

function safeTimestamp(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function installCleanup(beforeRemove?: () => void): () => void {
  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (activeCleanup === cleanup) activeCleanup = null;
    beforeRemove?.();
    for (const channel of requestChannels()) ipcMain.removeHandler(channel);
  };
  activeCleanup = cleanup;
  registerCleanup(cleanup);
  return cleanup;
}

function registrations(): readonly (readonly [string, ZodType<unknown>])[] {
  return [
    [IPC_CHANNELS.LOCAL_AI_GUARD_GET_SNAPSHOT, LocalAiEmptyRequestSchema],
    [IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_CREATE, LocalAiTargetCreateRequestSchema],
    [IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_UPDATE, LocalAiTargetUpdateRequestSchema],
    [IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_SET_LIFECYCLE, LocalAiTargetLifecycleRequestSchema],
    [IPC_CHANNELS.LOCAL_AI_GUARD_DISCOVER, LocalAiEmptyRequestSchema],
    [IPC_CHANNELS.LOCAL_AI_GUARD_VALIDATE, LocalAiValidateRequestSchema],
    [IPC_CHANNELS.LOCAL_AI_GUARD_RECHECK, LocalAiRecheckRequestSchema],
    [IPC_CHANNELS.LOCAL_AI_GUARD_INCIDENT_ACKNOWLEDGE, LocalAiIncidentAcknowledgeRequestSchema],
    [IPC_CHANNELS.LOCAL_AI_GUARD_DIAGNOSE, LocalAiTargetRequestSchema],
    [IPC_CHANNELS.LOCAL_AI_GUARD_REPAIR, LocalAiRepairRequestSchema],
    [IPC_CHANNELS.LOCAL_AI_GUARD_SUMMARY_QUERY, LocalAiSummaryRequestSchema],
    [IPC_CHANNELS.LOCAL_AI_GUARD_PENDING_FALLBACK_LIST, LocalAiEmptyRequestSchema],
    [IPC_CHANNELS.LOCAL_AI_GUARD_PENDING_FALLBACK_RESOLVE, LocalAiFallbackResolveRequestSchema],
  ] as const;
}

function requestChannels(): string[] {
  return registrations().map(([channel]) => channel);
}

const TRUSTED_OPERATION_CHANNELS = new Set<string>([
  IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_CREATE,
  IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_UPDATE,
  IPC_CHANNELS.LOCAL_AI_GUARD_TARGET_SET_LIFECYCLE,
  IPC_CHANNELS.LOCAL_AI_GUARD_DISCOVER,
  IPC_CHANNELS.LOCAL_AI_GUARD_VALIDATE,
  IPC_CHANNELS.LOCAL_AI_GUARD_RECHECK,
  IPC_CHANNELS.LOCAL_AI_GUARD_INCIDENT_ACKNOWLEDGE,
  IPC_CHANNELS.LOCAL_AI_GUARD_DIAGNOSE,
  IPC_CHANNELS.LOCAL_AI_GUARD_REPAIR,
  IPC_CHANNELS.LOCAL_AI_GUARD_PENDING_FALLBACK_RESOLVE,
]);
