import type {
  InstanceCreateConfig,
  OutputMessage,
} from '../../../shared/types/instance.types';

const LOG_PREVIEW_LENGTH = 160;

function summarizeLogText(value: string | undefined, maxLength = LOG_PREVIEW_LENGTH): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}... (${normalized.length} chars)`;
}

function summarizeAttachments(
  attachments: InstanceCreateConfig['attachments']
): Record<string, unknown>[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  return attachments.map((attachment) => ({
    name: summarizeLogText(attachment.name, 80) ?? attachment.name,
    type: attachment.type,
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
      metadataKeys: message.metadata ? Object.keys(message.metadata).slice(0, 8) : undefined,
    })),
  };
}

export function summarizeCreateInstanceConfig(config: InstanceCreateConfig): Record<string, unknown> {
  return {
    displayName: config.displayName,
    parentId: config.parentId,
    historyThreadId: config.historyThreadId,
    sessionId: config.sessionId,
    resume: config.resume ?? false,
    workingDirectory: config.workingDirectory,
    initialPromptLength: config.initialPrompt?.length ?? 0,
    initialPromptPreview: summarizeLogText(config.initialPrompt),
    initialContextBlockLength: config.initialContextBlock?.length ?? 0,
    attachments: summarizeAttachments(config.attachments),
    yoloMode: config.yoloMode,
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
