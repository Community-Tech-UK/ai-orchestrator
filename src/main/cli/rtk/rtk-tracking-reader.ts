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

/**
 * T5 — RTK compliance, measured rather than assumed.
 *
 * The plan asks for "the `RTK_DISABLED` bypass rate (warn above 10% over 7
 * days)". An earlier reading of this file concluded no bypass signal existed.
 * That was wrong, and the correction matters:
 *
 *  - `rtk proxy <cmd>` runs WITHOUT filtering but still records a row, and its
 *    `rtk_cmd` starts `rtk proxy`, so proxy bypass IS countable.
 *  - `rtk run <cmd>` is documented as raw, no filtering or tracking.
 *  - There is a SECOND table, `parse_failures`, that the first pass missed
 *    entirely: commands rtk could not parse and fell back to raw execution.
 *    These produce no saving but are invisible in the savings summary.
 *
 * What remains genuinely unmeasurable from this database, and must never be
 * presented as if it were: a command the agent ran with no `rtk` prefix at all,
 * and a command run under `RTK_DISABLED`. Neither writes a row, so their share
 * is unknown — not zero. `unmeasurable` below exists to say so out loud.
 */
export interface RtkComplianceSummary {
  /** Commands rtk actually filtered. */
  filtered: number;
  /** Commands routed through `rtk proxy` — tracked, but deliberately unfiltered. */
  proxied: number;
  /** `proxied / (filtered + proxied)`, 0–100. Null when there is nothing to divide. */
  proxyRatePct: number | null;
  /** Rows in `parse_failures` for the window. */
  parseFailures: number;
  /** Of those, how many still executed successfully unfiltered. */
  parseFailuresRecovered: number;
  /**
   * `parseFailures / (commands + parseFailures)`, 0–100. This is the share of
   * attempted rtk invocations that produced no filtering at all.
   */
  parseFailureRatePct: number | null;
  /** Days covered, echoing the caller's window so a UI cannot mislabel it. */
  windowDays: number | null;
  /** Named, machine-readable reasons the picture is incomplete. */
  unmeasurable: readonly string[];
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
 * RTK's data directory. Mirrors the Rust `dirs::data_dir()` crate that RTK uses.
 */
function getRtkDataDir(): string {
  const home = homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'rtk');
  }
  if (process.platform === 'win32') {
    const appData =
      process.env['APPDATA'] && process.env['APPDATA'].length > 0
        ? process.env['APPDATA']
        : path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'rtk');
  }
  // Linux / other unix
  const xdg =
    process.env['XDG_DATA_HOME'] && process.env['XDG_DATA_HOME'].length > 0
      ? process.env['XDG_DATA_HOME']
      : path.join(home, '.local', 'share');
  return path.join(xdg, 'rtk');
}

/**
 * Compute the path to RTK's tracking DB.
 *
 * RTK renamed this file from `tracking.db` to `history.db` (~v0.40+). The schema
 * is unchanged, so we probe the current name first and fall back to the legacy
 * name. If neither exists yet, return the current name so callers report a stable
 * "not present" path. (Previously this hard-coded `tracking.db`, which made the
 * savings panel always read empty against a modern rtk that writes `history.db`.)
 */
export function getRtkTrackingDbPath(): string {
  const dir = getRtkDataDir();
  const current = path.join(dir, 'history.db');
  const legacy = path.join(dir, 'tracking.db');
  if (existsSync(current)) return current;
  if (existsSync(legacy)) return legacy;
  return current;
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

  /** True when a table exists; `parse_failures` predates neither rtk nor us safely. */
  private hasTable(driver: SqliteDriver, table: string): boolean {
    try {
      const rows = driver
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?")
        .all(table) as { name: string }[];
      return rows.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Compliance picture for a window. Returns null when the DB cannot be read —
   * never a zeroed summary, which would read as "perfect compliance" when the
   * truth is "no data".
   */
  getCompliance(opts: { projectPath?: string; sinceMs?: number } = {}): RtkComplianceSummary | null {
    const driver = this.getDriver();
    if (!driver) return null;

    const hasProject = this.hasProjectColumn(driver);
    const filter = this.buildFilter(opts, hasProject);
    const unmeasurable = [
      'commands the agent ran with no rtk prefix at all (no row is written)',
      'commands run under RTK_DISABLED (no row is written)',
      'commands run via `rtk run` (documented as raw, no tracking)',
    ];

    try {
      const row = driver
        .prepare(
          `SELECT
             COALESCE(SUM(CASE WHEN rtk_cmd LIKE 'rtk proxy%' THEN 1 ELSE 0 END), 0) AS proxied,
             COALESCE(SUM(CASE WHEN rtk_cmd LIKE 'rtk proxy%' THEN 0 ELSE 1 END), 0) AS filtered
           FROM commands ${filter.clause}`,
        )
        .get(...filter.params) as { proxied: number; filtered: number } | undefined;

      const proxied = row?.proxied ?? 0;
      const filtered = row?.filtered ?? 0;
      const attempted = proxied + filtered;

      let parseFailures = 0;
      let parseFailuresRecovered = 0;
      // `parse_failures` has no project_path column, so a project-scoped query
      // must not silently report global failures as if they were this project's.
      const failuresAreScopable = !opts.projectPath;
      if (failuresAreScopable && this.hasTable(driver, 'parse_failures')) {
        const clause = opts.sinceMs !== undefined ? 'WHERE timestamp >= ?' : '';
        const params = opts.sinceMs !== undefined ? [new Date(opts.sinceMs).toISOString()] : [];
        const pf = driver
          .prepare(
            `SELECT COUNT(*) AS total,
                    COALESCE(SUM(CASE WHEN fallback_succeeded = 1 THEN 1 ELSE 0 END), 0) AS recovered
             FROM parse_failures ${clause}`,
          )
          .get(...params) as { total: number; recovered: number } | undefined;
        parseFailures = pf?.total ?? 0;
        parseFailuresRecovered = pf?.recovered ?? 0;
      }

      const invocations = attempted + parseFailures;
      return {
        filtered,
        proxied,
        proxyRatePct: attempted > 0 ? (proxied / attempted) * 100 : null,
        parseFailures,
        parseFailuresRecovered,
        parseFailureRatePct: invocations > 0 ? (parseFailures / invocations) * 100 : null,
        windowDays: opts.sinceMs !== undefined
          ? Math.max(1, Math.round((Date.now() - opts.sinceMs) / 86_400_000))
          : null,
        unmeasurable: opts.projectPath
          ? [...unmeasurable, 'parse failures are not recorded per project, so they are omitted here']
          : unmeasurable,
      };
    } catch (err) {
      logger.warn('rtk compliance query failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
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
