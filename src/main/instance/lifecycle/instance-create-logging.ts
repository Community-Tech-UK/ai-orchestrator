import type {
  InstanceCreateConfig,
  OutputMessage,
} from '../../../shared/types/instance.types';

import { textDiagnostic } from '../../logging/source-diagnostics';

function summarizeAttachments(
  attachments: InstanceCreateConfig['attachments']
): Record<string, unknown>[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  return attachments.map((attachment) => ({
    name: textDiagnostic(attachment.name),
    type: textDiagnostic(attachment.type),
    size: attachment.size,
    dataLength: attachment.data.length,
  }));
}

function summarizeInitialOutputBuffer(
  outputBuffer: OutputMessage[] | undefined
): Record<string, unknown> | undefined {
  if (!outputBuffer || outputBuffer.length === 0) {
    return undefined;
  }

  const totalContentLength = outputBuffer.reduce((total, message) => total + message.content.length, 0);
  const totalAttachmentCount = outputBuffer.reduce(
    (total, message) => total + (message.attachments?.length ?? 0),
    0
  );

  return {
    count: outputBuffer.length,
    totalContentLength,
    totalAttachmentCount,
    recentMessages: outputBuffer.slice(-3).map((message) => ({
      type: message.type,
      contentLength: message.content.length,
      attachmentCount: message.attachments?.length ?? 0,
      metadataKeyCount: message.metadata ? Object.keys(message.metadata).length : 0,
    })),
  };
}

export function summarizeCreateInstanceConfig(config: InstanceCreateConfig): Record<string, unknown> {
  const isCrashRecovery = config.metadata?.['reason'] === 'crash-recovery';
  return {
    displayName: config.displayName ? textDiagnostic(config.displayName) : undefined,
    parentId: config.parentId,
    historyThreadId: isCrashRecovery && config.historyThreadId
      ? '[recovery history identity omitted]'
      : config.historyThreadId,
    sessionId: isCrashRecovery && config.sessionId
      ? '[recovery session omitted]'
      : config.sessionId,
    resume: config.resume ?? false,
    workingDirectory: config.workingDirectory,
    initialPromptLength: config.initialPrompt?.length ?? 0,
    initialPrompt: config.initialPrompt ? textDiagnostic(config.initialPrompt) : undefined,
    initialContextBlockLength: config.initialContextBlock?.length ?? 0,
    attachments: summarizeAttachments(config.attachments),
    yoloMode: config.yoloMode,
    launchMode: config.launchMode,
    initialOutputBuffer: summarizeInitialOutputBuffer(config.initialOutputBuffer),
    agentId: config.agentId,
    modelOverride: config.modelOverride,
    provider: config.provider,
    terminationPolicy: config.terminationPolicy,
    hasContextInheritanceOverride: Boolean(config.contextInheritance),
    forceNodeId: config.forceNodeId ?? null,
    hasNodePlacement: Boolean(config.nodePlacement),
  };
}
