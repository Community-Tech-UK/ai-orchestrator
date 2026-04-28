import type { ChildDiagnosticBundle } from '../../shared/types/agent-tree.types';
import type { Instance } from '../../shared/types/instance.types';
import { getChildResultStorage } from './child-result-storage';

export async function buildChildDiagnosticBundle(
  child: Instance,
  timeoutReason?: string,
): Promise<ChildDiagnosticBundle> {
  const orchestration = typeof child.metadata?.['orchestration'] === 'object'
    && child.metadata['orchestration'] !== null
    ? child.metadata['orchestration'] as Record<string, unknown>
    : undefined;
  const summary = await getChildResultStorage().getChildSummary(child.id);
  return {
    childId: child.id,
    parentId: child.parentId ?? '',
    status: child.status,
    task: typeof orchestration?.['task'] === 'string' ? orchestration['task'] : undefined,
    resultId: summary?.resultId,
    routing: typeof orchestration?.['routingAudit'] === 'object'
      ? orchestration['routingAudit'] as ChildDiagnosticBundle['routing']
      : undefined,
    recentOutput: child.outputBuffer.slice(-20).map((message) => ({
      type: message.type,
      content: message.content.length > 1000
        ? `${message.content.slice(0, 1000)}...`
        : message.content,
      timestamp: message.timestamp,
    })),
    timeoutReason,
    capturedAt: Date.now(),
  };
}
