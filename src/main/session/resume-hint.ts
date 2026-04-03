// src/main/session/resume-hint.ts
/**
 * Resume Hint Manager
 *
 * Persists the last active session to disk so the app can offer quick
 * resume on next startup. The hint is a lightweight JSON file written
 * synchronously during shutdown (in the SESSION_SYNC phase) to ensure
 * it survives crashes and forced quits.
 *
 * Integration:
 *   - GracefulShutdownManager calls saveHint() in SESSION_SYNC phase
 *   - App startup reads getHint() and sends to renderer via IPC
 *   - IPC channel: SESSION_GET_RESUME_HINT → returns ResumeHint | null
 *   - clearHint() is called after successful resume to avoid stale prompts
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getLogger } from '../logging/logger';

const logger = getLogger('ResumeHintManager');

// ── Constants ─────────────────────────────────────────────────────────────────

const HINT_FILE_NAME = 'last-session.json';
const HINT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── Public interfaces ─────────────────────────────────────────────────────────

export interface ResumeHint {
  sessionId: string;
  instanceId: string;
  displayName: string;
  timestamp: number;
  workingDirectory: string;
  instanceCount: number;
  provider: string;
  model?: string;
}

// ── Validation ────────────────────────────────────────────────────────────────

function isValidHint(obj: unknown): obj is ResumeHint {
  if (typeof obj !== 'object' || obj === null) return false;
  const h = obj as Record<string, unknown>;
  return (
    typeof h['sessionId'] === 'string' &&
    typeof h['instanceId'] === 'string' &&
    typeof h['displayName'] === 'string' &&
    typeof h['timestamp'] === 'number' &&
    typeof h['workingDirectory'] === 'string' &&
    typeof h['instanceCount'] === 'number' &&
    typeof h['provider'] === 'string'
  );
}

// ── Implementation ────────────────────────────────────────────────────────────

export class ResumeHintManager {
  private static instance: ResumeHintManager;
  private readonly hintPath: string;

  constructor(storeDir: string) {
    this.hintPath = path.join(storeDir, HINT_FILE_NAME);
  }

  static getInstance(storeDir?: string): ResumeHintManager {
    if (!this.instance) {
      const dir = storeDir ?? path.join(os.homedir(), '.orchestrator');
      this.instance = new ResumeHintManager(dir);
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    (this.instance as unknown) = undefined;
  }

  /**
   * Write the hint synchronously.
   * Called during shutdown — must not throw or block quit.
   */
  saveHint(hint: ResumeHint): void {
    try {
      const dir = path.dirname(this.hintPath);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.hintPath, JSON.stringify(hint), 'utf-8');
      logger.info('Resume hint saved', { sessionId: hint.sessionId });
    } catch (err) {
      logger.warn('Failed to save resume hint', { error: String(err) });
    }
  }

  /**
   * Read and validate the hint from disk.
   * Returns null if the file is missing, corrupted, or older than 7 days.
   */
  getHint(): ResumeHint | null {
    try {
      const raw = fs.readFileSync(this.hintPath, 'utf-8');
      const obj = JSON.parse(raw) as unknown;

      if (!isValidHint(obj)) {
        logger.warn('Resume hint file has invalid structure — ignoring');
        return null;
      }

      if (Date.now() - obj.timestamp > HINT_MAX_AGE_MS) {
        logger.info('Resume hint is stale — ignoring', {
          ageMs: Date.now() - obj.timestamp,
        });
        return null;
      }

      return obj;
    } catch {
      return null;
    }
  }

  /**
   * Delete the hint file.
   * Called after a successful resume to prevent stale prompts.
   */
  clearHint(): void {
    try {
      fs.unlinkSync(this.hintPath);
    } catch {
      // File may not exist — best effort
    }
  }
}

export function getResumeHintManager(storeDir?: string): ResumeHintManager {
  return ResumeHintManager.getInstance(storeDir);
}
