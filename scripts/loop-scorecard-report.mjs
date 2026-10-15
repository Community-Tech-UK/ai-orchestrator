#!/usr/bin/env node
/** Read-only loop scorecards. Build main first; never runs migrations or writes a database. */
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
function openReadOnly(path) {
  try { const Database = require('better-sqlite3'); return new Database(path, {readonly:true,fileMustExist:true}); }
  catch (nativeError) {
    const query = (sql,params) => {
      let i=0;
      const bound=sql.replaceAll('?',()=>{const value=params[i++];return typeof value === 'number' ? String(value) : `'${String(value).replaceAll("'","''")}'`;});
      const output=execFileSync('sqlite3',['-readonly','-json',path,bound],{encoding:'utf8',maxBuffer:8*1024*1024}).trim();
      return output ? JSON.parse(output) : [];
    };
    try {query('SELECT 1',[]);} catch {throw nativeError;}
    return {prepare:sql=>({all:(...params)=>query(sql,params),get:(...params)=>query(sql,params)[0]}),close:()=>{}};
  }
}
const { loadScorecardInputs } = require('../dist/main/orchestration/loop-store-spend.js');
const { buildLoopScorecard, scorecardLines } = require('../dist/main/orchestration/loop-scorecard.js');
const db = openReadOnly(arg('db', join(homedir(), 'Library', 'Application Support', 'harness', 'loop-mode', 'loop-mode.db')));
try {
  const runId = arg('run', null); const since = arg('since', null);
  const sinceMs = since ? new Date(since).getTime() : 0;
  if (!Number.isFinite(sinceMs)) throw new Error('Invalid --since date');
  if (runId && since) throw new Error('Choose --run or --since');
  const runs = runId ? db.prepare('SELECT id, status FROM loop_runs WHERE id = ?').all(runId) : db.prepare('SELECT id, status FROM loop_runs WHERE started_at >= ? ORDER BY started_at').all(sinceMs);
  const cards = runs.map(run => ({ ...run, scorecard: buildLoopScorecard(loadScorecardInputs(db,run.id)) }));
  if (process.argv.includes('--json')) console.log(JSON.stringify(cards,null,2));
  else {
    for (const row of cards) console.log(`Run ${row.id} (${row.status})\n${scorecardLines(row.scorecard).join('\n')}\n`);
    const unfinished = cards.filter(row => !['completed','completed-needs-review'].includes(row.status));
    console.log(`Spent on runs that did not finish: $${(unfinished.reduce((sum,row) => sum+row.scorecard.costCents,0)/100).toFixed(2)} across ${unfinished.length} of ${cards.length} runs`);
  }
} finally { db.close(); }
