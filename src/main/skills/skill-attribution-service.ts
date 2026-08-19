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
  /**
   * Last-known-good snapshot of explicit controls, keyed by skill name.
   * NOT a memoization cache for reads — `loadControlCache()` re-queries the
   * DB on every call so every process realm stays in sync (LT-169). This
   * field only serves as a fallback for a transient DB read error and for
   * the DB-unavailable (in-memory-only) mode.
   */
  private controlCache: Map<string, SkillControl> | null = null;
  /**
   * Set true only for the duration of the most recent `loadControlCache()`
   * attempt: true if a DB was configured but the read threw (transient
   * error), false otherwise (success, or the designed no-DB fallback mode).
   * `getControl()` consults this immediately after calling
   * `loadControlCache()` — see its docstring for why (LT-169 fail-closed).
   */
  private lastControlReadFailed = false;

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

  /**
   * Read the current controls straight from the DB whenever it is available.
   *
   * LT-169: this service is a per-process singleton, and skill detection for
   * auto-injection runs inside a separate context-worker OS process with its
   * own module realm and its own instance of this class (see
   * `context-worker-main.ts`). A memoized `Map` here would only ever reflect
   * whatever that *specific* process instance saw on its first read, so a
   * control changed via the main-process IPC handler (`setControl`, used by
   * `SKILLS_SET_CONTROL`) would never reach the worker's copy — confirmed
   * live: the worker process kept serving a stale `disabled`/`enabled`
   * snapshot from its very first read indefinitely, ignoring every later
   * `setControl` call from the main process. The DB row is the only state
   * every realm actually shares, so it is the only safe source of truth for
   * every read. `controlCache` is kept only as a last-known-good fallback for
   * a transient DB error and for the DB-unavailable (in-memory-only) mode
   * `setControl` already documents.
   */
  private loadControlCache(): Map<string, SkillControl> {
    const db = this.resolveDb();
    if (db) {
      try {
        const fresh = new Map<string, SkillControl>();
        for (const control of listSkillControls(db)) {
          fresh.set(control.skillName, control);
        }
        this.controlCache = fresh;
        this.lastControlReadFailed = false;
        return fresh;
      } catch (err) {
        logger.warn('loadControlCache failed (fail-soft)', {
          error: err instanceof Error ? err.message : String(err),
        });
        this.lastControlReadFailed = true;
        if (this.controlCache) return this.controlCache;
        return new Map();
      }
    }
    // No DB (unit tests / RLM not yet initialised): fall back to whatever
    // was set in-memory via setControl(), same as before. This is a designed
    // mode, not a transient failure, so it does not trip the fail-closed path.
    this.lastControlReadFailed = false;
    if (this.controlCache) return this.controlCache;
    this.controlCache = new Map();
    return this.controlCache;
  }

  /**
   * The explicit control for a skill, or null if none has been set.
   *
   * LT-169 (fail-closed on a transient read error): removing the persistent
   * memoization fixed the "stale forever" bug, but a naive re-read still
   * fails OPEN for the single read that happens to race a DB error —
   * concretely, another process's `setControl('x','disabled')` write can
   * land and this process's very next read of it can throw (e.g.
   * `SQLITE_BUSY`) before it observes the disable. Falling back to the last
   * known snapshot (or, on a first-ever failed read, to an empty map) would
   * report "no override" and let a builtin default to 'enabled' — the same
   * wrong direction as the original bug, just narrowed to one unlucky read
   * instead of forever. A kill switch must fail closed: when the state
   * cannot be established, treat it as disabled rather than defaulting open.
   * This is the one place that decision is made, so every caller —
   * `getEffectiveMode` and skills-loader's direct `getControl` callers alike
   * — inherits it without needing its own check.
   */
  getControl(skillName: string): SkillControl | null {
    const cache = this.loadControlCache();
    if (this.lastControlReadFailed) {
      return {
        skillName,
        mode: 'disabled',
        reason: 'skill control state unknown after a DB read error (fail-closed)',
        updatedAt: Date.now(),
      };
    }
    return cache.get(skillName) ?? null;
  }

  /**
   * Best-effort listing for display (health panel / controls UI). Not part
   * of the injection-decision gate, so it is not fail-closed like
   * `getControl()`: a momentarily stale list is a display nit, not a policy
   * violation, and synthesizing entries for skills the DB never mentioned
   * makes no sense for a listing.
   */
  listControls(): SkillControl[] {
    return [...this.loadControlCache().values()];
  }

  /**
   * The source-based default when no explicit control exists: builtins
   * default to 'enabled', everything else to 'suggest-only' (decision D1a).
   * Pure — no DB access — so a caller that already holds its own
   * `getControl()` result (e.g. `SkillsLoader.resolveModeFor`) can apply
   * this default without a second DB round trip through `getEffectiveMode`.
   */
  resolveSourceDefaultMode(skillSource: string): SkillControlMode {
    return skillSource === 'builtin' ? 'enabled' : 'suggest-only';
  }

  /**
   * The mode the loader must honour for a skill: an explicit control wins;
   * otherwise builtins default to 'enabled' and every other source to
   * 'suggest-only' (decision D1a).
   */
  getEffectiveMode(skillName: string, skillSource: string): SkillControlMode {
    const control = this.getControl(skillName);
    if (control) return control.mode;
    return this.resolveSourceDefaultMode(skillSource);
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
