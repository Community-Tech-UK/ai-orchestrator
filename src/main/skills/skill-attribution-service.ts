/**
 * SkillAttributionService — records every skill injection and owns the
 * per-skill control modes (kill-switch).
 *
 * Design rules (spec 2026-07-23-skill-observability-and-design-skills):
 *   - Fail-soft everywhere: attribution sits on the message hot path and must
 *     never block or break a send. DB errors are logged and swallowed.
 *   - Lazily binds to the RLM database; if RLM is not initialised (unit tests,
 *     early startup) recording is skipped silently and controls fall back to
 *     source-based defaults.
 *   - Control defaults encode the D1a policy in one place: builtin skills are
 *     'enabled' unless overridden; everything else is 'suggest-only' until an
 *     explicit control says otherwise.
 *
 * Events:
 *   'activation'      — a SkillActivation was recorded.
 *   'control-changed' — a SkillControl was upserted.
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import type { SqliteDriver } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';
import { getRLMDatabase } from '../persistence/rlm-database';
import {
  insertSkillActivation,
  listSkillActivations,
  getSkillHealthSummary,
  getSkillControl,
  listSkillControls,
  markActivationsFollowedByError,
  upsertSkillControl,
  type ListSkillActivationsQuery,
  type SkillActivation,
  type SkillControl,
  type SkillControlMode,
  type SkillHealthSummaryEntry,
  type SkillMatchedBy,
} from '../persistence/rlm/rlm-skill-attribution';

export type {
  SkillActivation,
  SkillControl,
  SkillControlMode,
  SkillHealthSummaryEntry,
  SkillMatchedBy,
} from '../persistence/rlm/rlm-skill-attribution';

const logger = getLogger('SkillAttribution');

export interface RecordActivationParams {
  skillName: string;
  /** Where the skill was discovered: 'builtin' | 'global' | 'project'. */
  skillSource: string;
  instanceId?: string | null;
  sessionId?: string | null;
  /** Correlation key for the turn (e.g. conversation message id). */
  turnKey?: string | null;
  matchedBy: SkillMatchedBy;
  matchedTrigger?: string | null;
  matchScore?: number | null;
  tokensInjected: number;
  autoSelected: boolean;
}

export class SkillAttributionService extends EventEmitter {
  private static instance: SkillAttributionService | null = null;

  private db: SqliteDriver | null = null;
  private dbResolved = false;
  /** Write-through cache of explicit controls, keyed by skill name. */
  private controlCache: Map<string, SkillControl> | null = null;

  static getInstance(): SkillAttributionService {
    if (!SkillAttributionService.instance) {
      SkillAttributionService.instance = new SkillAttributionService();
    }
    return SkillAttributionService.instance;
  }

  static _resetForTesting(): void {
    SkillAttributionService.instance = null;
  }

  /** Test seam: bind directly to a database instead of the RLM singleton. */
  _bindDatabaseForTesting(db: SqliteDriver): void {
    this.db = db;
    this.dbResolved = true;
    this.controlCache = null;
  }

  /** Test seam: simulate a permanently unavailable database. */
  _bindUnavailableForTesting(): void {
    this.db = null;
    this.dbResolved = true;
    this.controlCache = null;
  }

  private resolveDb(): SqliteDriver | null {
    if (this.db) return this.db;
    if (this.dbResolved) return null;
    this.dbResolved = true;
    try {
      const rlm = getRLMDatabase();
      if (!rlm.isInitialized()) {
        this.dbResolved = false; // retry on next call; RLM may init later
        return null;
      }
      this.db = rlm.getDb();
      return this.db;
    } catch (err) {
      logger.warn('RLM database unavailable; skill attribution disabled', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  // ---- Activations ---------------------------------------------------------

  /**
   * Record one skill injection. Fail-soft and cheap; callers must not await
   * anything meaningful on it — it either records or silently doesn't.
   */
  recordActivation(params: RecordActivationParams): SkillActivation | null {
    const db = this.resolveDb();
    if (!db) return null;
    const activation: SkillActivation = {
      id: crypto.randomUUID(),
      skillName: params.skillName,
      skillSource: params.skillSource,
      instanceId: params.instanceId ?? null,
      sessionId: params.sessionId ?? null,
      turnKey: params.turnKey ?? null,
      matchedBy: params.matchedBy,
      matchedTrigger: params.matchedTrigger ?? null,
      matchScore: params.matchScore ?? null,
      tokensInjected: params.tokensInjected,
      autoSelected: params.autoSelected,
      createdAt: Date.now(),
    };
    try {
      insertSkillActivation(db, { ...activation });
    } catch (err) {
      logger.warn('recordActivation failed (fail-soft)', {
        skillName: params.skillName,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    this.emit('activation', activation);
    return activation;
  }

  /** Recent activations, newest first. Fail-soft: empty array on error. */
  getRecentActivations(query: ListSkillActivationsQuery = {}): SkillActivation[] {
    const db = this.resolveDb();
    if (!db) return [];
    try {
      return listSkillActivations(db, query);
    } catch (err) {
      logger.warn('getRecentActivations failed (fail-soft)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** Per-skill aggregates, optionally bounded to a time window. */
  getHealthSummary(since?: number): SkillHealthSummaryEntry[] {
    const db = this.resolveDb();
    if (!db) return [];
    try {
      return getSkillHealthSummary(db, since);
    } catch (err) {
      logger.warn('getHealthSummary failed (fail-soft)', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Correlation hook: an instance errored/failed — flag its recent activations
   * so the health view can surface "activated shortly before an error".
   */
  markErrorForInstance(instanceId: string, windowMs = 10 * 60_000, errorAt = Date.now()): void {
    const db = this.resolveDb();
    if (!db) return;
    try {
      const flagged = markActivationsFollowedByError(db, instanceId, windowMs, errorAt);
      if (flagged > 0) {
        logger.info('Flagged skill activations preceding an instance error', {
          instanceId,
          flagged,
        });
      }
    } catch (err) {
      logger.warn('markErrorForInstance failed (fail-soft)', {
        instanceId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ---- Controls (kill-switch) ---------------------------------------------

  private loadControlCache(): Map<string, SkillControl> {
    if (this.controlCache) return this.controlCache;
    const cache = new Map<string, SkillControl>();
    const db = this.resolveDb();
    if (db) {
      try {
        for (const control of listSkillControls(db)) {
          cache.set(control.skillName, control);
        }
      } catch (err) {
        logger.warn('loadControlCache failed (fail-soft)', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    this.controlCache = cache;
    return cache;
  }

  /** The explicit control for a skill, or null if none has been set. */
  getControl(skillName: string): SkillControl | null {
    return this.loadControlCache().get(skillName) ?? null;
  }

  listControls(): SkillControl[] {
    return [...this.loadControlCache().values()];
  }

  /**
   * The mode the loader must honour for a skill: an explicit control wins;
   * otherwise builtins default to 'enabled' and every other source to
   * 'suggest-only' (decision D1a).
   */
  getEffectiveMode(skillName: string, skillSource: string): SkillControlMode {
    const control = this.getControl(skillName);
    if (control) return control.mode;
    return skillSource === 'builtin' ? 'enabled' : 'suggest-only';
  }

  /** Persist a control. Returns the stored control, or null on failure. */
  setControl(
    skillName: string,
    mode: SkillControlMode,
    reason?: string | null,
  ): SkillControl | null {
    const db = this.resolveDb();
    const control: SkillControl = {
      skillName,
      mode,
      reason: reason ?? null,
      updatedAt: Date.now(),
    };
    if (db) {
      try {
        upsertSkillControl(db, control);
      } catch (err) {
        logger.warn('setControl failed (fail-soft)', {
          skillName,
          mode,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    } else {
      // No DB: keep the control in-memory so the session still honours it.
      logger.warn('setControl stored in-memory only (RLM unavailable)', { skillName, mode });
    }
    this.loadControlCache().set(skillName, control);
    this.emit('control-changed', control);
    return control;
  }

  /** Direct DB read (bypasses cache) — used by tests and diagnostics. */
  _getControlFromDb(skillName: string): SkillControl | null {
    const db = this.resolveDb();
    if (!db) return null;
    try {
      return getSkillControl(db, skillName);
    } catch {
      return null;
    }
  }
}

export function getSkillAttribution(): SkillAttributionService {
  return SkillAttributionService.getInstance();
}
