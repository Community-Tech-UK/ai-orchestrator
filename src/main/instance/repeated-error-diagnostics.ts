import type { InstanceStatus } from '../../shared/types/instance.types';
import { isCompactTurnRejection } from '../cli/adapters/codex/app-server-runtime-errors';

export function buildRepeatedErrorDiagnosticFields(input: {
  instanceId: string;
  content: string;
  count: number;
  status: InstanceStatus;
  adapter: unknown;
}): Record<string, unknown> {
  const adapter = input.adapter as { isProviderCompacting?: () => boolean } | undefined;
  return {
    instanceId: input.instanceId,
    content: input.content,
    count: input.count,
    status: input.status,
    ...(isCompactTurnRejection(input.content) ? {
      compactionState: adapter?.isProviderCompacting?.() ? 'running' : 'not-running',
    } : {}),
  };
}
