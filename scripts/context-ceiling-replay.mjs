#!/usr/bin/env node
/**
 * context-ceiling-replay.mjs — the A4 context-ceiling replay (Step 3).
 *
 * Replays James's own Claude history and shows how much each possible context
 * ceiling would have saved, and how often it would have made a conversation
 * summarise. The numbers pick the defaults in Step 5. Read-only.
 *
 * Usage:
 *   npm run audit:context-ceiling -- [--projects <Claude projects dir> ...] (default: legacy + Harness account-profile histories)
 *     [--since <ISO date>] [--until <ISO date>] [--json] [--resume-cache] [--cold-returns]
 *     [--userdata <Electron userData dir>] [--prices <json: {model: {inputPerMTok, outputPerMTok}}>]
 *
 * Simulation (the sawtooth): for each ceiling C in {200K, 250K, 300K, 400K,
 * 600K, none} walk each session's requests in order. When the simulated
 * context passes C minus 33K, book one summary call (read C at the cache-read
 * price plus the median measured summary output) and drop the simulated
 * context to F, the median measured size of the first request after a real
 * compact_boundary (fallback 40K if fewer than 5 are found). Each later
 * request keeps its real growth and is priced at its simulated context: the
 * cached history is read at 0.1x, cold-cache writes are re-priced at the
 * simulated size, and writes are priced at 1.25x/2x by the measured
 * 5-minute/1-hour split.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import {
  CACHE_READ_MULT,
  CACHE_WRITE_5M_MULT,
  CACHE_WRITE_1H_MULT,
  activityReturns,
  resumeRestarts,
  transcriptProjectsDirs,
  isRecent,
  listTranscripts,
  measuredSummaryFloors,
  median,
  p90,
  parseTranscript,
  priceFor,
} from './lib/claude-transcripts.mjs';

const require = createRequire(import.meta.url);

export const CEILINGS = [200_000, 250_000, 300_000, 400_000, 600_000, null];
export const SUMMARY_MARGIN = 33_000;
export const DEFAULT_SUMMARY_FLOOR = 40_000;
export const DEFAULT_SUMMARY_OUTPUT = 2_000;

export function parseArgs(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  const projectsDirs = argv.flatMap((arg, i) => arg === '--projects' && argv[i + 1] ? [resolve(argv[i + 1])] : []);
  const userData = get('userdata', join(homedir(), 'Library', 'Application Support', 'harness'));
  if (projectsDirs.length === 0) {
    projectsDirs.push(...transcriptProjectsDirs(userData));
  }
  return {
    projectsDir: projectsDirs[0],
    projectsDirs: [...new Set(projectsDirs)],
    userData,
    sinceMs: get('since', null) ? new Date(get('since', null)).getTime() : 0,
    untilMs: get('until', null) ? new Date(get('until', null)).getTime() : Number.MAX_SAFE_INTEGER,
    json: argv.includes('--json'),
    resumeCache: argv.includes('--resume-cache'),
    coldReturns: argv.includes('--cold-returns'),
    prices: get('prices', null) ? JSON.parse(get('prices', null)) : null,
  };
}

// ── SQLite (read-only; better-sqlite3 with a sqlite3 CLI fallback) ──────────

function sqlLiteral(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '0';
  if (value === null || value === undefined) return 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}

function bindSqlParams(sql, params) {
  let i = 0;
  return sql.replaceAll('?', () => sqlLiteral(params[i++]));
}

export function queryRows(path, sql, params = []) {
  if (!path || !existsSync(path)) return null;
  if (process.env.AIO_CONTEXT_REPLAY_SQLITE_DRIVER === 'cli') {
    try {
      return queryCli(path, sql, params);
    } catch {
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
  } catch {
    try {
      return queryCli(path, sql, params);
    } catch {
      return null;
    }
  }
}

function queryCli(path, sql, params) {
  const output = execFileSync('sqlite3', ['-readonly', '-json', path, bindSqlParams(sql, params)], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
  return output ? JSON.parse(output) : [];
}

// ── Purpose joins (read-only) ───────────────────────────────────────────────

/**
 * transcript session id → purpose. `own-chat` when the session has no Harness
 * marker; `unclassified` when it has the marker but no join.
 */
export function buildPurposeLookup(userData) {
  const instancePurpose = new Map();
  const chatPurpose = new Map();
  const loopDb = join(userData, 'loop-mode', 'loop-mode.db');
  const rlmDb = join(userData, 'rlm', 'rlm.db');

  for (const row of queryRows(loopDb, 'SELECT id, worker_instance_id, verifier_instance_id FROM plan_queue_items') ?? []) {
    if (row.worker_instance_id) instancePurpose.set(row.worker_instance_id, 'plan-queue');
    if (row.verifier_instance_id) instancePurpose.set(row.verifier_instance_id, 'plan-queue');
  }
  for (const row of queryRows(loopDb, 'SELECT loop_run_id, child_instance_id FROM loop_iterations WHERE child_instance_id IS NOT NULL') ?? []) {
    if (row.child_instance_id) instancePurpose.set(row.child_instance_id, 'loop');
  }
  for (const row of queryRows(loopDb, 'SELECT chat_id FROM loop_runs WHERE chat_id IS NOT NULL') ?? []) {
    if (row.chat_id) chatPurpose.set(row.chat_id, 'loop');
  }
  for (const row of queryRows(rlmDb, 'SELECT instance_id FROM automation_runs WHERE instance_id IS NOT NULL') ?? []) {
    if (row.instance_id && !instancePurpose.has(row.instance_id)) instancePurpose.set(row.instance_id, 'automation');
  }
  const sessionToInstance = new Map();
  for (const row of queryRows(rlmDb, 'SELECT session_id, instance_id FROM cost_entries') ?? []) {
    if (row.session_id && row.instance_id) sessionToInstance.set(row.session_id, row.instance_id);
  }
  return {
    purposeOf(sessionId) {
      const instanceId = sessionToInstance.get(sessionId);
      if (instanceId && instancePurpose.has(instanceId)) return instancePurpose.get(instanceId);
      if (chatPurpose.has(sessionId)) return chatPurpose.get(sessionId);
      return null;
    },
  };
}

export function classifySession({ kind, sessionId, isHarness }, lookup) {
  if (kind === 'subagent') return 'subagent';
  if (!isHarness) return 'own-chat';
  const purpose = lookup.purposeOf(sessionId);
  if (purpose) return purpose;
  return 'unclassified';
}

// ── Pricing ─────────────────────────────────────────────────────────────────

function requestCostInputUnits(request, writeOverride) {
  const write5m = writeOverride !== undefined ? writeOverride.write5m : request.cacheWrite5m;
  const write1h = writeOverride !== undefined ? writeOverride.write1h : request.cacheWrite1h;
  return request.input
    + request.cacheRead * CACHE_READ_MULT
    + write5m * CACHE_WRITE_5M_MULT
    + write1h * CACHE_WRITE_1H_MULT;
}

function inputUnitsToUsd(inputUnits, price) {
  return (inputUnits * price.inputPerMTok) / 1_000_000;
}

function outputToUsd(outputTokens, price) {
  return (outputTokens * price.outputPerMTok) / 1_000_000;
}

// ── The sawtooth simulation ─────────────────────────────────────────────────

/**
 * Simulate one session at one ceiling. Returns the simulated cost in USD and
 * the number of summary calls booked.
 *
 * Each request processes its simulated context `simContext_i` tokens,
 * partitioned like the real request but at simulated scale (the three parts
 * always sum to `simContext_i`):
 *   - `input` stays real (uncached new tokens, priced 1x);
 *   - a request whose real cache read is empty while a previous context
 *     exists is a cold cache: the whole previous simulated context is
 *     re-written (no read);
 *   - otherwise the previous simulated context is read at 0.1x and only the
 *     growth is written at 1.25x/2x.
 * A real compact-boundary drop in the growth series drops the simulated
 * context too (the real sawtooth keeps its shape).
 */
export function simulateSession(requests, ceiling, floorTokens, summaryOutputTokens, priceOverrides) {
  if (requests.length === 0) return { simulatedUsd: 0, summaries: 0 };
  let simContext = 0;
  let summaries = 0;
  let simulatedUsd = 0;
  let previousRealContext = 0;
  // Until the first simulated summary the simulated world equals the real one,
  // so requests are priced exactly as recorded (this makes the 'none' row an
  // exact validation anchor: its saving is always 0).
  let diverged = false;
  for (const request of requests) {
    const growth = request.context - previousRealContext;
    previousRealContext = request.context;
    simContext = Math.max(0, simContext + growth);
    const price = priceFor(request.model, priceOverrides);
    if (!diverged) {
      simulatedUsd += inputUnitsToUsd(requestCostInputUnits(request), price);
      simulatedUsd += outputToUsd(request.output, price);
    } else {
      const input = Math.min(request.input, simContext);
      const cacheCold = request.cacheRead === 0 && simContext - growth > 0;
      const readSim = cacheCold ? 0 : Math.max(0, simContext - growth - input);
      const writeSim = Math.max(0, simContext - input - readSim);
      const write1hShare = request.cacheWrite5m + request.cacheWrite1h > 0
        ? request.cacheWrite1h / (request.cacheWrite5m + request.cacheWrite1h)
        : 0;
      const inputUnits = input
        + readSim * CACHE_READ_MULT
        + writeSim * ((1 - write1hShare) * CACHE_WRITE_5M_MULT + write1hShare * CACHE_WRITE_1H_MULT);
      simulatedUsd += inputUnitsToUsd(inputUnits, price);
      simulatedUsd += outputToUsd(request.output, price);
    }
    if (ceiling !== null && simContext > ceiling - SUMMARY_MARGIN) {
      const summaryPrice = priceFor(request.model, priceOverrides);
      simulatedUsd += inputUnitsToUsd(ceiling * CACHE_READ_MULT, summaryPrice);
      simulatedUsd += outputToUsd(summaryOutputTokens, summaryPrice);
      summaries += 1;
      simContext = floorTokens;
      diverged = true;
    }
  }
  return { simulatedUsd, summaries };
}

export function realSessionUsd(requests, priceOverrides) {
  let usd = 0;
  for (const request of requests) {
    const price = priceFor(request.model, priceOverrides);
    usd += inputUnitsToUsd(requestCostInputUnits(request), price);
    usd += outputToUsd(request.output, price);
  }
  return usd;
}

/**
 * Replay every session in `sessions` (each `{ className, requests }`) at every
 * ceiling and aggregate per class and ceiling.
 */
export function replay(sessions, floorTokens, summaryOutputTokens, priceOverrides) {
  const byClass = new Map();
  for (const session of sessions) {
    const bucket = byClass.get(session.className) ?? [];
    bucket.push(session);
    byClass.set(session.className, bucket);
  }
  const result = {};
  for (const [className, classSessions] of byClass) {
    result[className] = {};
    for (const ceiling of CEILINGS) {
      let realUsd = 0;
      let simulatedUsd = 0;
      let summarising = 0;
      const summariesPer = [];
      for (const session of classSessions) {
        realUsd += realSessionUsd(session.requests, priceOverrides);
        const sim = simulateSession(session.requests, ceiling, floorTokens, summaryOutputTokens, priceOverrides);
        simulatedUsd += sim.simulatedUsd;
        if (sim.summaries > 0) {
          summarising += 1;
          summariesPer.push(sim.summaries);
        }
      }
      result[className][ceiling === null ? 'none' : ceiling] = {
        realUsd,
        simulatedUsd,
        savingUsd: realUsd - simulatedUsd,
        sessions: classSessions.length,
        summarisingShare: classSessions.length > 0 ? summarising / classSessions.length : 0,
        summariesPerSession: summariesPer,
        summariesP50: median(summariesPer),
        summariesP90: p90(summariesPer),
      };
    }
  }
  return result;
}

// ── Decision rule (Step 3) ──────────────────────────────────────────────────

export const DECISION_RULE = {
  savingShareOf200k: 0.8,
  maxP90OwnChat: 2,
  maxP90Harness: 3,
};

/**
 * The smallest ceiling that keeps at least 80% of the saving available at
 * 200K, with p90 summaries per summarising session at most `maxP90`.
 * `rows` is one class group's `{ '200000': {...}, ..., 'none': {...} }`.
 */
/**
 * The `--resume-cache` guard (plan Step 3 / Step 4): of the restarts within
 * 55 minutes after a process that edited files or committed, the share whose
 * first request read at least 90% of the prior context from cache. Restarts
 * the transcript cannot judge are counted as `unknown`, never as kept;
 * `keptShareLowerBound` treats every unknown as a failure.
 */
export function summariseResumeCache(restarts) {
  const edited = restarts.filter((r) => r.category === 'edited');
  const unknown = restarts.filter((r) => r.category === 'unknown');
  const unknownReasons = {};
  for (const r of unknown) unknownReasons[r.unknownReason] = (unknownReasons[r.unknownReason] ?? 0) + 1;
  const kept = edited.filter((r) => r.kept).length;
  return {
    restarts: restarts.length,
    returns: edited.length,
    kept,
    keptShare: edited.length > 0 ? kept / edited.length : null,
    unknown: unknown.length,
    unknownReasons,
    keptShareLowerBound: edited.length + unknown.length > 0 ? kept / (edited.length + unknown.length) : null,
    excludedNoEdits: restarts.filter((r) => r.category === 'no-edits').length,
    excludedCold: restarts.filter((r) => r.category === 'cold').length,
  };
}

export function pickCeiling(rows, maxP90) {
  const at200k = rows['200000'];
  if (!at200k) return { ceiling: null, reason: 'no 200K row' };
  if (!(at200k.savingUsd > 0)) {
    return { ceiling: null, reason: 'the replay finds no saving even at 200K; leave summarisation to Claude' };
  }
  const target = at200k.savingUsd * DECISION_RULE.savingShareOf200k;
  for (const ceiling of CEILINGS) {
    const key = ceiling === null ? 'none' : String(ceiling);
    const row = rows[key];
    if (!row) continue;
    if (row.savingUsd < target) continue;
    if (row.summariesP90 !== null && row.summariesP90 > maxP90) continue;
    return { ceiling, reason: `keeps ${((row.savingUsd / (at200k.savingUsd || 1)) * 100).toFixed(0)}% of the 200K saving, p90 summaries ${row.summariesP90}` };
  }
  return { ceiling: null, reason: 'no ceiling met both rules; fall back to the largest considered (600K) or none' };
}

/** Combine class rows into one decision group (sums per ceiling). */
export function combineRows(rowsByClass, classNames) {
  const combined = {};
  for (const ceiling of CEILINGS) {
    const key = ceiling === null ? 'none' : String(ceiling);
    let realUsd = 0;
    let simulatedUsd = 0;
    let sessions = 0;
    let summarising = 0;
    const summariesPer = [];
    for (const name of classNames) {
      const row = rowsByClass[name]?.[key];
      if (!row) continue;
      realUsd += row.realUsd;
      simulatedUsd += row.simulatedUsd;
      sessions += row.sessions;
      summarising += row.summarisingShare * row.sessions;
      summariesPer.push(...row.summariesPerSession);
    }
    combined[key] = {
      realUsd,
      simulatedUsd,
      savingUsd: realUsd - simulatedUsd,
      sessions,
      summarisingShare: sessions > 0 ? summarising / sessions : 0,
      summariesPerSession: summariesPer,
      summariesP50: median(summariesPer),
      summariesP90: p90(summariesPer),
    };
  }
  return combined;
}

// ── Rendering ───────────────────────────────────────────────────────────────

const fmtUsd = (n) => (n === null || n === undefined ? '—' : `$${n.toFixed(2)}`);
const fmtPct = (n) => (n === null || n === undefined ? '—' : `${(n * 100).toFixed(1)}%`);
const fmtTok = (n) => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-US'));
const CEILING_LABEL = { 200000: '200K', 250000: '250K', 300000: '300K', 400000: '400K', 600000: '600K', none: 'none' };

export function renderReport(data) {
  console.log('# Context-ceiling replay (A4)\n');
  console.log(`projects: ${data.projectsDir}`);
  console.log(`sessions: ${data.sessions} (${data.sessionsByClass.map(([k, v]) => `${k} ${v}`).join(', ')})`);
  console.log(`summary floor F: ${fmtTok(data.floorTokens)} (${data.floorSource})`);
  console.log(`median measured summary output: ${fmtTok(data.summaryOutputTokens)} tokens`);
  if (data.caveats.length > 0) {
    console.log(`caveats: ${data.caveats.join('; ')}`);
  }
  console.log('');
  for (const [className, rows] of Object.entries(data.classes)) {
    console.log(`## ${className}\n`);
    console.log('| ceiling | real spend | simulated spend | saving | sessions summarising | summaries p50/p90 |');
    console.log('|---|---:|---:|---:|---:|---|');
    for (const ceiling of CEILINGS) {
      const key = ceiling === null ? 'none' : String(ceiling);
      const row = rows[key];
      if (!row) continue;
      console.log(`| ${CEILING_LABEL[key]} | ${fmtUsd(row.realUsd)} | ${fmtUsd(row.simulatedUsd)} | ${fmtUsd(row.savingUsd)} | ${fmtPct(row.summarisingShare)} | ${row.summariesP50 ?? '—'}/${row.summariesP90 ?? '—'} |`);
    }
    console.log('');
  }
  console.log('## Parent-owned decision cohorts\n');
  console.log(`subagents: Harness-owned ${data.ownership.children.harness}, own-chat-owned ${data.ownership.children['own-chat']}, unresolved ${data.ownership.children.unknown}`);
  for (const [cohort, rows] of Object.entries(data.cohorts)) {
    console.log(`### ${cohort} (each transcript counted once)\n`);
    console.log('| ceiling | real spend | simulated spend | saving | sessions | summaries p50/p90 |');
    console.log('|---|---:|---:|---:|---:|---|');
    for (const ceiling of CEILINGS) {
      const key = ceiling === null ? 'none' : String(ceiling);
      const row = rows[key];
      console.log(`| ${CEILING_LABEL[key]} | ${fmtUsd(row.realUsd)} | ${fmtUsd(row.simulatedUsd)} | ${fmtUsd(row.savingUsd)} | ${row.sessions} | ${row.summariesP50 ?? '—'}/${row.summariesP90 ?? '—'} |`);
    }
    console.log('');
  }
  console.log('## Decision rule\n');
  console.log(`- own chats → ceiling ${data.decision.ownChat.ceiling === null ? 'none' : CEILING_LABEL[String(data.decision.ownChat.ceiling)]} (${data.decision.ownChat.reason})`);
  console.log(`- Harness-started work → ceiling ${data.decision.harness.ceiling === null ? 'none' : CEILING_LABEL[String(data.decision.harness.ceiling)]} (${data.decision.harness.reason})\n`);
  if (data.resumeCache) {
    console.log('## --resume-cache (the Step 4 guard)\n');
    const rc = data.resumeCache;
    console.log(`restarts within 55 minutes after edits: ${rc.returns}; kept ≥90% of the context in cache: ${rc.kept} (${fmtPct(rc.keptShare)})`);
    console.log(`unknown (the transcript cannot establish an element): ${rc.unknown}${rc.unknown > 0 ? ` (${Object.entries(rc.unknownReasons).map(([k, v]) => `${k} ${v}`).join(', ')})` : ''}; if every unknown failed: ${fmtPct(rc.keptShareLowerBound)}`);
    console.log(`excluded: ${rc.excludedNoEdits} restarts within 55 minutes after no edits; ${rc.excludedCold} after 55 minutes or more idle (cache expiry, see --cold-returns); of ${rc.restarts} restarts in all`);
    console.log('(a restart is the first request after a process-end `cost-state` record; edits come from Edit/Write/MultiEdit/NotebookEdit tool calls, git commit, or growth in the recorded lines changed; ordinary gaps with no restart are not counted)\n');
  }
  if (data.coldReturns) {
    console.log('## --cold-returns\n');
    console.log(`returns after 55 idle minutes: ${data.coldReturns.returns}; tokens re-written: ${fmtTok(data.coldReturns.rewrittenTokens)}`);
    console.log('');
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

export async function runReplay(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const lookup = buildPurposeLookup(options.userData);
  // Resolve aliases before selection so a config root listed twice cannot bill
  // the same physical transcript twice. Parent provenance is not mtime-filtered.
  const discovered = new Map();
  for (const root of options.projectsDirs) {
    for (const transcript of listTranscripts(root)) {
      const path = realpathSync(transcript.path);
      if (!discovered.has(path)) discovered.set(path, { ...transcript, path });
    }
  }
  const transcripts = [...discovered.values()].filter((t) => isRecent(t.path, options.sinceMs));
  const parsedByPath = new Map();
  const readParsed = (path) => {
    if (!parsedByPath.has(path)) parsedByPath.set(path, parseTranscript(path));
    return parsedByPath.get(path);
  };
  const ownership = { children: { harness: 0, 'own-chat': 0, unknown: 0 }, parentClasses: {} };
  const parentClassByPath = new Map();
  const readParentClass = (transcript) => {
    const parentPath = resolve(dirname(dirname(dirname(transcript.path))), `${transcript.sessionId}.jsonl`);
    if (!parentClassByPath.has(parentPath)) parentClassByPath.set(parentPath, (async () => {
      const parent = discovered.get(parentPath);
      if (!parent || parent.kind !== 'main') return null;
      try {
        const parsed = await readParsed(parentPath);
        // Empty/malformed provenance is unknown, never evidence for own-chat.
        if (!parsed.isHarness && parsed.entrypoint === null && parsed.requests.length === 0) return null;
        return classifySession({ ...parent, isHarness: parsed.isHarness }, lookup);
      } catch {
        return null;
      }
    })());
    return parentClassByPath.get(parentPath);
  };

  const sessions = [];
  const allFloors = [];
  const allPostTokens = [];
  const allSummaryOutputs = [];
  const allReturns = [];
  const allRestarts = [];
  const caveats = [];
  const unknownModels = new Set();
  let harnessMarkerOnly = 0;

  for (const transcript of transcripts) {
    const parsed = await readParsed(transcript.path);
    if (parsed.requests.length === 0) continue;
    for (const request of parsed.requests) {
      if (!priceFor(request.model, options.prices).known) unknownModels.add(String(request.model));
    }
    const className = classifySession(
      { kind: transcript.kind, sessionId: transcript.sessionId, isHarness: parsed.isHarness },
      lookup,
    );
    if (parsed.isHarness && className === 'unclassified') harnessMarkerOnly += 1;
    let decisionCohort = className === 'own-chat' ? 'own-chat' : 'harness';
    if (transcript.kind === 'subagent') {
      const parentClass = await readParentClass(transcript);
      decisionCohort = parentClass === null ? 'unknown' : parentClass === 'own-chat' ? 'own-chat' : 'harness';
      ownership.children[decisionCohort] += 1;
      if (parentClass !== null) ownership.parentClasses[parentClass] = (ownership.parentClasses[parentClass] ?? 0) + 1;
    }
    sessions.push({ className, decisionCohort, requests: parsed.requests });
    allFloors.push(...measuredSummaryFloors(parsed));
    for (const compaction of parsed.compactions) {
      if (compaction.postTokens !== null) allPostTokens.push(compaction.postTokens);
      const before = parsed.requests.filter((r) => r.at !== null && compaction.at !== null && r.at <= compaction.at);
      const last = before[before.length - 1];
      if (last && last.output > 0) allSummaryOutputs.push(last.output);
    }
    allReturns.push(...activityReturns(parsed));
    allRestarts.push(...resumeRestarts(parsed));
  }

  // F: Claude's real post-summary size (compact_metadata.postTokens), then the
  // median first-request-after-boundary measure, then 40K.
  let floorTokens = DEFAULT_SUMMARY_FLOOR;
  let floorSource = 'fallback 40K';
  if (allPostTokens.length >= 5) {
    floorTokens = median(allPostTokens);
    floorSource = `median postTokens from ${allPostTokens.length} compact_boundary records`;
  } else if (allFloors.length >= 5) {
    floorTokens = median(allFloors);
    floorSource = `median first request after ${allFloors.length} compact_boundary records`;
  }
  const summaryOutputTokens = allSummaryOutputs.length > 0 ? median(allSummaryOutputs) : DEFAULT_SUMMARY_OUTPUT;
  if (unknownModels.size > 0) {
    caveats.push(`unknown model prices (treated as Sonnet-class): ${[...unknownModels].slice(0, 5).join(', ')}`);
  }
  caveats.push('pricing caveat: if a long-context premium applies above 200K on these models, savings are larger than the replay shows');

  const classes = replay(sessions, floorTokens, summaryOutputTokens, options.prices);
  // Keep the display taxonomy, but include each separately billed child once
  // in its parent's whole-process decision population. Never roll child costs
  // into a parent row as well as retaining the child row.
  const cohorts = replay(sessions.map((session) => ({ ...session, className: session.decisionCohort })),
    floorTokens, summaryOutputTokens, options.prices);
  const ownChatRows = cohorts['own-chat'] ?? {};
  const harnessRows = cohorts.harness ?? {};
  const ownedCohortDecision = {
    ownChat: pickCeiling(ownChatRows, DECISION_RULE.maxP90OwnChat),
    harness: pickCeiling(harnessRows, DECISION_RULE.maxP90Harness),
  };

  const decision = ownership.children.unknown === 0 ? ownedCohortDecision : {
    ownChat: { ceiling: null, reason: `${ownership.children.unknown} subagent transcripts have unresolved parent ownership; default decision withheld` },
    harness: { ceiling: null, reason: `${ownership.children.unknown} subagent transcripts have unresolved parent ownership; default decision withheld` },
  };
  if (ownership.children.unknown > 0) caveats.push('unresolved child provenance is excluded from owned cohorts and cannot justify a default');
  caveats.push('selection uses file mtime (--since), not a per-request date window; --until is not a request filter');
  caveats.push('Harness marker provenance is not a complete reconstruction of current machine-session metadata');

  const cold = allReturns.filter((r) => r.cold);
  const resumeCache = summariseResumeCache(allRestarts);
  const coldReturns = {
    returns: cold.length,
    rewrittenTokens: cold.reduce((sum, r) => sum + r.rewrittenTokens, 0),
  };

  const sessionsByClass = new Map();
  for (const session of sessions) {
    sessionsByClass.set(session.className, (sessionsByClass.get(session.className) ?? 0) + 1);
  }

  const data = {
    projectsDir: options.projectsDir,
    projectsDirs: options.projectsDirs,
    sessions: sessions.length,
    sessionsByClass: [...sessionsByClass.entries()].sort(),
    floorTokens,
    floorSource,
    floorsFound: allFloors.length,
    summaryOutputTokens,
    caveats,
    classes,
    cohorts,
    ownership,
    ownedCohortDecision,
    decision,
    resumeCache,
    coldReturns,
    harnessMarkerOnly,
  };

  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderReport({ ...data, resumeCache: options.resumeCache ? resumeCache : null, coldReturns: options.coldReturns ? coldReturns : null });
    if (!options.resumeCache && !options.coldReturns) {
      console.log('(pass --resume-cache and --cold-returns for those sections)');
    }
  }
  return data;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runReplay().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
