/** Disposable eight-day cache owned by Harness; never writes to RTK's database. */
import type { SqliteDriver } from '../../db/sqlite-driver';
import type { RtkSavingsSummary } from './rtk-tracking-reader';
import { CAPPED_SAVED, RAN_IN_FULL_CLAUSE, SHORTENED_CLAUSE } from './rtk-summary-queries';

export interface SavingsQuery { projectPath?: string; sinceMs?: number; topN?: number }
interface Group {
  day: string; project: string; command: string; count: number;
  input: number; output: number; saved: number; pct: number; first: string; last: string;
  filtered: number; ranInFull: number; capped: number; reducedBase: number;
}
const DAY = 86_400_000;
const fields = `COUNT(*) AS count, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
  SUM(saved_tokens) AS saved, SUM(savings_pct) AS pct, MIN(timestamp) AS first, MAX(timestamp) AS last,
  SUM(CASE WHEN ${SHORTENED_CLAUSE} THEN 1 ELSE 0 END) AS filtered,
  SUM(CASE WHEN ${RAN_IN_FULL_CLAUSE} THEN 1 ELSE 0 END) AS ranInFull,
  SUM(CASE WHEN ${SHORTENED_CLAUSE} THEN ${CAPPED_SAVED} ELSE 0 END) AS capped,
  SUM(CASE WHEN ${SHORTENED_CLAUSE} THEN COALESCE(output_tokens, 0) + ${CAPPED_SAVED} ELSE 0 END) AS reducedBase`;

export class RtkDailyRollup {
  constructor(private readonly cache: SqliteDriver) {
    cache.pragma('journal_mode = WAL');
    const existing = new Set(
      cache.prepare(`SELECT name FROM pragma_table_info('daily')`).all<{ name: string }>().map((r) => r.name),
    );
    // The cache is disposable: an earlier build's schema is rebuilt, not migrated.
    if (existing.size > 0 && (!existing.has('capped') || !existing.has('reducedBase'))) {
      cache.exec('DROP TABLE IF EXISTS daily; DROP TABLE IF EXISTS checkpoint;');
    }
    cache.exec(`CREATE TABLE IF NOT EXISTS checkpoint (singleton INTEGER PRIMARY KEY, source TEXT, highwater INTEGER);
      CREATE TABLE IF NOT EXISTS daily (day TEXT, project TEXT, command TEXT, count INTEGER,
        input INTEGER, output INTEGER, saved INTEGER, pct REAL, first TEXT, last TEXT,
        filtered INTEGER, ranInFull INTEGER, capped INTEGER, reducedBase INTEGER,
        PRIMARY KEY(day, project, command)) WITHOUT ROWID;`);
  }

  getSummary(source: SqliteDriver, identity: string, hasProject: boolean,
    opts: SavingsQuery, now = Date.now()): RtkSavingsSummary | undefined {
    const cutoff = new Date(now - 8 * DAY).toISOString().slice(0, 10);
    // Preserve exact semantics for arbitrary older/all-time API callers.
    if (opts.sinceMs === undefined || new Date(opts.sinceMs).toISOString().slice(0, 10) < cutoff) return undefined;
    const maxId = source.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM commands').get<{ id: number }>()?.id ?? 0;
    const previous = this.cache.prepare('SELECT source, highwater FROM checkpoint WHERE singleton = 1')
      .get<{ source: string; highwater: number }>();
    const reset = previous?.source !== identity || previous.highwater > maxId;
    const highwater = reset ? 0 : previous.highwater;
    const project = hasProject ? "COALESCE(project_path, '')" : "''";
    const rows = source.prepare(`SELECT substr(timestamp, 1, 10) AS day, ${project} AS project,
      rtk_cmd AS command, ${fields} FROM commands
      WHERE id > ? AND id <= ? AND timestamp >= ? GROUP BY day, project, rtk_cmd`)
      .all<Group>(highwater, maxId, cutoff);
    this.cache.transaction(() => {
      if (reset) this.cache.exec('DELETE FROM daily');
      const upsert = this.cache.prepare(`INSERT INTO daily VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, project, command) DO UPDATE SET count=count+excluded.count,
        input=input+excluded.input, output=output+excluded.output, saved=saved+excluded.saved,
        pct=pct+excluded.pct, first=MIN(first, excluded.first), last=MAX(last, excluded.last),
        filtered=filtered+excluded.filtered, ranInFull=ranInFull+excluded.ranInFull,
        capped=capped+excluded.capped, reducedBase=reducedBase+excluded.reducedBase`);
      for (const r of rows) upsert.run(r.day, r.project, r.command, r.count, r.input, r.output, r.saved,
        r.pct, r.first, r.last, r.filtered, r.ranInFull, r.capped, r.reducedBase);
      this.cache.prepare('DELETE FROM daily WHERE day < ?').run(cutoff);
      this.cache.prepare('INSERT OR REPLACE INTO checkpoint VALUES (1, ?, ?)').run(identity, maxId);
    })();

    const since = new Date(opts.sinceMs).toISOString();
    const nextDay = new Date(Math.floor(opts.sinceMs / DAY) * DAY + DAY).toISOString();
    const projectClause = hasProject && opts.projectPath ? ' AND project_path = ?' : '';
    const projectParams = projectClause ? [opts.projectPath] : [];
    // The partial first day is read exactly; complete days come from the cache.
    const boundary = source.prepare(`SELECT rtk_cmd AS command, ${fields} FROM commands
      WHERE timestamp >= ? AND timestamp < ? AND id <= ? ${projectClause} GROUP BY rtk_cmd`)
      .all<Group>(since, nextDay, maxId, ...projectParams);
    const cached = this.cache.prepare(`SELECT command, SUM(count) AS count, SUM(input) AS input,
      SUM(output) AS output, SUM(saved) AS saved, SUM(pct) AS pct,
      MIN(first) AS first, MAX(last) AS last, SUM(filtered) AS filtered, SUM(ranInFull) AS ranInFull,
      SUM(capped) AS capped, SUM(reducedBase) AS reducedBase
      FROM daily WHERE day >= ? ${projectClause ? 'AND project = ?' : ''} GROUP BY command`)
      .all<Group>(nextDay.slice(0, 10), ...projectParams);
    const merged = new Map<string, Group>();
    for (const r of [...boundary, ...cached]) {
      const old = merged.get(r.command);
      merged.set(r.command, old ? { ...r, count: old.count + r.count, input: old.input + r.input,
        output: old.output + r.output, saved: old.saved + r.saved, pct: old.pct + r.pct,
        first: old.first < r.first ? old.first : r.first,
        last: old.last > r.last ? old.last : r.last,
        filtered: old.filtered + r.filtered, ranInFull: old.ranInFull + r.ranInFull,
        capped: old.capped + r.capped, reducedBase: old.reducedBase + r.reducedBase } : r);
    }
    const summary: RtkSavingsSummary = { commands: 0, commandsFiltered: 0, commandsRanInFull: 0,
      totalInput: 0, totalOutput: 0, totalSaved: 0, savedTokensCapped: 0, weightedReductionPct: 0,
      avgSavingsPct: 0, windowDays: 0, byCommand: [], byProgram: [], lastCommandAt: null };
    let pct = 0;
    let reducedBase = 0;
    let firstCommandAt: string | null = null;
    for (const r of merged.values()) {
      summary.commands += r.count; summary.totalInput += r.input; summary.totalOutput += r.output;
      summary.totalSaved += r.saved; pct += r.pct;
      summary.commandsFiltered += r.filtered; summary.commandsRanInFull += r.ranInFull;
      summary.savedTokensCapped += r.capped; reducedBase += r.reducedBase;
      if (!summary.lastCommandAt || r.last > summary.lastCommandAt) summary.lastCommandAt = r.last;
      if (!firstCommandAt || r.first < firstCommandAt) firstCommandAt = r.first;
    }
    summary.avgSavingsPct = summary.commands ? pct / summary.commands : 0;
    summary.weightedReductionPct = reducedBase > 0 ? (100 * summary.savedTokensCapped) / reducedBase : 0;
    const firstMs = firstCommandAt ? Date.parse(firstCommandAt) : NaN;
    const lastMs = summary.lastCommandAt ? Date.parse(summary.lastCommandAt) : NaN;
    const spanMs = Number.isFinite(firstMs) && Number.isFinite(lastMs) && lastMs > firstMs
      ? lastMs - firstMs
      : opts.sinceMs !== undefined ? now - opts.sinceMs : 0;
    summary.windowDays = spanMs > 0 ? Math.max(1, Math.round(spanMs / DAY)) : 0;
    summary.byCommand = [...merged.values()].sort((a, b) => b.saved - a.saved || a.command.localeCompare(b.command))
      .slice(0, opts.topN ?? 10).map(r => ({ rtkCmd: r.command, count: r.count, saved: r.saved,
        avgSavingsPct: r.count ? r.pct / r.count : 0 }));
    const byProgram = new Map<string, { program: string; count: number; savedTokensCapped: number }>();
    for (const r of merged.values()) {
      if (r.filtered <= 0) continue;
      const program = r.command.slice(4).split(' ')[0] ?? '';
      const entry = byProgram.get(program) ?? { program, count: 0, savedTokensCapped: 0 };
      entry.count += r.filtered;
      entry.savedTokensCapped += r.capped;
      byProgram.set(program, entry);
    }
    summary.byProgram = [...byProgram.values()]
      .sort((a, b) => b.savedTokensCapped - a.savedTokensCapped || b.count - a.count)
      .slice(0, opts.topN ?? 10);
    return summary;
  }

  close(): void { this.cache.close(); }
}
