import { randomUUID } from 'node:crypto';
import {
  AUXILIARY_DISCOVERY_MAX_CANDIDATES,
  AUXILIARY_DISCOVERY_MAX_MODELS,
  type AuxiliaryLlmCandidate,
} from '../../shared/types/auxiliary-llm.types';
import type {
  LocalAiDiscoveredEndpoint,
  LocalAiEndpointIdentity,
  LocalAiProbeResult,
  LocalAiTarget,
  LocalAiTargetConfig,
} from '../../shared/types/local-ai-guard.types';
import {
  LocalAiDiscoveredEndpointSchema,
  LocalAiDiscoveredEndpointsSchema,
  LocalAiProbeResultsSchema,
  LocalAiTargetConfigSchema,
  LocalAiTargetSchema,
} from '../../shared/validation/local-ai-guard.schemas';
import type { LocalAiGuardRuntime } from './local-ai-runtime';

type PublicRuntime = Pick<LocalAiGuardRuntime, 'targets' | 'probes'>;

export interface LocalAiPublicOperationsDependencies {
  getRuntime: () => PublicRuntime;
  discoverCandidates: () => Promise<AuxiliaryLlmCandidate[]>;
  now?: () => number;
  createId?: () => string;
}

export interface LocalAiPublicOperations {
  list(): Promise<LocalAiTarget[]>;
  discover(): Promise<LocalAiDiscoveredEndpoint[]>;
  validate(config: LocalAiTargetConfig): Promise<LocalAiProbeResult[]>;
  create(config: LocalAiTargetConfig): Promise<LocalAiTarget>;
}

export function createLocalAiPublicOperations(
  dependencies: LocalAiPublicOperationsDependencies,
): LocalAiPublicOperations {
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? randomUUID;
  return {
    list: async () => {
      const runtime = dependencies.getRuntime();
      return LocalAiTargetSchema.array().max(1_000).parse(
        runtime.targets.list({ includeRetired: false }),
      );
    },
    discover: async () => {
      const runtime = dependencies.getRuntime();
      return sanitizeCandidates(
        await dependencies.discoverCandidates(),
        (identity) => runtime.targets.findByEndpoint(identity)?.id,
      );
    },
    validate: async (input) => {
      const config = LocalAiTargetConfigSchema.parse(input);
      const checkedAt = safeTimestamp(now());
      const target = LocalAiTargetSchema.parse({
        ...config,
        id: createId(),
        label: 'Validation target',
        createdAt: checkedAt,
        updatedAt: checkedAt,
      });
      const samples = await dependencies.getRuntime().probes.check(target, 'functional');
      return LocalAiProbeResultsSchema.parse(sanitizeProbeResults(samples));
    },
    create: async (input) => {
      const config = LocalAiTargetConfigSchema.parse(input);
      return LocalAiTargetSchema.parse(dependencies.getRuntime().targets.create(config));
    },
  };
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
