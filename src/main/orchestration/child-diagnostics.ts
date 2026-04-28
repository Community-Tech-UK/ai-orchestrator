import { createHash } from 'crypto';
import type { ChildDiagnosticBundle } from '../../shared/types/agent-tree.types';
import type { Instance } from '../../shared/types/instance.types';
import { getChildResultStorage } from './child-result-storage';

const MAX_TASK_SUMMARY = 500;
const MAX_OUTPUT_CONTENT = 1000;
const MAX_EVENT_SUMMARY = 300;

export async function buildChildDiagnosticBundle(
  child: Instance,
  timeoutReason?: string,
): Promise<ChildDiagnosticBundle> {
  const orchestration = typeof child.metadata?.['orchestration'] === 'object'
    && child.metadata['orchestration'] !== null
    ? child.metadata['orchestration'] as Record<string, unknown>
    : undefined;
  const task = typeof orchestration?.['task'] === 'string' ? orchestration['task'] : undefined;
  const statusTimeline = parseStatusTimeline(orchestration?.['statusTimeline'])
    ?? [{
      status: child.status,
      timestamp: child.lastActivity ?? child.createdAt,
    }];
  const summary = await getChildResultStorage().getChildSummary(child.id).catch(() => null);
  const recentOutputTail = child.outputBuffer.slice(-20).map((message) => ({
    type: message.type,
    content: truncate(message.content, MAX_OUTPUT_CONTENT),
    timestamp: message.timestamp,
  }));

  return {
    childId: child.id,
    parentId: child.parentId ?? '',
    parentInstanceId: child.parentId ?? '',
    childInstanceId: child.id,
    status: child.status,
    provider: child.provider,
    model: child.currentModel,
    workingDirectory: child.workingDirectory,
    task,
    spawnTaskSummary: task ? truncate(task, MAX_TASK_SUMMARY) : undefined,
    spawnPromptHash: task ? createHash('sha256').update(task).digest('hex') : undefined,
    resultId: summary?.resultId,
    routing: typeof orchestration?.['routingAudit'] === 'object'
      ? orchestration['routingAudit'] as ChildDiagnosticBundle['routing']
      : undefined,
    statusTimeline,
    lastHeartbeatAt: child.lastActivity,
    recentEvents: child.outputBuffer.slice(-20).map((message) => {
      const metadata = typeof message.metadata === 'object' && message.metadata !== null
        ? message.metadata as Record<string, unknown>
        : undefined;
      const eventType = typeof metadata?.['kind'] === 'string'
        ? metadata['kind']
        : typeof metadata?.['category'] === 'string'
          ? metadata['category']
          : message.type;
      return {
        type: eventType,
        summary: truncate(message.content, MAX_EVENT_SUMMARY),
        timestamp: message.timestamp,
        metadata: metadata ? pickDiagnosticMetadata(metadata) : undefined,
      };
    }),
    recentOutput: recentOutputTail,
    recentOutputTail,
    artifactsSummary: {
      resultId: summary?.resultId,
      success: summary?.success,
      artifactCount: summary?.artifactCount ?? 0,
      artifactTypes: summary?.artifactTypes ?? [],
      hasMoreDetails: summary?.hasMoreDetails ?? false,
    },
    timeoutReason,
    capturedAt: Date.now(),
  };
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function parseStatusTimeline(value: unknown): ChildDiagnosticBundle['statusTimeline'] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const timeline = value.filter((entry): entry is { status: string; timestamp: number } => (
    typeof entry === 'object'
    && entry !== null
    && typeof (entry as Record<string, unknown>)['status'] === 'string'
    && typeof (entry as Record<string, unknown>)['timestamp'] === 'number'
  ));
  return timeline.length > 0 ? timeline : undefined;
}

function pickDiagnosticMetadata(metadata: Record<string, unknown>): Record<string, unknown> | undefined {
  const keys = [
    'toolName',
    'toolId',
    'category',
    'level',
    'fatal',
    'diagnostic',
    'provider',
    'model',
  ];
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (metadata[key] !== undefined) {
      picked[key] = metadata[key];
    }
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}
