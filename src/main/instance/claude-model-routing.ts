import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import { getModelsForProvider, normalizeModelAliasForProvider } from '../../shared/types/provider.types';
import type { CommunicationDependencies } from './instance-communication.types';

export function detectClaudeSafetyRouteModel(message: OutputMessage): string | undefined {
  if (message.type !== 'system') {
    return undefined;
  }

  const match = /\bSwitched\s+to\s+(.+?)(?:\.\s|\.?$)/i.exec(message.content);
  const modelLabel = match?.[1]?.trim().replace(/^Claude\s+/i, '');
  if (!modelLabel) {
    return undefined;
  }

  const model = normalizeModelAliasForProvider('claude', modelLabel);
  return model && getModelsForProvider('claude').some((candidate) => candidate.id === model)
    ? model
    : undefined;
}

export function reconcileClaudeSafetyRouteModel(
  instanceId: string,
  instance: Instance,
  message: OutputMessage,
  queueUpdate: CommunicationDependencies['queueUpdate'],
): void {
  if (instance.provider !== 'claude') {
    return;
  }

  const model = detectClaudeSafetyRouteModel(message);
  if (!model || instance.currentModel === model) {
    return;
  }

  instance.currentModel = model;
  queueUpdate(
    instanceId,
    instance.status,
    instance.contextUsage,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    model,
  );
}
