import type { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type { UnifiedSpawnOptions } from './adapter-factory.types';
import { InstanceTelemetryParamsSchema, type RemoteInstanceTelemetry } from '../../remote-node/instance-telemetry-rpc';
import { appendCodexEphemeralUsage, readCodexEphemeralUsage } from '../../core/system/codex-ephemeral-usage-store';
import { getLogger } from '../../logging/logger';

const logger = getLogger('RemoteCodexUsage');

/** The authenticated router supplies nodeId. Match the exact spawn incarnation and semantic owner. */
export function observeRemoteCodexUsage(registry: EventEmitter, nodeId: string, instanceId: string,
  interactionId: string, options: UnifiedSpawnOptions): () => void {
  const trialKey = options.trialKey ? createHash('sha256').update(options.trialKey).digest('hex') : null;
  // A worker has no settings store, so without an explicit arm its thread policy records `unassigned`.
  const trialArm = options.trialArm ?? 'unassigned';
  const { instanceId: owningInstanceId, jobId, sessionKind } = options;
  const receive = (event: RemoteInstanceTelemetry): void => {
    if (event.nodeId !== nodeId || event.instanceId !== instanceId || event.telemetry.event !== 'codex_ephemeral_usage') return;
    const parsed = InstanceTelemetryParamsSchema.safeParse({ instanceId: event.instanceId, telemetry: event.telemetry });
    if (!parsed.success || parsed.data.telemetry.event !== 'codex_ephemeral_usage') return;
    const payload = parsed.data.telemetry.payload;
    const row = payload.receipt;
    if (payload.interactionId !== interactionId || row.instanceId !== (owningInstanceId ?? null)
      || row.jobId !== (jobId ?? null) || row.kind !== (sessionKind ?? 'chat')
      || row.trialKey !== trialKey || row.trialArm !== trialArm) return;
    try {
      // Deduplicate against the bounded Costs history as well as transport replay.
      if (readCodexEphemeralUsage(undefined, 1000).entries.some(entry => entry.threadId === row.threadId)) return;
      appendCodexEphemeralUsage(row);
    } catch { logger.warn('Could not save remote temporary Codex usage'); }
  };
  registry.on('remote:instance-telemetry', receive);
  return () => registry.off('remote:instance-telemetry', receive);
}
