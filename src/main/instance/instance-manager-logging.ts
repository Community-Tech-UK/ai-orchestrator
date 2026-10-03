import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import { getLogger } from '../logging/logger';
import { errorDiagnostic, textDiagnostic } from '../logging/source-diagnostics';
import { getResourceGovernor } from '../process/resource-governor';

const logger = getLogger('InstanceManager');
const LOG_PREVIEW_LENGTH = 160;

export function summarizeLogText(
  value: string | undefined,
  maxLength = LOG_PREVIEW_LENGTH,
): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}... (${normalized.length} chars)`;
}

export function sanitizeCreateConfig(config: InstanceCreateConfig): Partial<InstanceCreateConfig> {
  const {
    attachments,
    initialOutputBuffer,
    initialPrompt,
    modelRuntimeTarget,
    sessionId,
    historyThreadId,
    metadata,
    ...rest
  } = config;
  const isCrashRecovery = metadata?.['reason'] === 'crash-recovery';
  return {
    ...rest,
    sessionId: isCrashRecovery && sessionId ? '[recovery session omitted]' : sessionId,
    historyThreadId: isCrashRecovery && historyThreadId
      ? '[recovery history identity omitted]'
      : historyThreadId,
    metadata: isCrashRecovery
      ? {
          reason: 'crash-recovery',
          continuityRevival: metadata?.['continuityRevival'] === true,
        }
      : metadata,
    modelRuntimeTarget: sanitizeModelRuntimeTarget(modelRuntimeTarget),
    initialPrompt: initialPrompt ? summarizeLogText(initialPrompt, 240) : undefined,
    attachments: attachments?.map((attachment) => ({
      name: attachment.name,
      type: attachment.type,
      size: attachment.size,
      data: `[${attachment.size} bytes omitted]`,
    })),
    initialOutputBuffer: initialOutputBuffer
      ? isCrashRecovery
        ? [{
            id: '[recovery transcript omitted]',
            timestamp: 0,
            type: 'system',
            content: `[${initialOutputBuffer.length} recovery messages omitted]`,
          }]
        : initialOutputBuffer.map((message) => ({
            ...message,
            content: summarizeLogText(message.content, 240) ?? '',
          }))
      : undefined,
  };
}

function sanitizeModelRuntimeTarget(
  target: InstanceCreateConfig['modelRuntimeTarget'],
): InstanceCreateConfig['modelRuntimeTarget'] {
  if (!target) {
    return undefined;
  }
  if (target.kind === 'cli') {
    return {
      kind: 'cli',
      ...(target.provider ? { provider: target.provider } : {}),
    };
  }
  return {
    kind: 'local-model',
    source: target.source,
    endpointProvider: target.endpointProvider,
    endpointId: target.endpointId,
    modelId: target.modelId,
    selectorId: target.selectorId,
    ...(target.nodeId ? { nodeId: target.nodeId } : {}),
    ...(target.nodeName ? { nodeName: target.nodeName } : {}),
  };
}

export function getResourceGovernorCreationBlockReason(): string | null {
  try {
    return getResourceGovernor().getCreationBlockReason();
  } catch (error) {
    logger.debug('Resource governor unavailable while checking instance creation gate', {
      ...errorDiagnostic(error),
    });
    return null;
  }
}

export function summarizeInputRequiredPayload(payload: {
  instanceId: string;
  requestId: string;
  prompt: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}): Record<string, unknown> {
  const metadata = payload.metadata ?? {};
  return {
    instanceId: payload.instanceId,
    requestId: payload.requestId,
    timestamp: payload.timestamp,
    promptLength: payload.prompt.length,
    metadataType: typeof metadata['type'] === 'string' ? textDiagnostic(metadata['type']) : undefined,
    approvalTraceId: typeof metadata['approvalTraceId'] === 'string'
      ? metadata['approvalTraceId']
      : undefined,
    action: typeof metadata['action'] === 'string' ? textDiagnostic(metadata['action']) : undefined,
    path: typeof metadata['path'] === 'string'
      ? textDiagnostic(metadata['path'])
      : undefined,
    permissionKey: typeof metadata['permissionKey'] === 'string'
      ? textDiagnostic(metadata['permissionKey'])
      : undefined,
  };
}
