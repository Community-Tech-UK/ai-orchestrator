import type { OutputMessage } from '../../shared/types/instance.types';
import type {
  PluginHookPayloads,
  PluginNotification,
  PluginRecord,
  PluginTelemetryRecord,
  PluginTrackerEvent,
} from '../../shared/types/plugin.types';
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import { toOutputMessageFromProviderEnvelope } from '../providers/provider-output-event';
import type { ReactionEvent } from '../reactions/reaction.types';

export function isRecord(value: unknown): value is PluginRecord {
  return typeof value === 'object' && value !== null;
}

function isOutputMessage(value: unknown): value is OutputMessage {
  if (!isRecord(value)) {
    return false;
  }

  const type = value['type'];
  return (
    typeof value['id'] === 'string' &&
    typeof value['timestamp'] === 'number' &&
    typeof value['content'] === 'string' &&
    (type === 'assistant' ||
      type === 'user' ||
      type === 'system' ||
      type === 'tool_use' ||
      type === 'tool_result' ||
      type === 'error')
  );
}

export function isStringRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function toTrackerEvent(event: ReactionEvent): PluginTrackerEvent {
  return {
    event: `reaction.${event.type}`,
    timestamp: event.timestamp,
    instanceId: event.instanceId,
    data: {
      priority: event.priority,
      ...(event.message ? { message: event.message } : {}),
      ...event.data,
    },
  };
}

export function toNotificationPayload(
  event: ReactionEvent,
  priority: string | undefined,
  channels: string[],
): PluginNotification {
  return {
    event: `reaction.${event.type}`,
    title: event.type,
    message: event.message ?? `Reaction event: ${event.type}`,
    timestamp: event.timestamp,
    priority,
    instanceId: event.instanceId,
    channels,
    data: {
      reactionType: event.type,
      ...event.data,
    },
  };
}

export function toTelemetryRecord(envelope: ProviderRuntimeEventEnvelope): PluginTelemetryRecord {
  return {
    event: `provider.${envelope.event.kind}`,
    timestamp: envelope.timestamp,
    attributes: {
      provider: envelope.provider,
      instanceId: envelope.instanceId,
      ...(envelope.sessionId ? { sessionId: envelope.sessionId } : {}),
      seq: envelope.seq,
    },
    data: envelope.event as unknown as PluginRecord,
  };
}

export function toInstanceCreatedPayload(payload: unknown): PluginHookPayloads['instance.created'] | null {
  if (!isRecord(payload)) return null;
  const rawId = payload['id'];
  const rawWorkingDirectory = payload['workingDirectory'];
  if (typeof rawId !== 'string' || typeof rawWorkingDirectory !== 'string') {
    return null;
  }

  const provider = typeof payload['provider'] === 'string' ? payload['provider'] : undefined;
  return {
    ...payload,
    id: rawId,
    instanceId: rawId,
    workingDirectory: rawWorkingDirectory,
    ...(provider ? { provider } : {}),
  };
}

export function toInstanceOutputPayloadFromEnvelope(
  envelope: ProviderRuntimeEventEnvelope,
): PluginHookPayloads['instance.output'] | null {
  const message = toOutputMessageFromProviderEnvelope(envelope);
  if (!message) {
    return null;
  }

  return {
    instanceId: envelope.instanceId,
    message,
  };
}

export function toInstanceStateChangedPayload(
  payload: unknown,
): PluginHookPayloads['instance.stateChanged'] | null {
  if (!isRecord(payload)) return null;
  if (
    typeof payload['instanceId'] !== 'string'
    || typeof payload['status'] !== 'string'
    || typeof payload['previousStatus'] !== 'string'
  ) {
    return null;
  }

  return {
    instanceId: payload['instanceId'],
    previousState: payload['previousStatus'],
    newState: payload['status'],
    timestamp: typeof payload['timestamp'] === 'number' ? payload['timestamp'] : Date.now(),
  };
}

export function toPermissionAskPayload(
  payload: unknown,
): PluginHookPayloads['permission.ask'] | null {
  if (!isRecord(payload) || typeof payload['instanceId'] !== 'string') {
    return null;
  }

  const metadata = isRecord(payload['metadata']) ? payload['metadata'] : {};
  const type = typeof metadata['type'] === 'string' ? metadata['type'] : '';
  if (type !== 'deferred_permission' && type !== 'permission_denial') {
    return null;
  }

  const toolName =
    typeof metadata['tool_name'] === 'string'
      ? metadata['tool_name']
      : typeof metadata['action'] === 'string'
        ? metadata['action']
        : 'unknown';
  const toolInput = isRecord(metadata['tool_input']) ? metadata['tool_input'] : {};
  const command =
    typeof toolInput['command'] === 'string'
      ? toolInput['command']
      : typeof metadata['path'] === 'string'
        ? metadata['path']
        : undefined;

  return {
    instanceId: payload['instanceId'],
    toolName,
    ...(command ? { command } : {}),
  };
}

export function toSessionResumedPayload(payload: unknown): PluginHookPayloads['session.resumed'] | null {
  if (!isRecord(payload) || !isRecord(payload['state'])) {
    return null;
  }

  const state = payload['state'];
  if (typeof state['instanceId'] !== 'string' || typeof state['sessionId'] !== 'string') {
    return null;
  }

  return {
    instanceId: state['instanceId'],
    sessionId: state['sessionId'],
  };
}

export function toSessionCompactingPayload(
  payload: unknown,
): PluginHookPayloads['session.compacting'] | null {
  if (!isRecord(payload)) {
    return null;
  }
  if (
    typeof payload['instanceId'] !== 'string'
    || typeof payload['messageCount'] !== 'number'
    || typeof payload['tokenCount'] !== 'number'
  ) {
    return null;
  }

  return {
    instanceId: payload['instanceId'],
    messageCount: payload['messageCount'],
    tokenCount: payload['tokenCount'],
  };
}

export function toVerificationStartedPayload(
  payload: unknown,
): PluginHookPayloads['verification.started'] | null {
  if (!isRecord(payload)) return null;
  if (typeof payload['id'] !== 'string' || typeof payload['instanceId'] !== 'string') {
    return null;
  }

  return {
    ...payload,
    id: payload['id'],
    verificationId: payload['id'],
    instanceId: payload['instanceId'],
  };
}

export function toVerificationCompletedPayload(
  payload: unknown,
): PluginHookPayloads['verification.completed'] | null {
  if (!isRecord(payload) || typeof payload['id'] !== 'string') {
    return null;
  }

  const request = isRecord(payload['request']) ? payload['request'] : null;
  const instanceId =
    typeof payload['instanceId'] === 'string'
      ? payload['instanceId']
      : typeof request?.['instanceId'] === 'string'
        ? request['instanceId']
        : '';

  return {
    ...payload,
    id: payload['id'],
    verificationId: payload['id'],
    instanceId,
  };
}

export function toVerificationErrorPayload(
  payload: unknown,
): PluginHookPayloads['verification.error'] | null {
  if (!isRecord(payload) || !isRecord(payload['request'])) {
    return null;
  }

  const request = payload['request'];
  const verificationId = typeof request['id'] === 'string' ? request['id'] : '';
  const instanceId = typeof request['instanceId'] === 'string' ? request['instanceId'] : '';

  return {
    request,
    error: payload['error'],
    verificationId,
    instanceId,
  };
}
