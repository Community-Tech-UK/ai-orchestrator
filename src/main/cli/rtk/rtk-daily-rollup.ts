/** Disposable eight-day cache owned by Harness; never writes to RTK's database. */
import type { SqliteDriver } from '../../db/sqlite-driver';
import type { RtkSavingsSummary } from './rtk-tracking-reader';

export interface SavingsQuery { projectPath?: string; sinceMs?: number; topN?: number }
interface Group {
  day: string; project: string; command: string; count: number;
  input: number; output: number; saved: number; pct: number; last: string;
}
const DAY = 86_400_000;
const fields = `COUNT(*) AS count, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
  SUM(saved_tokens) AS saved, SUM(savings_pct) AS pct, MAX(timestamp) AS last`;

export class RtkDailyRollup {
  constructor(private readonly cache: SqliteDriver) {
    cache.pragma('journal_mode = WAL');
    cache.exec(`CREATE TABLE IF NOT EXISTS checkpoint (singleton INTEGER PRIMARY KEY, source TEXT, highwater INTEGER);
      CREATE TABLE IF NOT EXISTS daily (day TEXT, project TEXT, command TEXT, count INTEGER,
        input INTEGER, output INTEGER, saved INTEGER, pct REAL, last TEXT,
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
      const upsert = this.cache.prepare(`INSERT INTO daily VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, project, command) DO UPDATE SET count=count+excluded.count,
        input=input+excluded.input, output=output+excluded.output, saved=saved+excluded.saved,
        pct=pct+excluded.pct, last=MAX(last, excluded.last)`);
      for (const r of rows) upsert.run(r.day, r.project, r.command, r.count, r.input, r.output, r.saved, r.pct, r.last);
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
      SUM(output) AS output, SUM(saved) AS saved, SUM(pct) AS pct, MAX(last) AS last
      FROM daily WHERE day >= ? ${projectClause ? 'AND project = ?' : ''} GROUP BY command`)
      .all<Group>(nextDay.slice(0, 10), ...projectParams);
    const merged = new Map<string, Group>();
    for (const r of [...boundary, ...cached]) {
      const old = merged.get(r.command);
      merged.set(r.command, old ? { ...r, count: old.count + r.count, input: old.input + r.input,
        output: old.output + r.output, saved: old.saved + r.saved, pct: old.pct + r.pct,
        last: old.last > r.last ? old.last : r.last } : r);
    }
    const summary: RtkSavingsSummary = { commands: 0, totalInput: 0, totalOutput: 0,
      totalSaved: 0, avgSavingsPct: 0, byCommand: [], lastCommandAt: null };
    let pct = 0;
    for (const r of merged.values()) {
      summary.commands += r.count; summary.totalInput += r.input; summary.totalOutput += r.output;
      summary.totalSaved += r.saved; pct += r.pct;
      if (!summary.lastCommandAt || r.last > summary.lastCommandAt) summary.lastCommandAt = r.last;
    }
    summary.avgSavingsPct = summary.commands ? pct / summary.commands : 0;
    summary.byCommand = [...merged.values()].sort((a, b) => b.saved - a.saved || a.command.localeCompare(b.command))
      .slice(0, opts.topN ?? 10).map(r => ({ rtkCmd: r.command, count: r.count, saved: r.saved,
        avgSavingsPct: r.count ? r.pct / r.count : 0 }));
    return summary;
  }

  close(): void { this.cache.close(); }
}
