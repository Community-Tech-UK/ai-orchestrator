#!/usr/bin/env node
/**
 * codex-helper-trial-report.mjs — the Codex helper-agents trial report (A16).
 *
 * Compares the two trial groups for Harness-started work ("off" against
 * "full") and for James's own chats ("economy"/"cheaper" against "full"), per
 * the decision rules in docs/plans/2026-10-10-oct-phase1-token-levers_plan.md
 * (Step 1d). Read-only: it reads the session-policy log, Codex's private
 * state database, the thread rollouts, loop-mode.db plan-queue items, the
 * cost-attribution rows and rlm.db automation runs. It never writes and never
 * reads message text.
 *
 * Where each measure comes from:
 *  - Chats, automations, loops, children and reviews are measured from the
 *    thread rollouts (their threads are durable).
 *  - Plan-queue items are measured from Harness's own records, because the
 *    plan queue's worker and verifier threads are ephemeral and leave no
 *    rollout or state-database row. The policy log's `armKey` is the item id;
 *    its `instanceId`s join to the cost-attribution rows. Gross input per item
 *    is the sum of `inputTokens + cacheReadTokens` over those rows (Codex's
 *    `inputTokens` is the uncached part). Landed or parked comes from
 *    `plan_queue_items.state`. Wall-clock is `updated_at - created_at`, which
 *    includes time the item spent waiting in the queue. An outcome is part of
 *    the window only when the item's row settles before `--until`: a landing at
 *    or after the cutoff is reported as outside the window and is neither
 *    decided nor unknown, exactly like an item still queued or running, so no
 *    outcome after `--until` can be counted against costs that stop there.
 *  - Scheduled-run outcomes: `automation_runs` rows joined by Harness instance
 *    id and automation id. A run's outcome is part of the window only when it
 *    settles before `--until` (`finished_at`), exactly like a plan-queue item,
 *    and a decided run whose decision timestamps are unusable is explicitly
 *    unknown. Run outcomes use valid policy/instance identities independently
 *    of rollout availability, as child outcomes do.
 *  - Helper threads: the Codex adapter appends a `helper-count` record to the
 *    policy log when it first sees each helper thread of a root; the Off-breach
 *    guard reads those counts as well as the state database's spawn edges.
 *
 * Usage:
 *   node scripts/codex-helper-trial-report.mjs --since <ISO date> [--until <ISO date>] [--json]
 *     [--userdata <Electron userData dir>] [--policy-dir <session-policy dir>]
 *     [--state-db <state_5.sqlite>] [--sessions-dir <rollouts dir>]
 *     [--loop-db <loop-mode.db>] [--rlm-db <rlm.db>] [--cost-dir <cost-attribution dir>]
 *
 * Default userData on macOS: ~/Library/Application Support/harness
 * Default Codex state: ~/.ai-orchestrator/codex (state_5.sqlite, sessions/).
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HELPER_MAIL_CACHE_MEASURE = 'Observed zero-cache requests: the first positive-input request after typed descendant-to-parent mail delivery, with an earlier request in the same turn. This is chronology, not proof that mail caused a miss. Unsupported mail formats or missing counters remain unknown.';

// ── CLI ─────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const get = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
  };
  // The requested window is validated up front: an unreadable date must fail
  // loudly, never become NaN and silently empty (or unbounded) the window.
  const when = (name, fallback) => {
    const raw = get(name, null);
    if (raw === null) return fallback;
    const ms = new Date(raw).getTime();
    if (!Number.isFinite(ms)) throw new Error(`--${name} is not a readable date: ${raw}`);
    return ms;
  };
  const sinceMs = when('since', 0);
  const untilMs = when('until', Number.MAX_SAFE_INTEGER);
  if (sinceMs >= untilMs) throw new Error('--since must be earlier than --until');
  return {
    sinceMs,
    untilMs,
    json: argv.includes('--json'),
    userData: get('userdata', join(homedir(), 'Library', 'Application Support', 'harness')),
    policyDir: get('policy-dir', null),
    stateDb: get('state-db', join(homedir(), '.ai-orchestrator', 'codex', 'state_5.sqlite')),
    sessionsDir: get('sessions-dir', join(homedir(), '.ai-orchestrator', 'codex', 'sessions')),
    loopDb: get('loop-db', null),
    rlmDb: get('rlm-db', null),
    costDir: get('cost-dir', null),
  };
}

// ── Session-policy log ──────────────────────────────────────────────────────

/** Arm names the build before the helper-trial rebuild wrote. Their even/odd
 * polarity differs from the current arms, so they are never mapped onto them. */
const LEGACY_ARMS = new Set(['control', 'candidate']);

/**
 * One entry per thread start/resume. `arm` is the trial group; entries with
 * arm 'unassigned' (no trial key) are excluded from every comparison.
 *
 * The build before the rebuild wrote a numeric epoch-millisecond `at`, the arms
 * `control`/`candidate` and hashed keys. Those lines are returned with
 * `legacyFormat: true` and their arm left exactly as written; `atMs` is the
 * parsed time for either format. Callers decide what to do with legacy lines
 * (the report treats their threads as pre-existing).
 */
export function parsePolicyLog(dir, sinceMs, untilMs, recordType = 'policy') {
  if (!dir || !existsSync(dir)) return { entries: [], unparsableLines: 0 };
  const entries = [];
  let unparsableLines = 0;
  const untilDay = untilMs < Number.MAX_SAFE_INTEGER ? new Date(untilMs).toISOString().slice(0, 10) : null;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    // The writer names files by UTC write day. Future files cannot affect an
    // earlier report, even if their contents were interrupted during append.
    if (untilDay && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && file.slice(0, 10) > untilDay) continue;
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        unparsableLines += 1;
        continue;
      }
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) { unparsableLines += 1; continue; }
      if (rec.provider !== 'codex') continue;
      const numericAt = typeof rec.at === 'number';
      const at = numericAt ? rec.at : Date.parse(rec.at);
      if (!Number.isFinite(at)) { unparsableLines += 1; continue; }
      if (at < sinceMs || at >= untilMs) continue;
      if (rec.recordType === 'helper-count' && (!Number.isInteger(rec.helperThreads) || rec.helperThreads < 0
        || typeof rec.threadId !== 'string' || !rec.threadId)) { unparsableLines += 1; continue; }
      if ((rec.recordType ?? 'policy') !== recordType) continue;
      entries.push({ ...rec, atMs: at, legacyFormat: numericAt || LEGACY_ARMS.has(rec.arm) });
    }
  }
  return { entries, unparsableLines };
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
  if (process.env.AIO_CODEX_HELPERS_SQLITE_DRIVER === 'cli') {
    try {
      return queryWithSqliteCli(path, sql, params);
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
      return queryWithSqliteCli(path, sql, params);
    } catch {
      return null;
    }
  }
}

function queryWithSqliteCli(path, sql, params) {
  const output = execFileSync('sqlite3', ['-readonly', '-json', path, bindSqlParams(sql, params)], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  }).trim();
  return output ? JSON.parse(output) : [];
}

// ── Harness records: cost attribution and helper counts ─────────────────────

/** The result when no cost record can be read: every plan-queue item is unknown. */
export const UNREADABLE_COST_RECORDS = Object.freeze({
  readable: false, byInstance: new Map(), files: 0, unparsableLines: 0,
});

const COST_FILE = /^cost-attribution-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function nonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Sum the Harness cost rows (`source: 'instance-turn'`) of the wanted instances.
 * Gross input of a Codex row is `inputTokens + cacheReadTokens`: the adapter
 * stores the uncached part in `inputTokens` and the cached part separately.
 *
 * Only rows inside the requested window `[sinceMs, untilMs)` are counted: a row
 * after `--until` is not part of this measurement and cannot change a figure or
 * a verdict. A row without a usable `ts` cannot be placed in the window and
 * fails closed as invalid (unknown), never as absent or zero.
 *
 * `readable: false` means the directory is missing or a file in range could not
 * be read, which makes the figures unknown. A directory with no rows for an
 * instance is readable: that instance simply has no records. Lines that are not
 * valid JSON are counted in `unparsableLines`. Their instance, time and missing
 * amount cannot be bounded, so no queue total is certified from the remaining
 * rows. Measured chat rollouts remain independent. Message text
 * is never present in these rows.
 */
export function readCostAttribution(dir, sinceMs, untilMs, wantedInstanceIds) {
  if (!dir || !existsSync(dir)) return UNREADABLE_COST_RECORDS;
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return UNREADABLE_COST_RECORDS;
  }
  const sinceDay = Number.isFinite(sinceMs) && sinceMs > 0 ? new Date(sinceMs).toISOString().slice(0, 10) : '';
  const untilDay = Number.isFinite(untilMs) && untilMs < Number.MAX_SAFE_INTEGER
    ? new Date(untilMs).toISOString().slice(0, 10) : '';
  const byInstance = new Map();
  let files = 0;
  let unparsableLines = 0;
  for (const name of names.sort()) {
    const match = COST_FILE.exec(name);
    if (!match || match[1] < sinceDay) continue;
    if (untilDay && match[1] > untilDay) continue;
    let text;
    try {
      text = readFileSync(join(dir, name), 'utf8');
    } catch {
      return UNREADABLE_COST_RECORDS;
    }
    files += 1;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        unparsableLines += 1;
        continue;
      }
      if (!row || row.source !== 'instance-turn' || typeof row.instanceId !== 'string'
        || !wantedInstanceIds.has(row.instanceId)) continue;
      const entry = byInstance.get(row.instanceId)
        ?? { rows: 0, gross: 0, estimatedRows: 0, invalidRows: 0 };
      if (!nonNegative(row.ts)) {
        entry.rows += 1;
        entry.invalidRows += 1;
        byInstance.set(row.instanceId, entry);
        continue;
      }
      if (row.ts < sinceMs || row.ts >= untilMs) continue;
      entry.rows += 1;
      const usage = asRecord(row.usage);
      if (usage && nonNegative(usage.inputTokens) && nonNegative(usage.cacheReadTokens)) {
        entry.gross += usage.inputTokens + usage.cacheReadTokens;
      } else {
        entry.invalidRows += 1;
      }
      if (row.isEstimated === true) entry.estimatedRows += 1;
      byInstance.set(row.instanceId, entry);
    }
  }
  return { readable: true, byInstance, files, unparsableLines };
}

/**
 * Helper threads per root thread, from the `helper-count` follow-up records the
 * Codex adapter writes. Counts only grow, so the largest value per thread wins.
 * A thread with no record has no helper the adapter saw; the Off-breach guard
 * therefore catches only helpers the adapter observed.
 */
export function helperCountsFromLog(helperRecords) {
  const counts = new Map();
  for (const record of helperRecords) {
    if (typeof record.threadId !== 'string' || !record.threadId) continue;
    const value = record.helperThreads;
    if (!Number.isInteger(value) || value < 0) continue;
    counts.set(record.threadId, Math.max(counts.get(record.threadId) ?? 0, value));
  }
  return counts;
}

// ── Rollout parsing (no message text is read) ───────────────────────────────

function asRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function numberField(record, ...names) {
  for (const name of names) {
    const value = record?.[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

function timestampOf(entry, payload) {
  const raw = entry?.['timestamp'] ?? payload?.['timestamp'];
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function snapshotFrom(value) {
  const record = asRecord(value);
  if (!record) return null;
  const input = record.input_tokens ?? record.inputTokens;
  if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) return null;
  return {
    input: numberField(record, 'input_tokens', 'inputTokens'),
    cached: numberField(record, 'cached_input_tokens', 'cachedInputTokens'),
    output: numberField(record, 'output_tokens', 'outputTokens'),
    cacheKnown: typeof (record.cached_input_tokens ?? record.cachedInputTokens) === 'number'
      && Number.isFinite(record.cached_input_tokens ?? record.cachedInputTokens)
      && (record.cached_input_tokens ?? record.cachedInputTokens) >= 0,
  };
}

function usageSnapshot(entry, payload) {
  if (entry?.['type'] === 'token_usage_record') {
    return snapshotFrom(payload?.['thread_token_usage']);
  }
  const subtype = payload?.['type'] ?? entry?.['subtype'];
  if (subtype === 'token_count') {
    const info = asRecord(payload?.['info']) ?? payload;
    return snapshotFrom(info?.['total_token_usage'] ?? info?.['totalTokenUsage']);
  }
  return null;
}

function isCompaction(entry, payload) {
  const type = entry?.['type'];
  const subtype = payload?.['type'] ?? entry?.['subtype'];
  return type === 'compacted' || type === 'context_compacted'
    || subtype === 'compacted' || subtype === 'context_compacted';
}

/**
 * Containment index for one turn list: for each queried `at`, the index of the
 * first turn in array order whose window contains it (a turn without a finite
 * start never contains; the window is `at >= start` and `at <= end`, with a
 * null `end` open), or -1 when none does or the query has no finite `at`.
 *
 * Queries are painted in turn order: each turn claims the still-unclaimed
 * timestamps inside its window, and a union-find skips claimed positions, so
 * the pass is near-linear in turns plus queries instead of their product. The
 * match rule is exactly the former per-snapshot `turns.findIndex` walk: an
 * overlapping earlier turn still wins.
 */
export function indexTurnContainment(turns, ats) {
  const answers = new Array(ats.length).fill(-1);
  const queries = [];
  for (let position = 0; position < ats.length; position++) {
    if (Number.isFinite(ats[position])) queries.push({ at: ats[position], position });
  }
  queries.sort((a, b) => a.at - b.at);
  const n = queries.length;
  // nextUnclaimed[i] is the smallest unclaimed query position >= i; n is the
  // end sentinel. Claiming a position points it at the one after it.
  const nextUnclaimed = new Array(n + 1);
  for (let i = 0; i <= n; i++) nextUnclaimed[i] = i;
  const findUnclaimed = (i) => {
    let root = i;
    while (nextUnclaimed[root] !== root) root = nextUnclaimed[root];
    while (nextUnclaimed[i] !== root) {
      const up = nextUnclaimed[i];
      nextUnclaimed[i] = root;
      i = up;
    }
    return root;
  };
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index];
    if (!Number.isFinite(turn.start)) continue;
    // First query with at >= turn.start.
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (queries[mid].at < turn.start) lo = mid + 1;
      else hi = mid;
    }
    // Last query with at <= turn.end (an open end reaches the last query).
    let end = n - 1;
    if (turn.end !== null) {
      let low = 0;
      let high = n;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (queries[mid].at <= turn.end) low = mid + 1;
        else high = mid;
      }
      end = low - 1;
    }
    for (let p = findUnclaimed(lo); p <= end; p = findUnclaimed(p)) {
      answers[queries[p].position] = index;
      nextUnclaimed[p] = findUnclaimed(p + 1);
    }
  }
  return answers;
}

/**
 * Parse one rollout into turn windows, usage deltas and compaction markers.
 * Cumulative counters are read from both record types and deduped, so one
 * model request is counted once. Message text is never inspected.
 *
 * `sinceMs`/`untilMs` bound every measurement to `[sinceMs, untilMs)`: only
 * turns that start inside it are returned, usage and compaction markers at or
 * after `untilMs` are never counted, helper-mail receipts outside it are not
 * measured, and a turn that runs past the cutoff reports only its in-window
 * wall clock. Cumulative counter baselines are kept: snapshots before
 * `sinceMs` still anchor the delta chain, so an in-window turn measures its own
 * growth and not the thread's whole history. A turn whose start cannot be
 * parsed is kept whatever the window — it makes the thread unmeasurable, which
 * fails closed instead of guessing.
 * Unparsable lines and usage records without usable counters or timestamps
 * make the rollout's usage unknown. Their missing contribution cannot be
 * bounded from the surviving snapshots (including pre-window baselines).
 * Timestamped invalid usage at or after the cutoff is outside the report.
 */
export function parseRolloutSync(path, sinceMs = 0, untilMs = Number.MAX_SAFE_INTEGER) {
  const turns = [];
  const snapshots = [];
  const compactions = [];
  const mailByTurn = new Map();
  const requestsByTurn = new Map();
  let unknownUsageRecords = 0;
  let sequence = 0;
  let current = null;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      unknownUsageRecords += 1;
      continue;
    }
    const payload = asRecord(entry?.['payload']);
    const subtype = payload?.['type'] ?? entry?.['subtype'];
    const at = timestampOf(entry, payload);
    const snapshot = usageSnapshot(entry, payload);
    // Codex also emits quota updates with explicit info:null and no usage.
    // An info object with broken/missing counters still represents lost usage.
    const usageRecord = entry?.['type'] === 'token_usage_record'
      || (subtype === 'token_count' && payload?.['info'] !== null);
    if (usageRecord && (at === null || at < untilMs) && (!snapshot || at === null)) {
      unknownUsageRecords += 1;
    }
    sequence += 1;
    if (subtype === 'task_started' || subtype === 'turn_started') {
      current = {
        start: at, end: null, requests: 0,
        input: 0, cached: 0, output: 0,
        helperInput: 0, helperThreads: 0,
      };
      turns.push(current);
      continue;
    }
    if (subtype === 'task_complete' || subtype === 'turn_complete') {
      if (current) current.end = at;
      current = null;
      continue;
    }
    if (isCompaction(entry, payload)) {
      compactions.push({ at, midTask: current !== null });
      continue;
    }
    // Native v2 delivers mailbox input as a typed AgentMessage in history.
    // EventMsg::AgentMessage is the assistant's OUTPUT and is not mail.
    // Parent-to-child tasks, prose tags and queued/unconsumed notices are not evidence.
    const pathPattern = /^\/root(?:\/[a-z0-9_]+)*$/;
    if (current && at !== null && entry.type === 'response_item' && subtype === 'agent_message'
      && typeof payload.author === 'string' && typeof payload.recipient === 'string'
      && pathPattern.test(payload.author) && pathPattern.test(payload.recipient)
      && payload.author.startsWith(`${payload.recipient}/`)) {
      const mail = mailByTurn.get(current) ?? [];
      mail.push({ at, sequence, id: payload.id });
      mailByTurn.set(current, mail);
    }
    if (snapshot && at !== null) snapshots.push({ at, sequence, ...snapshot });
  }
  snapshots.sort((a, b) => a.at - b.at);
  // Each snapshot's containing turn, resolved once through the containment
  // index. The dedupe and the delta chain below only compare or read these;
  // re-walking every turn per snapshot was the O(snapshots x turns) scan this
  // replaces. Turn ends are capped below, but only for snapshots with
  // `at < untilMs` are they queried, where capping cannot change containment.
  const turnIndexes = indexTurnContainment(turns, snapshots.map((snap) => snap.at));
  for (let i = 0; i < snapshots.length; i++) snapshots[i].turnIndex = turnIndexes[i];
  // Post-cutoff snapshots are not part of the measurement; pre-window snapshots
  // stay in the chain as the cumulative-counter baseline.
  const deduped = [];
  for (const snap of snapshots) {
    if (snap.at >= untilMs) continue;
    const last = deduped[deduped.length - 1];
    if (last && last.turnIndex === snap.turnIndex
      && last.input === snap.input && last.cached === snap.cached && last.output === snap.output) continue;
    deduped.push(snap);
  }
  const turnsInWindow = turns.filter((t) => t.start === null || (t.start >= sinceMs && t.start < untilMs));
  const emitted = new Set(turnsInWindow);
  for (const turn of turnsInWindow) {
    if (turn.end !== null && turn.end > untilMs) turn.end = untilMs;
  }
  for (let i = 0; i < deduped.length; i++) {
    const snap = deduped[i];
    const prev = i > 0 ? deduped[i - 1] : { input: 0, cached: 0, output: 0, cacheKnown: true };
    const dIn = Math.max(0, snap.input - prev.input);
    const dCached = Math.max(0, snap.cached - prev.cached);
    const dOut = Math.max(0, snap.output - prev.output);
    // A pre-window snapshot only extends the baseline; its growth is not measured.
    if (snap.at < sinceMs) continue;
    const containing = snap.turnIndex >= 0 ? turns[snap.turnIndex] : null;
    // A snapshot inside an out-of-window turn is out-of-window work. Late
    // arrivals (no containing turn) keep the existing idiom: the last turn.
    const turn = containing === null ? turnsInWindow[turnsInWindow.length - 1]
      : emitted.has(containing) ? containing : null;
    if (!turn) continue;
    turn.requests += 1;
    turn.input += dIn;
    turn.cached += dCached;
    turn.output += dOut;
    if (!snap.cacheKnown) turn.cacheUnknown = true;
    const requests = requestsByTurn.get(turn) ?? [];
    requests.push({ at: snap.at, sequence: snap.sequence, input: dIn, cached: dCached,
      cacheKnown: snap.cacheKnown && prev.cacheKnown && snap.input >= prev.input
        && snap.cached >= prev.cached && dCached <= dIn });
    requestsByTurn.set(turn, requests);
  }
  const seenIds = new Set();
  for (const turn of turnsInWindow) {
    const deliveries = (mailByTurn.get(turn) ?? []).filter((m) => m.at >= sinceMs && m.at < untilMs).filter((m) => {
      if (m.id && seenIds.has(m.id)) return false;
      if (m.id) seenIds.add(m.id);
      return true;
    });
    const requests = (requestsByTurn.get(turn) ?? []).filter((r) => Number.isFinite(turn.start)
      && r.at >= turn.start && (turn.end === null || r.at <= turn.end));
    const measured = new Set();
    let unmeasured = 0;
    for (const delivery of deliveries) {
      const next = requests.findIndex((r) => r.sequence > delivery.sequence && r.at >= delivery.at);
      // Count only the first request after delivery, with an earlier request
      // in this turn. Missing cache counters and cold starts stay unknown.
      if (next <= 0 || !requests[next].cacheKnown || requests[next].input <= 0) unmeasured += 1;
      else measured.add(next);
    }
    turn.helperMailDeliveries = deliveries.length;
    turn.requestsAfterHelperMail = measured.size;
    turn.unmeasuredHelperMailDeliveries = unmeasured;
    turn.cacheMissesAfterHelperMail = measured.size > 0
      ? [...measured].filter((index) => requests[index].cached === 0).length : null;
  }
  return {
    unknownUsageRecords,
    turns: turnsInWindow.map((t) => ({ ...t })),
    compactions: compactions.filter((c) => c.at === null || (c.at >= sinceMs && c.at < untilMs)),
  };
}

// ── Thread graph and rollouts ───────────────────────────────────────────────

/**
 * The thread graph as of the reporting window. A helper created at or after
 * `untilMs` is outside the window, so its spawn edge is dropped: helpers
 * spawned after a fixed cutoff must not change that earlier report. Left in
 * place they would fail `hasMeasuredRolloutTree` for their parent (pushing it
 * out of the measured sample as unknown) and count as in-window Off
 * helper-spawn breaches. Creation comes from the state database's own thread
 * timestamps — `created_at_ms` (milliseconds) or `created_at` (Unix seconds,
 * the Codex schema). A child that cannot be placed in time (no usable
 * timestamp, an older table without the column, or a dangling edge) fails
 * closed as in-window exposure, keeping the breach guard and the
 * measured-rollout rule as strict as before.
 */
export function readThreadGraph(stateDb, untilMs = Number.MAX_SAFE_INTEGER) {
  // Older tables and test fixtures may carry neither timestamp column; select
  // only what exists so the graph still reads.
  const threads = queryRows(stateDb, 'SELECT id, rollout_path, created_at_ms, created_at FROM threads')
    ?? queryRows(stateDb, 'SELECT id, rollout_path, created_at FROM threads')
    ?? queryRows(stateDb, 'SELECT id, rollout_path FROM threads');
  const edges = queryRows(stateDb, 'SELECT parent_thread_id, child_thread_id FROM thread_spawn_edges');
  if (!threads || !edges) throw new Error('Codex state graph unavailable: threads or spawn edges could not be read.');
  const createdAtMs = new Map();
  for (const thread of threads) {
    const createdMs = nonNegative(thread.created_at_ms) ? thread.created_at_ms
      : nonNegative(thread.created_at) ? thread.created_at * 1000 : null;
    if (createdMs !== null) createdAtMs.set(thread.id, createdMs);
  }
  const childrenOf = new Map();
  for (const edge of edges) {
    const createdMs = createdAtMs.get(edge.child_thread_id);
    if (createdMs !== undefined && createdMs >= untilMs) continue;
    const list = childrenOf.get(edge.parent_thread_id) ?? [];
    list.push(edge.child_thread_id);
    childrenOf.set(edge.parent_thread_id, list);
  }
  const rolloutPath = new Map(threads.map((t) => [t.id, t.rollout_path]));
  return { childrenOf, rolloutPath };
}

export function resolveRolloutPath(path, sessionsDir) {
  if (path && existsSync(path)) return path;
  if (!path || !sessionsDir) return null;
  const normalized = path.replaceAll('\\', '/');
  for (const candidate of [join(sessionsDir, normalized), join(sessionsDir, path)]) {
    if (existsSync(candidate)) return candidate;
  }
  return findFileByName(sessionsDir, normalized.split('/').pop(), 0);
}

function findFileByName(dir, name, depth) {
  if (depth > 6 || !name || !existsSync(dir)) return null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
    if (entry.isDirectory()) {
      const found = findFileByName(full, name, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// ── Aggregation ─────────────────────────────────────────────────────────────

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p90(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.9) - 1)];
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

function emptyRaw() {
  return {
    threads: 0,
    completed: 0,
    notCompleted: 0,
    turnInputs: [],
    uncachedInputs: [],
    outputs: [],
    requests: [],
    helperInputs: [],
    helperThreads: [],
    helperThreadTurns: 0,
    helperMailDeliveries: 0,
    requestsAfterHelperMail: 0,
    cacheMissesAfterHelperMail: 0,
    unmeasuredHelperMailDeliveries: 0,
    turnsWithoutHelperMailReceipts: 0,
    wallClocksMs: [],
    compactionsMidTask: 0,
    compactionsBetween: 0,
  };
}

function foldTurn(raw, turn) {
  raw.turnInputs.push(turn.input + turn.helperInput);
  // A turn with a missing cache counter has no uncached figure: leave it out
  // so the mean shows unknown rather than a cache-miss-everywhere number.
  if (!turn.cacheUnknown) {
    raw.uncachedInputs.push(Math.max(0, turn.input - turn.cached)
      + Math.max(0, turn.helperInput - (turn.helperCached ?? 0)));
  }
  raw.outputs.push(turn.output + (turn.helperOutput ?? 0));
  raw.requests.push(turn.requests + (turn.helperRequests ?? 0));
  raw.helperInputs.push(turn.helperInput);
  raw.helperThreads.push(turn.helperThreads);
  raw.helperMailDeliveries += turn.helperMailDeliveries ?? 0;
  raw.requestsAfterHelperMail += turn.requestsAfterHelperMail ?? 0;
  raw.cacheMissesAfterHelperMail += turn.cacheMissesAfterHelperMail ?? 0;
  raw.unmeasuredHelperMailDeliveries += turn.unmeasuredHelperMailDeliveries ?? 0;
  if (!turn.helperMailDeliveries) raw.turnsWithoutHelperMailReceipts += 1;
  if (turn.helperThreads > 0) raw.helperThreadTurns += 1;
  if (turn.end !== null && turn.start !== null) raw.wallClocksMs.push(turn.end - turn.start);
}

function finalizeRaw(raw) {
  const totalInput = raw.turnInputs.reduce((a, b) => a + b, 0);
  const totalHelper = raw.helperInputs.reduce((a, b) => a + b, 0);
  return {
    threads: raw.threads,
    turns: raw.turnInputs.length,
    completed: raw.completed,
    notCompleted: raw.notCompleted,
    meanInputPerTurn: mean(raw.turnInputs),
    medianInputPerTurn: median(raw.turnInputs),
    meanUncachedInputPerTurn: mean(raw.uncachedInputs),
    meanOutputPerTurn: mean(raw.outputs),
    meanRequestsPerTurn: mean(raw.requests),
    helperInputShare: totalInput > 0 ? totalHelper / totalInput : 0,
    turnsWithHelperShare: raw.turnInputs.length > 0 ? raw.helperThreadTurns / raw.turnInputs.length : 0,
    meanHelperThreadsPerTurn: mean(raw.helperThreads),
    helperMailDeliveries: raw.helperMailDeliveries,
    requestsAfterHelperMail: raw.requestsAfterHelperMail,
    unmeasuredHelperMailDeliveries: raw.unmeasuredHelperMailDeliveries,
    turnsWithoutHelperMailReceipts: raw.turnsWithoutHelperMailReceipts,
    cacheMissesAfterHelperMail: raw.requestsAfterHelperMail > 0 ? raw.cacheMissesAfterHelperMail : null,
    cacheMissesAfterHelperMailReason: raw.requestsAfterHelperMail > 0
      ? `${raw.cacheMissesAfterHelperMail} / ${raw.requestsAfterHelperMail} measured next requests; ${raw.unmeasuredHelperMailDeliveries} unmeasured deliveries; ${raw.turnsWithoutHelperMailReceipts} turns without structural mail receipts`
      : 'unknown: no measurable mid-turn request following structural helper-mail delivery',
    medianWallClockMs: median(raw.wallClocksMs),
    p90WallClockMs: p90(raw.wallClocksMs),
    compactionsPerTurn: raw.turnInputs.length > 0
      ? (raw.compactionsMidTask + raw.compactionsBetween) / raw.turnInputs.length
      : 0,
    compactionsMidTask: raw.compactionsMidTask,
    compactionsBetween: raw.compactionsBetween,
    totalInput,
  };
}

/** Helper threads seen under a root: the larger of Codex's spawn edges and the adapter's logged count. */
function observedHelperThreads(threadId, graph) {
  const edges = new Set((graph.childrenOf.get(threadId) ?? []).filter((id) => typeof id === 'string' && id)).size;
  return Math.max(edges, graph.loggedHelperThreads?.get(threadId) ?? 0);
}

function observedOffBreaches(logEntries, graph) {
  return [...new Set(logEntries
    .filter((entry) => entry.arm === 'off' && typeof entry.threadId === 'string'
      && observedHelperThreads(entry.threadId, graph) > 0)
    .map((entry) => entry.threadId))].sort();
}

function descendantDistances(rootId, graph) {
  const distances = new Map();
  const pending = [[rootId, 0]];
  for (let index = 0; index < pending.length; index++) {
    const [parentId, distance] = pending[index];
    for (const childId of graph.childrenOf.get(parentId) ?? []) {
      if (!childId || childId === rootId || distances.has(childId)) continue;
      distances.set(childId, distance + 1);
      pending.push([childId, distance + 1]);
    }
  }
  return distances;
}

/** Assign every observed descendant turn to one logged root, then to its
 * containing root turn. A root's own rollout is never counted as a helper. */
function attributedRollouts(logEntries, graph, rollouts) {
  const { eligible } = classifyThreadExposure(logEntries);
  const breaches = new Set(observedOffBreaches(logEntries, graph));
  const rootIds = [...eligible.keys()].filter((id) => rollouts.has(id) && !breaches.has(id)).sort();
  const rootSet = new Set(rootIds);
  const result = new Map(rootIds.map((id) => [id, {
    turns: rollouts.get(id).turns.map((turn) => ({
      ...turn, helperInput: 0, helperCached: 0, helperOutput: 0,
      helperRequests: 0, helperThreads: 0,
    })),
    compactions: rollouts.get(id).compactions,
  }]));
  const candidates = new Map();
  const startsByRoot = new Map();
  const helpersByTurn = new Map();
  for (const rootId of rootIds) {
    for (const [childId, distance] of descendantDistances(rootId, graph)) {
      if (rootSet.has(childId)) continue;
      const options = candidates.get(childId) ?? [];
      options.push({ rootId, distance });
      candidates.set(childId, options);
    }
  }
  for (const [childId, options] of candidates) {
    const child = rollouts.get(childId);
    if (!child) continue;
    for (const childTurn of child.turns) {
      if (!Number.isFinite(childTurn.start)) continue;
      for (const { rootId } of options) {
        const starts = startsByRoot.get(rootId) ?? new Set();
        starts.add(childTurn.start);
        startsByRoot.set(rootId, starts);
      }
    }
  }
  // Containment of a child turn's start in a root's turns, resolved once per
  // root through the containment index instead of a `turns.findIndex` walk per
  // child turn and root option — the same super-linear scan class as the
  // snapshot scans in parseRolloutSync, with the same first-match rule.
  const containedByRoot = new Map();
  for (const [rootId, starts] of startsByRoot) {
    const turns = result.get(rootId).turns;
    const unique = [...starts];
    const answers = indexTurnContainment(turns, unique);
    containedByRoot.set(rootId, new Map(unique.map((at, i) => [at, answers[i]])));
  }
  for (const [childId, options] of candidates) {
    const child = rollouts.get(childId);
    if (!child) continue;
    for (const childTurn of child.turns) {
      const ranked = options.map(({ rootId, distance }) => {
        const turns = result.get(rootId).turns;
        const containing = Number.isFinite(childTurn.start)
          ? containedByRoot.get(rootId)?.get(childTurn.start) ?? -1
          : -1;
        return { rootId, distance, turnIndex: containing >= 0 ? containing : turns.length - 1,
          contained: containing >= 0 };
      }).filter((option) => option.turnIndex >= 0)
        .sort((a, b) => Number(b.contained) - Number(a.contained)
          || a.distance - b.distance || a.rootId.localeCompare(b.rootId));
      const chosen = ranked[0];
      if (!chosen) continue;
      const target = result.get(chosen.rootId).turns[chosen.turnIndex];
      target.helperInput += childTurn.input;
      target.helperCached += childTurn.cached;
      if (childTurn.cacheUnknown) target.cacheUnknown = true;
      target.helperOutput += childTurn.output;
      target.helperRequests += childTurn.requests;
      const helpers = helpersByTurn.get(target) ?? new Set();
      helpers.add(childId);
      helpersByTurn.set(target, helpers);
      target.helperThreads = helpers.size;
    }
  }
  return result;
}

function hasMeasuredRolloutTree(threadId, graph, rollouts, visited = new Set()) {
  if (visited.has(threadId)) return true;
  visited.add(threadId);
  const rollout = rollouts.get(threadId);
  if (!rollout?.turns.length || rollout.unknownUsageRecords > 0
    || !rollout.turns.every((turn) => turn.requests > 0 && Number.isFinite(turn.input) && turn.input >= 0)
    || !rollout.turns.every((turn) => Number.isFinite(turn.start)
      && Number.isFinite(turn.end) && turn.end > turn.start)) return false;
  return (graph.childrenOf.get(threadId) ?? [])
    .every((childId) => hasMeasuredRolloutTree(childId, graph, rollouts, visited));
}

/** A thread is trial-exposed only if every recorded start and resume applied
 * the same arm and raw grouping key. Unknown or rejected config fails closed. */
function classifyThreadExposure(logEntries) {
  const byThread = new Map();
  const keysByThread = new Map();
  for (const entry of logEntries) {
    if (typeof entry.threadId !== 'string' || !entry.threadId) continue;
    if (typeof entry.armKey === 'string' && entry.armKey) {
      const keys = keysByThread.get(entry.threadId) ?? new Set();
      keys.add(entry.armKey);
      keysByThread.set(entry.threadId, keys);
    }
    const validLevels = entry.sessionKind === 'chat'
      ? { cheaper: 'economy', full: 'full' }
      : { off: 'off', full: 'full' };
    const valid = entry.applied === true && typeof entry.armKey === 'string' && !!entry.armKey
      && Object.hasOwn(validLevels, entry.arm)
      && entry.level === validLevels[entry.arm]
      && typeof entry.sessionKind === 'string';
    const previous = byThread.get(entry.threadId);
    if (!previous) {
      byThread.set(entry.threadId, { entry, eligible: valid });
    } else {
      previous.eligible = previous.eligible && valid
        && previous.entry.arm === entry.arm
        && previous.entry.armKey === entry.armKey
        && previous.entry.armSource === entry.armSource
        && previous.entry.sessionKind === entry.sessionKind;
    }
  }
  const eligible = new Map();
  const ineligible = new Set();
  for (const [threadId, state] of byThread) {
    if (state.eligible) eligible.set(threadId, state.entry);
    else ineligible.add(threadId);
  }
  return { eligible, ineligible, keysByThread };
}

/**
 * Aggregate one session kind's eligible threads by trial arm. A thread with
 * an unapplied or inconsistent resume contributes no turns to either arm.
 */
export function aggregateKind(kind, logEntries, graph, rollouts, attributed = attributedRollouts(logEntries, graph, rollouts)) {
  const { eligible } = classifyThreadExposure(logEntries);
  const threads = [...eligible.entries()].filter(([threadId, entry]) => entry.sessionKind === kind
    && !(entry.arm === 'off' && observedHelperThreads(threadId, graph) > 0)
    && hasMeasuredRolloutTree(threadId, graph, rollouts));
  const rawByArm = new Map();
  for (const [, entry] of threads) {
    const raw = rawByArm.get(entry.arm) ?? emptyRaw();
    raw.threads += 1;
    const rootRollout = attributed.get(entry.threadId);
    for (const turn of rootRollout.turns) foldTurn(raw, turn);
    for (const comp of rootRollout.compactions) {
      if (comp.midTask) raw.compactionsMidTask += 1;
      else raw.compactionsBetween += 1;
    }
    const last = rootRollout.turns[rootRollout.turns.length - 1];
    if (last && last.end !== null) raw.completed += 1;
    else raw.notCompleted += 1;
    rawByArm.set(entry.arm, raw);
  }
  const out = {};
  for (const [arm, raw] of rawByArm) {
    out[arm] = finalizeRaw(raw);
    out[arm].threadIds = threads.filter(([, e]) => e.arm === arm).map(([id]) => id);
  }
  return out;
}

// ── Plan queue ──────────────────────────────────────────────────────────────

const DECIDED_STATES = new Set(['landed', 'parked']);
const FINISHED_STATES = new Set(['landed', 'parked', 'skipped']);

/**
 * Measure one finished item from Harness's own records. Returns the figures, or
 * the reason they are unknown. Nothing here is ever zero-filled: a missing or
 * malformed record makes the whole item unknown.
 *
 * Tokens: gross input over every cost row of every instance the policy log ties
 * to the item. Time: `updated_at - created_at`, which includes queue waiting.
 */
function measurePlanQueueItem(item, instanceIds, threadsWithoutInstance, usage) {
  if (!usage?.readable) return { reason: 'cost-records-unreadable' };
  if (usage.unparsableLines > 0) return { reason: 'unparsable-cost-records' };
  if (instanceIds.size === 0 || threadsWithoutInstance > 0) return { reason: 'no-instance-id' };
  let input = 0;
  let estimatedRows = 0;
  for (const instanceId of instanceIds) {
    const entry = usage.byInstance.get(instanceId);
    if (!entry || entry.rows === 0) return { reason: 'no-cost-rows' };
    if (entry.invalidRows > 0) return { reason: 'invalid-cost-row' };
    input += entry.gross;
    estimatedRows += entry.estimatedRows;
  }
  let wallClockMs = null;
  if (DECIDED_STATES.has(item.state)) {
    const wall = item.updated_at - item.created_at;
    if (!nonNegative(item.created_at) || !nonNegative(item.updated_at) || !nonNegative(wall)) {
      return { reason: 'bad-timestamps' };
    }
    wallClockMs = wall;
  }
  return { input, wallClockMs, estimated: estimatedRows > 0 };
}

/**
 * Group plan-queue items by trial arm through the policy log's armKey (the
 * item id), then measure each from Harness records: `usage` is the result of
 * readCostAttribution; `items` are `plan_queue_items` rows. An item whose log
 * lines show two arms is listed and excluded; unassigned threads are excluded.
 * No rollout is read: plan-queue threads are ephemeral.
 *
 * `untilMs` bounds the outcomes like every other measurement. The items are
 * read whole (the SELECT has no date bound) precisely so each outcome can be
 * judged as of the cutoff instead of silently dropped: a row that settles at
 * or after `untilMs` did not finish inside the window, so it is listed as
 * `settledAfterWindowItems` and counts as neither decided, measured nor
 * unknown — the plan's rule for items still queued or running. Only the row's
 * `updated_at` can place the decision in time, so the cutoff is exclusive,
 * matching the cost rows and policy records. Without `--until` (the default
 * `Number.MAX_SAFE_INTEGER`) every settled outcome counts, as before.
 */
export function aggregatePlanQueue(logEntries, items, usage, graph, untilMs = Number.MAX_SAFE_INTEGER) {
  const exposure = classifyThreadExposure(logEntries);
  const armByKey = new Map();
  const threadsByKey = new Map();
  const excluded = new Set();
  for (const entry of logEntries) {
    if (entry.sessionKind !== 'plan-queue' || !entry.armKey) continue;
    if (!entry.arm || entry.arm === 'unassigned' || !exposure.eligible.has(entry.threadId)) {
      excluded.add(entry.armKey);
    }
    if (entry.arm && entry.arm !== 'unassigned') {
      const arms = armByKey.get(entry.armKey) ?? new Set();
      arms.add(entry.arm);
      armByKey.set(entry.armKey, arms);
    }
  }
  for (const threadId of exposure.ineligible) {
    for (const key of exposure.keysByThread.get(threadId) ?? []) excluded.add(key);
  }
  const offBreaches = new Set(observedOffBreaches(logEntries, graph));
  for (const entry of logEntries) {
    if (entry.sessionKind === 'plan-queue' && offBreaches.has(entry.threadId) && entry.armKey) {
      excluded.add(entry.armKey);
    }
  }
  for (const [threadId, entry] of exposure.eligible) {
    if (entry.sessionKind !== 'plan-queue') continue;
    const threads = threadsByKey.get(entry.armKey) ?? new Set();
    threads.add(threadId);
    threadsByKey.set(entry.armKey, threads);
  }
  // Every Harness instance the log ties to an item, across all its rounds.
  const instancesByThread = new Map();
  for (const entry of logEntries) {
    if (entry.sessionKind !== 'plan-queue' || typeof entry.threadId !== 'string') continue;
    const ids = instancesByThread.get(entry.threadId) ?? new Set();
    if (typeof entry.instanceId === 'string' && entry.instanceId) ids.add(entry.instanceId);
    instancesByThread.set(entry.threadId, ids);
  }
  const mixed = [...armByKey.entries()].filter(([, arms]) => arms.size > 1).map(([key]) => key);
  for (const key of mixed) excluded.add(key);
  const perArm = new Map();
  const rows = [];
  const unknownItems = [];
  const unknownItemReasons = {};
  const inFlightItems = [];
  const settledAfterWindowItems = [];
  for (const item of items) {
    const arms = armByKey.get(item.id);
    if (!arms || excluded.has(item.id)) continue;
    const arm = [...arms][0];
    const bucket = perArm.get(arm) ?? {
      items: 0, decided: 0, landed: 0, parked: 0, skipped: 0, rounds: 0,
      measuredItems: 0, measuredLanded: 0, unknown: 0, inFlight: 0, estimatedItems: 0,
      settledAfterWindow: 0, inputPerLanded: [], wallClocksMs: [],
    };
    bucket.items += 1;
    bucket.rounds += item.round ?? 0;
    let itemInput = null;
    let itemWallClock = null;
    let unknownReason = null;
    // An outcome settled at or after the cutoff is outside the window: as of
    // --until the item had not finished, so it is neither decided nor unknown.
    if (FINISHED_STATES.has(item.state) && nonNegative(item.updated_at) && item.updated_at >= untilMs) {
      bucket.settledAfterWindow += 1;
      settledAfterWindowItems.push(item.id);
      rows.push({ id: item.id, arm, state: item.state, round: item.round ?? 0, input: null,
        wallClockMs: null, unknownReason: null, settledAfterWindow: true });
      perArm.set(arm, bucket);
      continue;
    }
    if (item.state === 'landed') bucket.landed += 1;
    else if (item.state === 'parked') bucket.parked += 1;
    else if (item.state === 'skipped') bucket.skipped += 1;
    if (DECIDED_STATES.has(item.state)) bucket.decided += 1;
    if (!FINISHED_STATES.has(item.state)) {
      // Still queued or running: not decided, so neither measured nor unknown.
      bucket.inFlight += 1;
      inFlightItems.push(item.id);
    } else {
      const threadIds = [...(threadsByKey.get(item.id) ?? [])];
      const instanceIds = new Set(threadIds.flatMap((id) => [...(instancesByThread.get(id) ?? [])]));
      const threadsWithoutInstance = threadIds.filter((id) => (instancesByThread.get(id)?.size ?? 0) === 0).length;
      const measured = threadIds.length === 0
        ? { reason: 'no-instance-id' }
        : measurePlanQueueItem(item, instanceIds, threadsWithoutInstance, usage);
      if ('reason' in measured) {
        unknownReason = measured.reason;
        unknownItems.push(item.id);
        unknownItemReasons[item.id] = measured.reason;
        bucket.unknown += 1;
      } else {
        itemInput = measured.input;
        itemWallClock = measured.wallClockMs;
        bucket.measuredItems += 1;
        if (measured.estimated) bucket.estimatedItems += 1;
        if (item.state === 'landed') {
          bucket.measuredLanded += 1;
          bucket.inputPerLanded.push(itemInput);
        }
        if (itemWallClock !== null) bucket.wallClocksMs.push(itemWallClock);
      }
    }
    rows.push({ id: item.id, arm, state: item.state, round: item.round ?? 0, input: itemInput,
      wallClockMs: itemWallClock, unknownReason });
    perArm.set(arm, bucket);
  }
  const out = {};
  for (const [arm, bucket] of perArm) {
    out[arm] = {
      items: bucket.items,
      decided: bucket.decided,
      landed: bucket.landed,
      parked: bucket.parked,
      skipped: bucket.skipped,
      inFlight: bucket.inFlight,
      measuredItems: bucket.measuredItems,
      measuredLanded: bucket.measuredLanded,
      unknownItems: bucket.unknown,
      estimatedItems: bucket.estimatedItems,
      settledAfterWindow: bucket.settledAfterWindow,
      landedShare: bucket.landed + bucket.parked > 0 ? bucket.landed / (bucket.landed + bucket.parked) : null,
      meanVerifierRoundsPerItem: bucket.items > 0 ? bucket.rounds / bucket.items : null,
      meanInputPerLandedItem: mean(bucket.inputPerLanded),
      medianWallClockMsPerItem: median(bucket.wallClocksMs),
    };
  }
  return { perArm: out, mixedArmItems: mixed, excludedItems: [...excluded], unknownItems,
    unknownItemReasons, inFlightItems, settledAfterWindowItems, rows };
}

// ── Verdict rules (Step 1d item 4) ─────────────────────────────────────────

export const VERDICT_RULES = {
  harnessWorkTokenDrop: 0.25,
  harnessWorkLandedDropPoints: 10,
  harnessWorkWallClockRatio: 1.5,
  chatsTokenDrop: 0.15,
  chatsWallClockRatio: 1.25,
  minDays: 21,
  maxDays: 35,
  minChatThreadsPerGroup: 40,
  minTurnsPerChatThread: 3,
  minDecidedItemsPerGroup: 20,
};

// Shares and ratios are compared after rounding away floating-point noise, so a
// result exactly on a rule's edge (16 of 20 against 14 of 20 is 10 points)
// is judged as that edge and not as 10.000000000000009.
const atRulePrecision = (n) => Math.round(n * 1e9) / 1e9;

/**
 * Step 1d item 4's choice-2 rule: a kind whose outcome is more than ten points
 * worse with Off goes back to the chats setting. Prints one note per degraded
 * kind (and per comparison whose outcomes are unknown, which withholds the
 * call) and returns the degraded kinds. It runs on every Harness-work path,
 * including the 35-day Decision 3 fallback: a short plan-queue sample must not
 * hide an observed kind regression or send a degraded kind along with the
 * default.
 */
function noteKindOutcomeRegressions(notes, kinds) {
  const degraded = [];
  for (const kind of ['child', 'automation']) {
    const offKind = kinds?.[kind]?.off;
    const fullKind = kinds?.[kind]?.full;
    if (kind === 'automation' && (offKind?.runs?.unknown || fullKind?.runs?.unknown)) {
      notes.push('Automation outcome comparison unknown: run records are unavailable or decided runs have unusable decision timestamps. Do not change the automation helper setting from this comparison.');
      continue;
    }
    if (!offKind || !fullKind) continue;
    const offDenominator = kind === 'automation' ? offKind.runs?.decided : kind === 'child' ? offKind.outcomes?.decided : offKind.threads;
    const fullDenominator = kind === 'automation' ? fullKind.runs?.decided : kind === 'child' ? fullKind.outcomes?.decided : fullKind.threads;
    if (kind === 'child' && (offKind.outcomes?.unknown || fullKind.outcomes?.unknown)) {
      notes.push('Child outcome comparison unknown: unmatched Harness child records remain.');
      continue;
    }
    if (!offDenominator || !fullDenominator) continue;
    const offRate = (kind === 'automation' ? offKind.runs.succeeded : kind === 'child' ? offKind.outcomes.succeeded : offKind.completed) / offDenominator;
    const fullRate = (kind === 'automation' ? fullKind.runs.succeeded : kind === 'child' ? fullKind.outcomes.succeeded : fullKind.completed) / fullDenominator;
    if (atRulePrecision((fullRate - offRate) * 100) > 10) {
      notes.push(`Kind "${kind}" completes more than 10 points worse with Off; move it back to the chats setting (CODEX_HARNESS_WORK_KINDS).`);
      degraded.push(kind);
    }
  }
  return degraded;
}

/**
 * Pure verdict from prepared comparisons. `counts` carries the sample-size
 * inputs: daysElapsed: { chats, harnessWork } (each comparison's own clock,
 * anchored at its first eligible logged exposure), chatThreads: {arm:
 * count-with-min-turns}, decidedItems: {arm: count}, measuredLandedItems:
 * {arm: count}. `kinds` is the per-kind arm table used for the choice 2
 * outcome rule.
 *
 * The two comparisons are judged on their own samples and their own clocks:
 * the chat verdict reads only the chat counts and chat exposure age, the
 * Harness-work verdict only the plan-queue counts and plan-queue exposure age.
 * Unknown figures withhold the verdict they belong to and are never zero.
 */
export function computeVerdict({ chats, planQueue, kinds, counts }) {
  const notes = [];
  if (Object.keys(kinds?.review ?? {}).length) notes.push('Review verdict outcomes are unknown where exact typed receipts are missing or conflicting. Thread completion is a transport measure, not review quality.');
  const armsOf = (table) => Object.keys(table ?? {});
  const chatDaysElapsed = counts.daysElapsed.chats;
  const harnessDaysElapsed = counts.daysElapsed.harnessWork;
  const chatArms = armsOf(counts.chatThreads);
  const itemArms = armsOf(counts.decidedItems);
  const enoughChats = ['cheaper', 'full']
    .every((arm) => counts.chatThreads?.[arm] >= VERDICT_RULES.minChatThreadsPerGroup);
  const enoughItems = ['off', 'full']
    .every((arm) => counts.decidedItems?.[arm] >= VERDICT_RULES.minDecidedItemsPerGroup);
  const enoughMeasuredLanded = ['off', 'full']
    .every((arm) => counts.measuredLandedItems?.[arm] >= VERDICT_RULES.minDecidedItemsPerGroup);
  const chatsComplete = chatDaysElapsed >= VERDICT_RULES.minDays && enoughChats;
  const harnessComplete = harnessDaysElapsed >= VERDICT_RULES.minDays && enoughItems && enoughMeasuredLanded;
  const pastStop = (days) => days >= VERDICT_RULES.maxDays;
  const longEnough = (days) => days >= VERDICT_RULES.minDays;

  if (counts.unreadableRollouts > 0) {
    notes.push(`${counts.unreadableRollouts} unreadable rollout file(s): no verdict until the input can be read.`);
    return { harnessWork: 'pending', chats: 'pending', notes };
  }
  if (counts.unparsablePolicyRecords > 0) {
    notes.push(`${counts.unparsablePolicyRecords} damaged session-policy record(s): exposure and helper counts are unknown; no verdict or defaults until the input is complete.`);
    return { harnessWork: 'pending', chats: 'pending', notes };
  }

  const offBreach = (counts.offGraphBreaches ?? 0) > 0;
  if (offBreach) notes.push(`${counts.offGraphBreaches} Off helper spawn breach(es) observed (Codex thread graph or the adapter's helper counts). A favorable Off verdict and 35-day Off defaults are withheld until this exposure is resolved.`);

  // An unreadable or missing loop database means the plan-queue items are
  // unknown, which is not the same as an empty queue. Chats do not read it.
  const harnessUnknown = counts.loopDbReadable === false;
  if (harnessUnknown) notes.push('The loop database could not be read, so Harness-work (plan-queue) evidence is unknown, not empty: no Harness-work verdict or default until it can be read.');
  const harnessHeld = offBreach || harnessUnknown;

  const anyData = chatArms.length > 0 || itemArms.length > 0;
  if (!anyData) {
    notes.push('No trial data yet: the session-policy log holds no grouped threads in this range. The rebuilt app must run with the helper settings on "trial" for the comparison to start.');
    return { harnessWork: harnessHeld ? 'pending' : 'no-data', chats: 'no-data', notes };
  }

  return {
    harnessWork: decideHarnessWork(),
    chats: decideChats(),
    notes,
  };

  // Harness work (Step 1d item 4): all three rules read the plan queue, which
  // is measured from Harness's own records (plan_queue_items + cost rows).
  function decideHarnessWork() {
    const days = Math.floor(harnessDaysElapsed);
    if (!harnessComplete) {
      if (pastStop(harnessDaysElapsed) && !counts.unknownItems) {
        if (harnessUnknown || offBreach) {
          notes.push('Harness work: counts are still short at 35 days; defer the Off Harness-work default while observed helper spawn breaches or unreadable Harness-work evidence remain.');
          return 'pending';
        }
        // Step 1d item 4's kind rule applies at the fallback too: a kind more
        // than ten points worse with Off returns to the chats setting even
        // when the plan-queue sample never completed. The kind's own outcome
        // evidence is in Harness's records and is not short just because the
        // landing sample is, so the default must not carry a degraded kind.
        const degradedKinds = noteKindOutcomeRegressions(notes, kinds);
        const automationUnknown = Object.values(kinds?.automation ?? {}).some(arm => (arm.runs?.unknown ?? 0) > 0);
        notes.push(`Counts are still short at 35 days: apply Decision 3 defaults for Harness work (Off for loops and the plan queue, and for the other kinds while choice 2 stands${degradedKinds.length || automationUnknown ? ' and their outcomes hold' : ''}) and keep the report running.`);
        return 'apply-defaults';
      }
      const short = [
        longEnough(harnessDaysElapsed) ? null : 'needs 21 days',
        enoughItems ? null : 'needs 20 decided plan-queue items per group',
        enoughMeasuredLanded ? null : 'needs 20 measured landed plan-queue items per group',
      ].filter(Boolean);
      if (counts.unknownItems) short.push(`${counts.unknownItems} plan-queue item(s) have unknown Harness-record measures`);
      notes.push(`Trial sample incomplete after ${days} days for Harness work: ${short.join('; ')}. No verdict yet.`);
      return 'pending';
    }
    const pqOff = planQueue?.off;
    const pqFull = planQueue?.full;
    // Landed share counts every decided item, but input per landed item reads
    // only the measured ones, so unknown items must withhold the verdict even
    // once each arm has 20 measured landed items.
    if (counts.unknownItems) notes.push(`${counts.unknownItems} plan-queue item(s) have unknown Harness-record measures; Harness-work verdict withheld.`);
    // Estimated rows are Harness's own heuristic where the provider sent no usage. They
    // are counted, not excluded, so the verdict says how many items rest on any.
    if (counts.estimatedItems) notes.push(`${counts.estimatedItems} measured plan-queue item(s) include estimated (not provider-reported) cost rows; their input is an estimate.`);
    if (counts.unknownItems || harnessHeld || !pqOff || !pqFull
      || pqOff.meanInputPerLandedItem === null || pqFull.meanInputPerLandedItem === null
      || pqOff.landedShare === null || pqFull.landedShare === null) return 'pending';
    let verdict;
    const tokenDrop = atRulePrecision(1 - pqOff.meanInputPerLandedItem / pqFull.meanInputPerLandedItem);
    const landedDropPoints = atRulePrecision((pqFull.landedShare - pqOff.landedShare) * 100);
    const wallRatio = atRulePrecision((pqOff.medianWallClockMsPerItem ?? 0) / (pqFull.medianWallClockMsPerItem ?? 1));
    const tokensOk = tokenDrop >= VERDICT_RULES.harnessWorkTokenDrop;
    const landingOk = landedDropPoints <= VERDICT_RULES.harnessWorkLandedDropPoints;
    const wallOk = wallRatio <= VERDICT_RULES.harnessWorkWallClockRatio;
    if (tokensOk && landingOk && wallOk) {
      verdict = 'off-justified';
    } else if (tokensOk && !landingOk) {
      verdict = 'split';
      notes.push('Tokens fall but landing drops more than 10 points: keep Full for the plan queue, use Off for loops (and for children, scheduled jobs and reviews while choice 2 stands and their outcomes hold).');
    } else {
      verdict = 'full-keeps-plan-queue';
      notes.push(`Harness-work Off did not meet all three rules (token drop ${(tokenDrop * 100).toFixed(1)}% needs 25%, landed-share drop ${landedDropPoints.toFixed(1)} points needs ≤10, wall-clock ratio ${wallRatio.toFixed(2)} needs ≤1.5).`);
    }
    notes.push('With 20 items per group, a 10-point landing difference is a direction, not proof.');
    noteKindOutcomeRegressions(notes, kinds);
    return verdict;
  }

  // Chats (Step 1d item 4): Cheaper justified if tokens fall 15%, wall clock
  // rises ≤25%, and James does not find the answers worse (a live check). This
  // never reads the plan-queue sample.
  function decideChats() {
    const days = Math.floor(chatDaysElapsed);
    if (!chatsComplete) {
      if (pastStop(chatDaysElapsed) && !counts.unknownChatThreads) {
        notes.push('Chats: counts are still short at 35 days: apply the Cheaper chat default and keep the report running.');
        return 'apply-defaults';
      }
      const short = [
        longEnough(chatDaysElapsed) ? null : 'needs 21 days',
        enoughChats ? null : 'needs 40 chat threads with 3+ turns per group',
      ].filter(Boolean);
      if (counts.unknownChatThreads) short.push(`${counts.unknownChatThreads} chat root(s) have unknown usage receipts`);
      notes.push(`Trial sample incomplete after ${days} days for chats: ${short.join('; ')}. No verdict yet.`);
      return 'pending';
    }
    const cheaper = chats?.cheaper ?? chats?.economy;
    const chatFull = chats?.full;
    if (counts.unknownChatThreads) notes.push(`${counts.unknownChatThreads} chat root(s) have unknown usage receipts; chat verdict withheld.`);
    if (counts.unknownChatThreads || !cheaper || !chatFull || cheaper.meanInputPerTurn === null || chatFull.meanInputPerTurn === null
      || cheaper.medianWallClockMs === null || chatFull.medianWallClockMs === null) return 'pending';
    const tokenDrop = atRulePrecision(1 - cheaper.meanInputPerTurn / chatFull.meanInputPerTurn);
    const wallRatio = atRulePrecision(cheaper.medianWallClockMs / chatFull.medianWallClockMs);
    const tokensOk = tokenDrop >= VERDICT_RULES.chatsTokenDrop;
    const wallOk = wallRatio <= VERDICT_RULES.chatsWallClockRatio;
    if (tokensOk && wallOk) {
      notes.push('Chats: Cheaper meets the token and wall-clock rules. The interrupt-or-steer measure is not recorded in these sources; James answers whether the answers were worse before the default changes.');
      return 'cheaper-justified';
    }
    notes.push(`Chats: Cheaper did not meet both rules (token drop ${(tokenDrop * 100).toFixed(1)}% needs 15%, wall-clock ratio ${wallRatio.toFixed(2)} needs ≤1.25). Full stays the chat default.`);
    return 'full-stays';
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

const fmtTok = (n) => (n === null || n === undefined ? '—' : Math.round(n).toLocaleString('en-US'));
const fmtRatio = (n) => (n === null || n === undefined ? '—' : n.toFixed(2));
const fmtPct = (n) => (n === null || n === undefined ? '—' : `${(n * 100).toFixed(1)}%`);
const fmtMs = (n) => (n === null || n === undefined ? '—' : `${(n / 1000).toFixed(1)}s`);

function renderArmTable(title, byArm) {
  const arms = Object.keys(byArm ?? {}).sort();
  if (arms.length === 0) return;
  console.log(`### ${title}\n`);
  console.log('| arm | threads | turns | input/turn (mean) | uncached in/turn | out/turn | helper input share | requests/turn | wall clock med/p90 | compactions/turn (mid-task/between) | helpers/turn | cache misses after helper mail |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---|---|---:|---|');
  for (const arm of arms) {
    const a = byArm[arm];
    console.log(`| ${arm} | ${a.threads} | ${a.turns} | ${fmtTok(a.meanInputPerTurn)} | ${fmtTok(a.meanUncachedInputPerTurn)} | ${fmtTok(a.meanOutputPerTurn)} | ${fmtPct(a.helperInputShare)} | ${fmtRatio(a.meanRequestsPerTurn)} | ${fmtMs(a.medianWallClockMs)}/${fmtMs(a.p90WallClockMs)} | ${fmtRatio(a.compactionsPerTurn)} (${a.compactionsMidTask}/${a.compactionsBetween}) | ${fmtRatio(a.meanHelperThreadsPerTurn)} | ${a.cacheMissesAfterHelperMailReason} |`);
  }
  console.log('');
}

export function renderReport(data) {
  console.log('# Codex helper trial report\n');
  console.log(`since: ${data.since}  until: ${data.until}`);
  const ageLine = (label, age, firstAt) => `${label} ${age.toFixed(2)} day(s)`
    + (firstAt ? ` since first eligible exposure ${firstAt}` : ' (no eligible exposure: this comparison has not started)');
  console.log(`trial age: ${ageLine('chats', data.trialAgeDays.chats, data.firstExposureAt.chats)}; ${ageLine('Harness work', data.trialAgeDays.harnessWork, data.firstExposureAt.harnessWork)}`);
  console.log(`policy log: ${data.policyDir} (${data.logEntries} entries)`);
  if (data.policyRecords?.unparsableLines) console.log(`Policy evidence UNKNOWN: ${data.policyRecords.unparsableLines} damaged record(s); no verdict or defaults.`);
  if (data.automationDbReadable === false) console.log('Automation database unavailable: run outcomes are UNKNOWN, not zero.');
  console.log(`root threads compared: ${data.rootThreads}; unassigned threads excluded: ${data.unassignedThreads}; policy exposure ineligible: ${data.ineligibleThreads}; pre-window threads excluded: ${data.preexistingThreadsExcluded}\n`);
  console.log(`Rollout measures unavailable (chats, loops, children, scheduled jobs, reviews): ${data.unknownRollouts.missing} missing, ${data.unknownRollouts.unreadable} unreadable.`);
  console.log(`Rollouts with damaged or unattributable usage (excluded, never zero-filled): ${data.damagedRollouts.length}.`);
  console.log(`Plan-queue items with unknown Harness-record measures (never zero-filled): ${data.unknownItems.length}${data.unknownItems.length ? ` (${data.unknownItems.map((id) => `${id}: ${data.unknownItemReasons?.[id] ?? 'unknown'}`).join(', ')})` : ''}; still queued or running: ${data.inFlightItems?.length ?? 0}; outcome settled at or after --until (outside this window, neither decided nor unknown): ${data.settledAfterWindowItems?.length ?? 0}.`);
  console.log(`Cost records: ${data.costRecords?.readable === false ? 'UNREADABLE or missing, so every plan-queue item is unknown' : `${data.costRecords?.files ?? 0} file(s) read`}; unparsable lines skipped: ${data.costRecords?.unparsableLines ?? 0}.\n`);
  console.log(`Chat roots with unknown usage receipts (excluded, never zero-filled): ${data.unknownChatThreads.length}.\n`);
  if (data.loopDbReadable === false) console.log('Loop database unreadable or missing: Harness-work (plan-queue) evidence is UNKNOWN, not empty; no Harness-work verdict.\n');
  console.log(`${HELPER_MAIL_CACHE_MEASURE}\n`);

  renderArmTable('Chats (cheaper/economy vs full)', data.chats);
  renderArmTable('Harness work measured from rollouts: loops, children, scheduled jobs, reviews (off vs full)', data.harnessWorkArms);

  const kindHasData = Object.values(data.kindTable ?? {})
    .some((byArm) => Object.keys(byArm ?? {}).length > 0);
  if (kindHasData) {
    console.log('### Choice 2 kinds (counts only; no pass rule)\n');
    console.log('| kind | arm | threads | turns | input/turn (mean) | thread completed/not | runs succeeded/failed/unknown | child succeeded/failed/unknown | review verdict returned/not returned/unknown |');
    console.log('|---|---|---:|---:|---:|---|---|---|---|');
    for (const kind of Object.keys(data.kindTable).sort()) {
      for (const arm of Object.keys(data.kindTable[kind] ?? {}).sort()) {
        const a = data.kindTable[kind][arm];
        const runs = kind === 'automation' ? `${a.runs?.succeeded ?? 'unknown'}/${a.runs?.failed ?? 'unknown'}/${a.runs?.unknown ?? 0}` : '—';
        const children = kind === 'child' ? `${a.outcomes.succeeded}/${a.outcomes.failed}/${a.outcomes.unknown}` : '—';
        const reviews = kind === 'review' ? `${a.reviewVerdicts.returned ?? 'unknown'}/unknown/${a.reviewVerdicts.unknown}` : '—';
        console.log(`| ${kind} | ${arm} | ${a.threads} | ${a.turns} | ${fmtTok(a.meanInputPerTurn)} | ${a.completed}/${a.notCompleted} | ${runs} | ${children} | ${reviews} |`);
      }
    }
    console.log('');
  }

  console.log('### Plan queue (off vs full), measured from Harness records\n');
  console.log('| arm | items | decided | landed | parked | measured landed | landed share | rounds/item | input/landed item | wall clock/item | unknown | running | settled after until |');
  console.log('|---|---:|---:|---:|---:|---:|---:|---:|---|---|---:|---:|---:|');
  for (const arm of Object.keys(data.planQueueArms ?? {}).sort()) {
    const a = data.planQueueArms[arm];
    console.log(`| ${arm} | ${a.items} | ${a.decided} | ${a.landed} | ${a.parked} | ${a.measuredLanded} | ${fmtPct(a.landedShare)} | ${fmtRatio(a.meanVerifierRoundsPerItem)} | ${fmtTok(a.meanInputPerLandedItem)} | ${fmtMs(a.medianWallClockMsPerItem)} | ${a.unknownItems} | ${a.inFlight} | ${a.settledAfterWindow} |`);
  }
  console.log('');
  console.log('Plan-queue measures: input is gross (input plus cache-read tokens) summed over the cost rows of every worker and verifier instance the policy log ties to the item, helper tokens included only as far as Codex reports them in the thread totals; landed or parked is the item state; wall-clock is the item\'s created-to-updated time, which includes time spent waiting in the queue and any pause. An outcome counts only when the item\'s row settles before --until; a row settled at or after the cutoff is listed as outside this window and is neither decided nor unknown, like an item still queued or running. Plan-queue threads are ephemeral, so no rollout is read for them.\n');
  if (data.mixedArmItems?.length > 0) {
    console.log(`Items with two arms (a spawn missed the key), listed and excluded: ${data.mixedArmItems.join(', ')}\n`);
  }
  if (data.offGraphBreaches?.length > 0) {
    console.log(`Off helper spawn breaches (threads excluded; entire queue items excluded): ${data.offGraphBreaches.join(', ')}\n`);
  }
  console.log('Review verdict counts use exact typed reviewer receipts where available; absent or conflicting evidence remains unknown. Eligible review exposures are counted independently of rollout availability; completed turns measure transport completion, not returned verdicts or review quality.\n');
  console.log('Thread completion is a turn-complete marker, not child success. Child outcomes use Harness exit records joined by instance and provider thread; unmatched records remain unknown. Child outcome counts include valid policy exposures independently of rollout availability; thread, turn and token columns cover fully measured rollouts only. Scheduled-run success uses decided automation_runs joined to an eligible Codex instance, with runs as the denominator; those outcome counts likewise include valid policy exposures independently of rollout availability, and an outcome is part of the window only when its run settles before --until: runs settled at or after the cutoff are outside this window (settledAfterWindow in the JSON), neither decided nor unknown, while a decided run whose start and finish timestamps are unusable or reversed is explicitly unknown. The share of chat turns James interrupted or steered is not recorded in the sources this report reads; his verdict at the end of the trial stands in for it.\n');

  console.log('### Verdict\n');
  console.log(`- Harness work: ${data.verdict.harnessWork}`);
  console.log(`- Chats: ${data.verdict.chats}`);
  for (const note of data.verdict.notes ?? []) console.log(`- ${note}`);
  console.log('\n"Full" always stays available for both, in Settings. With 20 items per group, a 10-point landing difference is a direction, not proof.');
}

// ── Main ────────────────────────────────────────────────────────────────────

/** Harness-started kinds whose threads are durable, so rollouts measure them.
 * The plan queue is not here: its threads are ephemeral and it is measured from
 * Harness's own records (aggregatePlanQueue). */
const HARNESS_KINDS = ['loop', 'child', 'automation', 'review'];

export function buildComparisons(logEntries, graph, rollouts, items, usage = UNREADABLE_COST_RECORDS, untilMs = Number.MAX_SAFE_INTEGER) {
  const exposure = classifyThreadExposure(logEntries);
  const offGraphBreaches = observedOffBreaches(logEntries, graph);
  const attributed = attributedRollouts(logEntries, graph, rollouts);
  const unassigned = new Set(
    logEntries.filter((e) => !e.arm || e.arm === 'unassigned').map((e) => e.threadId),
  );
  const chats = aggregateKind('chat', logEntries, graph, rollouts, attributed);
  const planQueue = aggregatePlanQueue(logEntries, items, usage, graph, untilMs);
  const kindTable = {};
  for (const kind of HARNESS_KINDS) {
    kindTable[kind] = aggregateKind(kind, logEntries, graph, rollouts, attributed);
  }
  return { unassigned, ineligible: exposure.ineligible, offGraphBreaches,
    attributed, chats, kindTable, planQueue };
}

/**
 * Join each decided run to the Harness instance id in its policy record.
 * Provider session ids cannot be used for this join.
 *
 * Outcome eligibility rests on valid policy/instance identities, independently
 * of token-measurement eligibility — exactly as attachChildOutcomes does. A
 * known failure counts even when its rollout is incomplete, and an arm with no
 * measured rollout still prints its runs beside unknown token measures; the
 * exposed ids are never added to the measured threadIds.
 *
 * The settled outcome is placed in time by `finished_at`, exactly like a
 * plan-queue item's `updated_at`: a run that settles at or after `untilMs` is
 * outside the window and counts as neither decided nor unknown, and a decided
 * run whose start/finish timestamps are unusable or reversed is explicitly
 * unknown — never counted and never silently dropped. Runs still pending,
 * running, skipped or cancelled have no settled outcome and are not counted.
 */
function attachAutomationRunOutcomes(automationArms, logEntries, runs, graph, untilMs = Number.MAX_SAFE_INTEGER) {
  const { eligible } = classifyThreadExposure(logEntries);
  const breaches = new Set(observedOffBreaches(logEntries, graph));
  const exposed = new Map([...eligible].filter(([id, entry]) => entry.sessionKind === 'automation'
    && !breaches.has(id)));
  // Quality has its own exposure population. Never add these ids to the
  // measured threadIds: that would fold incomplete usage into token totals.
  for (const entry of exposed.values()) {
    automationArms[entry.arm] ??= {
      ...finalizeRaw(emptyRaw()), threadIds: [], totalInput: null,
      helperInputShare: null, turnsWithHelperShare: null, compactionsPerTurn: null,
    };
  }
  for (const [arm, bucket] of Object.entries(automationArms)) {
    bucket.unmeasuredThreadIds = [...exposed].filter(([id, entry]) => entry.arm === arm
      && !bucket.threadIds.includes(id)).map(([id]) => id);
  }
  const byInstance = new Map();
  for (const entry of logEntries) {
    if (entry.sessionKind !== 'automation' || !entry.instanceId) continue;
    const state = byInstance.get(entry.instanceId) ?? { arm: entry.arm, armKey: entry.armKey, valid: true };
    state.valid = state.valid && exposed.has(entry.threadId)
      && state.arm === entry.arm && state.armKey === entry.armKey;
    byInstance.set(entry.instanceId, state);
  }
  for (const bucket of Object.values(automationArms)) {
    bucket.runs = { succeeded: 0, failed: 0, decided: 0, unknown: 0, settledAfterWindow: 0 };
  }
  if (runs === null) {
    for (const [arm, bucket] of Object.entries(automationArms)) {
      // This is exposure coverage, not an inferred count of missing runs.
      const unknown = [...exposed.values()].filter(entry => entry.arm === arm).length;
      bucket.runs = { succeeded: null, failed: null, decided: null, unknown, settledAfterWindow: null };
    }
    return;
  }
  const seenRuns = new Set();
  for (const run of runs) {
    if (!run.id || seenRuns.has(run.id) || !['succeeded', 'failed'].includes(run.status)) continue;
    seenRuns.add(run.id);
    const exposure = byInstance.get(run.instance_id);
    if (!exposure?.valid || exposure.armKey !== run.automation_id) continue;
    const counts = automationArms[exposure.arm]?.runs;
    if (!counts) continue;
    // Both timestamps must be usable and consistent (the run finished at or
    // after it started), or the decision cannot be placed in the window: fail
    // closed as unknown, like a plan-queue item's `bad-timestamps`.
    if (!nonNegative(run.started_at) || !nonNegative(run.finished_at) || run.finished_at < run.started_at) {
      counts.unknown += 1;
      continue;
    }
    if (run.finished_at >= untilMs) {
      counts.settledAfterWindow += 1;
      continue;
    }
    counts[run.status] += 1;
    counts.decided += 1;
  }
}

/** Authoritative child exits are separate from policy exposure and rollout completion. */
function attachChildOutcomes(childArms, logEntries, outcomes, graph) {
  const { eligible } = classifyThreadExposure(logEntries);
  const breaches = new Set(observedOffBreaches(logEntries, graph));
  const exposed = new Map([...eligible].filter(([id, entry]) => entry.sessionKind === 'child'
    && !breaches.has(id)));
  // Quality has its own exposure population. Never add these ids to the
  // measured threadIds: that would fold incomplete usage into token totals.
  for (const entry of exposed.values()) {
    childArms[entry.arm] ??= {
      ...finalizeRaw(emptyRaw()), threadIds: [], totalInput: null,
      helperInputShare: null, turnsWithHelperShare: null, compactionsPerTurn: null,
    };
  }
  for (const [arm, bucket] of Object.entries(childArms)) {
    bucket.unmeasuredThreadIds = [...exposed].filter(([id, entry]) => entry.arm === arm
      && !bucket.threadIds.includes(id)).map(([id]) => id);
  }
  const byInstance = new Map();
  for (const entry of logEntries) {
    if (entry.sessionKind !== 'child' || !entry.instanceId) continue;
    const state = byInstance.get(entry.instanceId) ?? { arm: entry.arm, key: entry.armKey, valid: true, threads: new Set() };
    state.valid &&= exposed.has(entry.threadId) && state.arm === entry.arm && state.key === entry.armKey;
    state.threads.add(entry.threadId);
    byInstance.set(entry.instanceId, state);
  }
  for (const bucket of Object.values(childArms)) bucket.outcomes = { succeeded: 0, failed: 0, decided: 0, unknown: 0 };
  const matched = new Map();
  for (const outcome of outcomes) {
    const exposure = byInstance.get(outcome.instanceId);
    if (!exposure?.valid || !exposure.threads.has(outcome.threadId)) continue;
    const value = outcome.success === false || outcome.exitCode !== 0 && Number.isInteger(outcome.exitCode) ? false
      : outcome.exitCode === 0 && typeof outcome.success === 'boolean' ? outcome.success : null;
    const previous = matched.get(outcome.instanceId);
    matched.set(outcome.instanceId, previous === undefined || previous === value ? value : null);
  }
  for (const [instanceId, exposure] of byInstance) {
    const counts = childArms[exposure.arm]?.outcomes;
    if (!counts) continue;
    const value = exposure.valid ? matched.get(instanceId) : null;
    if (typeof value !== 'boolean') counts.unknown++;
    else { counts[value ? 'succeeded' : 'failed']++; counts.decided++; }
  }
  // Older policy records without a Harness instance identity cannot be joined.
  for (const bucket of Object.values(childArms)) {
    bucket.outcomes.unknown += [...exposed].filter(([id, entry]) => childArms[entry.arm] === bucket
      && !logEntries.some(e => e.threadId === id && e.instanceId)).length;
  }
}

/** Policy exposure coverage does not establish that a review returned a verdict. */
function attachReviewVerdictCoverage(reviewArms, logEntries, outcomes, graph) {
  const { eligible } = classifyThreadExposure(logEntries);
  const breaches = new Set(observedOffBreaches(logEntries, graph));
  const exposed = [...eligible].filter(([id, entry]) => entry.sessionKind === 'review' && !breaches.has(id));
  for (const [, entry] of exposed) {
    reviewArms[entry.arm] ??= {
      ...finalizeRaw(emptyRaw()), threadIds: [], totalInput: null,
      helperInputShare: null, turnsWithHelperShare: null, compactionsPerTurn: null,
    };
  }
  for (const [arm, bucket] of Object.entries(reviewArms)) {
    let returned = 0;
    const population = exposed.filter(([, entry]) => entry.arm === arm);
    for (const [threadId, entry] of population) {
      if (!entry.instanceId) continue;
      // A reused or inconsistent identity cannot establish this review's result.
      const claims = logEntries.filter(row => row.threadId === threadId || row.instanceId === entry.instanceId);
      if (claims.some(row => row.threadId !== threadId || row.instanceId !== entry.instanceId)) continue;
      const matches = outcomes.filter(row => row.threadId === threadId && row.instanceId === entry.instanceId);
      const verdicts = new Set(matches.map(row => row.verdict));
      if (verdicts.size === 1 && ['APPROVED', 'CHANGES_REQUESTED'].includes(matches[0]?.verdict)) returned++;
    }
    bucket.reviewVerdicts = {
      returned: returned || null, notReturned: null,
      unknown: population.length - returned,
      reason: outcomes.length ? 'Exact typed reviewer receipts establish returned verdicts; missing or conflicting evidence does not prove nonreturn.'
        : 'Authoritative review verdict receipts are not recorded in these sources.',
    };
  }
}

export async function runReport(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const policyDir = options.policyDir ?? join(options.userData, 'session-policy');
  const loopDb = options.loopDb ?? join(options.userData, 'loop-mode', 'loop-mode.db');
  const rlmDb = options.rlmDb ?? join(options.userData, 'rlm', 'rlm.db');

  // A resume inside the trial window cannot establish that an older start
  // used the trial policy. Exclude pre-existing threads rather than accepting
  // a partial exposure history from the selected date range.
  // A thread with any old-format record (numeric `at`, control/candidate arm)
  // started under the previous build, so its first resume after the rebuild
  // cannot be a clean trial exposure either, whenever that record was written.
  const policyRecords = parsePolicyLog(policyDir, 0, options.untilMs);
  const policyHistory = policyRecords.entries;
  const preexistingThreads = new Set(policyHistory
    .filter((entry) => entry.legacyFormat || entry.atMs < options.sinceMs)
    .map((entry) => entry.threadId));
  const inWindowThreadIds = new Set(policyHistory
    .filter((entry) => entry.atMs >= options.sinceMs)
    .map((entry) => entry.threadId));
  const logEntries = policyHistory.filter((entry) =>
    entry.atMs >= options.sinceMs && !preexistingThreads.has(entry.threadId));
  // The spawn graph is bounded by the same cutoff as every other measurement:
  // a helper created at or after --until is outside the window and cannot
  // change the report that ends there.
  const graph = logEntries.length > 0
    ? readThreadGraph(options.stateDb, options.untilMs)
    : { childrenOf: new Map(), rolloutPath: new Map() };
  // Helper threads the Codex adapter saw, for the Off-breach guard. These are
  // follow-up records, so they may be written after the thread's own record —
  // but a record at or after --until is outside the window like every other
  // measurement: it must not change a report that ends at the cutoff.
  graph.loggedHelperThreads = helperCountsFromLog(
    parsePolicyLog(policyDir, options.sinceMs, options.untilMs, 'helper-count').entries);

  const rollouts = new Map();
  const rolloutIssues = new Map();
  // Plan-queue threads are ephemeral and have no rollout to load.
  const rootThreadIds = new Set(logEntries.filter((e) => e.sessionKind !== 'plan-queue').map((e) => e.threadId));
  const attempted = new Set();
  const load = (threadId) => {
    if (attempted.has(threadId)) return;
    attempted.add(threadId);
    const path = resolveRolloutPath(graph.rolloutPath.get(threadId), options.sessionsDir);
    if (!path) rolloutIssues.set(threadId, 'missing');
    else {
      try {
        rollouts.set(threadId, parseRolloutSync(path, options.sinceMs, options.untilMs));
      } catch {
        rolloutIssues.set(threadId, 'unreadable');
      }
    }
    for (const childId of graph.childrenOf.get(threadId) ?? []) load(childId);
  };
  for (const threadId of rootThreadIds) load(threadId);

  // A missing or unreadable loop database is unknown Harness-work evidence,
  // not an empty queue: it must never feed an "apply defaults" verdict.
  // The rows are read whole, without a date bound, so each item's outcome can
  // be judged as of the reporting cutoff in aggregatePlanQueue rather than
  // dropped: an item exposed in-window but settled after --until must be
  // reported as outside the window, and a row without usable timestamps must
  // stay visible as unknown.
  const queueRows = queryRows(loopDb, 'SELECT id, state, round, created_at, updated_at FROM plan_queue_items');
  const loopDbReadable = queueRows !== null;
  const items = queueRows ?? [];
  // Cost rows are read only when there are plan-queue instances to join.
  const queueInstanceIds = new Set(logEntries
    .filter((e) => e.sessionKind === 'plan-queue' && typeof e.instanceId === 'string' && e.instanceId)
    .map((e) => e.instanceId));
  const costDir = options.costDir ?? join(options.userData, 'cost-attribution');
  const usage = logEntries.some((e) => e.sessionKind === 'plan-queue')
    ? readCostAttribution(costDir, options.sinceMs, options.untilMs, queueInstanceIds)
    : { readable: true, byInstance: new Map(), files: 0, unparsableLines: 0 };
  const { unassigned, ineligible, offGraphBreaches, attributed, chats, kindTable, planQueue } =
    buildComparisons(logEntries, graph, rollouts, items, usage, options.untilMs);

  // Harness-work combined per-turn figures: fold every harness-kind thread's
  // turns into one accumulator per arm (helpers attributed first).
  const harnessWorkArms = {};
  const harnessArms = [...new Set(HARNESS_KINDS.flatMap((kind) => Object.keys(kindTable[kind] ?? {})))];
  for (const arm of harnessArms) {
    const combined = emptyRaw();
    for (const kind of HARNESS_KINDS) {
      const finalized = kindTable[kind]?.[arm];
      if (!finalized) continue;
      combined.threads += finalized.threads;
      combined.completed += finalized.completed;
      combined.notCompleted += finalized.notCompleted;
      for (const threadId of finalized.threadIds ?? []) {
        const rootRollout = attributed.get(threadId);
        if (!rootRollout) continue;
        for (const turn of rootRollout.turns) foldTurn(combined, turn);
        for (const comp of rootRollout.compactions) {
          if (comp.midTask) combined.compactionsMidTask += 1;
          else combined.compactionsBetween += 1;
        }
      }
    }
    harnessWorkArms[arm] = finalizeRaw(combined);
  }

  // Automation-run outcomes use run ids and exact instance joins, not thread
  // completion counters. Unmatched runs cannot establish a Codex trial arm.
  // The rows are read whole, without a date bound, for the same reason as
  // plan_queue_items: each outcome is judged as of the reporting cutoff in
  // attachAutomationRunOutcomes instead of being silently dropped, and a
  // decided run whose decision timestamps are unusable stays visible as
  // unknown. The settled outcome is placed in time by `finished_at` — a run
  // that settles at or after `--until` did not finish inside the window and
  // counts as neither decided nor unknown.
  const automationRuns = queryRows(
    rlmDb,
    'SELECT id, automation_id, instance_id, status, started_at, finished_at FROM automation_runs',
  );
  attachAutomationRunOutcomes(kindTable.automation, logEntries, automationRuns, graph, options.untilMs);
  attachChildOutcomes(kindTable.child, logEntries, parsePolicyLog(policyDir, options.sinceMs, options.untilMs, 'child-outcome').entries, graph);
  attachReviewVerdictCoverage(kindTable.review, logEntries, parsePolicyLog(policyDir, options.sinceMs, options.untilMs, 'review-outcome').entries, graph);

  // Each comparison's trial clock runs from its own first eligible logged
  // exposure, never from the requested --since (Step 1d): a brand-new or
  // never-started comparison must not reach the 35-day stop just because the
  // query window is long. The two comparisons sample independently (the 20 Oct
  // amendment), so each has its own clock; the Harness-work verdict reads only
  // the plan-queue sample, so plan-queue exposure starts its clock.
  const exposure = classifyThreadExposure(logEntries);
  const firstExposureMs = (kind) => {
    let first = null;
    for (const entry of logEntries) {
      if (entry.sessionKind !== kind || !exposure.eligible.has(entry.threadId)) continue;
      if (first === null || entry.atMs < first) first = entry.atMs;
    }
    return first;
  };
  const windowEndMs = Math.min(options.untilMs, Date.now());
  const dayMs = 24 * 60 * 60 * 1000;
  const ageFrom = (firstMs) => (firstMs === null ? 0 : Math.max(0, (windowEndMs - firstMs) / dayMs));
  const firstExposureAt = {
    chats: firstExposureMs('chat'),
    harnessWork: firstExposureMs('plan-queue'),
  };
  const daysElapsed = {
    chats: ageFrom(firstExposureAt.chats),
    harnessWork: ageFrom(firstExposureAt.harnessWork),
  };
  const chatThreads = {};
  for (const [arm, agg] of Object.entries(chats)) {
    chatThreads[arm] = (agg.threadIds ?? []).filter((id) => (rollouts.get(id)?.turns.length ?? 0) >= VERDICT_RULES.minTurnsPerChatThread).length;
  }
  const decidedItems = {};
  for (const [arm, agg] of Object.entries(planQueue.perArm)) decidedItems[arm] = agg.decided;
  const measuredLandedItems = {};
  for (const [arm, agg] of Object.entries(planQueue.perArm)) measuredLandedItems[arm] = agg.measuredLanded;
  const unknownRollouts = {
    missing: [...rolloutIssues.values()].filter((reason) => reason === 'missing').length,
    unreadable: [...rolloutIssues.values()].filter((reason) => reason === 'unreadable').length,
  };
  const damagedRollouts = [...rollouts].filter(([, rollout]) => rollout.unknownUsageRecords > 0)
    .map(([id]) => id);
  const unknownChatThreads = [...exposure.eligible]
    .filter(([id, entry]) => entry.sessionKind === 'chat' && !hasMeasuredRolloutTree(id, graph, rollouts))
    .map(([id]) => id);

  const verdict = computeVerdict({
    chats,
    planQueue: planQueue.perArm,
    kinds: kindTable,
    counts: {
      daysElapsed, chatThreads, decidedItems, measuredLandedItems,
      unknownItems: planQueue.unknownItems.length,
      estimatedItems: Object.values(planQueue.perArm).reduce((sum, arm) => sum + arm.estimatedItems, 0),
      unreadableRollouts: unknownRollouts.unreadable,
      unparsablePolicyRecords: policyRecords.unparsableLines,
      unknownChatThreads: unknownChatThreads.length,
      offGraphBreaches: offGraphBreaches.length,
      loopDbReadable,
    },
  });

  const exposureIneligible = [...ineligible].filter((id) => !unassigned.has(id));
  const comparedThreadIds = new Set([
    ...Object.values(chats).flatMap((arm) => arm.threadIds ?? []),
    ...Object.values(kindTable).flatMap((arms) => Object.values(arms).flatMap((arm) => arm.threadIds ?? [])),
  ]);

  const data = {
    helperMailCacheMeasure: HELPER_MAIL_CACHE_MEASURE,
    since: options.sinceMs ? new Date(options.sinceMs).toISOString() : '(all time)',
    until: options.untilMs < Number.MAX_SAFE_INTEGER ? new Date(options.untilMs).toISOString() : '(now)',
    trialAgeDays: daysElapsed,
    firstExposureAt: {
      chats: firstExposureAt.chats === null ? null : new Date(firstExposureAt.chats).toISOString(),
      harnessWork: firstExposureAt.harnessWork === null ? null : new Date(firstExposureAt.harnessWork).toISOString(),
    },
    policyDir,
    policyRecords: { complete: policyRecords.unparsableLines === 0, unparsableLines: policyRecords.unparsableLines },
    automationDbReadable: automationRuns !== null,
    logEntries: logEntries.length,
    rootThreads: comparedThreadIds.size,
    unassignedThreads: unassigned.size,
    ineligibleThreads: exposureIneligible.length,
    preexistingThreadsExcluded: [...preexistingThreads].filter((id) => inWindowThreadIds.has(id)).length,
    chats,
    harnessWorkArms,
    kindTable,
    planQueueArms: planQueue.perArm,
    mixedArmItems: planQueue.mixedArmItems,
    offGraphBreaches,
    unknownItems: planQueue.unknownItems,
    unknownItemReasons: planQueue.unknownItemReasons,
    inFlightItems: planQueue.inFlightItems,
    settledAfterWindowItems: planQueue.settledAfterWindowItems,
    costRecords: { readable: usage.readable, files: usage.files, unparsableLines: usage.unparsableLines },
    loopDbReadable,
    unknownRollouts,
    damagedRollouts,
    unknownChatThreads,
    verdict,
  };

  if (options.json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    renderReport(data);
  }
  return data;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runReport().then((data) => {
    if (data.unknownRollouts.unreadable > 0) {
      console.error(`${data.unknownRollouts.unreadable} unreadable rollout file(s); measures excluded and no CLI success verdict.`);
      process.exitCode = 1;
    }
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
