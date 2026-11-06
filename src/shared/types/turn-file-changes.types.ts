/**
 * What changed in the working folder while one turn ran.
 *
 * Produced in the main process from two git snapshots of the folder (see
 * `TurnFileBaselineService`) and read by the transcript, which shows "Changed 4
 * files while this reply ran" only from a `ready` answer.
 */

export type TurnBaselineUnavailableReason = 'not-git' | 'remote' | 'no-baseline' | 'git-error';

export interface TurnFileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  /** Lines added and removed; null for a binary file. */
  added: number | null;
  deleted: number | null;
}

export type TurnBaselineResult =
  | { state: 'unavailable'; reason: TurnBaselineUnavailableReason }
  | { state: 'running' }
  | {
    state: 'ready';
    /** Every file that differs, even when `files` was cut short. */
    total: number;
    files: TurnFileChange[];
    truncated: boolean;
    /** When the "before" snapshot finished. A turn whose first tool call came earlier is not trusted. */
    baselineCompletedAt: number;
    /** When the "after" snapshot finished. */
    endedAt: number;
  };

/** Narrows an IPC answer, so a malformed one is treated as "no answer" rather than trusted. */
export function readTurnBaselineResult(value: unknown): TurnBaselineResult | null {
  if (value === null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record['state'] === 'running') return { state: 'running' };
  if (record['state'] === 'unavailable') {
    const reason = record['reason'];
    return reason === 'not-git' || reason === 'remote' || reason === 'no-baseline' || reason === 'git-error'
      ? { state: 'unavailable', reason }
      : null;
  }
  if (record['state'] !== 'ready') return null;
  const { total, files, truncated, baselineCompletedAt, endedAt } = record;
  if (
    typeof total !== 'number' || !Number.isFinite(total) || total < 0
    || !Array.isArray(files) || typeof truncated !== 'boolean'
    || typeof baselineCompletedAt !== 'number' || typeof endedAt !== 'number'
  ) {
    return null;
  }
  const kept: TurnFileChange[] = [];
  for (const file of files) {
    const entry = file as Record<string, unknown> | null;
    if (!entry || typeof entry['path'] !== 'string') return null;
    const status = entry['status'];
    if (status !== 'added' && status !== 'modified' && status !== 'deleted') return null;
    const added = entry['added'];
    const deleted = entry['deleted'];
    kept.push({
      path: entry['path'],
      status,
      added: typeof added === 'number' ? added : null,
      deleted: typeof deleted === 'number' ? deleted : null,
    });
  }
  return { state: 'ready', total, files: kept, truncated, baselineCompletedAt, endedAt };
}
