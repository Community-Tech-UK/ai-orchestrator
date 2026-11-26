import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { SqliteDriver } from '../db/sqlite-driver';
import type { WakeHint } from '../../shared/types/wake-context.types';
import { getRLMDatabase } from '../persistence/rlm-database';
import { getWakeContextBuilder } from './wake-context-builder';
import { memoryRemovalSuggestions } from './memory-removal-suggestions';

const WINDOW_MS = 30 * 86_400_000;
const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

// Stream into the hash: review cannot synchronously read or allocate an unbounded file.
async function compareSource(file: string, fingerprint: string): Promise<boolean | undefined> {
  if (!isAbsolute(file) || !/^[a-f0-9]{64}$/i.test(fingerprint)) return undefined;
  try {
    const handle = await open(file, 'r');
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size > MAX_SOURCE_BYTES) return undefined;
      const hash = createHash('sha256');
      const buffer = Buffer.alloc(64 * 1024);
      let bytes = 0;
      while (bytes <= MAX_SOURCE_BYTES) {
        const read = await handle.read(buffer, 0, buffer.length, null);
        if (read.bytesRead === 0) break;
        bytes += read.bytesRead;
        hash.update(buffer.subarray(0, read.bytesRead));
      }
      const after = await handle.stat();
      if (bytes > MAX_SOURCE_BYTES || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return undefined;
      return hash.digest('hex') === fingerprint;
    } finally {
      await handle.close();
    }
  } catch (error) {
    // Missing source really changed; permission/I/O errors are not evidence of change.
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? false : undefined;
  }
}

export async function reviewWakeHints(db: SqliteDriver, hints: WakeHint[], now = Date.now()): Promise<WakeHint[]> {
  const since = db.prepare('SELECT started_at FROM wake_hint_tracking').get<{ started_at: number }>()!.started_at;
  const counts = new Map(db.prepare(`SELECT hint_id, COUNT(*) AS count FROM wake_hint_showings
    WHERE shown_at >= ? AND shown_at <= ? GROUP BY hint_id`).all<{ hint_id: string; count: number }>(now - WINDOW_MS, now)
    .map((row) => [row.hint_id, row.count]));
  const hintIds = new Set(hints.map((hint) => hint.id));
  const sources = db.prepare('SELECT hint_id, source_uri, fingerprint FROM wake_hint_sources')
    .all<{ hint_id: string; source_uri: string; fingerprint: string }>();
  const byHint = new Map<string, typeof sources>();
  const compared = new Map<string, boolean | undefined>();
  // Group requested hints once, preserving their source order. Sequential reads
  // bound file descriptors and memory; shared sources hash once per review.
  for (const source of sources) {
    if (!hintIds.has(source.hint_id)) continue;
    const recorded = byHint.get(source.hint_id) ?? [];
    recorded.push(source);
    byHint.set(source.hint_id, recorded);
    const key = `${source.source_uri}\0${source.fingerprint}`;
    if (!compared.has(key)) compared.set(key, await compareSource(source.source_uri, source.fingerprint));
  }
  return hints.map((hint) => {
    const recorded = byHint.get(hint.id) ?? [];
    const matches = recorded.map((source) => compared.get(`${source.source_uri}\0${source.fingerprint}`));
    const sourceStatus = matches.includes(false) ? 'changed'
      : matches.length > 0 && matches.every((match) => match === true) ? 'matches' : 'unknown';
    const shownIn30Days = counts.get(hint.id) ?? 0;
    const historyStartedAt = Math.max(since, hint.createdAt);
    const suggestions = memoryRemovalSuggestions([{
      id: hint.id, shownInWindow: shownIn30Days, lastShownAt: hint.usageCount > 0 ? hint.lastUsed : null,
      createdAt: hint.createdAt, historyStartedAt,
      sourceRecorded: recorded.length > 0, sourceStillMatches: sourceStatus === 'unknown' ? undefined : sourceStatus === 'matches',
    }], now);
    return { ...hint, review: { shownIn30Days, historyStartedAt, sourceStatus,
      sourceFiles: recorded.map((source) => source.source_uri), suggestion: suggestions[0]?.label } };
  });
}

/**
 * Memory-page review over the builder's notes. Lives here rather than on
 * `WakeContextBuilder` so worker lanes that only subscribe to its events do
 * not pull the review rule (and its suggestion module) into their import
 * closure.
 */
export async function reviewWakeHintsForRoom(room?: string): Promise<WakeHint[]> {
  return reviewWakeHints(getRLMDatabase().getRawDb(), getWakeContextBuilder().listHints(room));
}
