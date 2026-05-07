/**
 * Read-only access to RTK's SQLite tracking database for the savings UI panel.
 *
 * RTK writes one row per `rtk` invocation to `commands` (~/.local/share/rtk/
 * tracking.db on Linux, ~/Library/Application Support/rtk on macOS,
 * %APPDATA%\rtk on Windows). We open it read-only — RTK does its own schema
 * migrations on its own startup. We tolerate missing columns: if rtk is older
 * or newer than we expect, queries that reference unknown columns degrade
 * to "no data" rather than crashing.
 *
 * Concurrency: RTK uses WAL mode + `busy_timeout=5000`. Multiple readers are
 * safe; multi-writer (e.g. four orchestrator children running rtk in parallel
 * on the same project) is also safe because all writes go through rtk's
 * own connection. Our reads never lock the DB.
 */

import { existsSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

import {
  defaultDriverFactory,
} from '../../db/better-sqlite3-driver';
import type {
  SqliteDriver,
  SqliteDriverFactory,
} from '../../db/sqlite-driver';
import { getLogger } from '../../logging/logger';

const logger = getLogger('RtkTrackingReader');

/** Aggregate summary for the savings UI. */
export interface RtkSavingsSummary {
  /** Number of commands recorded in the queried window. */
  commands: number;
  /** Sum of input_tokens (raw command output before filtering). */
  totalInput: number;
  /** Sum of output_tokens (filtered output sent to LLM). */
  totalOutput: number;
  /** Sum of saved_tokens (input - output). */
  totalSaved: number;
  /** Average savings_pct across rows ([0, 100]). */
  avgSavingsPct: number;
  /** Top commands by tokens saved. */
  byCommand: RtkCommandStat[];
  /** ISO timestamp of the most recent command, or null if none. */
  lastCommandAt: string | null;
}

export interface RtkCommandStat {
  /** The rtk_cmd column — e.g. "rtk git status". */
  rtkCmd: string;
  /** Count of invocations. */
  count: number;
  /** Sum of saved_tokens for this command. */
  saved: number;
  /** Average savings_pct for this command. */
  avgSavingsPct: number;
}

export interface RtkCommandRecord {
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** The original raw command (e.g. "git status"). */
  originalCmd: string;
  /** The rtk-rewritten command. */
  rtkCmd: string;
  /** Tokens saved for this invocation. */
  savedTokens: number;
  /** Savings percentage [0, 100]. */
  savingsPct: number;
  /** Project path the command ran in (may be empty for older rtk). */
  projectPath: string;
}

export interface RtkTrackingReaderOptions {
  /** Override the resolved DB path (testing only). */
  dbPathOverride?: string;
  /** Override the SqliteDriver factory (testing only). */
  driverFactory?: SqliteDriverFactory;
}

/**
 * Compute the platform-specific path to RTK's tracking.db.
 * Mirrors the behavior of the Rust `dirs::data_dir()` crate that RTK uses.
 */
export function getRtkTrackingDbPath(): string {
  const home = homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'rtk', 'tracking.db');
  }
  if (process.platform === 'win32') {
    const appData =
      process.env['APPDATA'] && process.env['APPDATA'].length > 0
        ? process.env['APPDATA']
        : path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'rtk', 'tracking.db');
  }
  // Linux / other unix
  const xdg =
    process.env['XDG_DATA_HOME'] && process.env['XDG_DATA_HOME'].length > 0
      ? process.env['XDG_DATA_HOME']
      : path.join(home, '.local', 'share');
  return path.join(xdg, 'rtk', 'tracking.db');
}

/**
 * Reader that opens RTK's tracking DB on demand and serves aggregate queries.
 *
 * The connection is opened lazily and held for the lifetime of the reader
 * (better-sqlite3 connections are cheap; we share one across queries). Call
 * `close()` to release it explicitly.
 *
 * Methods return null/empty when the DB doesn't exist or schema is incompatible.
 */
export class RtkTrackingReader {
  private readonly dbPath: string;
  private readonly factory: SqliteDriverFactory;
  private driver: SqliteDriver | null = null;
  private openAttempted = false;

  constructor(options: RtkTrackingReaderOptions = {}) {
    this.dbPath = options.dbPathOverride ?? getRtkTrackingDbPath();
    this.factory = options.driverFactory ?? defaultDriverFactory;
  }

  /** True if the tracking DB exists on disk. Cheap; safe to call repeatedly. */
  isAvailable(): boolean {
    return existsSync(this.dbPath);
  }

  /** Resolved DB path. */
  getDbPath(): string {
    return this.dbPath;
  }

  /**
   * Lazy connection accessor. Returns null if the file doesn't exist or
   * couldn't be opened (in which case openAttempted is set so we don't
   * retry on every query call).
   */
  private getDriver(): SqliteDriver | null {
    if (this.driver) return this.driver;
    if (this.openAttempted) return null;
    this.openAttempted = true;
    if (!this.isAvailable()) {
      logger.debug('rtk tracking DB not present', { path: this.dbPath });
      return null;
    }
    try {
      this.driver = this.factory(this.dbPath, { readonly: true });
      logger.info('rtk tracking DB opened (read-only)', { path: this.dbPath });
      return this.driver;
    } catch (err) {
      logger.warn('Failed to open rtk tracking DB read-only', {
        path: this.dbPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Build the WHERE clause + params for project/since filters. Returns:
   *   { clause: 'WHERE ...' | '', params: [...] }
   * `project_path` was added in a later rtk migration; if it's missing we
   * silently skip the project filter and return data from all projects.
   */
  private buildFilter(opts: { projectPath?: string; sinceMs?: number }, hasProjectColumn: boolean) {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (opts.sinceMs !== undefined) {
      clauses.push('timestamp >= ?');
      params.push(new Date(opts.sinceMs).toISOString());
    }
    if (opts.projectPath && hasProjectColumn) {
      clauses.push('project_path = ?');
      params.push(opts.projectPath);
    }
    return {
      clause: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
      params,
    };
  }

  /** True if rtk's `commands` table has the project_path column. */
  private hasProjectColumnCache: boolean | null = null;
  private hasProjectColumn(driver: SqliteDriver): boolean {
    if (this.hasProjectColumnCache !== null) return this.hasProjectColumnCache;
    try {
      const rows = driver.pragma('table_info(commands)') as { name: string }[];
      this.hasProjectColumnCache = rows.some((r) => r.name === 'project_path');
    } catch {
      this.hasProjectColumnCache = false;
    }
    return this.hasProjectColumnCache;
  }

  /**
   * Aggregate savings summary, optionally filtered by project path and time.
   * Returns null when the DB is unavailable or schema is incompatible.
   */
  getSummary(opts: { projectPath?: string; sinceMs?: number; topN?: number } = {}): RtkSavingsSummary | null {
    const driver = this.getDriver();
    if (!driver) return null;

    const topN = opts.topN ?? 10;
    const hasProject = this.hasProjectColumn(driver);
    const filter = this.buildFilter(opts, hasProject);

    try {
      const summaryRow = driver
        .prepare(
          `SELECT
            COUNT(*) AS commands,
            COALESCE(SUM(input_tokens), 0) AS totalInput,
            COALESCE(SUM(output_tokens), 0) AS totalOutput,
            COALESCE(SUM(saved_tokens), 0) AS totalSaved,
            COALESCE(AVG(savings_pct), 0) AS avgSavingsPct,
            MAX(timestamp) AS lastCommandAt
          FROM commands
          ${filter.clause}`,
        )
        .get<{
          commands: number;
          totalInput: number;
          totalOutput: number;
          totalSaved: number;
          avgSavingsPct: number;
          lastCommandAt: string | null;
        }>(...filter.params);

      if (!summaryRow) {
        return {
          commands: 0,
          totalInput: 0,
          totalOutput: 0,
          totalSaved: 0,
          avgSavingsPct: 0,
          byCommand: [],
          lastCommandAt: null,
        };
      }

      const byCommandRows = driver
        .prepare(
          `SELECT
            rtk_cmd AS rtkCmd,
            COUNT(*) AS count,
            COALESCE(SUM(saved_tokens), 0) AS saved,
            COALESCE(AVG(savings_pct), 0) AS avgSavingsPct
          FROM commands
          ${filter.clause}
          GROUP BY rtk_cmd
          ORDER BY saved DESC
          LIMIT ?`,
        )
        .all<RtkCommandStat>(...filter.params, topN);

      return {
        commands: Number(summaryRow.commands ?? 0),
        totalInput: Number(summaryRow.totalInput ?? 0),
        totalOutput: Number(summaryRow.totalOutput ?? 0),
        totalSaved: Number(summaryRow.totalSaved ?? 0),
        avgSavingsPct: Number(summaryRow.avgSavingsPct ?? 0),
        byCommand: byCommandRows.map((r) => ({
          rtkCmd: r.rtkCmd,
          count: Number(r.count),
          saved: Number(r.saved),
          avgSavingsPct: Number(r.avgSavingsPct),
        })),
        lastCommandAt: summaryRow.lastCommandAt ?? null,
      };
    } catch (err) {
      logger.warn('rtk tracking summary query failed', {
        path: this.dbPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Recent command history (newest first), optionally filtered by project.
   * Returns empty array when the DB is unavailable.
   */
  getRecentHistory(opts: { projectPath?: string; limit?: number } = {}): RtkCommandRecord[] {
    const driver = this.getDriver();
    if (!driver) return [];

    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 1000);
    const hasProject = this.hasProjectColumn(driver);
    const filter = this.buildFilter({ projectPath: opts.projectPath }, hasProject);

    try {
      const projectPathSelect = hasProject ? 'project_path' : `'' AS project_path`;
      const rows = driver
        .prepare(
          `SELECT
            timestamp,
            original_cmd AS originalCmd,
            rtk_cmd AS rtkCmd,
            saved_tokens AS savedTokens,
            savings_pct AS savingsPct,
            ${projectPathSelect} AS projectPath
          FROM commands
          ${filter.clause}
          ORDER BY timestamp DESC
          LIMIT ?`,
        )
        .all<RtkCommandRecord>(...filter.params, limit);
      return rows.map((r) => ({
        timestamp: r.timestamp,
        originalCmd: r.originalCmd,
        rtkCmd: r.rtkCmd,
        savedTokens: Number(r.savedTokens),
        savingsPct: Number(r.savingsPct),
        projectPath: r.projectPath ?? '',
      }));
    } catch (err) {
      logger.warn('rtk tracking history query failed', {
        path: this.dbPath,
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /** Release the SQLite connection. Safe to call multiple times. */
  close(): void {
    if (this.driver) {
      try {
        this.driver.close();
      } catch {
        // best-effort
      }
      this.driver = null;
    }
  }
}

let instance: RtkTrackingReader | null = null;

/** Lazy singleton — holds a single read-only connection for the process. */
export function getRtkTrackingReader(opts: RtkTrackingReaderOptions = {}): RtkTrackingReader {
  if (!instance) {
    instance = new RtkTrackingReader(opts);
  }
  return instance;
}

/** Test-only: clear the cached singleton and close the underlying connection. */
export function _resetForTesting(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}
