/**
 * Small JSON file holding the latest Claude cost check and a short history.
 *
 * Kept out of the RLM database on purpose: it is a few kilobytes written once a
 * day, needs no migration, and a damaged file just means the next daily run starts
 * fresh. Writes go through a temp file and a rename so a crash never leaves half a file.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { ClaudeCostReconcileReport, ClaudeCostReconcileSnapshot } from '../../../shared/types/claude-cost-reconcile.types';
import { getLogger } from '../../logging/logger';

const logger = getLogger('ClaudeCostReconcileStore');

export const RECONCILE_HISTORY_LIMIT = 60;

export interface ClaudeCostReconcileState {
  latest: ClaudeCostReconcileReport | null;
  history: ClaudeCostReconcileSnapshot['history'];
  /** When the last run started, whether or not it worked (drives the daily schedule). */
  lastAttemptAt: number | null;
  lastError: string | null;
}

export const EMPTY_RECONCILE_STATE: ClaudeCostReconcileState = { latest: null, history: [], lastAttemptAt: null, lastError: null };

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function validReport(value: unknown): value is ClaudeCostReconcileReport {
  return isRecord(value) && value['version'] === 1 && finite(value['checkedAt']) && isRecord(value['total'])
    && isRecord(value['byEra']) && isRecord(value['coverage']) && Array.isArray(value['largestGaps'])
    && ['ok', 'drift', 'insufficient-data'].includes(String(value['status']));
}

export class ClaudeCostReconcileStore {
  constructor(private readonly filePath: string) {}

  /** Never throws: a missing, unreadable or malformed file reads as "no history yet". */
  load(): ClaudeCostReconcileState {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'));
      if (!isRecord(parsed)) return { ...EMPTY_RECONCILE_STATE };
      const history = Array.isArray(parsed['history'])
        ? parsed['history'].filter((entry): entry is ClaudeCostReconcileSnapshot['history'][number] =>
          isRecord(entry) && finite(entry['checkedAt']) && isRecord(entry['total']) && typeof entry['status'] === 'string')
        : [];
      return {
        latest: validReport(parsed['latest']) ? parsed['latest'] : null,
        history: history.slice(0, RECONCILE_HISTORY_LIMIT),
        lastAttemptAt: finite(parsed['lastAttemptAt']) ? parsed['lastAttemptAt'] : null,
        lastError: typeof parsed['lastError'] === 'string' ? parsed['lastError'] : null,
      };
    } catch {
      return { ...EMPTY_RECONCILE_STATE };
    }
  }

  /** Best effort: a failed write is logged and the in-memory state still serves the UI. */
  save(state: ClaudeCostReconcileState): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const temp = `${this.filePath}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ ...state, history: state.history.slice(0, RECONCILE_HISTORY_LIMIT) }), 'utf8');
      renameSync(temp, this.filePath);
    } catch (error) {
      logger.warn('Could not save the Claude cost check', { error: String(error) });
    }
  }
}
