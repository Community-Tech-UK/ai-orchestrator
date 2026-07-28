import type {
  LocalAiDiagnosticReport,
  LocalAiFailureCode,
  LocalAiProbeResult,
  LocalAiRepairAction,
  LocalAiRepairResult,
  LocalAiTarget,
} from '../../shared/types/local-ai-guard.types';
import { localAiWorkerEndpointId } from '../../shared/types/local-ai-guard.types';
import {
  LocalAiHealthCheckResultSchema,
  LocalAiHealthDiagnoseResultSchema,
  LocalAiHealthRepairResultSchema,
  LOCAL_AI_HEALTH_MAX_LATENCY_THRESHOLD_MS,
  LOCAL_AI_HEALTH_MAX_TIMEOUT_MS,
} from '../remote-node/rpc-schemas';
import {
  BoundedServiceRpcResponseError,
  parseBoundedServiceRpcResponse,
} from '../remote-node/worker-node-connection-helpers';
import { sendServiceRpc } from '../remote-node/service-rpc-client';
import { COORDINATOR_TO_NODE } from '../remote-node/worker-node-rpc';
import { WorkerLocalAiHealth } from '../../worker-agent/worker-local-ai-health';

type SendServiceRpc = (
  nodeId: string,
  method: string,
  params?: unknown,
  timeoutMs?: number,
) => Promise<unknown>;

interface LocalAiProbeServiceDeps {
  fetch?: typeof globalThis.fetch;
  sendServiceRpc?: SendServiceRpc;
  now?: () => number;
}

const LOCAL_AI_HEALTH_RPC_TRANSPORT_MARGIN_MS = 1_000;
const LOCAL_AI_REPAIR_RPC_TIMEOUT_MS = 65_000;

export class LocalAiProbeService {
  private readonly fetchPort: typeof globalThis.fetch;
  private readonly sendServiceRpcPort: SendServiceRpc;
  private readonly now: () => number;

  constructor(deps: LocalAiProbeServiceDeps = {}) {
    this.fetchPort = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.sendServiceRpcPort = deps.sendServiceRpc ?? sendServiceRpc;
    this.now = deps.now ?? Date.now;
  }

  async check(
    target: LocalAiTarget,
    kind: 'lightweight' | 'functional',
  ): Promise<LocalAiProbeResult[]> {
    return target.location.type === 'worker'
      ? this.checkWorker(target, target.location.nodeId, kind)
      : this.checkCoordinator(target, kind);
  }

  async diagnose(target: LocalAiTarget): Promise<LocalAiDiagnosticReport> {
    if (target.location.type !== 'worker') {
      const samples = await this.checkCoordinator(target, 'functional');
      return {
        targetId: target.id,
        checkedAt: this.now(),
        samples,
        recommendedActions: recommendedActionsFor(target.provider, samples),
      };
    }

    const params = this.healthParams(target);
    const startedAt = this.now();
    try {
      const raw = await this.sendServiceRpcPort(
        target.location.nodeId,
        COORDINATOR_TO_NODE.LOCAL_AI_HEALTH_DIAGNOSE,
        params,
        healthRpcBudget(target.provider, 'functional', params.timeoutMs),
      );
      const report = parseBoundedServiceRpcResponse(
        LocalAiHealthDiagnoseResultSchema,
        raw,
      );
      const samples = [
        this.workerSuccess(target, 'functional', elapsed(this.now(), startedAt)),
        ...this.mapWorkerSamples(target, 'functional', report.samples),
      ];
      return {
        targetId: target.id,
        checkedAt: report.checkedAt,
        samples,
        recommendedActions: report.recommendedActions,
      };
    } catch (error) {
      const sample = this.workerFailure(target, 'functional', startedAt, error);
      return {
        targetId: target.id,
        checkedAt: this.now(),
        samples: [sample],
        recommendedActions: recommendedActionsFor(target.provider, [sample]),
      };
    }
  }

  async repair(
    target: LocalAiTarget,
    action: LocalAiRepairAction,
  ): Promise<LocalAiRepairResult> {
    if (action === 'recheck-layer' || action === 'deep-check' || action === 'validate-models') {
      const samples = await this.check(
        target,
        action === 'deep-check' ? 'functional' : 'lightweight',
      );
      const relevant = action === 'validate-models'
        ? samples.filter((sample) => sample.layer === 'model')
        : samples;
      return {
        targetId: target.id,
        action,
        outcome: relevant.length > 0 && relevant.every((sample) => sample.ok || !sample.required)
          ? 'recovered'
          : 'completed-not-recovered',
        supported: true,
        attempted: true,
        recovered: relevant.length > 0 && relevant.every((sample) => sample.ok || !sample.required),
        message: 'The named Local AI health check completed.',
        completedAt: this.now(),
      };
    }

    if (action === 'reconnect-worker') {
      return {
        targetId: target.id,
        action,
        outcome: 'unsupported',
        supported: false,
        attempted: false,
        recovered: false,
        message: 'Worker reconnection is handled by the remote worker repair service.',
        completedAt: this.now(),
      };
    }

    if (target.location.type === 'coordinator') {
      const health = this.coordinatorHealth(target);
      const result = await health.repair({
        provider: target.provider,
        endpointId: localAiWorkerEndpointId(target.provider),
        action,
      });
      return { ...result, targetId: target.id };
    }

    try {
      const raw = await this.sendServiceRpcPort(
        target.location.nodeId,
        COORDINATOR_TO_NODE.LOCAL_AI_HEALTH_REPAIR,
        {
          provider: target.provider,
          endpointId: localAiWorkerEndpointId(target.provider),
          action,
        },
        LOCAL_AI_REPAIR_RPC_TIMEOUT_MS,
      );
      const result = parseBoundedServiceRpcResponse(LocalAiHealthRepairResultSchema, raw);
      return { ...result, targetId: target.id };
    } catch {
      return {
        targetId: target.id,
        action,
        outcome: 'execution-failed',
        supported: true,
        attempted: true,
        recovered: false,
        message: 'The bounded worker repair request could not be completed.',
        completedAt: this.now(),
      };
    }
  }

  private async checkCoordinator(
    target: LocalAiTarget,
    kind: 'lightweight' | 'functional',
  ): Promise<LocalAiProbeResult[]> {
    const startedAt = this.now();
    const samples = await this.coordinatorHealth(target).check({
      ...this.healthParams(target),
      kind,
    });
    return [
      {
        targetId: target.id,
        layer: 'worker',
        checkType: kind,
        ok: true,
        required: true,
        affectedRoles: target.routingRoles,
        checkedAt: startedAt,
        durationMs: 0,
        evidence: {
          workerConnected: true,
          rpcReachable: true,
        },
      },
      ...this.mapWorkerSamples(target, kind, samples),
    ];
  }

  private async checkWorker(
    target: LocalAiTarget,
    nodeId: string,
    kind: 'lightweight' | 'functional',
  ): Promise<LocalAiProbeResult[]> {
    const params = { ...this.healthParams(target), kind };
    const startedAt = this.now();
    try {
      const raw = await this.sendServiceRpcPort(
        nodeId,
        COORDINATOR_TO_NODE.LOCAL_AI_HEALTH_CHECK,
        params,
        healthRpcBudget(target.provider, kind, params.timeoutMs),
      );
      const samples = parseBoundedServiceRpcResponse(LocalAiHealthCheckResultSchema, raw);
      return [
        this.workerSuccess(target, kind, elapsed(this.now(), startedAt)),
        ...this.mapWorkerSamples(target, kind, samples),
      ];
    } catch (error) {
      return [this.workerFailure(target, kind, startedAt, error)];
    }
  }

  private healthParams(target: LocalAiTarget) {
    return {
      provider: target.provider,
      endpointId: localAiWorkerEndpointId(target.provider),
      expectedModels: target.expectedModels,
      canary: {
        contract: 'exact-token-v1' as const,
        model: target.canary.model,
      },
      latencyThresholdMs: Math.min(
        Math.max(1, target.warningLatencyMs),
        LOCAL_AI_HEALTH_MAX_LATENCY_THRESHOLD_MS,
      ),
      timeoutMs: boundedTimeout(target.canary.timeoutMs),
    };
  }

  private coordinatorHealth(target: LocalAiTarget): WorkerLocalAiHealth {
    return new WorkerLocalAiHealth({
      fetch: this.fetchPort,
      now: this.now,
      endpointResolver: () => target.baseUrl,
    });
  }

  private mapWorkerSamples(
    target: LocalAiTarget,
    kind: 'lightweight' | 'functional',
    samples: LocalAiProbeResult[],
  ): LocalAiProbeResult[] {
    if (samples.some((sample) => sample.checkType !== kind)) {
      throw new BoundedServiceRpcResponseError();
    }
    return samples.map((sample) => ({
      ...sample,
      targetId: target.id,
      affectedRoles: [...target.routingRoles],
    }));
  }

  private workerSuccess(
    target: LocalAiTarget,
    kind: 'lightweight' | 'functional',
    durationMs: number,
  ): LocalAiProbeResult {
    return {
      targetId: target.id,
      layer: 'worker',
      checkType: kind,
      ok: true,
      required: true,
      affectedRoles: target.routingRoles,
      checkedAt: this.now(),
      durationMs,
      evidence: {
        workerConnected: true,
        rpcReachable: true,
        workerLatencyMs: durationMs,
      },
    };
  }

  private workerFailure(
    target: LocalAiTarget,
    kind: 'lightweight' | 'functional',
    startedAt: number,
    error: unknown,
  ): LocalAiProbeResult {
    const classification = classifyWorkerRpcFailure(error);
    return {
      targetId: target.id,
      layer: 'worker',
      checkType: kind,
      ok: false,
      required: true,
      affectedRoles: target.routingRoles,
      checkedAt: this.now(),
      durationMs: elapsed(this.now(), startedAt),
      failureCode: classification.failureCode,
      message: classification.message,
      evidence: {
        workerConnected: classification.workerConnected,
        rpcReachable: false,
        errorKind: classification.errorKind,
      },
    };
  }
}

function classifyWorkerRpcFailure(error: unknown): {
  failureCode: LocalAiFailureCode;
  workerConnected: boolean;
  errorKind: string;
  message: string;
} {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (
    message.includes('node not connected')
    || message.includes('disconnected')
    || message.includes('connection closed')
  ) {
    return {
      failureCode: 'worker-offline',
      workerConnected: false,
      errorKind: 'worker-disconnected',
      message: 'The worker is offline.',
    };
  }
  if (message.includes('timeout')) {
    return {
      failureCode: 'rpc-unavailable',
      workerConnected: true,
      errorKind: 'rpc-timeout',
      message: 'The worker health RPC timed out.',
    };
  }
  if (message.includes('rpc error -32000') || message.includes('unauthorized')) {
    return {
      failureCode: 'authentication-error',
      workerConnected: true,
      errorKind: 'rpc-authentication',
      message: 'The worker rejected the authenticated health RPC.',
    };
  }
  return {
    failureCode: 'protocol-error',
    workerConnected: true,
    errorKind: error instanceof BoundedServiceRpcResponseError
      ? 'invalid-rpc-response'
      : 'rpc-error',
    message: 'The worker returned an invalid or oversized health response.',
  };
}

function boundedTimeout(timeoutMs: number): number {
  return Math.min(Math.max(1, timeoutMs), LOCAL_AI_HEALTH_MAX_TIMEOUT_MS);
}

/**
 * Worker probes perform a bounded sequence of HTTP calls, each with the
 * target-specific per-request timeout. Keep the transport deadline larger than
 * that complete sequence so the worker's precise endpoint/inference result wins
 * the race, while retaining a finite worst-case bound.
 */
function healthRpcBudget(
  provider: LocalAiTarget['provider'],
  kind: 'lightweight' | 'functional',
  perRequestTimeoutMs: number,
): number {
  const metadataRequests = provider === 'ollama' ? 2 : 1;
  const requestCount = metadataRequests + (kind === 'functional' ? 1 : 0);
  return requestCount * perRequestTimeoutMs + LOCAL_AI_HEALTH_RPC_TRANSPORT_MARGIN_MS;
}

function elapsed(now: number, startedAt: number): number {
  return Math.max(0, Math.round(now - startedAt));
}

function recommendedActionsFor(
  provider: LocalAiTarget['provider'],
  samples: LocalAiProbeResult[],
): LocalAiRepairAction[] {
  const actions: LocalAiRepairAction[] = ['deep-check'];
  if (samples.some((sample) => sample.failureCode === 'missing-required-model')) {
    actions.push('validate-models');
  }
  if (samples.some((sample) => sample.failureCode === 'worker-offline')) {
    actions.push('reconnect-worker');
  }
  if (provider === 'ollama' && samples.some((sample) =>
    ['connection-refused', 'endpoint-timeout', 'protocol-error'].includes(sample.failureCode ?? ''))) {
    actions.push('restart-ollama');
  }
  return [...new Set(actions)];
}
