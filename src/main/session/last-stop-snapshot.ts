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
import { z } from 'zod';
import {
  DisplayNameSchema,
  InstanceIdSchema,
  ModelIdSchema,
  SessionIdSchema,
  WorkingDirectorySchema,
} from '@contracts/schemas/common';
import { SessionRecoveryProviderSchema } from '@contracts/schemas/session';
import { getLogger } from '../logging/logger';
import type { ResumeCursor } from './session-continuity';
import {
  getCanonicalRecoveryKey,
  selectRecoverableSessions,
  type RecoverableSessionSelectionInput,
} from './recoverable-session-selection';

const logger = getLogger('LastStopSnapshot');

const SNAPSHOT_FILE_NAME = 'last-stop.json';
const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const MAX_SESSIONS_IN_SNAPSHOT = 20;

/** Providers that are inherently stateless and never need native resume. */
const STATELESS_PROVIDERS = new Set(['gemini']);

const NonNegativeIntegerSchema = z.number().int().nonnegative();
const OptionalNonEmptyStringSchema = z.string().min(1);
const ResumeCursorSchema = z.object({
  provider: SessionRecoveryProviderSchema,
  threadId: z.string().min(1),
  workspacePath: z.string().min(1),
  capturedAt: NonNegativeIntegerSchema,
  scanSource: z.enum(['native', 'jsonl-scan', 'thread-list', 'replay']),
  configFingerprint: OptionalNonEmptyStringSchema.optional(),
});

export interface RecoverableSession {
  instanceId: string;
  sessionId?: string;
  historyThreadId?: string;
  resumeCursor?: ResumeCursor | null;
  provider?: string;
  modelId?: string;
  displayName: string;
  workingDirectory: string;
  capturedAt: number;
}

/** The unversioned snapshot shape written before v2. */
export interface LastStopSnapshotV1 {
  /** Optional because snapshots written before versioning had no version field. */
  version?: 1;
  /** Epoch-ms when this snapshot was written. */
  writtenAt: number;
  /** All sessions that had active recovery state at shutdown time. */
  sessions: RecoverableSession[];
}

/** The current snapshot format used by startup recovery. */
export interface LastStopSnapshotV2 {
  version: 2;
  /** Epoch-ms when this snapshot was written. */
  writtenAt: number;
  /** Canonical current sessions followed by bounded non-live fallback sessions. */
  sessions: RecoverableSessionSelectionInput[];
}

/** Last-stop snapshots are exposed to readers in the current, migrated shape. */
export type LastStopSnapshot = LastStopSnapshotV2;

const RecoverableSessionV1Schema = z.object({
  instanceId: InstanceIdSchema,
  sessionId: SessionIdSchema.optional(),
  historyThreadId: z.string().min(1).max(200).optional(),
  resumeCursor: ResumeCursorSchema.nullish(),
  provider: SessionRecoveryProviderSchema.optional(),
  modelId: ModelIdSchema.optional(),
  displayName: DisplayNameSchema,
  workingDirectory: WorkingDirectorySchema,
  capturedAt: NonNegativeIntegerSchema,
});

const RecoverableSessionV2Schema = RecoverableSessionV1Schema.extend({
  provider: SessionRecoveryProviderSchema,
  recoveryKey: z.string().min(1).max(500),
  lastActivityAt: NonNegativeIntegerSchema,
  isLive: z.boolean(),
  messageCount: NonNegativeIntegerSchema,
  hasAssistantOutput: z.boolean(),
});

const SnapshotV1EnvelopeSchema = z.object({
  version: z.union([z.literal(1), z.undefined()]).optional(),
  writtenAt: NonNegativeIntegerSchema,
  sessions: z.array(z.unknown()),
});

const SnapshotV2EnvelopeSchema = z.object({
  version: z.literal(2),
  writtenAt: NonNegativeIntegerSchema,
  sessions: z.array(z.unknown()),
});

function toConservativeSelectionInput(
  session: RecoverableSession,
): RecoverableSessionSelectionInput {
  return {
    ...session,
    recoveryKey: getCanonicalRecoveryKey(session),
    lastActivityAt: session.capturedAt,
    isLive: false,
    messageCount: 0,
    hasAssistantOutput: false,
  };
}

function toSelectionInput(
  session: RecoverableSession | RecoverableSessionSelectionInput,
): RecoverableSessionSelectionInput {
  const parsed = RecoverableSessionV2Schema.safeParse(session);
  if (!parsed.success) {
    return toConservativeSelectionInput(session);
  }

  return {
    ...parsed.data,
    recoveryKey: getCanonicalRecoveryKey(parsed.data),
  };
}

interface ParsedSnapshot {
  snapshot: LastStopSnapshot;
  skippedInvalidSessions: number;
}

function parseSnapshot(obj: unknown): ParsedSnapshot | null {
  const v2 = SnapshotV2EnvelopeSchema.safeParse(obj);
  if (v2.success) {
    const sessions = v2.data.sessions.flatMap((session) => {
      const parsed = RecoverableSessionV2Schema.safeParse(session);
      return parsed.success
        ? [parsed.data as RecoverableSessionSelectionInput]
        : [];
    });
    return {
      snapshot: {
        version: 2,
        writtenAt: v2.data.writtenAt,
        sessions: selectRecoverableSessions(sessions, MAX_SESSIONS_IN_SNAPSHOT),
      },
      skippedInvalidSessions: v2.data.sessions.length - sessions.length,
    };
  }

  const v1 = SnapshotV1EnvelopeSchema.safeParse(obj);
  if (!v1.success) return null;
  const sessions = v1.data.sessions.flatMap((session) => {
    const parsed = RecoverableSessionV1Schema.safeParse(session);
    return parsed.success ? [toConservativeSelectionInput(parsed.data)] : [];
  });
  return {
    snapshot: {
      version: 2,
      writtenAt: v1.data.writtenAt,
      sessions,
    },
    skippedInvalidSessions: v1.data.sessions.length - sessions.length,
  };
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
  saveSnapshot(sessions: readonly (RecoverableSession | RecoverableSessionSelectionInput)[]): void {
    const recoverable = selectRecoverableSessions(sessions
      .filter((s) => {
        if (STATELESS_PROVIDERS.has(s.provider ?? '')) return false;
        return s.sessionId != null || s.resumeCursor != null;
      })
      .map(toSelectionInput), MAX_SESSIONS_IN_SNAPSHOT);

    if (recoverable.length === 0) {
      // Nothing to snapshot; remove any stale file.
      this.clear();
      return;
    }

    const snapshot: LastStopSnapshotV2 = {
      version: 2,
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

      const parsed = parseSnapshot(obj);
      if (!parsed) {
        logger.warn('Last-stop snapshot has invalid structure — ignoring');
        return null;
      }
      const { snapshot } = parsed;
      if (parsed.skippedInvalidSessions > 0) {
        logger.warn('Skipped invalid last-stop snapshot records', {
          skipped: parsed.skippedInvalidSessions,
        });
      }

      if (Date.now() - snapshot.writtenAt > SNAPSHOT_MAX_AGE_MS) {
        logger.info('Last-stop snapshot is stale — ignoring', {
          ageMs: Date.now() - snapshot.writtenAt,
        });
        return null;
      }

      return snapshot;
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
