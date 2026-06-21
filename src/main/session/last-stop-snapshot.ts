/**
 * LastStopSnapshot — atomic multi-session recovery snapshot (§3.6 / Phase 6 / C5).
 *
 * Writes a crash-resilient JSON snapshot of ALL currently recoverable sessions
 * before shutdown or before destructive operations (interrupt escalation,
 * respawn, terminate). On next launch the startup flow reads this file to offer
 * the user a one-click "restore last sessions" prompt.
 *
 * Design:
 *   - Atomic write: write to a `.tmp` file, fsync, rename, fsync parent dir.
 *     A crash mid-write leaves the old file intact (rename is atomic on POSIX).
 *   - "Recoverable" criteria: the session has a sessionId or resumeCursor AND
 *     the provider is not known-stateless (Gemini uses replay, never native resume).
 *   - The snapshot is bounded: at most MAX_SESSIONS_IN_SNAPSHOT entries.
 *   - Expiry: entries older than SNAPSHOT_MAX_AGE_MS are pruned on read.
 *   - Clear: the snapshot is removed after a successful restore so stale
 *     entries do not persist across normal exits.
 *
 * Complements resume-hint.ts (which stores only the most-recent single session).
 */

import * as fs from 'fs';
import * as path from 'path';
import { getLogger } from '../logging/logger';
import type { ResumeCursor } from './session-continuity';

const logger = getLogger('LastStopSnapshot');

const SNAPSHOT_FILE_NAME = 'last-stop.json';
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_SESSIONS_IN_SNAPSHOT = 20;

/** Providers that are inherently stateless and never need native resume. */
const STATELESS_PROVIDERS = new Set(['gemini']);

export interface RecoverableSession {
  instanceId: string;
  sessionId?: string;
  resumeCursor?: ResumeCursor | null;
  provider?: string;
  modelId?: string;
  displayName: string;
  workingDirectory: string;
  capturedAt: number;
}

export interface LastStopSnapshot {
  /** Epoch-ms when this snapshot was written. */
  writtenAt: number;
  /** All sessions that had active recovery state at shutdown time. */
  sessions: RecoverableSession[];
}

function isValidSession(s: unknown): s is RecoverableSession {
  if (typeof s !== 'object' || s === null) return false;
  const o = s as Record<string, unknown>;
  return (
    typeof o['instanceId'] === 'string' &&
    typeof o['displayName'] === 'string' &&
    typeof o['workingDirectory'] === 'string' &&
    typeof o['capturedAt'] === 'number'
  );
}

function isValidSnapshot(obj: unknown): obj is LastStopSnapshot {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o['writtenAt'] === 'number' &&
    Array.isArray(o['sessions']) &&
    (o['sessions'] as unknown[]).every(isValidSession)
  );
}

export class LastStopSnapshotManager {
  private static instance: LastStopSnapshotManager | null = null;
  private readonly snapshotPath: string;

  constructor(storeDir: string) {
    this.snapshotPath = path.join(storeDir, SNAPSHOT_FILE_NAME);
  }

  static getInstance(storeDir: string): LastStopSnapshotManager {
    if (!this.instance) {
      this.instance = new LastStopSnapshotManager(storeDir);
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  /**
   * Write an atomic snapshot of all recoverable sessions.
   *
   * "Recoverable" means the session has a sessionId or a non-expired resumeCursor
   * AND the provider is not inherently stateless (Gemini).
   *
   * Safe to call from the synchronous shutdown path — uses only `fs.writeFileSync`,
   * `fs.renameSync`, and `fs.fsyncSync`.
   */
  saveSnapshot(sessions: RecoverableSession[]): void {
    const recoverable = sessions
      .filter((s) => {
        if (STATELESS_PROVIDERS.has(s.provider ?? '')) return false;
        return s.sessionId != null || s.resumeCursor != null;
      })
      .slice(0, MAX_SESSIONS_IN_SNAPSHOT);

    if (recoverable.length === 0) {
      // Nothing to snapshot; remove any stale file.
      this.clear();
      return;
    }

    const snapshot: LastStopSnapshot = {
      writtenAt: Date.now(),
      sessions: recoverable,
    };

    const snapshotDir = path.dirname(this.snapshotPath);
    const tmpPath = `${this.snapshotPath}.tmp`;

    try {
      fs.mkdirSync(snapshotDir, { recursive: true });
      fs.writeFileSync(tmpPath, JSON.stringify(snapshot), 'utf-8');
      try {
        const fd = fs.openSync(tmpPath, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } catch {
        // fsync not always available (Windows, some CI environments).
      }
      fs.renameSync(tmpPath, this.snapshotPath);
      try {
        const dirFd = fs.openSync(snapshotDir, 'r');
        try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
      } catch {
        // Directory fsync not available on all platforms (Windows).
      }
      logger.info('Last-stop snapshot written', {
        sessions: recoverable.length,
        path: this.snapshotPath,
      });
    } catch (err) {
      logger.warn('Failed to write last-stop snapshot', { error: String(err) });
      try { fs.unlinkSync(tmpPath); } catch { /* best effort cleanup */ }
    }
  }

  /**
   * Read and validate the snapshot from disk.
   * Returns null if the file is missing, corrupted, or expired.
   * Prunes entries older than SNAPSHOT_MAX_AGE_MS.
   */
  getSnapshot(): LastStopSnapshot | null {
    try {
      const raw = fs.readFileSync(this.snapshotPath, 'utf-8');
      const obj = JSON.parse(raw) as unknown;

      if (!isValidSnapshot(obj)) {
        logger.warn('Last-stop snapshot has invalid structure — ignoring');
        return null;
      }

      if (Date.now() - obj.writtenAt > SNAPSHOT_MAX_AGE_MS) {
        logger.info('Last-stop snapshot is stale — ignoring', {
          ageMs: Date.now() - obj.writtenAt,
        });
        return null;
      }

      // Prune per-entry stale cursors and return what's still fresh.
      const fresh: RecoverableSession[] = obj.sessions.filter(
        (s) => Date.now() - s.capturedAt < SNAPSHOT_MAX_AGE_MS,
      );

      return { writtenAt: obj.writtenAt, sessions: fresh };
    } catch {
      return null;
    }
  }

  /**
   * Delete the snapshot file.
   * Call after a successful restore so stale entries don't accumulate.
   */
  clear(): void {
    try {
      fs.unlinkSync(this.snapshotPath);
    } catch {
      // File may not exist — best effort.
    }
  }
}

// ── Module-level singleton helpers ────────────────────────────────────────────

let _managerInstance: LastStopSnapshotManager | null = null;

export function initLastStopSnapshot(storeDir: string): LastStopSnapshotManager {
  _managerInstance = LastStopSnapshotManager.getInstance(storeDir);
  return _managerInstance;
}

export function getLastStopSnapshotIfInitialized(): LastStopSnapshotManager | null {
  return _managerInstance;
}

/** For tests only — reset module-level state. */
export function _resetLastStopSnapshotForTesting(): void {
  LastStopSnapshotManager._resetForTesting();
  _managerInstance = null;
}
