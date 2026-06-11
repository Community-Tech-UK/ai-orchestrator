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
 *
 * Default userData on macOS: ~/Library/Application Support/ai-orchestrator
 * (pass --userdata if your app name/path differs — check the About panel or
 * `app.getPath('userData')`).
 *
 * Read-only: opens databases in readonly mode and only reads the JSONL files.
 */

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
  join(homedir(), 'Library', 'Application Support', 'ai-orchestrator'),
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
    console.log(`(no attribution dir at ${dir} — run a session with AIO_COST_ATTRIBUTION=1 first)\n`);
    return [];
  }
  const records = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.jsonl'))) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.ts >= sinceMs) records.push(rec);
      } catch {
        /* skip malformed line */
      }
    }
  }
  return records;
}

function reportAttribution(records) {
  console.log('## Per-task-type ranking (attribution JSONL — primary)\n');
  if (records.length === 0) return;
  const byType = new Map();
  for (const r of records) {
    const key = `${r.taskType} [${r.provider ?? '?'}/${r.model ?? '?'}]`;
    const agg = byType.get(key) ?? { calls: 0, in: 0, out: 0, cacheR: 0, cacheW: 0, cost: 0, costUnknown: 0 };
    agg.calls += 1;
    agg.in += r.usage?.inputTokens ?? 0;
    agg.out += r.usage?.outputTokens ?? 0;
    agg.cacheR += r.usage?.cacheReadTokens ?? 0;
    agg.cacheW += r.usage?.cacheWriteTokens ?? 0;
    agg.cost += r.usage?.cost ?? 0;
    if (r.costKnown === false) agg.costUnknown += 1;
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
}

// ── 2/3. SQLite cross-checks ────────────────────────────────────────────────
function openDb(path) {
  if (!existsSync(path)) return null;
  try {
    const Database = require('better-sqlite3');
    return new Database(path, { readonly: true, fileMustExist: true });
  } catch (err) {
    console.log(`(could not open ${path}: ${err.message})\n`);
    return null;
  }
}

function reportCostEntries() {
  const db = openDb(join(userData, 'rlm', 'rlm.db'));
  if (!db) return;
  console.log('## Cross-check: cost_entries (instance turns, CostTracker)\n');
  try {
    const rows = db
      .prepare(
        `SELECT model, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
                SUM(cache_read_tokens) AS cache_r, SUM(cache_write_tokens) AS cache_w, SUM(cost) AS cost
         FROM cost_entries WHERE timestamp >= ? GROUP BY model ORDER BY cost DESC`,
      )
      .all(sinceMs);
    console.log('| model | calls | input | output | cache r/w | cost |');
    console.log('|---|---:|---:|---:|---:|---:|');
    for (const r of rows) {
      console.log(
        `| ${r.model} | ${r.calls} | ${fmtTok(r.input ?? 0)} | ${fmtTok(r.output ?? 0)} | ${fmtTok(r.cache_r ?? 0)}/${fmtTok(r.cache_w ?? 0)} | ${fmtUsd(r.cost ?? 0)} |`,
      );
    }
    console.log('');
  } catch (err) {
    console.log(`(query failed: ${err.message})\n`);
  } finally {
    db.close();
  }
}

function reportLoopIterations() {
  // defaultLoopDbPath() = <userData>/loop-mode/loop-mode.db (loop-store.ts).
  const candidates = [join(userData, 'loop-mode', 'loop-mode.db')].filter(existsSync);
  if (candidates.length === 0) {
    console.log(`(no loop DB found under ${userData} — check defaultLoopDbPath() in loop-store.ts)\n`);
    return;
  }
  const db = openDb(candidates[0]);
  if (!db) return;
  console.log(`## Cross-check: loop_iterations (${candidates[0]})\n`);
  try {
    const rows = db
      .prepare(
        `SELECT loop_run_id, COUNT(*) AS iters, SUM(tokens) AS tokens, SUM(cost_cents) AS cost_cents
         FROM loop_iterations WHERE started_at >= ? GROUP BY loop_run_id ORDER BY cost_cents DESC LIMIT 20`,
      )
      .all(sinceMs);
    console.log('| loop run | iterations | tokens | cost |');
    console.log('|---|---:|---:|---:|');
    for (const r of rows) {
      console.log(
        `| ${r.loop_run_id} | ${r.iters} | ${fmtTok(r.tokens ?? 0)} | ${fmtUsd((r.cost_cents ?? 0) / 100)} |`,
      );
    }
    console.log('');
  } catch (err) {
    console.log(`(query failed: ${err.message})\n`);
  } finally {
    db.close();
  }
}

console.log(`# Claude cost audit report\n`);
console.log(`userData: ${userData}`);
console.log(`since: ${sinceMs ? new Date(sinceMs).toISOString() : '(all time)'}\n`);
reportAttribution(readAttribution());
reportCostEntries();
reportLoopIterations();
