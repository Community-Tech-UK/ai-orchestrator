import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { CliToolCall } from '../cli/adapters/base-cli-adapter';
import type { RuntimeToolResultEvidenceCaptureInput } from '../context-evidence/context-evidence-coordinator';
import { getAdapterToolResultCapturePayload } from '../providers/adapter-runtime-event-bridge';
import type {
  ProviderName,
  ProviderRuntimeEvent,
  ProviderRuntimeEventEnvelope,
} from '@contracts/types/provider-runtime-events';
import type { PendingEnvelope } from '../providers/provider-runtime-event-bus';
import { resolveProviderName, resolveRuntimeEventTurnId } from './provider-runtime-helpers';

export interface ProviderRuntimeEventIngressOptions {
  provider?: ProviderName;
  sessionId?: string;
  timestamp?: number;
  raw?: ProviderRuntimeEventEnvelope['raw'];
}

interface BuildProviderRuntimeEventIngressInput {
  getInstance: (instanceId: string) => Instance | undefined;
  instanceId: string;
  event: ProviderRuntimeEvent;
  options?: ProviderRuntimeEventIngressOptions;
}

/** Build one canonical or capture-only event from the current instance state. */
export function buildProviderRuntimeEventIngress(
  input: BuildProviderRuntimeEventIngressInput,
): PendingEnvelope | null {
  const instance = input.getInstance(input.instanceId);
  const provider = resolveProviderName(input.instanceId, input.options?.provider, instance?.provider);
  if (!provider) return null;

  return {
    timestamp: input.options?.timestamp ?? Date.now(),
    provider,
    instanceId: input.instanceId,
    sessionId: input.options?.sessionId ?? instance?.providerSessionId ?? instance?.sessionId,
    adapterGeneration: instance?.adapterGeneration,
    turnId: resolveRuntimeEventTurnId(input.event, instance),
    raw: input.options?.raw,
    event: input.event,
  };
}

export function buildParsedToolResultEvidenceIngress(
  instance: Instance,
  message: OutputMessage,
): RuntimeToolResultEvidenceCaptureInput | null {
  if (message.type !== 'tool_result') return null;
  const metadata = message.metadata;
  const toolCallRef = firstString(metadata, ['tool_use_id', 'toolUseId', 'tool_call_id', 'toolCallId'])
    ?? message.id;
  const turnRef = firstString(metadata, ['turnId', 'turn_id']) ?? instance.activeTurnId;
  const toolName = firstString(metadata, ['name', 'toolName', 'tool_name']) ?? 'unknown';
  return buildToolResultEvidenceIngress(instance, {
    toolCallRef,
    turnRef,
    toolName,
    content: new TextEncoder().encode(message.content),
    mimeType: 'text/plain;charset=utf-8',
  });
}

export function buildRawToolResultEvidenceIngress(
  instance: Instance,
  toolCall: CliToolCall,
): RuntimeToolResultEvidenceCaptureInput | null {
  const payload = getAdapterToolResultCapturePayload(toolCall);
  if (!payload) return null;
  return buildToolResultEvidenceIngress(instance, {
    toolCallRef: toolCall.id,
    turnRef: instance.activeTurnId,
    toolName: toolCall.name,
    ...payload,
  });
}

function buildToolResultEvidenceIngress(
  instance: Instance,
  input: {
    toolCallRef: string;
    turnRef?: string;
    toolName: string;
    content: Uint8Array;
    mimeType: string;
  },
): RuntimeToolResultEvidenceCaptureInput | null {
  const evidence = instance.contextEvidence;
  if (!evidence || evidence.mode === 'off' || !evidence.conversationId) return null;
  const turnKey = input.turnRef ?? 'unscoped';
  return {
    queueId: instance.id,
    conversationId: evidence.conversationId,
    captureKey: `tool-result:${turnKey}:${input.toolCallRef}`,
    provider: instance.provider,
    providerThreadRef: instance.providerSessionId ?? instance.sessionId,
    ...(input.turnRef ? { turnRef: input.turnRef } : {}),
    toolCallRef: input.toolCallRef,
    toolName: input.toolName,
    sourceKind: classifyEvidenceSource(input.toolName),
    mimeType: input.mimeType,
    content: input.content,
  };
}

function firstString(
  metadata: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = metadata?.[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function classifyEvidenceSource(toolName: string): RuntimeToolResultEvidenceCaptureInput['sourceKind'] {
  const normalized = toolName.toLowerCase();
  if (/browser/.test(normalized)) return 'browser';
  if (/web|search|fetch|http/.test(normalized)) return 'web';
  if (/database|sql|query/.test(normalized)) return 'database';
  if (/mcp/.test(normalized)) return 'mcp';
  if (/bash|shell|command|exec|terminal/.test(normalized)) return 'command';
  if (/read|write|edit|file|glob|grep|patch/.test(normalized)) return 'file';
  return 'other';
}
