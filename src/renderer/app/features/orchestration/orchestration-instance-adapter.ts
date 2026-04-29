import type { Instance } from '../../core/state/instance.store';
import type { HudChildInput } from '../../../../shared/utils/orchestration-hud-builder';
import type { ChildStateTimelineEntry } from '../../../../shared/utils/child-state-deriver';

export function toHudChildInput(
  instance: Instance,
  activity?: string,
): HudChildInput {
  const orchestration = getOrchestrationMetadata(instance);
  return {
    instanceId: instance.id,
    displayName: instance.displayName,
    status: instance.status,
    statusTimeline: readStatusTimeline(orchestration) ?? [{
      status: instance.status,
      timestamp: instance.lastActivity || instance.createdAt,
    }],
    lastActivityAt: instance.lastActivity || instance.createdAt,
    heartbeatAt: readNumber(orchestration['heartbeatAt']) ?? instance.lastActivity,
    createdAt: instance.createdAt,
    role: readString(orchestration['role']) ?? inferRole(instance),
    spawnPromptHash: readString(orchestration['spawnPromptHash']),
    activity,
  };
}

export function getChildRole(instance: Instance): string {
  return toHudChildInput(instance).role ?? inferRole(instance);
}

export function getChildSpawnPromptHash(instance: Instance): string | undefined {
  return readString(getOrchestrationMetadata(instance)['spawnPromptHash']);
}

export function getChildStatusTimeline(instance: Instance): ChildStateTimelineEntry[] {
  return toHudChildInput(instance).statusTimeline ?? [];
}

function getOrchestrationMetadata(instance: Instance): Record<string, unknown> {
  const metadata = instance.metadata;
  const orchestration = metadata?.['orchestration'];
  return isRecord(orchestration) ? orchestration : {};
}

function readStatusTimeline(metadata: Record<string, unknown>): ChildStateTimelineEntry[] | undefined {
  const value = metadata['statusTimeline'];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const timeline = value.filter((entry): entry is ChildStateTimelineEntry =>
    isRecord(entry)
    && typeof entry['status'] === 'string'
    && typeof entry['timestamp'] === 'number'
  );
  return timeline.length > 0 ? timeline : undefined;
}

function inferRole(instance: Instance): string {
  if (!instance.parentId) {
    return 'parent';
  }
  if (instance.agentId && instance.agentId !== 'build') {
    return instance.agentId;
  }
  return 'worker';
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
