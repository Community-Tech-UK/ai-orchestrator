import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import type {
  LocalAiDiagnosticReport,
  LocalAiFailureCode,
  LocalAiProbeResult,
  LocalAiRepairAction,
  LocalAiRepairResult,
} from '../shared/types/local-ai-guard.types';
import {
  LocalAiHealthCheckParamsSchema,
  LocalAiHealthDiagnoseParamsSchema,
  LocalAiHealthRepairParamsSchema,
  validateRpcParams,
} from '../main/remote-node/rpc-schemas';
import { LMSTUDIO_LOCAL_BASE_URL, OLLAMA_LOCAL_BASE_URL } from './local-model-config';
import {
  affectedRolesForExpectedModels,
  evaluateLocalAiModelCapacity,
  parseLocalAiModelCapacity,
  type LocalAiModelCapacityMetadata,
} from './worker-local-ai-model-capacity';
import {
  executeFile,
  isProcessNotFoundError,
  launchDetached,
  resolveOllamaRestart,
  type ExecFilePort,
  type LaunchDetachedPort,
  type SupportedLocalAiPlatform,
} from './worker-local-ai-repair';

export const EXACT_TOKEN_CANARY = 'AIO_HEALTH_OK';
export const EXACT_TOKEN_CANARY_PROMPT =
  'Reply with exactly AIO_HEALTH_OK and no other text.';
const MAX_HTTP_RESPONSE_BYTES = 64 * 1024;
const MAX_ADVERTISED_MODELS = 512;
const MAX_EVIDENCE_MODELS = 20;

type LocalAiHealthCheckParams = ReturnType<typeof LocalAiHealthCheckParamsSchema.parse>;
type FetchPort = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface WorkerLocalAiHealthDeps {
  fetch?: FetchPort;
  now?: () => number;
  endpointResolver?: (
    provider: LocalAiHealthCheckParams['provider'],
    endpointId: string,
  ) => string | null;
  platform?: SupportedLocalAiPlatform;
  pathExists?: (candidate: string) => boolean;
  execFile?: ExecFilePort;
  launchDetached?: LaunchDetachedPort;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

class ProbeFailure extends Error {
  constructor(
    readonly failureCode: LocalAiFailureCode,
    readonly evidenceErrorKind: string,
    message: string,
  ) {
    super(message);
  }
}

export class WorkerLocalAiHealth {
  private readonly fetchPort: FetchPort;
  private readonly now: () => number;
  private readonly endpointResolver: NonNullable<WorkerLocalAiHealthDeps['endpointResolver']>;
  private readonly platform: SupportedLocalAiPlatform;
  private readonly pathExists: (candidate: string) => boolean;
  private readonly execFile: ExecFilePort;
  private readonly launchDetached: LaunchDetachedPort;
  private readonly homeDir: string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(deps: WorkerLocalAiHealthDeps = {}) {
    this.fetchPort = deps.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.now = deps.now ?? Date.now;
    this.endpointResolver = deps.endpointResolver ?? resolveWorkerLocalEndpoint;
    this.platform = deps.platform ?? normalizePlatform(process.platform);
    this.pathExists = deps.pathExists ?? existsSync;
    this.execFile = deps.execFile ?? executeFile;
    this.launchDetached = deps.launchDetached ?? launchDetached;
    this.homeDir = deps.homeDir ?? homedir();
    this.env = deps.env ?? process.env;
  }

  async check(rawParams: unknown): Promise<LocalAiProbeResult[]> {
    const params = validateRpcParams(LocalAiHealthCheckParamsSchema, rawParams);
    const checkedAt = this.now();
    const baseUrl = this.endpointResolver(params.provider, params.endpointId);
    if (!baseUrl) {
      return [this.failureSample(params, 'endpoint', checkedAt, 0, new ProbeFailure(
        'endpoint-not-advertised',
        'endpoint-not-advertised',
        'The enrolled endpoint is not available on this worker.',
      ))];
    }

    try {
      const endpointStartedAt = this.now();
      const metadata: {
        version?: string;
        models: string[];
        httpStatus: number;
      } = params.provider === 'ollama'
        ? await this.readOllamaMetadata(baseUrl, params.timeoutMs)
        : await this.readOpenAiMetadata(baseUrl, params.timeoutMs);
      const endpointDuration = elapsed(this.now(), endpointStartedAt);
      const endpointLatencyExceeded = endpointDuration > params.latencyThresholdMs;
      const endpoint: LocalAiProbeResult = {
        targetId: params.endpointId,
        layer: 'endpoint',
        checkType: params.kind,
        ok: !endpointLatencyExceeded,
        required: true,
        affectedRoles: [],
        checkedAt,
        durationMs: endpointDuration,
        ...(endpointLatencyExceeded
          ? {
              failureCode: 'latency-exceeded' as const,
              message: 'Endpoint metadata exceeded the configured latency threshold.',
            }
          : {}),
        evidence: {
          endpointReachable: true,
          endpointProtocol: params.provider === 'ollama' ? 'ollama-api' : 'openai-v1',
          ...(metadata.version ? { endpointVersion: metadata.version } : {}),
          httpStatus: metadata.httpStatus,
        },
      };

      const advertisedModels = metadata.models;
      const advertisedSet = new Set(advertisedModels);
      const missing = params.expectedModels
        .filter((expected) => !advertisedSet.has(expected.modelId));
      const missingIds = missing.map((expected) => expected.modelId);
      const canaryMissing = !advertisedSet.has(params.canary.model);
      const canary = params.kind === 'functional' && !canaryMissing
        ? await this.runCanary(params, baseUrl, checkedAt)
        : undefined;
      const capacity = params.expectedModels.some((expected) =>
        expected.minContextLength !== undefined)
        ? await this.readModelCapacity(
            params.provider,
            baseUrl,
            params.timeoutMs,
            new Set(params.expectedModels
              .filter((expected) => expected.minContextLength !== undefined)
              .map((expected) => expected.modelId)),
          )
        : { loadedModels: [], contextLengths: new Map<string, number>() };
      const context = evaluateLocalAiModelCapacity(
        params.expectedModels,
        capacity,
        params.canary.model,
      );
      const insufficientIds = context.insufficientModels.map((expected) => expected.modelId);
      const requiredMissing = missing.some((expected) => expected.required) || canaryMissing;
      const requiredFailure = requiredMissing || context.required;
      const affectedRoles = affectedRolesForExpectedModels([
        ...missing,
        ...context.insufficientModels,
      ]);
      const model: LocalAiProbeResult = {
        targetId: params.endpointId,
        layer: 'model',
        checkType: params.kind,
        ok: missing.length === 0 && context.insufficientModels.length === 0,
        required: requiredFailure,
        affectedRoles,
        checkedAt,
        durationMs: endpointDuration,
        ...(missing.length > 0 || context.insufficientModels.length > 0
          ? {
              failureCode: missing.length > 0
                ? 'missing-required-model' as const
                : 'insufficient-context' as const,
              message: missing.length > 0
                ? requiredMissing
                  ? 'One or more required local models are unavailable.'
                  : 'One or more optional local models are unavailable.'
                : context.required
                  ? 'One or more required local models have insufficient context capacity.'
                  : 'One or more optional local models have insufficient context capacity.',
            }
          : {}),
        evidence: {
          advertisedModels: advertisedModels.slice(0, MAX_EVIDENCE_MODELS),
          ...(capacity.loadedModels.length > 0
            ? { loadedModels: capacity.loadedModels.slice(0, MAX_EVIDENCE_MODELS) }
            : {}),
          missingModels: missingIds.slice(0, MAX_EVIDENCE_MODELS),
          ...(insufficientIds.length > 0
            ? { insufficientContextModels: insufficientIds.slice(0, MAX_EVIDENCE_MODELS) }
            : {}),
          requiredModelCount: params.expectedModels.filter((expected) => expected.required).length,
          ...(context.availableContextLength === undefined
            ? {} : { availableContextLength: context.availableContextLength }),
        },
      };

      const samples = [endpoint, model];
      if (canary) samples.push(canary);
      return samples;
    } catch (error) {
      const failure = normalizeProbeFailure(error, 'endpoint-timeout');
      return [this.failureSample(
        params,
        'endpoint',
        checkedAt,
        elapsed(this.now(), checkedAt),
        failure,
      )];
    }
  }

  async diagnose(rawParams: unknown): Promise<LocalAiDiagnosticReport> {
    const params = validateRpcParams(LocalAiHealthDiagnoseParamsSchema, rawParams);
    const samples = await this.check({ ...params, kind: 'functional' });
    return {
      targetId: params.endpointId,
      checkedAt: this.now(),
      samples,
      recommendedActions: recommendedActionsFor(params.provider, samples),
    };
  }

  async repair(rawParams: unknown): Promise<LocalAiRepairResult> {
    const params = validateRpcParams(LocalAiHealthRepairParamsSchema, rawParams);
    const completedAt = this.now();
    if (params.action !== 'restart-ollama' || params.provider !== 'ollama') {
      return {
        targetId: params.endpointId,
        action: params.action,
        outcome: 'unsupported',
        supported: false,
        attempted: false,
        recovered: false,
        message: 'This named action is handled by the coordinator.',
        completedAt,
      };
    }

    const operation = resolveOllamaRestart({
      platform: this.platform,
      pathExists: this.pathExists,
      homeDir: this.homeDir,
      env: this.env,
    });
    if (!operation) {
      return {
        targetId: params.endpointId,
        action: params.action,
        outcome: 'unsupported',
        supported: false,
        attempted: false,
        recovered: false,
        message: 'A supported Ollama installation could not be resolved.',
        completedAt,
      };
    }

    try {
      for (const command of operation) {
        if (command.detached) {
          await this.launchDetached(command.executable, command.args);
          continue;
        }
        try {
          await this.execFile(command.executable, command.args);
        } catch (error) {
          if (!command.allowProcessNotFound || !isProcessNotFoundError(error)) {
            throw error;
          }
        }
      }
      return {
        targetId: params.endpointId,
        action: params.action,
        outcome: 'completed-not-recovered',
        supported: true,
        attempted: true,
        recovered: false,
        message: 'The fixed Ollama restart operation completed.',
        completedAt: this.now(),
      };
    } catch {
      return {
        targetId: params.endpointId,
        action: params.action,
        outcome: 'execution-failed',
        supported: true,
        attempted: true,
        recovered: false,
        message: 'The fixed Ollama restart operation failed.',
        completedAt: this.now(),
      };
    }
  }

  private async readOllamaMetadata(
    baseUrl: string,
    timeoutMs: number,
  ): Promise<{ version: string; models: string[]; httpStatus: number }> {
    const versionResponse = await this.requestJson(
      `${baseUrl}/api/version`,
      { method: 'GET' },
      timeoutMs,
      'endpoint-timeout',
    );
    const version = readBoundedString(
      (versionResponse.data as { version?: unknown } | null)?.version,
      'Ollama version response was malformed.',
    );
    const tagsResponse = await this.requestJson(
      `${baseUrl}/api/tags`,
      { method: 'GET' },
      timeoutMs,
      'endpoint-timeout',
    );
    const rows = (tagsResponse.data as { models?: unknown } | null)?.models;
    if (!Array.isArray(rows) || rows.length > MAX_ADVERTISED_MODELS) {
      throw new ProbeFailure('protocol-error', 'invalid-model-catalog', 'Model catalog was malformed.');
    }
    const models = rows.map((row) =>
      readBoundedString((row as { name?: unknown } | null)?.name, 'Model catalog was malformed.'));
    return { version, models, httpStatus: tagsResponse.status };
  }

  private async readOpenAiMetadata(
    baseUrl: string,
    timeoutMs: number,
  ): Promise<{ models: string[]; httpStatus: number }> {
    const response = await this.requestJson(
      `${baseUrl}/v1/models`,
      { method: 'GET' },
      timeoutMs,
      'endpoint-timeout',
    );
    const rows = (response.data as { data?: unknown } | null)?.data;
    if (!Array.isArray(rows) || rows.length > MAX_ADVERTISED_MODELS) {
      throw new ProbeFailure('protocol-error', 'invalid-model-catalog', 'Model catalog was malformed.');
    }
    const models = rows.map((row) =>
      readBoundedString((row as { id?: unknown } | null)?.id, 'Model catalog was malformed.'));
    return { models, httpStatus: response.status };
  }

  private async readModelCapacity(
    provider: LocalAiHealthCheckParams['provider'],
    baseUrl: string,
    timeoutMs: number,
    relevantModelIds: ReadonlySet<string>,
  ): Promise<LocalAiModelCapacityMetadata> {
    try {
      const response = await this.requestJson(
        provider === 'ollama' ? `${baseUrl}/api/ps` : `${baseUrl}/api/v0/models`,
        { method: 'GET' },
        timeoutMs,
        'endpoint-timeout',
      );
      return parseLocalAiModelCapacity(provider, response.data, relevantModelIds);
    } catch (error) {
      if (
        error instanceof ProbeFailure
        && ['http-404', 'http-405'].includes(error.evidenceErrorKind)
      ) {
        return { loadedModels: [], contextLengths: new Map<string, number>() };
      }
      throw error;
    }
  }

  private async runCanary(
    params: LocalAiHealthCheckParams,
    baseUrl: string,
    checkedAt: number,
  ): Promise<LocalAiProbeResult> {
    const startedAt = this.now();
    try {
      const response = params.provider === 'ollama'
        ? await this.requestJson(
            `${baseUrl}/api/generate`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: params.canary.model,
                prompt: EXACT_TOKEN_CANARY_PROMPT,
                stream: false,
                options: {
                  temperature: 0,
                  num_predict: 8,
                },
              }),
            },
            params.timeoutMs,
            'inference-timeout',
          )
        : await this.requestJson(
            `${baseUrl}/v1/chat/completions`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                model: params.canary.model,
                messages: [{ role: 'user', content: EXACT_TOKEN_CANARY_PROMPT }],
                temperature: 0,
                max_tokens: 8,
                stream: false,
              }),
            },
            params.timeoutMs,
            'inference-timeout',
          );
      const output = params.provider === 'ollama'
        ? (response.data as { response?: unknown } | null)?.response
        : (response.data as {
            choices?: { message?: { content?: unknown } }[];
          } | null)?.choices?.[0]?.message?.content;
      const outputValid = typeof output === 'string' && output.trim() === EXACT_TOKEN_CANARY;
      const durationMs = elapsed(this.now(), startedAt);
      const latencyExceeded = durationMs > params.latencyThresholdMs;
      return {
        targetId: params.endpointId,
        layer: 'inference',
        checkType: params.kind,
        ok: outputValid && !latencyExceeded,
        required: true,
        affectedRoles: [],
        checkedAt,
        durationMs,
        ...(!outputValid
          ? {
              failureCode: 'malformed-inference-output' as const,
              message: 'The canary response did not match the exact-token contract.',
            }
          : latencyExceeded
            ? {
                failureCode: 'latency-exceeded' as const,
                message: 'The canary exceeded the configured latency threshold.',
              }
            : {}),
        evidence: {
          canaryOutputValid: outputValid,
          canaryLatencyMs: durationMs,
        },
      };
    } catch (error) {
      return this.failureSample(
        params,
        'inference',
        checkedAt,
        elapsed(this.now(), startedAt),
        normalizeProbeFailure(error, 'inference-timeout'),
      );
    }
  }

  private async requestJson(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    timeoutCode: 'endpoint-timeout' | 'inference-timeout',
  ): Promise<{ data: unknown; status: number }> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetchPort(url, { ...init, signal: controller.signal });
      if (response.status === 401 || response.status === 403) {
        throw new ProbeFailure(
          'authentication-error',
          'authentication-error',
          'The local endpoint rejected authentication.',
        );
      }
      if (!response.ok) {
        throw new ProbeFailure(
          'protocol-error',
          `http-${response.status}`,
          'The local endpoint returned an unsuccessful status.',
        );
      }
      const body = await readBoundedResponseBody(response);
      try {
        return { data: JSON.parse(body) as unknown, status: response.status };
      } catch {
        throw new ProbeFailure(
          'protocol-error',
          'malformed-json',
          'The local endpoint returned malformed JSON.',
        );
      }
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw new ProbeFailure(
          timeoutCode,
          timeoutCode,
          timeoutCode === 'endpoint-timeout'
            ? 'The local endpoint metadata request timed out.'
            : 'The local inference canary timed out.',
        );
      }
      if (error instanceof ProbeFailure) {
        throw error;
      }
      throw new ProbeFailure(
        'connection-refused',
        'connection-refused',
        'The local endpoint connection was refused.',
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private failureSample(
    params: LocalAiHealthCheckParams,
    layer: 'endpoint' | 'inference',
    checkedAt: number,
    durationMs: number,
    failure: ProbeFailure,
  ): LocalAiProbeResult {
    return {
      targetId: params.endpointId,
      layer,
      checkType: params.kind,
      ok: false,
      required: true,
      affectedRoles: [],
      checkedAt,
      durationMs,
      failureCode: failure.failureCode,
      message: failure.message,
      evidence: {
        ...(layer === 'endpoint' ? { endpointReachable: false } : { canaryOutputValid: false }),
        errorKind: failure.evidenceErrorKind,
      },
    };
  }

}

function resolveWorkerLocalEndpoint(
  provider: LocalAiHealthCheckParams['provider'],
  endpointId: string,
): string | null {
  if (provider === 'ollama' && endpointId === 'ollama') {
    return OLLAMA_LOCAL_BASE_URL;
  }
  if (provider === 'openai-compatible' && endpointId === 'openai-compatible') {
    return LMSTUDIO_LOCAL_BASE_URL;
  }
  return null;
}

function normalizePlatform(platform: NodeJS.Platform): SupportedLocalAiPlatform {
  return platform === 'darwin' || platform === 'win32' ? platform : 'linux';
}

function elapsed(now: number, startedAt: number): number {
  return Math.max(0, Math.round(now - startedAt));
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function normalizeProbeFailure(
  error: unknown,
  timeoutCode: 'endpoint-timeout' | 'inference-timeout',
): ProbeFailure {
  if (error instanceof ProbeFailure) {
    return error;
  }
  if (isAbortError(error)) {
    return new ProbeFailure(timeoutCode, timeoutCode, 'The local endpoint request timed out.');
  }
  return new ProbeFailure(
    'monitor-error',
    'monitor-error',
    'The local endpoint check failed unexpectedly.',
  );
}

function readBoundedString(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256) {
    throw new ProbeFailure('protocol-error', 'malformed-response', message);
  }
  return value;
}

async function readBoundedResponseBody(response: Response): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (
    contentLength
    && /^\d+$/.test(contentLength)
    && Number(contentLength) > MAX_HTTP_RESPONSE_BYTES
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw responseTooLargeFailure();
  }
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return text + decoder.decode();
      }
      byteLength += chunk.value.byteLength;
      if (byteLength > MAX_HTTP_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw responseTooLargeFailure();
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
}

function responseTooLargeFailure(): ProbeFailure {
  return new ProbeFailure(
    'protocol-error',
    'response-too-large',
    'The local endpoint response exceeded its byte limit.',
  );
}

function recommendedActionsFor(
  provider: LocalAiHealthCheckParams['provider'],
  samples: LocalAiProbeResult[],
): LocalAiRepairAction[] {
  const actions: LocalAiRepairAction[] = ['deep-check'];
  if (samples.some((sample) =>
    ['missing-required-model', 'insufficient-context'].includes(sample.failureCode ?? ''))) {
    actions.push('validate-models');
  }
  if (provider === 'ollama' && samples.some((sample) =>
    ['connection-refused', 'endpoint-timeout', 'protocol-error'].includes(sample.failureCode ?? ''))) {
    actions.push('restart-ollama');
  }
  return [...new Set(actions)];
}
