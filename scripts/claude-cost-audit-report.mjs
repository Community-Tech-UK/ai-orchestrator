#!/usr/bin/env node
/**
 * claude-cost-audit-report.mjs — aggregate Phase 1 fan-out audit data.
 *
 * Combines three sources into a per-task-type Claude cost ranking:
 *   1. cost-attribution JSONL (flag-gated sink; AIO_COST_ATTRIBUTION=1) —
 *      one line per LLM call, tagged with task-type. Primary source.
 *   2. rlm.db `cost_entries` — per-instance turns (chat + spawned children),
 *      recorded by CostTracker. Cross-check for instance-side numbers.
 *   3. loop DB `loop_iterations` — per-iteration tokens/cost_cents recorded
 *      by the loop store. Cross-check for loop-side numbers.
 *
 * Usage:
 *   node scripts/claude-cost-audit-report.mjs [--userdata <Electron userData dir>] [--since <ISO date>]
 *   --compare-transcripts --day YYYY-MM-DD [--projects <isolated projects directory>] [--prices <json>]
 *
 * Default userData on macOS: ~/Library/Application Support/harness
 * (pass --userdata if your app name/path differs — check the About panel or
 * `app.getPath('userData')`).
 *
 * Read-only: opens databases in readonly mode and only reads the JSONL files.
 */

import { compareTranscriptCosts } from './claude-transcript-cost-comparison.mjs';
import { execFileSync } from 'child_process';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const userData = arg(
  'userdata',
  join(homedir(), 'Library', 'Application Support', 'harness'),
);
const sinceMs = (() => {
  const raw = arg('since', null);
  return raw ? new Date(raw).getTime() : 0;
})();

const fmtUsd = (n) => `$${n.toFixed(4)}`;
const fmtTok = (n) => n.toLocaleString('en-US');

// ── 1. Attribution JSONL ─────────────────────────────────────────────────────
function readAttribution() {
  const dir = process.env.AIO_COST_ATTRIBUTION_DIR || join(userData, 'cost-attribution');
  if (!existsSync(dir)) {
    console.error(`(no attribution dir at ${dir} — run a session with AIO_COST_ATTRIBUTION=1 first)\n`);
    return [];
  }
  const records = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (typeof rec?.ts==='number' && Number.isFinite(rec.ts) && rec.ts >= sinceMs) records.push(rec);
      } catch {
        /* skip malformed line */
      }
    }
  }
  return records;
}

function reportAttribution(records) {
  records=records.filter(r=>!r.subagentUsage && !r.reviewDispatch && !r.reviewLifecycle
    && r.auxiliarySpendReservationUsd===undefined && r.provider!=='local-fallback' && r.auxRoutedTo!=='fallback');
  console.log('## Per-task-type ranking (attribution JSONL — primary)\n');
  if (records.length === 0) return;
  const byType = new Map();
  let historicalUnknown = 0;
  for (const r of records) {
    const key = `${r.taskType} [${r.provider ?? '?'}/${r.model ?? '?'}]`;
    const agg = byType.get(key) ?? { calls: 0, in: 0, out: 0, cacheR: 0, cacheW: 0, cost: 0, costUnknown: 0 };
    agg.calls += 1;
    agg.in += r.usage?.inputTokens ?? 0;
    agg.out += r.usage?.outputTokens ?? 0;
    agg.cacheR += r.usage?.cacheReadTokens ?? 0;
    agg.cacheW += r.usage?.cacheWriteTokens ?? 0;
    // Same conservative view as the Costs page: legacy Claude instance turns
    // contain running totals but lack native session identity for reconciliation.
    const unreconciled = r.source === 'instance-turn' && r.costSource === undefined
      && (r.provider === 'claude' || r.provider === 'claude-cli');
    if (unreconciled) historicalUnknown += 1;
    const source = unreconciled ? 'unknown' : r.costSource ?? (r.costKnown === false ? 'unknown' : 'provider');
    const cost = r.usage?.cost;
    if (source !== 'unknown' && typeof cost === 'number' && Number.isFinite(cost) && cost >= 0) agg.cost += cost;
    else agg.costUnknown += 1;
    byType.set(key, agg);
  }
  const rows = [...byType.entries()].sort((a, b) => b[1].cost - a[1].cost);
  const total = rows.reduce((s, [, v]) => s + v.cost, 0);
  console.log('| task-type [provider/model] | calls | input tok | output tok | cache r/w | cost | % of total |');
  console.log('|---|---:|---:|---:|---:|---:|---:|');
  for (const [key, v] of rows) {
    const pct = total > 0 ? ((v.cost / total) * 100).toFixed(1) : '0.0';
    const unknown = v.costUnknown > 0 ? ` (${v.costUnknown} cost-unknown)` : '';
    console.log(
      `| ${key} | ${v.calls} | ${fmtTok(v.in)} | ${fmtTok(v.out)} | ${fmtTok(v.cacheR)}/${fmtTok(v.cacheW)} | ${fmtUsd(v.cost)}${unknown} | ${pct}% |`,
    );
  }
  console.log(`\nTotal attributed cost: ${fmtUsd(total)} across ${records.length} calls.\n`);
  if (historicalUnknown) console.log(`${historicalUnknown} historical Claude calls have uncorrected running totals in the cost log. Their dollar amounts are excluded here. Original logs are unchanged.\n`);
}

function reportSubagents(records) {
  const groups=new Map();
  for (const record of records.filter(record=>record.subagentUsage===true)) {
    const key=`${new Date(record.ts).toISOString().slice(0,10)} [${record.sessionId ?? record.instanceId ?? '?'}]`;
    const group=groups.get(key) ?? [];group.push(record);groups.set(key,group);
  }
  if (!groups.size) return;
  const percentile=(records,key,pct)=>{
    const values=records.map(record=>record[key]).filter(value=>typeof value==='number' && Number.isFinite(value)).sort((a,b)=>a-b);
    return values.length ? values[Math.max(0,Math.ceil(values.length*pct)-1)] : 0;
  };
  console.log('## Subagents — last context size, not a cost\n');
  console.log('| day [parent session] | count | final size median / p90 | tool uses median / p90 | duration ms median / p90 |');
  console.log('|---|---:|---:|---:|---:|');
  for (const [key,group] of groups) console.log(`| ${key} | ${group.length} | ${percentile(group,'finalContextTokens',0.5)} / ${percentile(group,'finalContextTokens',0.9)} | ${percentile(group,'toolUses',0.5)} / ${percentile(group,'toolUses',0.9)} | ${percentile(group,'durationMs',0.5)} / ${percentile(group,'durationMs',0.9)} |`);
}

// ── 2/3. SQLite cross-checks ────────────────────────────────────────────────
function sqlLiteral(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function bindSqlParams(sql, params) {
  let i = 0;
  return sql.replaceAll('?', () => sqlLiteral(params[i++]));
}

function queryWithSqliteCli(path, sql, params, reason) {
  const suffix = reason ? `: ${reason}` : '';
  console.error(`(using sqlite3 CLI fallback for ${path}${suffix})\n`);
  const output = execFileSync('sqlite3', ['-json', path, bindSqlParams(sql, params)], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
  return output ? JSON.parse(output) : [];
}

function queryRows(path, sql, params = []) {
  if (!existsSync(path)) return null;
  if (process.env.AIO_COST_AUDIT_SQLITE_DRIVER === 'cli') {
    try {
      return queryWithSqliteCli(path, sql, params, 'forced by AIO_COST_AUDIT_SQLITE_DRIVER=cli');
    } catch (err) {
      console.error(`(could not open ${path} with sqlite3 CLI: ${err.message})\n`);
      return null;
    }
  }

  try {
    const Database = require('better-sqlite3');
    const db = new Database(path, { readonly: true, fileMustExist: true });
    try {
      return db.prepare(sql).all(...params);
    } finally {
      db.close();
    }
  } catch (err) {
    try {
      return queryWithSqliteCli(path, sql, params, err.message);
    } catch (fallbackErr) {
      console.error(`(could not open ${path}: ${err.message}; sqlite3 fallback failed: ${fallbackErr.message})\n`);
    }
    return null;
  }
}

function reportCostEntries() {
  const rows = queryRows(
    join(userData, 'rlm', 'rlm.db'),
    `SELECT model, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
            SUM(cache_read_tokens) AS cache_r, SUM(cache_write_tokens) AS cache_w, SUM(cost) AS cost
     FROM cost_entries WHERE timestamp >= ? GROUP BY model ORDER BY cost DESC`,
    [sinceMs],
  );
  if (!rows) return;
  console.log('## Cross-check: cost_entries (instance turns, CostTracker)\n');
  console.log('| model | calls | input | output | cache r/w | cost |');
  console.log('|---|---:|---:|---:|---:|---:|');
  for (const r of rows) {
    console.log(
      `| ${r.model} | ${r.calls} | ${fmtTok(r.input ?? 0)} | ${fmtTok(r.output ?? 0)} | ${fmtTok(r.cache_r ?? 0)}/${fmtTok(r.cache_w ?? 0)} | ${fmtUsd(r.cost ?? 0)} |`,
    );
  }
  console.log('');
}

function reportLoopIterations() {
  // defaultLoopDbPath() = <userData>/loop-mode/loop-mode.db (loop-store.ts).
  const candidates = [join(userData, 'loop-mode', 'loop-mode.db')].filter(existsSync);
  if (candidates.length === 0) {
    console.log(`(no loop DB found under ${userData} — check defaultLoopDbPath() in loop-store.ts)\n`);
    return;
  }
  const rows = queryRows(
    candidates[0],
    `SELECT loop_run_id, COUNT(*) AS iters, SUM(tokens) AS tokens, SUM(cost_cents) AS cost_cents
     FROM loop_iterations WHERE started_at >= ? GROUP BY loop_run_id ORDER BY cost_cents DESC LIMIT 20`,
    [sinceMs],
  );
  if (!rows) return;
  console.log(`## Cross-check: loop_iterations (${candidates[0]})\n`);
  console.log('| loop run | iterations | tokens | cost |');
  console.log('|---|---:|---:|---:|');
  for (const r of rows) {
    console.log(
      `| ${r.loop_run_id} | ${r.iters} | ${fmtTok(r.tokens ?? 0)} | ${fmtUsd((r.cost_cents ?? 0) / 100)} |`,
    );
  }
  console.log('');
}

if (process.argv.includes('--compare-transcripts')) {
  const day=arg('day',null);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('--day YYYY-MM-DD is required');
  const start=new Date(`${day}T00:00:00`).getTime();
  const local=new Date(start);
  const localDay=`${local.getFullYear()}-${String(local.getMonth()+1).padStart(2,'0')}-${String(local.getDate()).padStart(2,'0')}`;
  if (!Number.isFinite(start) || localDay !== day) throw new Error('Invalid --day');
  const next=new Date(start); next.setDate(next.getDate()+1);
  const end=next.getTime();
  const rows=queryRows(join(userData,'rlm','rlm.db'),
    'SELECT * FROM cost_entries WHERE timestamp >= ? AND timestamp < ?',[start,end]);
  if (!rows) throw new Error('Cannot read cost_entries');
  const providers=new Map();
  for (const record of readAttribution()) if (record.instanceId && record.model && record.provider) {
    providers.set(JSON.stringify([record.instanceId,record.model]),record.provider.replace(/-cli$/,''));
  }
  const claudeRows=rows.filter(row => {
    const provider=providers.get(JSON.stringify([row.instance_id,row.model]));
    return provider ? provider==='claude' : /^(opus|sonnet|haiku|fable)(\[1m\])?$/.test(row.model) || row.model.startsWith('claude-');
  });
  const profiles=join(userData,'claude-cli-profiles');
  const projects=arg('projects',null);
  const roots=projects ? [projects] : [join(homedir(),'.claude','projects'),
    ...(existsSync(profiles) ? readdirSync(profiles).map(profile=>join(profiles,profile,'projects')) : [])];
  const pricePath=arg('prices',null);
  const prices=pricePath ? JSON.parse(readFileSync(pricePath,'utf8')) : {};
  const threshold=Number(arg('max-diff-pct','5'));
  if (!Number.isFinite(threshold) || threshold<0) throw new Error('Invalid --max-diff-pct');
  const byModel=queryRows(join(userData,'rlm','rlm.db'),
    `SELECT u.model, SUM(u.input_tokens) AS input, SUM(u.output_tokens) AS output,
      SUM(u.cache_read_tokens) AS cacheRead, SUM(u.cache_write_tokens) AS cacheWrite, SUM(u.cost_usd) AS cost
      FROM cost_entry_model_usage u JOIN cost_entries e ON e.id=u.entry_id
      WHERE e.timestamp >= ? AND e.timestamp < ? AND e.id IN (${claudeRows.map(()=>'?').join(',') || 'NULL'}) GROUP BY u.model`,[start,end,...claudeRows.map(row=>row.id)]) ?? [];
  const report=compareTranscriptCosts({rows:claudeRows,roots,start,end,prices,maxDiffPct:threshold,byModel});
  if (process.argv.includes('--json')) console.log(JSON.stringify({day,...report},null,2));
  else {
    console.log(`Claude ${day}: stored ${fmtUsd(report.stored)}, transcripts ${fmtUsd(report.transcript)} (main ${fmtUsd(report.main)}, subagent ${fmtUsd(report.subagent)}), gap ${report.gapPct ?? 'unbounded'}%`);
    console.log(JSON.stringify(report,null,2));
  }
  process.exitCode=report.exceeded ? 1 : 0;
} else {
console.log(`# Claude cost audit report\n`);
console.log(`userData: ${userData}`);
console.log(`since: ${sinceMs ? new Date(sinceMs).toISOString() : '(all time)'}\n`);
const attribution=readAttribution();
reportAttribution(attribution);
reportSubagents(attribution);
reportCostEntries();
reportLoopIterations();

}
