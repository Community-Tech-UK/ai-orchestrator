/**
 * Reads the daily cost-attribution logs (`cost-attribution-YYYY-MM-DD.jsonl`)
 * for the three things the Claude transcripts cannot say:
 *
 * - which Harness session a transcript belongs to (`sessionId` on the record),
 * - whether that session was started as a helper for another one (`parentId`),
 * - which effort setting it ran at (`reasoningEffort`, recorded per turn).
 *
 * `sessionId` and `reasoningEffort` are written by `recordCompletionCost` since
 * this feature shipped. Earlier turns have neither, so the effort-based causes
 * cover only sessions Harness has recorded, and the report says so.
 *
 * Reading is incremental: each day file remembers how far it was read, so only
 * the newly appended lines are parsed on a refresh. Only the three facts above
 * are kept; token counts and costs in the log are ignored here.
 */

import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { streamLines } from './jsonl-line-stream';

const FILE_PATTERN = /^cost-attribution-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const CHUNK_BYTES = 1024 * 1024;
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const GATE = Buffer.from('"source":"instance-turn"');

export interface EffortPoint {
  at: number;
  effort: string;
}

export interface AttributionDigest {
  /** Harness session id -> the child session's parent session id. Only helper sessions appear. */
  parentByInstance: Map<string, string>;
  /** Harness session id -> effort setting over time, oldest first. */
  effortByInstance: Map<string, EffortPoint[]>;
  /** Claude session id -> Harness session id, for turns recorded with their session id. */
  sessionToInstance: Map<string, string>;
  /** Day files that exist but could not be read, so their turns are missing from the maps above. */
  unreadableFiles: number;
}

interface DayDigest {
  path: string;
  ino: number;
  offset: number;
  /** The last attempt to read this day failed. */
  failed: boolean;
  parents: Map<string, string>;
  efforts: { instanceId: string; at: number; effort: string }[];
  sessions: Map<string, string>;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Keeps the first and last point of each run of the same effort. */
export function compressEfforts(points: readonly EffortPoint[]): EffortPoint[] {
  const out: EffortPoint[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const previous = points[index - 1];
    const next = points[index + 1];
    if (!previous || !next || previous.effort !== point.effort || next.effort !== point.effort) out.push(point);
  }
  return out;
}

export class UsageAttributionReader {
  private readonly days = new Map<string, DayDigest>();

  constructor(private readonly directory: () => string | null) {}

  async read(sinceMs: number): Promise<AttributionDigest> {
    const directory = this.directory();
    let names: string[] = [];
    if (directory) {
      try {
        names = await fs.readdir(directory);
      } catch {
        names = [];
      }
    }

    const wanted = new Map<string, string>();
    for (const name of names) {
      const match = FILE_PATTERN.exec(name);
      if (!match) continue;
      const dayStart = Date.parse(`${match[1]}T00:00:00Z`);
      if (Number.isFinite(dayStart) && dayStart + DAY_MS > sinceMs) wanted.set(join(directory!, name), name);
    }
    for (const path of this.days.keys()) {
      if (!wanted.has(path)) this.days.delete(path);
    }

    for (const path of wanted.keys()) {
      let stat;
      try {
        stat = await fs.stat(path);
      } catch {
        this.days.delete(path);
        continue;
      }
      let day = this.days.get(path);
      if (day && (day.ino !== stat.ino || stat.size < day.offset)) day = undefined;
      if (!day) {
        day = { path, ino: stat.ino, offset: 0, failed: false, parents: new Map(), efforts: [], sessions: new Map() };
        this.days.set(path, day);
      }
      if (stat.size <= day.offset) continue;
      const target = day;
      try {
        await streamLines(path, {
          start: day.offset,
          chunkBytes: CHUNK_BYTES,
          maxLineBytes: MAX_LINE_BYTES,
          onLine: (line, endOffset) => {
            if (line && line.includes(GATE)) collectLine(target, line);
            target.offset = endOffset;
          },
          onChunk: () => new Promise<void>((resolve) => setImmediate(resolve)),
        });
        target.failed = false;
      } catch {
        // What was read stays; the day is counted so the report can say it is incomplete.
        target.failed = true;
      }
    }

    return this.merge(sinceMs);
  }

  private merge(sinceMs: number): AttributionDigest {
    const parentByInstance = new Map<string, string>();
    const sessionToInstance = new Map<string, string>();
    const grouped = new Map<string, EffortPoint[]>();
    let unreadableFiles = 0;
    for (const day of this.days.values()) {
      if (day.failed) unreadableFiles += 1;
      for (const [child, parent] of day.parents) parentByInstance.set(child, parent);
      for (const [session, instance] of day.sessions) sessionToInstance.set(session, instance);
      for (const point of day.efforts) {
        if (point.at < sinceMs) continue;
        const list = grouped.get(point.instanceId) ?? [];
        list.push({ at: point.at, effort: point.effort });
        grouped.set(point.instanceId, list);
      }
    }
    const effortByInstance = new Map<string, EffortPoint[]>();
    for (const [instanceId, points] of grouped) {
      effortByInstance.set(instanceId, compressEfforts(points.sort((a, b) => a.at - b.at)));
    }
    return { parentByInstance, effortByInstance, sessionToInstance, unreadableFiles };
  }
}

function collectLine(day: DayDigest, line: Buffer): void {
  let row: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line.toString('utf8'));
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    row = parsed as Record<string, unknown>;
  } catch {
    return;
  }
  const provider = text(row['provider']);
  if (row['source'] !== 'instance-turn' || !provider || !provider.toLowerCase().startsWith('claude')) return;
  const instanceId = text(row['instanceId']);
  if (!instanceId) return;
  const parentId = text(row['parentId']);
  if (parentId) day.parents.set(instanceId, parentId);
  const sessionId = text(row['sessionId']);
  if (sessionId) day.sessions.set(sessionId, instanceId);
  const effort = text(row['reasoningEffort']);
  const at = typeof row['ts'] === 'number' && Number.isFinite(row['ts']) ? row['ts'] : null;
  if (effort && at !== null) day.efforts.push({ instanceId, at, effort });
}
