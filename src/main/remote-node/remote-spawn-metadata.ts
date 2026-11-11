import { z } from 'zod';
import { CodexUsageIdSchema } from '../../shared/validation/codex-ephemeral-usage.schemas';
import type { UnifiedSpawnOptions } from '../cli/adapters/adapter-factory.types';
import type { InstanceTelemetry } from './instance-telemetry-rpc';

/** Optional additions: older workers strip them, older controllers omit them. */
export const RemoteSpawnMetadataSchema = z.object({
  // The legacy wire instanceId identifies a provider session, not its owning chat.
  owningInstanceId: CodexUsageIdSchema.optional(),
  jobId: CodexUsageIdSchema.optional(),
  sessionKind: z.enum(['chat', 'child', 'loop', 'plan-queue', 'automation', 'review']).optional(),
  trialKey: z.string().max(4096).optional(),
  trialArm: z.enum(['cheaper', 'full', 'off', 'unassigned']).optional(),
  /** Codex helper-agent level the controller resolved from its settings; a worker has no settings store. */
  codexHelperLevel: z.enum(['off', 'economy', 'full']).optional(),
  /** Plan-queue role (`verifier` marks a checker); sent for Codex only, where the policy and required skills depend on it. */
  queueRole: z.string().max(64).optional(),
  /** Set when the controller resolved that this Codex checker runs without the skills catalog. */
  codexOmitSkillCatalog: z.literal(true).optional(),
  ephemeral: z.boolean().optional(),
  codexUsageProtocol: z.literal(1).optional(),
  /** Plan Queue session: the node builds the push guard. Only sent to workers advertising `queuePushGuard: 1`. */
  queuePushGuard: z.literal(true).optional(),
});
export type RemoteSpawnMetadata = z.infer<typeof RemoteSpawnMetadataSchema>;

export function remoteSpawnMetadata(options: UnifiedSpawnOptions, codex: boolean): RemoteSpawnMetadata {
  const parsed = RemoteSpawnMetadataSchema.safeParse({ owningInstanceId: options.instanceId, jobId: options.jobId,
    sessionKind: options.sessionKind, trialKey: options.trialKey, trialArm: options.trialArm, ephemeral: options.ephemeral,
    codexHelperLevel: options.codexHelperLevel,
    ...(codex ? { queueRole: options.queueRole, codexOmitSkillCatalog: options.codexOmitSkillCatalog } : {}),
    ...(options.queuePushGuard ? { queuePushGuard: true } : {}),
    ...(codex ? { codexUsageProtocol: 1 } : {}),
  });
  // Never include the raw grouping key, even in validation diagnostics.
  if (!parsed.success) throw new Error('Invalid remote spawn ownership metadata');
  return parsed.data;
}

/** Rebuild trusted local options; no worker paths or callbacks come from the wire. */
export function workerSpawnMetadata(params: RemoteSpawnMetadata & { cliType: string; interactionId?: string },
  isCurrent: () => boolean, emit: (telemetry: InstanceTelemetry) => void): Pick<UnifiedSpawnOptions,
    'instanceId' | 'jobId' | 'sessionKind' | 'trialKey' | 'trialArm' | 'codexHelperLevel' | 'codexOmitSkillCatalog' | 'queueRole' | 'ephemeral' | 'onCodexEphemeralUsage'> {
  const interactionId = params.interactionId;
  return { instanceId: params.owningInstanceId, jobId: params.jobId, sessionKind: params.sessionKind,
    trialKey: params.trialKey, trialArm: params.trialArm, codexHelperLevel: params.codexHelperLevel,
    codexOmitSkillCatalog: params.codexOmitSkillCatalog, queueRole: params.queueRole, ephemeral: params.ephemeral,
    ...(params.cliType === 'codex' && params.codexUsageProtocol === 1 && interactionId ? {
      onCodexEphemeralUsage: receipt => {
        // Ownership lasts through terminate(), but ends on removal/replacement.
        if (isCurrent()) emit({ event: 'codex_ephemeral_usage', payload: { interactionId, receipt } });
      },
    } : {}),
  };
}
