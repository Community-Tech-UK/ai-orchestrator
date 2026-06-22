import type { InstanceStatus } from './instance.types';

export function withStatusTimeline(
  metadata: Record<string, unknown> | undefined,
  status: InstanceStatus,
  timestamp: number,
): Record<string, unknown> {
  const current = metadata ?? {};
  const orchestration = isRecord(current['orchestration'])
    ? current['orchestration']
    : {};
  const existing = Array.isArray(orchestration['statusTimeline'])
    ? orchestration['statusTimeline'].filter((entry): entry is { status: string; timestamp: number } =>
        isRecord(entry)
        && typeof entry['status'] === 'string'
        && typeof entry['timestamp'] === 'number'
      )
    : [];
  const last = existing[existing.length - 1];
  const statusTimeline = last?.status === status
    ? existing
    : [...existing, { status, timestamp }].slice(-100);
  return {
    ...current,
    orchestration: {
      ...orchestration,
      statusTimeline,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
