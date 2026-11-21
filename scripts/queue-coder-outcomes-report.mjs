#!/usr/bin/env node
/** Read-only queue outcomes and reporting receipts. Never emits transcript text. */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

function accepted(value) {
  if (!value || typeof value !== 'object' || value.isError === true) return false;
  if (value.accepted === true) return true;
  if (Array.isArray(value)) return value.some(accepted);
  if (value.type === 'text' && typeof value.text === 'string') return parseAccepted(value.text);
  return accepted(value.structuredContent) || accepted(value.content);
}
function parseAccepted(text) {
  try { return accepted(JSON.parse(text)); } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}
function readBounded(file) {
  if (statSync(file).size > 32 * 1024 * 1024) throw new Error('Checker history file exceeds the report limit');
  return readFileSync(file);
}

function readCheckerHistory(directory, items) {
  const byItem = new Map(items.map(item => [item.id, []]));
  const coverage = { archivesRead: 0, missingArchives: 0, archivesWithoutEndTime: 0, acceptedReports: 0,
    checkerSessionsComplete: null, appliedVerdictsComplete: false };
  if (!directory) return { byItem, coverage: { ...coverage, supplied: false } };
  let index;
  try { index = JSON.parse(readBounded(join(directory, 'index.json')).toString()); }
  catch { throw new Error('Could not read checker history index'); }
  if (!Array.isArray(index.entries) || index.entries.length > 10000) throw new Error('Invalid checker history index');
  const earliest = Math.min(...items.map(item => item.created));
  const latest = Math.max(...items.map(item => item.updated));
  const seen = new Set();
  for (const entry of index.entries) {
    const hasEndTime = typeof entry.endedAt === 'number' && Number.isFinite(entry.endedAt);
    if ((hasEndTime && entry.endedAt < earliest) || entry.createdAt > latest) continue;
    if (entry.workingDirectory && !entry.workingDirectory.includes('/.worktrees/queue/')) continue;
    if (typeof entry.id !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(entry.id)) throw new Error('Invalid checker archive identity');
    if (!hasEndTime) coverage.archivesWithoutEndTime++;
    let data;
    try { data = JSON.parse(gunzipSync(readBounded(join(directory, `${entry.id}.json.gz`)), { maxOutputLength: 64 * 1024 * 1024 }).toString()); }
    catch (error) {
      if (error.code === 'ENOENT') { coverage.missingArchives++; continue; }
      throw new Error('Could not read checker archive');
    }
    if (!Array.isArray(data.messages)) throw new Error('Invalid checker archive messages');
    coverage.archivesRead++;
    const outcomes = new Map();
    for (const message of data.messages) {
      const id = message.metadata?.tool_use_id;
      if (!id || !['tool_result', 'tool_outcome'].includes(message.type)) continue;
      const records = outcomes.get(id) ?? []; records.push(message); outcomes.set(id, records);
    }
    for (const message of data.messages) {
      const meta = message.metadata;
      if (message.type !== 'tool_use' || typeof meta?.id !== 'string' || typeof meta.name !== 'string') continue;
      const name = meta.name;
      const args = /(?:^|[._])plan_queue_report_verdict$/.test(name) ? meta.input
        : /(?:^|[._])tool_execute$/.test(name) && meta.input?.name === 'plan_queue_report_verdict' ? meta.input.arguments : null;
      if (!args || !byItem.has(args.item_id)) continue;
      const receipt = outcomes.get(meta.id) ?? [];
      if (receipt.some(out => out.metadata?.is_error === true) || !receipt.some(out => typeof out.content === 'string' ? parseAccepted(out.content) : accepted(out.content))) continue;
      const identity = `${entry.historyThreadId ?? entry.originalInstanceId ?? entry.id}:${meta.id}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (typeof message.timestamp !== 'number' || !Number.isFinite(message.timestamp)) throw new Error('Invalid checker report timestamp');
      const round = /\(round (\d+)\)$/.exec(data.entry?.displayName ?? '');
      byItem.get(args.item_id).push({ timestamp: message.timestamp, reportedRound: round ? Number(round[1]) : null,
        verdict: args.verdict, findings: findings({ verdict: args.verdict, findings: args.findings ?? [] }) });
      coverage.acceptedReports++;
    }
  }
  for (const reports of byItem.values()) reports.sort((a, b) => a.timestamp - b.timestamp);
  return { byItem, coverage: { ...coverage, supplied: true } };
}

function options(args) {
  const result = { runs: [], json: false, db: join(homedir(), 'Library', 'Application Support', 'harness', 'loop-mode', 'loop-mode.db') };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') result.json = true;
    else if (['--run', '--queue-db', '--history-dir'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
      const value = args[++i];
      if (args[i - 1] === '--run') result.runs.push(value);
      else if (args[i - 1] === '--queue-db') result.db = value;
      else result.history = value;
    } else throw new Error('Usage: --run <id> [--run <id> ...] [--queue-db <path>] [--history-dir <path>] [--json]');
  }
  result.runs = [...new Set(result.runs)];
  if (!result.runs.length || result.runs.length > 50 || result.runs.some(id => id.length > 200)) throw new Error('Specify between 1 and 50 run ids');
  return result;
}
const literal = value => `'${value.replaceAll("'", "''")}'`;
const sum = values => values.reduce((a, b) => a + b, 0);
function numeric(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Invalid numeric queue evidence');
  return value;
}
function findings(verdict) {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  if (verdict === null) return counts;
  if (!['PASS', 'FAIL'].includes(verdict.verdict) || !Array.isArray(verdict.findings)) throw new Error('Invalid saved verdict');
  for (const finding of verdict.findings) {
    if (!Object.hasOwn(counts, finding.severity)) throw new Error('Invalid saved finding severity');
    counts[finding.severity]++;
  }
  return counts;
}
function report(config) {
  const ids = config.runs.map(literal).join(',');
  // One read transaction: items and run overhead must describe the same snapshot.
  const sql = `BEGIN; SELECT json_object('runs', json((SELECT json_group_array(json_object(
    'id', id, 'routing', json(config_json), 'cost', cost_usd, 'exact', exact_cost_usd))
    FROM plan_queue_runs WHERE id IN (${ids}))), 'items', json((SELECT json_group_array(json_object(
    'id', id, 'runId', run_id, 'document', document_path, 'state', state, 'parkReason', park_reason,
    'round', round, 'erroredRounds', errored_rounds, 'stepUp', stepped_up_at, 'verdict', json(verdict_json),
    'created', created_at, 'updated', updated_at, 'tokens', tokens, 'cost', cost_usd, 'exact', exact_cost_usd))
    FROM (SELECT * FROM plan_queue_items WHERE run_id IN (${ids}) ORDER BY created_at, id)))) AS snapshot; COMMIT;`;
  let snapshot;
  try {
    const raw = execFileSync('sqlite3', ['-readonly', '-json', config.db, sql], {
      encoding: 'utf8', timeout: 30_000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    });
    snapshot = JSON.parse(JSON.parse(raw)[0].snapshot);
  } catch { throw new Error('Could not read queue outcomes with sqlite3; check the database path and schema'); }
  if (snapshot.runs.length !== config.runs.length) throw new Error('One or more requested queue runs do not exist');
  const history = readCheckerHistory(config.history, snapshot.items);
  const documents = snapshot.items.map(item => {
    const cost = numeric(item.cost), exact = numeric(item.exact);
    if (exact > cost || numeric(item.updated) < numeric(item.created)) throw new Error('Inconsistent queue cost or timestamps');
    return { itemId: item.id, runId: item.runId, document: item.document, state: item.state, parkReason: item.parkReason,
      currentPhaseRounds: numeric(item.round), erroredRounds: numeric(item.erroredRounds), handedOver: item.stepUp !== null,
      firstCheckPass: null, totalRounds: null, finalVerdict: item.verdict?.verdict ?? null, findings: findings(item.verdict),
      checkerReports: history.byItem.get(item.id),
      earliestAvailableReportPass: history.byItem.get(item.id).length ? history.byItem.get(item.id)[0].verdict === 'PASS' : null,
      elapsedMinutes: (item.updated - item.created) / 60000, tokens: numeric(item.tokens),
      recordedUsd: cost > 0 ? cost : null, providerReportedUsd: exact, estimatedUsd: cost - exact };
  });
  const runs = snapshot.runs.map(run => {
    const rows = documents.filter(item => item.runId === run.id);
    const cost = numeric(run.cost), exact = numeric(run.exact);
    if (exact > cost) throw new Error('Inconsistent run cost');
    const recordedUsd = cost + sum(rows.map(item => item.recordedUsd ?? 0));
    const landed = rows.filter(item => item.state === 'landed').length;
    return { runId: run.id, routing: run.routing.routing ?? null, documents: rows.length, landed,
      handedOver: rows.filter(item => item.handedOver).length, recordedUsd,
      providerReportedUsd: exact + sum(rows.map(item => item.providerReportedUsd)), runOverheadUsd: cost,
      documentsWithoutRecordedCost: rows.filter(item => item.recordedUsd === null).length,
      recordedUsdPerLanded: landed ? recordedUsd / landed : null, costPerLandedUsd: null };
  });
  return { documents, runs, history: history.coverage, limitations: [
    'The round counter resets at handover and Resume. Total rounds and first-check passes require a complete, validated transcript history; latest verdicts alone cannot establish them.',
    'Elapsed time is the recorded creation-to-update window, including pauses and queue waits, not active model runtime.',
    'Costs are recorded lower bounds, separating provider-reported and estimated amounts. Zero counters do not establish complete or free usage. Run overhead is included once.',
    'Findings describe only the latest saved verdict, not all historical checker findings. No matched Opus comparison is implied by selecting multiple runs.',
    'With --history-dir, checkerReports contain deduplicated accepted reporting calls only. earliestAvailableReportPass describes only the earliest available call, even when earlier checks were never archived. A complete archive index does not prove complete checker-session coverage.',
    'Applied verdict history is not retained: accepted reports may be discarded at turn end, latest verdicts are overwritten, and round counters reset. Existing archives cannot recover first-check success, total applied rounds or all historical findings. Complete campaign measurement needs durable decision and spend coverage before the campaign starts.',
  ] };
}
const cell = value => String(value ?? 'unknown').replaceAll('|', '\\|').replaceAll('\r', ' ').replaceAll('\n', ' ');
function markdown(result) {
  const lines = ['# Queue coding outcomes', '', '| Run | Document | Outcome | Park reason | First check | Current phase rounds | Handed over | Minutes elapsed | Recorded USD | Findings (critical/high/medium/low) |', '|---|---|---|---|---|---:|---|---:|---:|---|'];
  for (const row of result.documents) lines.push(`| ${[row.runId, row.document, row.state, row.parkReason, row.firstCheckPass,
    row.currentPhaseRounds, row.handedOver ? 'yes' : 'no', row.elapsedMinutes.toFixed(1), row.recordedUsd?.toFixed(2),
    Object.values(row.findings).join('/')].map(cell).join(' | ')} |`);
  for (const run of result.runs) lines.push('', `Run ${cell(run.runId)}: ${run.landed}/${run.documents} landed; ${run.handedOver} handed over; $${run.recordedUsd.toFixed(2)} recorded, including $${run.runOverheadUsd.toFixed(2)} run overhead.`);
  lines.push('', ...result.limitations.map(note => `- ${note}`));
  return lines.join('\n');
}
try {
  const config = options(process.argv.slice(2)), result = report(config);
  console.log(config.json ? JSON.stringify(result, null, 2) : markdown(result));
} catch (error) { console.error(error.message); process.exitCode = 2; }
