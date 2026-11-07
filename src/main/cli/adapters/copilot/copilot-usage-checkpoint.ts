import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { CopilotModelCache } from '../../../../shared/types/cost-session.types';

export interface CopilotCheckpoint {
  eventId: string;
  at: number;
  totalNanoAiu: number;
  totalPremiumRequests: number;
  modelCache: CopilotModelCache[];
}
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const timestamp = (value: unknown): number => typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;

/** Never log these lines: neighbouring records contain conversation text. */
export function parseCopilotCheckpointLine(line: string): CopilotCheckpoint | undefined {
  if (!line.slice(0, 200).includes('"session.usage_checkpoint"')) return undefined;
  try {
    const raw = JSON.parse(line);
    const data = raw.data;
    const at = timestamp(raw.timestamp);
    if (raw.type !== 'session.usage_checkpoint' || typeof raw.id !== 'string' || !raw.id
      || !Number.isFinite(at) || !nonnegative(data?.totalNanoAiu) || !nonnegative(data?.totalPremiumRequests)) return undefined;
    const modelCache: CopilotModelCache[] = [];
    for (const item of Array.isArray(data.modelCacheState) ? data.modelCacheState : []) {
      const expiresAt = timestamp(item.cacheExpiresAt);
      if (typeof item.modelId === 'string' && Number.isFinite(expiresAt) && nonnegative(item.cacheTtlSeconds)) {
        modelCache.push({ modelId: item.modelId, expiresAt, ttlSeconds: item.cacheTtlSeconds });
      }
    }
    return { eventId: raw.id, at, totalNanoAiu: data.totalNanoAiu, totalPremiumRequests: data.totalPremiumRequests, modelCache };
  } catch { return undefined; }
}

export interface CopilotCheckpointTail {
  last?: CopilotCheckpoint;
  previous?: CopilotCheckpoint;
  /** True when the read window never reached the start of the file: a missing
   * `previous` is then unknown history, not a truly first checkpoint. */
  truncated: boolean;
}

export async function readCopilotCheckpointTail(eventsPath: string): Promise<CopilotCheckpointTail> {
  const file = await open(eventsPath, 'r');
  try {
    const { size } = await file.stat();
    for (const limit of [256 * 1024, 1024 * 1024]) {
      const start = Math.max(0, size - limit);
      const buffer = Buffer.alloc(size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split('\n');
      lines.pop(); // only newline-terminated records are durable, complete samples
      if (start > 0) lines.shift();
      const checkpoints: CopilotCheckpoint[] = [];
      for (let i = lines.length - 1; i >= 0 && checkpoints.length < 2; i--) {
        const checkpoint = parseCopilotCheckpointLine(lines[i]);
        if (checkpoint) checkpoints.push(checkpoint);
      }
      const truncated = start > 0;
      // Expand the window while the previous checkpoint is still missing and
      // older records may sit beyond the current tail; without this a lone
      // checkpoint in a short tail is mistaken for the stream's first.
      if (checkpoints.length >= 2 || !truncated || limit === 1024 * 1024) {
        return {
          ...(checkpoints[0] ? { last: checkpoints[0] } : {}),
          ...(checkpoints[1] ? { previous: checkpoints[1] } : {}),
          truncated,
        };
      }
    }
    return { truncated: true };
  } finally { await file.close(); }
}

export function copilotEventsPath(home: string, sessionId: string): string {
  if (!sessionId || sessionId.includes('..') || /[/\\\0]/.test(sessionId)) throw new Error('Unsafe Copilot session id');
  return join(home, 'session-state', sessionId, 'events.jsonl');
}
