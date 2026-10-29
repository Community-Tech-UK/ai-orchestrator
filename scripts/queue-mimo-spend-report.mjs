#!/usr/bin/env node
/** Read-only MiMo allowance attribution. No transcript or credential columns are read. */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

// Xiaomi Token Plan page (https://platform.xiaomimimo.com/), rates recorded 2026-10-28.
const RATES = {
  'mimo-v2.6-pro': { cacheHit: 2.5, input: 300, output: 600 },
  'mimo-v2.6-flash': { cacheHit: 2, input: 100, output: 200 },
};
function options(args) {
  const result = { since: '7d', json: false };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--json') result.json = true;
    else if (['--since', '--opencode-db', '--queue-db'].includes(key) && args[i + 1] && !args[i + 1].startsWith('--')) result[key.slice(2)] = args[++i];
    else throw new Error(`Invalid argument: ${key}`);
  }
  const days = /^(\d+)d$/.exec(result.since);
  const timestamp = days ? Date.now() - Number(days[1]) * 86400000 : Date.parse(`${result.since}T00:00:00Z`);
  if (!Number.isFinite(timestamp) || (!days && (!/^\d{4}-\d{2}-\d{2}$/.test(result.since) || new Date(timestamp).toISOString().slice(0, 10) !== result.since))) throw new Error('Invalid --since (expected 7d or YYYY-MM-DD)');
  return { ...result, timestamp };
}
function query(db, sql) {
  const result = execFileSync('sqlite3', ['-readonly', '-json', db, sql], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  return result ? JSON.parse(result) : [];
}
const literal = value => `'${String(value).replaceAll("'", "''")}'`;
function checkSchema(openCode, queue) {
  const error = 'OpenCode database layout not supported (expected tables session and message)';
  const tables = query(openCode, "select name from sqlite_master where type='table' and name in ('session','message')");
  const columns = query(openCode, 'pragma table_info(session)').map(row => row.name);
  if (tables.length !== 2 || !['directory', 'time_created', 'version'].every(name => columns.includes(name))) throw new Error(error);
  if (!query(queue, "select name from sqlite_master where type='table' and name='plan_queue_items'").length) throw new Error('Queue database layout not supported (expected table plan_queue_items)');
}
function messages(db, sessions) {
  const rows = [];
  for (let start = 0; start < sessions.length; start += 200) {
    const ids = sessions.slice(start, start + 200).map(session => literal(session.id)).join(',');
    rows.push(...query(db, `select session_id, time_created, json_extract(data,'$.role') role, json_extract(data,'$.modelID') model, json_extract(data,'$.providerID') provider, json_extract(data,'$.tokens.input') input, json_extract(data,'$.tokens.output') output, json_extract(data,'$.tokens.reasoning') reasoning, json_extract(data,'$.tokens.cache.read') cache_read from message where session_id in (${ids}) order by session_id, time_created`).filter(row => row.role === 'assistant' && row.model?.startsWith('mimo')));
  }
  return rows;
}
function matchItem(session, items, since) {
  const slug = basename(session.directory);
  const direct = items.find(item => item.worktree_path?.endsWith(`/${slug}`) || item.branch_name?.endsWith(slug));
  if (direct) return { item: direct, matchType: 'worktree or branch' };
  const name = slug.replace(/-[a-z0-9]{6}$/i, '');
  const byName = items.find(item => item.updated_at >= since && item.document_path?.includes(name));
  return { item: byName, matchType: byName ? 'matched by name' : 'unmatched' };
}
function buildReport(db, queue, since) {
  // Select time-bounded queue sessions BEFORE touching message data in this large database.
  const sessions = query(db, `select id, directory, version, time_created from session where time_created >= ${since} and directory like '%/.worktrees/queue/%'`);
  const others = query(db, `select id, directory, version, time_created from session where time_created >= ${since} and directory not like '%/.worktrees/queue/%'`);
  const items = query(queue, 'select document_path, state, park_reason, worktree_path, branch_name, updated_at from plan_queue_items order by updated_at desc');
  // Outcomes belong to the latest queue item for a document, including reruns
  // whose worktree differs from an earlier contributing session.
  const latestItems = new Map();
  for (const item of items) if (!latestItems.has(item.document_path)) latestItems.set(item.document_path, item);
  const sessionMap = new Map(sessions.map(session => [session.id, session]));
  const documents = new Map(), days = new Map(), previous = new Map(), unknown = new Set(), drops = [];
  for (const message of [...messages(db, sessions), ...messages(db, others)]) {
    const rate = RATES[message.model];
    if (!rate) unknown.add(message.model);
    const input = message.input ?? 0, cache = message.cache_read ?? 0;
    const components = rate ? { input: input * rate.input, cached: cache * rate.cacheHit, output: ((message.output ?? 0) + (message.reasoning ?? 0)) * rate.output } : null;
    const credits = components ? components.input + components.cached + components.output : null;
    const dayKey = new Date(message.time_created).toISOString().slice(0, 10);
    const day = days.get(dayKey) ?? { day: dayKey, requests: 0, credits: 0, queueCredits: 0, unknownRequests: 0 };
    day.requests++; if (credits === null) day.unknownRequests++; else day.credits += credits;
    const session = sessionMap.get(message.session_id);
    if (session && credits !== null) day.queueCredits += credits;
    days.set(dayKey, day);
    if (!session) continue;
    const { item: matchedItem, matchType } = matchItem(session, items, since);
    const item = matchedItem ? latestItems.get(matchedItem.document_path) : undefined;
    const key = item?.document_path ?? session.directory;
    const row = documents.get(key) ?? { repository: item?.document_path?.includes('/docs/') ? item.document_path.split('/docs/')[0] : session.directory.split('/.worktrees/queue/')[0], document: basename(item?.document_path ?? session.directory), documentPath: item?.document_path ?? null, state: item?.state ?? null, parkReason: item?.park_reason ?? null, sessions: new Set(), requests: 0, context: 0, credits: 0, inputCredits: 0, cachedCredits: 0, outputCredits: 0, cacheDrops: 0, cacheDropInputCredits: 0, matchType };
    row.sessions.add(session.id); row.requests++; row.context += input + cache;
    if (credits === null) row.credits = null;
    else { if (row.credits !== null) row.credits += credits; row.inputCredits += components.input; row.cachedCredits += components.cached; row.outputCredits += components.output; }
    const prior = previous.get(session.id);
    if (prior && cache < 0.5 * (prior.cache_read ?? 0) && input >= 20000) {
      row.cacheDrops++;
      if (!rate) row.cacheDropInputCredits = null;
      else if (row.cacheDropInputCredits !== null) row.cacheDropInputCredits += input * rate.input;
      drops.push({ sessionId: session.id, time: message.time_created, secondsSincePrevious: (message.time_created - prior.time_created) / 1000, previousCachedInput: prior.cache_read ?? 0, input, credits: rate ? input * rate.input : null });
    }
    previous.set(session.id, message); documents.set(key, row);
  }
  const rows = [...documents.values()].map(row => { const { context, ...rest } = row; return { ...rest, sessions: row.sessions.size, averageContextThousands: context / row.requests / 1000 }; }).sort((a, b) => (b.credits ?? -1) - (a.credits ?? -1));
  const landed = rows.filter(row => row.state === 'landed').length;
  const knownCredits = rows.reduce((sum, row) => sum + row.inputCredits + row.cachedCredits + row.outputCredits, 0);
  const credits = rows.some(row => row.credits === null) ? null : knownCredits;
  return { documents: rows, days: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).map(day => ({ ...day, credits: day.unknownRequests ? null : day.credits, queueShare: day.unknownRequests ? null : day.credits ? day.queueCredits / day.credits : 0 })), totals: { documents: rows.length, landedDocuments: landed, requests: rows.reduce((sum, row) => sum + row.requests, 0), credits, knownCredits, creditsPerLandedDocument: landed && credits !== null ? credits / landed : null }, cacheDrops: drops, footer: { since: new Date(since).toISOString(), until: new Date().toISOString(), versions: [...new Set([...sessions, ...others].map(session => session.version))].sort(), nightDiscountApplied: false, ratesDate: '2026-10-28' }, warnings: [...unknown].sort().map(model => `Unknown MiMo model: ${model}; credits unavailable`) };
}
const billions = value => value === null ? 'unknown' : (value / 1e9).toFixed(4);
const cell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
function markdown(report) {
  const lines = ['# Queue MiMo spend', '', '| Repository | Document | State | Park reason | Sessions | Requests | Avg context (k) | Credits (B) | New / cached / output (B) | Cache drops / input credits (B) | Match |', '|---|---|---|---|---:|---:|---:|---:|---|---|---|'];
  for (const row of report.documents) lines.push(`| ${[row.repository, row.document, row.state, row.parkReason, row.sessions, row.requests, row.averageContextThousands.toFixed(1), billions(row.credits), `${billions(row.inputCredits)} / ${billions(row.cachedCredits)} / ${billions(row.outputCredits)}`, `${row.cacheDrops} / ${billions(row.cacheDropInputCredits)}`, row.matchType].map(cell).join(' | ')} |`);
  lines.push('', '| Day (UTC) | Requests (all MiMo) | Credits (B) | Queue share |', '|---|---:|---:|---:|');
  for (const day of report.days) lines.push(`| ${day.day} | ${day.requests} | ${billions(day.credits)} | ${day.queueShare === null ? 'unknown' : (100 * day.queueShare).toFixed(1) + '%'} |`);
  lines.push('', `Documents: ${report.totals.documents}; landed documents: ${report.totals.landedDocuments}; requests: ${report.totals.requests}; credits (B): ${billions(report.totals.credits)}; credits per landed document (B): ${billions(report.totals.creditsPerLandedDocument)}`, '', `Window: ${report.footer.since} to ${report.footer.until}; sessions created in this window. OpenCode versions: ${report.footer.versions.join(', ')}. Night discount not applied. Rates date: ${report.footer.ratesDate}.`);
  return lines.join('\n');
}
try {
  const config = options(process.argv.slice(2));
  const db = config['opencode-db'] ?? (process.env.OPENCODE_DB?.trim() || join(process.env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share'), 'opencode', 'opencode.db'));
  const queue = config['queue-db'] ?? join(homedir(), 'Library', 'Application Support', 'harness', 'loop-mode', 'loop-mode.db');
  checkSchema(db, queue);
  const report = buildReport(db, queue, config.timestamp);
  for (const warning of report.warnings) console.error(warning);
  console.log(config.json ? JSON.stringify(report, null, 2) : markdown(report));
} catch (error) {
  // Child-process errors can include SQL and output; print only a bounded diagnostic.
  console.error(error.message.startsWith('Command failed:') ? 'Could not read the report databases with sqlite3' : error.message);
  process.exitCode = 2;
}
