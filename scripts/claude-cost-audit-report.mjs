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
 * `--subagents` adds the A18 helper-agent trial section (Phase 1 Step 2):
 * per-group spend, quality signs, the reviewer guard, the long-wait cache
 * metric and the trial verdict, read from Claude transcripts through
 * `scripts/lib/claude-transcripts.mjs` and from the session-policy log.
 *
 * Usage:
 *   node scripts/claude-cost-audit-report.mjs [--userdata <Electron userData dir>] [--since <ISO date>] [--until <ISO date>]
 *   node scripts/claude-cost-audit-report.mjs --subagents [--projects <Claude projects dir>] [--prices <json>] [--policy-dir <dir>] [--loop-db <path>] [--rlm-db <path>]
 *   node scripts/claude-cost-audit-report.mjs --compare-transcripts --day YYYY-MM-DD [--projects <isolated projects directory>] [--prices <json>]
 *
 * Default userData on macOS: ~/Library/Application Support/harness
 * (pass --userdata if your app name/path differs — check the About panel or
 * `app.getPath('userData')`).
 *
 * Read-only: opens databases in readonly mode and only reads the JSONL files.
 */

import { compareTranscriptCosts } from './claude-transcript-cost-comparison.mjs';
import { execFileSync } from 'child_process';
import { readFileSync, readdirSync, existsSync, realpathSync } from 'fs';
import { basename, join } from 'path';
import { homedir } from 'os';
import { createRequire } from 'module';
import { fileURLToPath } from 'node:url';
import {
  activityReturns,
  listTranscripts,
  median,
  modelFamily,
  p90,
  parseTaskToolOutcomes,
  parseTranscript,
  priceFor,
  readSubagentMeta,
  transcriptProjectsDirs,
  CACHE_READ_MULT,
  CACHE_WRITE_5M_MULT,
  CACHE_WRITE_1H_MULT,
} from './lib/claude-transcripts.mjs';

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
const untilMs = (() => {
  const raw = arg('until', null);
  return raw ? new Date(raw).getTime() : Number.MAX_SAFE_INTEGER;
})();
const wantSubagents = process.argv.includes('--subagents');
const priceOverrides = (() => {
  const raw = arg('prices', null);
  if (!raw) return null;
  try {
    return JSON.parse(readFileSync(raw, 'utf8'));
  } catch (err) {
    console.error(`(--prices ${raw} is not readable JSON: ${err.message})`);
    return null;
  }
})();

const fmtUsd = (n) => n === null ? 'unknown' : `$${n.toFixed(4)}`;
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
        if (typeof rec?.ts === 'number' && Number.isFinite(rec.ts) && rec.ts >= sinceMs && rec.ts < untilMs) records.push(rec);
      } catch {
        /* skip malformed line */
      }
    }
  }
  return records;
}

function reportAttribution(records) {
  records = records.filter((r) => !r.subagentUsage && !r.reviewDispatch && !r.reviewLifecycle
    && r.auxiliarySpendReservationUsd === undefined && r.provider !== 'local-fallback' && r.auxRoutedTo !== 'fallback');
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

/** Phase0 daily subagent context summary; usage size is never billed as cost. */
function reportSubagents(records) {
  const groups = new Map();
  for (const record of records.filter((r) => r.subagentUsage === true && Number.isFinite(r.ts))) {
    const key = `${new Date(record.ts).toISOString().slice(0, 10)} [${record.sessionId ?? record.instanceId ?? '?'}]`;
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
  }
  if (!groups.size) return;
  const percentile = (entries, key, pct) => {
    const values = entries.map((entry) => entry[key]).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
    return values.length ? values[Math.max(0, Math.ceil(values.length * pct) - 1)] : 0;
  };
  console.log('## Subagents — last context size, not a cost\n');
  console.log('| day [parent session] | count | final size median / p90 | tool uses median / p90 | duration ms median / p90 |');
  console.log('|---|---:|---:|---:|---:|');
  for (const [key, group] of groups) console.log(`| ${key} | ${group.length} | ${percentile(group, 'finalContextTokens', 0.5)} / ${percentile(group, 'finalContextTokens', 0.9)} | ${percentile(group, 'toolUses', 0.5)} / ${percentile(group, 'toolUses', 0.9)} | ${percentile(group, 'durationMs', 0.5)} / ${percentile(group, 'durationMs', 0.9)} |`);
  // T6 step 3 / K3.8: which model ran each helper, and how it was started (fork, depth, foreground or background).
  const shapes=new Map();
  for (const record of [...groups.values()].flat()) {
    const key=[record.model ? `${record.model} (${record.helperModelSource ?? '?'})` : 'unknown',record.helperMode ?? '?',
      record.helperFork===undefined ? '?' : record.helperFork ? 'yes' : 'no',record.helperDepth ?? '?'].join(' | ');
    const group=shapes.get(key) ?? [];group.push(record);shapes.set(key,group);
  }
  console.log('\n## Subagents by model, mode, fork and depth — last context size, not a cost\n');
  console.log('| model (source) | mode | fork | depth | count | final size median / p90 | tool uses median / p90 |');
  console.log('|---|---|---|---:|---:|---:|---:|');
  for (const [key,group] of [...shapes].sort((a,b)=>b[1].length-a[1].length)) console.log(`| ${key} | ${group.length} | ${percentile(group,'finalContextTokens',0.5)} / ${percentile(group,'finalContextTokens',0.9)} | ${percentile(group,'toolUses',0.5)} / ${percentile(group,'toolUses',0.9)} |`);
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
  const output = execFileSync('sqlite3', ['-readonly', '-json', path, bindSqlParams(sql, params)], {
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

function reportCostEntries(rlmDbPath = join(userData, 'rlm', 'rlm.db')) {
  const rows = queryRows(
    rlmDbPath,
    `SELECT model, COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output,
            SUM(cache_read_tokens) AS cache_r, SUM(cache_write_tokens) AS cache_w, SUM(cost) AS cost
     FROM cost_entries WHERE timestamp >= ? AND timestamp < ? GROUP BY model ORDER BY cost DESC`,
    [sinceMs, untilMs],
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

function reportLoopIterations(loopDbPath = join(userData, 'loop-mode', 'loop-mode.db')) {
  // defaultLoopDbPath() = <userData>/loop-mode/loop-mode.db (loop-store.ts).
  const candidates = [loopDbPath].filter(existsSync);
  if (candidates.length === 0) {
    console.log(`(no loop DB found at ${loopDbPath} — check defaultLoopDbPath() in loop-store.ts)\n`);
    return;
  }
  const rows = queryRows(
    candidates[0],
    `SELECT loop_run_id, COUNT(*) AS iters, SUM(tokens) AS tokens, SUM(cost_cents) AS cost_cents
     FROM loop_iterations WHERE started_at >= ? AND started_at < ? GROUP BY loop_run_id ORDER BY cost_cents DESC LIMIT 20`,
    [sinceMs, untilMs],
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

// ── A18: --subagents (Phase 1 Step 2's measurement) ─────────────────────────

/**
 * Verdict thresholds, exactly as the plan records them. Sonnet becomes the
 * default only when every criterion holds at the end of the sample window.
 */
export const SUBAGENT_VERDICT_RULES = {
  spendDrop: 0.3,
  respawnRisePoints: 5,
  errorRisePoints: 3,
  landedDropPoints: 10,
  reviewerGuardShare: 0.02,
  minDays: 14,
  maxDays: 28,
  minGeneralPurposePerGroup: 300,
  waitingRuleRewriteDrop: 0.3,
  waitingRuleRuntimeRise: 0.2,
  respawnWindowMs: 10 * 60 * 1000,
  longWaitMinMs: 5 * 60 * 1000,
  longWaitMaxMs: 60 * 60 * 1000,
};

/**
 * The trial group for a session: the fixed half-and-half split from the last
 * hex digit of the native session id. Mirrors `claudeSubagentArmForSession`
 * in `src/main/cli/adapters/claude-subagent-policy.ts` — the policy module,
 * this report and the session-policy log all use this one split.
 */
export function armForSessionId(nativeSessionId) {
  const last = String(nativeSessionId ?? '').trim().toLowerCase().slice(-1);
  return /^[0-7]$/.test(last) ? 'sonnet' : 'same-as-session';
}

/** List-price cost of one recorded request (cache multiples on the input price). */
export function requestUsd(r, prices = null) {
  const p = priceFor(r.model, prices);
  return (
    r.input * p.inputPerMTok +
    r.cacheRead * p.inputPerMTok * CACHE_READ_MULT +
    r.cacheWrite5m * p.inputPerMTok * CACHE_WRITE_5M_MULT +
    r.cacheWrite1h * p.inputPerMTok * CACHE_WRITE_1H_MULT +
    r.output * p.outputPerMTok
  ) / 1e6;
}

/** The reviewer guard's local keyword match (counts only, never descriptions). */
export function reviewKeywordMatch(description) {
  return /\b(reviews?|verif(?:y|ies|ication)|check(?:s|ing)?|gate)\b/i.test(String(description ?? ''));
}

/**
 * Agent types the subagent-model policy moves (claude-subagent-policy.ts:
 * `CLAUDE_CODE_SUBAGENT_MODEL` "moves Claude's built-in general-purpose (and
 * catch-all) helper agents to Sonnet"): the built-in `general-purpose` agent
 * and the built-in `claude` catch-all. The reviewer guard watches exactly
 * these, because they are the helpers the trial's lever can mis-home against
 * the reviewer rule; helpers that name their own model keep it by James's
 * design (the setting's own description) and are his choice, not an ignored
 * rule. Plugin agents with no model are moved too, but `.meta.json` cannot
 * tell them apart from named-model agents.
 */
export function policyMovedAgentType(agentType) {
  return agentType === 'general-purpose' || agentType === 'claude';
}

/**
 * The re-spawn rate's event: another general-purpose agent started in the
 * same parent turn within `windowMs` AFTER one returning. Input entries need
 * `firstAt`/`lastAt`; callers may supply actual `returnedAt` and ownership.
 */
export function detectRespawns(generalPurpose, windowMs = SUBAGENT_VERDICT_RULES.respawnWindowMs) {
  const groups = new Map();
  for (const agent of generalPurpose) {
    const returnedAt = agent.returnedAt ?? agent.lastAt;
    if (!Number.isFinite(agent.firstAt) || !Number.isFinite(returnedAt) || returnedAt < agent.firstAt) continue;
    const key = JSON.stringify([agent.parentSessionId, agent.parentTurnId]);
    const group = groups.get(key) ?? [];
    group.push({ firstAt: agent.firstAt, returnedAt });
    groups.set(key, group);
  }
  let respawns = 0;
  for (const group of groups.values()) {
    const returns = group.map(a => a.returnedAt).sort((a, b) => a - b);
    const bound = (at, inclusive) => {
      let lo = 0;
      let hi = returns.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (returns[mid] < at || (inclusive && returns[mid] === at)) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    for (const agent of group) {
      const priorReturns = bound(agent.firstAt, true) - bound(agent.firstAt - windowMs, false);
      // A zero-duration helper must never count its own return as a respawn.
      if (priorReturns > (agent.returnedAt === agent.firstAt ? 1 : 0)) respawns += 1;
    }
  }
  return respawns;
}

/**
 * Phase 0's recorded subagent finals (`subagentUsage` rows carrying
 * `durationMs`/`toolUses`/`toolUseId`), indexed by `toolUseId` for Step 2's
 * size-and-effort join. The sink records one final sample per helper, so the
 * first record for an id wins; rows without a usable id or figure are simply
 * absent (unknown, never zero).
 */
function indexSubagentUsage(records) {
  const byToolUseId = new Map();
  for (const record of records ?? []) {
    if (!record || record.subagentUsage !== true) continue;
    const id = record.toolUseId;
    if (typeof id !== 'string' || !id || byToolUseId.has(id)) continue;
    byToolUseId.set(id, {
      durationMs: Number.isFinite(record.durationMs) ? record.durationMs : null,
      toolUses: Number.isFinite(record.toolUses) ? record.toolUses : null,
    });
  }
  return byToolUseId;
}

/**
 * Scan Claude transcripts into per-parent session records. `projectsDir` is
 * one projects root or several (the default is every discovered root, see
 * `transcriptProjectsDirs`). Nothing is filtered by date here — the
 * aggregation applies the analysis window and logged exposure. No message
 * text is read.
 *
 * `opts.subagentUsage` carries Phase 0's recorded subagent finals (the
 * `subagentUsage` cost-attribution rows written in
 * instance-communication-provider-events.ts). Step 2's "size and effort"
 * measurement joins their `durationMs`/`toolUses` onto each helper by
 * `toolUseId` (also in `.meta.json`); a helper without a record keeps unknown
 * run time and tool uses, never a timestamp guess.
 */
export async function collectSubagentSessions(projectsDir, prices = null, opts = {}) {
  const roots = Array.isArray(projectsDir) ? projectsDir : [projectsDir];
  const usageByToolUseId = indexSubagentUsage(opts.subagentUsage);
  // A managed account profile's `projects` is symlinked back into the shared
  // store (claude-profile-seed.ts), so one physical transcript can surface
  // under two roots. Resolve aliases before grouping — the same idiom as
  // context-ceiling-replay.mjs — so one helper can never be counted twice.
  const entries = [];
  const seenFiles = new Set();
  for (const root of roots) {
    for (const entry of listTranscripts(root)) {
      let path = entry.path;
      try {
        path = realpathSync(entry.path);
      } catch {
        /* keep the listed path when it cannot be resolved */
      }
      if (seenFiles.has(path)) continue;
      seenFiles.add(path);
      entries.push({ ...entry, path });
    }
  }
  const mains = new Map();
  const subsByParent = new Map();
  for (const entry of entries) {
    if (entry.kind === 'main') {
      if (!mains.has(entry.sessionId)) mains.set(entry.sessionId, entry);
    } else {
      const list = subsByParent.get(entry.sessionId) ?? [];
      list.push(entry);
      subsByParent.set(entry.sessionId, list);
    }
  }
  const sessions = [];
  for (const [sessionId, mainEntry] of mains) {
    const parsed = await parseTranscript(mainEntry.path);
    const outcomes = parseTaskToolOutcomes(mainEntry.path);
    // parseTranscript sorts by timestamp (stably for ties). Build this index
    // once; scanning all parent requests for every helper is quadratic.
    const parentRequests = parsed.requests.filter((r) => r.at !== null);
    const parentModel = parentRequests[0]?.model ?? null;
    const subagents = [];
    let unplacedUsageRecords = parsed.unknownUsageRecords;
    // A helper's identity is its Task tool_use id (its file name when the
    // sidecar meta cannot say), so a copied — not just symlinked — store
    // cannot bill the same helper twice either. Distinct ids always survive.
    const seenHelpers = new Set();
    for (const subEntry of subsByParent.get(sessionId) ?? []) {
      const meta = readSubagentMeta(subEntry.path);
      const helperKey = typeof meta?.toolUseId === 'string' && meta.toolUseId ? meta.toolUseId : basename(subEntry.path);
      if (seenHelpers.has(helperKey)) continue;
      const subParsed = await parseTranscript(subEntry.path);
      const reqs = subParsed.requests.filter((r) => r.at !== null);
      if (reqs.length === 0 && subParsed.unknownUsageRecords === 0) continue;
      seenHelpers.add(helperKey);
      const first = reqs[0];
      const last = reqs[reqs.length - 1];
      const outcome = meta?.toolUseId ? outcomes.get(meta.toolUseId) ?? null : null;
      const firstAt = first?.at ?? outcome?.startedAt ?? null;
      const lastAt = last?.at ?? outcome?.returnedAt ?? null;
      if (firstAt === null || lastAt === null) {
        unplacedUsageRecords += subParsed.unknownUsageRecords;
        continue;
      }
      const recorded = typeof meta?.toolUseId === 'string' && meta.toolUseId
        ? usageByToolUseId.get(meta.toolUseId) : undefined;
      let lo = 0;
      let hi = parentRequests.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (parentRequests[mid].at <= firstAt) lo = mid + 1;
        else hi = mid;
      }
      // The final equal-time request wins, matching the previous reduction.
      const parentModelAtSpawn = parentRequests[lo - 1]?.model ?? parentModel;
      subagents.push({
        meta,
        parentTurnId: outcome?.parentTurnId ?? null,
        startedAt: outcome?.startedAt ?? null,
        returnedAt: outcome?.returnedAt ?? null,
        model: last?.model ?? null,
        parentModel: parentModelAtSpawn,
        unknownUsageRecords: subParsed.unknownUsageRecords,
        spendUsd: subParsed.unknownUsageRecords > 0 ? null : reqs.reduce((s, r) => s + requestUsd(r, prices), 0),
        finalContext: last?.context ?? null,
        // Step 2's join on toolUseId (7i records), not first/last request
        // timestamps: a helper without a recorded final keeps run time and
        // tool uses unknown.
        runMs: recorded?.durationMs ?? null,
        toolUses: recorded?.toolUses ?? null,
        firstAt,
        lastAt,
        // Only a terminal Task result is evidence. A launch with no result
        // (still running, or the transcript ends first) stays unknown.
        isError: outcome?.resolved === true ? outcome.isError : null,
        isPartial: outcome?.resolved === true ? outcome.partial === true : null,
        longWaits: activityReturns(subParsed)
          .filter((ret) => ret.gapMs >= SUBAGENT_VERDICT_RULES.longWaitMinMs && ret.gapMs < SUBAGENT_VERDICT_RULES.longWaitMaxMs)
          .map((ret) => ({ at: ret.at, rewrittenTokens: ret.rewrittenTokens,
            rewrittenTokens5m: ret.rewrittenTokens5m, rewrittenTokens1h: ret.rewrittenTokens1h,
            model: last?.model ?? null })),
      });
    }
    sessions.push({
      sessionId,
      arm: armForSessionId(sessionId),
      parentModel,
      firstAt: parsed.requests.find((r) => r.at !== null)?.at ?? null,
      activityAt: parsed.requests.map((r) => r.at).filter((at) => at !== null),
      subagents,
      unplacedUsageRecords,
    });
  }
  return sessions;
}

/**
 * Per-arm measurement over the sessions' helpers. `exposures` is the map of
 * trial-exposure intervals from `eligibleClaudeExposures`: a helper is trial
 * exposure only when its spawn time falls inside one of its session's
 * intervals, so a later resume that turns the trial off can never leave
 * later helpers counted as exposure.
 */
function armMetrics(sessions, arm, { sinceMs: from, untilMs: to }, exposures) {
  const inWindow = (at) => Number.isFinite(at) && at >= from && at < to;
  const exposedAt = (sessionId, at) => (exposures.get(sessionId) ?? [])
    .some((span) => at >= span.start && at < span.end);
  const armSessions = sessions.filter((s) => s.arm === arm && exposures.has(s.sessionId)
    && (s.activityAt?.some((at) => inWindow(at) && exposedAt(s.sessionId, at))
      || (s.unplacedUsageRecords > 0 && exposures.get(s.sessionId).some(span => span.start < to && span.end > from))
      || s.subagents.some((a) => inWindow(a.firstAt) && a.lastAt < to && exposedAt(s.sessionId, a.firstAt))));
  const subagents = armSessions.flatMap((s) => s.subagents.filter((a) => inWindow(a.firstAt)
    && a.lastAt < to && exposedAt(s.sessionId, a.firstAt))
    .map(a => ({ ...a, parentSessionId: s.sessionId })));
  const gp = subagents.filter((a) => a.meta?.agentType === 'general-purpose');
  const models = new Map();
  for (const a of subagents) {
    const key = a.model ?? '(unknown)';
    models.set(key, (models.get(key) ?? 0) + 1);
  }
  const contexts = subagents.map((a) => a.finalContext).filter(Number.isFinite);
  const unknownUsageRecords = armSessions.reduce((sum, s) => sum + (s.unplacedUsageRecords ?? 0), 0)
    + subagents.reduce((sum, a) => sum + (a.unknownUsageRecords ?? 0), 0);
  const spend = unknownUsageRecords > 0 ? null : subagents.reduce((s, a) => s + a.spendUsd, 0);
  const respawnKnown = gp.filter(a => typeof a.parentTurnId === 'string'
    && Number.isFinite(a.returnedAt) && a.returnedAt >= Math.max(a.startedAt ?? a.firstAt, a.lastAt) && a.returnedAt < to);
  const gpRespawns = detectRespawns(respawnKnown.map(a => ({ ...a, firstAt: a.startedAt ?? a.firstAt })));
  // Step 2's quality sign is the partial-or-error rate: a helper that ended
  // with an error or a non-completed terminal status.
  const badEnds = gp.filter((a) => a.isError === true || a.isPartial === true);
  const errors = gp.filter((a) => a.isError === true);
  const guardChecked = subagents.filter((a) => policyMovedAgentType(a.meta?.agentType)
    && reviewKeywordMatch(a.meta?.description));
  // Only a known family on both sides can be compared. A helper or parent with
  // no recorded or unrecognised model is unverified, never compliant.
  const guardUnknown = guardChecked.filter((a) => modelFamily(a.model) === 'other' || modelFamily(a.parentModel) === 'other');
  const guardViolations = guardChecked.filter((a) => modelFamily(a.model) !== 'other' && modelFamily(a.parentModel) !== 'other'
    && modelFamily(a.model) !== modelFamily(a.parentModel));
  const runMs = subagents.map((a) => a.runMs).filter((n) => Number.isFinite(n));
  const toolUses = subagents.map((a) => a.toolUses).filter((n) => Number.isFinite(n));
  return {
    sessions: armSessions.length,
    subagents: subagents.length,
    gpSubagents: gp.length,
    spendUsd: spend,
    unknownUsageRecords,
    spendPerSessionUsd: spend === null ? null : armSessions.length > 0 ? spend / armSessions.length : 0,
    spendPerGpUsd: spend === null ? null : gp.length > 0 ? gp.reduce((s, a) => s + a.spendUsd, 0) / gp.length : 0,
    models,
    finalContextMedian: median(contexts),
    finalContextP90: p90(contexts),
    spawnDepthMedian: median(gp.map((a) => a.meta?.spawnDepth).filter((n) => Number.isFinite(n))),
    respawnRate: gp.length > 0 ? gpRespawns / gp.length : 0,
    respawnUnknown: gp.length - respawnKnown.length,
    badEndRate: gp.length > 0 ? badEnds.length / gp.length : 0,
    badEndCount: badEnds.length,
    errorCount: errors.length,
    partialCount: gp.filter((a) => a.isPartial === true).length,
    outcomesUnknown: gp.filter((a) => a.isError === null).length,
    reviewerGuardChecked: guardChecked.length,
    reviewerGuardViolations: guardViolations.length,
    reviewerGuardUnknown: guardUnknown.length,
    runMsMedian: median(runMs),
    runMsUnknown: subagents.length - runMs.length,
    toolUsesMedian: median(toolUses),
    toolUsesUnknown: subagents.length - toolUses.length,
  };
}

/**
 * The long-wait cache metric (TR-2's method): subagent gaps of 5-60 minutes
 * followed by a cache rewrite, bucketed before/after the waiting rule shipped
 * (`waitingRuleMs`, the first logged delivery). Counts, rewritten tokens and the
 * estimated dollars of the rewrites.
 */
export function longWaitCacheMetric(sessions, waitingRuleMs, prices = null, opts = {}) {
  const from = opts.sinceMs ?? 0;
  const to = opts.untilMs ?? Number.MAX_SAFE_INTEGER;
  const delivered = opts.delivered;
  let unknownUsageRecords = 0;
  const buckets = {
    before: { count: 0, tokens: 0, usd: 0, runMs: [] },
    after: { count: 0, tokens: 0, usd: 0, runMs: [] },
  };
  for (const session of sessions) {
    const afterExposure = delivered?.get(session.sessionId);
    if ((session.unplacedUsageRecords ?? 0) > 0
      && ((!Number.isFinite(session.firstAt))
        || (afterExposure !== undefined && afterExposure < to)
        || session.activityAt?.some(at => at >= from && at < Math.min(to, waitingRuleMs)))) {
      unknownUsageRecords += session.unplacedUsageRecords;
    }
    for (const a of session.subagents) {
      const lastPossibleAt = Math.max(a.lastAt, a.returnedAt ?? a.lastAt);
      if ((a.unknownUsageRecords ?? 0) > 0 && a.firstAt < to && lastPossibleAt >= from
        && (a.firstAt < waitingRuleMs || !delivered
          || (afterExposure !== undefined && lastPossibleAt >= Math.max(waitingRuleMs, afterExposure)))) {
        unknownUsageRecords += a.unknownUsageRecords;
      }
      if (a.firstAt >= from && a.lastAt < to && Number.isFinite(a.runMs)
        && (a.firstAt < waitingRuleMs || !delivered || (afterExposure !== undefined && a.firstAt >= afterExposure))) {
        const bucket = a.firstAt < waitingRuleMs ? buckets.before : buckets.after;
        bucket.runMs.push(a.runMs);
      }
      for (const wait of a.longWaits) {
        // Keep the 5-minute/1-hour split so each part is priced at its own
        // multiple. A legacy entry carrying only the total is read as one
        // 5-minute write (the split-missing idiom in claude-transcripts.mjs).
        const rewritten5m = wait.rewrittenTokens5m ?? wait.rewrittenTokens ?? 0;
        const rewritten1h = wait.rewrittenTokens1h ?? 0;
        const rewritten = wait.rewrittenTokens ?? rewritten5m + rewritten1h;
        if (!(rewritten > 0) || wait.at < from || wait.at >= to) continue;
        if (delivered && wait.at >= waitingRuleMs && (afterExposure === undefined || wait.at < afterExposure)) continue;
        const bucket = wait.at < waitingRuleMs ? buckets.before : buckets.after;
        const p = priceFor(wait.model, prices);
        bucket.count += 1;
        bucket.tokens += rewritten;
        bucket.usd += (rewritten5m * p.inputPerMTok * CACHE_WRITE_5M_MULT
          + rewritten1h * p.inputPerMTok * CACHE_WRITE_1H_MULT) / 1e6;
      }
    }
  }
  return {
    unknownUsageRecords,
    before: { count: buckets.before.count, tokens: buckets.before.tokens, usd: buckets.before.usd, runMsMedian: median(buckets.before.runMs) },
    after: { count: buckets.after.count, tokens: buckets.after.tokens, usd: buckets.after.usd, runMsMedian: median(buckets.after.runMs) },
  };
}

/**
 * The Claude plan-queue landed share per group. Each item counts in the group
 * of its first worker: the workers the caller lists under the item's raw key
 * (`armKey`), earliest first. Items with no logged worker are unassigned; an
 * item whose workers span both groups is counted mixed and grouped by its
 * earliest worker.
 *
 * The worker list must cover history before `untilMs`, including before
 * `--since`: an item keeps its first worker's group even when `--since`
 * starts after that worker (Step 2's first-worker rule). Workers at or after
 * the exclusive cutoff cannot assign an item or make it mixed.
 *
 * `untilMs` bounds the landings like every other measurement, the exact
 * mirror of the Codex report's plan-queue rule: only `updated_at` can place a
 * landing in time, so one that settles at or after the cutoff is outside the
 * window (`landedAfterWindow`, never counted as landed) and one without a
 * usable `updated_at` cannot be placed before it (`landedUnplaced`, unknown,
 * never counted as landed). With no `--until` (the default) every placeable
 * landing counts, as before.
 */
export function planQueueShare(policyEntries, items, untilMs = Number.MAX_SAFE_INTEGER) {
  const byItem = new Map();
  for (const rec of policyEntries) {
    const at = Date.parse(rec.at);
    if (rec.provider !== 'claude' || !rec.armKey || !Number.isFinite(at) || at >= untilMs) continue;
    const list = byItem.get(rec.armKey) ?? [];
    list.push(rec);
    byItem.set(rec.armKey, list);
  }
  const share = {
    'sonnet': { items: 0, landed: 0 },
    'same-as-session': { items: 0, landed: 0 },
    mixedItems: 0,
    unassignedItems: 0,
    landedAfterWindow: 0,
    landedUnplaced: 0,
    landedUnplacedByArm: { sonnet: 0, 'same-as-session': 0 },
  };
  for (const item of items) {
    const recs = (byItem.get(item.id) ?? []).slice().sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    if (recs.length === 0) {
      share.unassignedItems += 1;
      continue;
    }
    const arms = new Set(recs.map((r) => r.arm).filter((a) => a === 'sonnet' || a === 'same-as-session'));
    if (arms.size > 1) share.mixedItems += 1;
    const arm = recs.find((r) => r.arm === 'sonnet' || r.arm === 'same-as-session')?.arm;
    if (!arm) {
      share.unassignedItems += 1;
      continue;
    }
    share[arm].items += 1;
    if (!item.landed_commit) continue;
    const updated = item.updated_at;
    const placed = typeof updated === 'number' && Number.isFinite(updated) && updated >= 0;
    if (!placed) {
      share.landedUnplaced += 1;
      share.landedUnplacedByArm[arm] += 1;
      continue;
    }
    if (updated >= untilMs) {
      share.landedAfterWindow += 1;
      continue;
    }
    share[arm].landed += 1;
  }
  return share;
}

/** Session-policy log entries (same reader shape as the Codex trial report). */
export function parsePolicyLog(dir, fromMs, toMs) {
  if (!dir || !existsSync(dir)) return { entries: [], unparsableLines: 0 };
  const entries = [];
  let unparsableLines = 0;
  const untilDay = toMs < Number.MAX_SAFE_INTEGER ? new Date(toMs).toISOString().slice(0, 10) : null;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    // The writer uses UTC write-day filenames; later files cannot affect a
    // historical report. Earlier damage may hide a still-relevant exposure.
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
      if (rec.provider !== 'claude') continue;
      const at = Date.parse(rec.at);
      if (!Number.isFinite(at)) { unparsableLines += 1; continue; }
      if (at < fromMs || at >= toMs) continue;
      entries.push(rec);
    }
  }
  return { entries, unparsableLines };
}

/** Pre-release, failed-spawn and no-reviewer-rule records cannot enter the trial. */
function isEligibleClaudeExposure(rec) {
  return rec.provider === 'claude' && rec.setting === 'trial'
    && rec.reviewerRuleDelivered === true && typeof rec.sessionId === 'string'
    && rec.arm === armForSessionId(rec.sessionId)
    && rec.applied === (rec.arm === 'sonnet');
}

/**
 * Trial exposure from the session-policy log.
 *
 * `eligible` is every eligible record inside the analysis window (the exposure
 * records for the window's helper measurements). `intervalsBySession` is the
 * real exposure timeline: a session is under trial exposure from an eligible
 * record until the next record for the same session that is not eligible (a
 * resume that changes the setting or fails the guards ends it; a later eligible
 * record re-opens it). Helpers are measured only inside those intervals, so a
 * later resume that turns the trial off can never leave its later helpers
 * counted as exposure. `firstBySession` holds each session's first exposure
 * start before the exclusive `toMs` cutoff, including before `fromMs`: the
 * log records when the trial actually ran. Plan-queue grouping retains the
 * same earlier history — see `planQueueShare`.
 */
export function eligibleClaudeExposures(policyEntries, fromMs, toMs) {
  const eligible = policyEntries.filter((rec) => {
    const at = Date.parse(rec.at);
    return isEligibleClaudeExposure(rec) && Number.isFinite(at) && at >= fromMs && at < toMs;
  });
  const recordsBySession = new Map();
  for (const rec of policyEntries) {
    if (rec.provider !== 'claude' || typeof rec.sessionId !== 'string') continue;
    const at = Date.parse(rec.at);
    if (!Number.isFinite(at) || at >= toMs) continue;
    const list = recordsBySession.get(rec.sessionId) ?? [];
    list.push({ at, exposed: isEligibleClaudeExposure(rec) });
    recordsBySession.set(rec.sessionId, list);
  }
  const firstBySession = new Map();
  const intervalsBySession = new Map();
  for (const [sessionId, records] of recordsBySession) {
    records.sort((a, b) => a.at - b.at);
    const spans = [];
    for (const record of records) {
      const open = spans.length > 0 ? spans[spans.length - 1] : null;
      if (record.exposed) {
        if (!open || open.end !== null) spans.push({ start: record.at, end: null });
      } else if (open && open.end === null) {
        open.end = record.at;
      }
    }
    if (spans.length === 0) continue;
    for (const span of spans) {
      if (span.end === null) span.end = Number.POSITIVE_INFINITY;
      const first = firstBySession.get(sessionId);
      if (first === undefined || span.start < first) firstBySession.set(sessionId, span.start);
    }
    intervalsBySession.set(sessionId, spans);
  }
  return { eligible, firstBySession, intervalsBySession };
}

export function aggregateSubagentMetrics(sessions, opts) {
  const { sinceMs: from, untilMs: to, policyEntries: policyHistory = [], policyUnparsableLines = 0, items = [], prices = null } = opts;
  // All policy-derived evidence is historical as of the exclusive cutoff.
  // Keep pre-since records for first-worker ownership and actual rollout dates.
  const policyEntries = policyHistory.filter((rec) => {
    const at = Date.parse(rec.at);
    return Number.isFinite(at) && at < to;
  });
  const { firstBySession, intervalsBySession } = eligibleClaudeExposures(policyEntries, from, to);
  const firstExposure = Math.min(...firstBySession.values());
  const waitingRuleActivationMs = policyEntries.reduce((first, rec) => {
    const at = Date.parse(rec.at);
    return rec.provider === 'claude' && rec.waitingRuleDelivered === true && Number.isFinite(at)
      ? Math.min(first, at) : first;
  }, Infinity);
  const waitingRuleDelivered = new Map();
  if (Number.isFinite(waitingRuleActivationMs)) {
    for (const rec of policyEntries) {
      const at = Date.parse(rec.at);
      if (rec.provider !== 'claude' || rec.waitingRuleDelivered !== true || typeof rec.sessionId !== 'string'
        || !Number.isFinite(at)) continue;
      waitingRuleDelivered.set(rec.sessionId, Math.min(waitingRuleDelivered.get(rec.sessionId) ?? at, at));
    }
  }
  const arms = {
    'sonnet': armMetrics(sessions, 'sonnet', { sinceMs: from, untilMs: to }, intervalsBySession),
    'same-as-session': armMetrics(sessions, 'same-as-session', { sinceMs: from, untilMs: to }, intervalsBySession),
  };
  const days = Number.isFinite(firstExposure) ? Math.max(0, (Math.min(to, Date.now()) - firstExposure) / (24 * 60 * 60 * 1000)) : 0;
  // Step 2's first-worker rule retains all eligible workers before `to`,
  // including before `from`; future workers cannot change assignments/mixing.
  const workers = policyEntries.filter(isEligibleClaudeExposure);
  return {
    policyUnparsableLines,
    arms,
    sample: { days, gp: { 'sonnet': arms['sonnet'].gpSubagents, 'same-as-session': arms['same-as-session'].gpSubagents } },
    trialExposureMs: Number.isFinite(firstExposure) ? firstExposure : null,
    waitingRuleActivationMs: Number.isFinite(waitingRuleActivationMs) ? waitingRuleActivationMs : null,
    waitingRule: Number.isFinite(waitingRuleActivationMs)
      ? longWaitCacheMetric(sessions, waitingRuleActivationMs, prices,
        { sinceMs: from, untilMs: to, delivered: waitingRuleDelivered })
      : longWaitCacheMetric([], 0, prices),
    planQueue: planQueueShare(workers, items, to),
  };
}

/**
 * The plan's verdict rules, in order: the reviewer guard vetoes; the sample
 * gates (14 days, 300 general-purpose helpers per group) hold everything else
 * at pending; then "adopt Sonnet" needs every criterion. Anything else keeps
 * "Same as the session" for chats and reports. The waiting rule is judged
 * separately on its before/after halves.
 */
export function evaluateSubagentVerdict(metrics, rules = SUBAGENT_VERDICT_RULES) {
  // A lost start/resume may remove a guard violation, extend exposure, change
  // first-worker ownership or move waiting-rule delivery. None of the trial
  // conclusions is established by the surviving population alone.
  if (metrics.policyUnparsableLines > 0) {
    return {
      verdict: 'pending (policy evidence)',
      waitingRule: 'pending (policy evidence)',
      notes: [`${metrics.policyUnparsableLines} damaged or unplaceable policy records; trial exposure and waiting-rule delivery are incomplete; recommendations withheld`],
    };
  }
  const notes = [];
  const s = metrics.arms['sonnet'];
  const c = metrics.arms['same-as-session'];

  if (!s || !c || (s.gpSubagents === 0 && c.gpSubagents === 0)) {
    return { verdict: 'pending (no data)', waitingRule: 'pending (no data)', notes: ['no general-purpose helpers on either side yet'] };
  }

  const guardShare = s.reviewerGuardChecked > 0 ? s.reviewerGuardViolations / s.reviewerGuardChecked : 0;
  const guardFail = guardShare > rules.reviewerGuardShare;

  // Points are compared at 0.1-point resolution so an exact threshold never
  // fails on floating-point noise.
  const round1 = (n) => Math.round(n * 10) / 10;
  const spendKnown = s.spendPerSessionUsd !== null && c.spendPerSessionUsd !== null;
  const spendDrop = spendKnown && c.spendPerSessionUsd > 0 ? 1 - s.spendPerSessionUsd / c.spendPerSessionUsd : 0;
  const respawnRisePoints = round1((s.respawnRate - c.respawnRate) * 100);
  const badEndRisePoints = round1((s.badEndRate - c.badEndRate) * 100);
  const landed = metrics.planQueue;
  const cLandedShare = landed['same-as-session'].items > 0 ? landed['same-as-session'].landed / landed['same-as-session'].items : null;
  const sLandedShare = landed['sonnet'].items > 0 ? landed['sonnet'].landed / landed['sonnet'].items : null;
  const landedDropPoints = cLandedShare !== null && sLandedShare !== null ? round1((cLandedShare - sLandedShare) * 100) : null;
  // An undated landing may fall on either side of the cutoff. Keep each
  // arm's known share as its lower bound and include all its undated landings
  // for its upper bound. Only a guaranteed loss can reject on landing quality;
  // adoption needs the worst possible loss to meet the rule.
  const cLandedUpper = cLandedShare === null ? null
    : (landed['same-as-session'].landed + landed.landedUnplacedByArm['same-as-session']) / landed['same-as-session'].items;
  const sLandedUpper = sLandedShare === null ? null
    : (landed.sonnet.landed + landed.landedUnplacedByArm.sonnet) / landed.sonnet.items;
  const minLandedDrop = cLandedShare !== null && sLandedUpper !== null ? round1((cLandedShare - sLandedUpper) * 100) : null;
  const maxLandedDrop = cLandedUpper !== null && sLandedShare !== null ? round1((cLandedUpper - sLandedShare) * 100) : null;

  const sampleReady =
    metrics.sample.days >= rules.minDays &&
    metrics.sample.gp['sonnet'] >= rules.minGeneralPurposePerGroup &&
    metrics.sample.gp['same-as-session'] >= rules.minGeneralPurposePerGroup;

  notes.push(
    spendKnown ? `spend per session: ${fmtUsd(s.spendPerSessionUsd)} vs ${fmtUsd(c.spendPerSessionUsd)} (${(spendDrop * 100).toFixed(1)}% lower; need ≥${rules.spendDrop * 100}%)`
      : `spend per session unknown: ${s.unknownUsageRecords ?? 0}/${c.unknownUsageRecords ?? 0} damaged or unattributable usage records; no saving can be established`,
    `re-spawn rate: ${(s.respawnRate * 100).toFixed(1)}% vs ${(c.respawnRate * 100).toFixed(1)}% (rise ${respawnRisePoints.toFixed(1)} pts; allow ≤${rules.respawnRisePoints}); ${s.respawnUnknown ?? 0}/${c.respawnUnknown ?? 0} helper lifecycles unknown`,
    `partial-or-error rate: ${(s.badEndRate * 100).toFixed(1)}% vs ${(c.badEndRate * 100).toFixed(1)}% (rise ${badEndRisePoints.toFixed(1)} pts; allow ≤${rules.errorRisePoints}); ${s.outcomesUnknown ?? 0}/${c.outcomesUnknown ?? 0} helper outcomes unknown`,
    `plan-queue landed share: ${sLandedShare === null ? 'n/a' : (sLandedShare * 100).toFixed(1) + '%'} vs ${cLandedShare === null ? 'n/a' : (cLandedShare * 100).toFixed(1) + '%'}${landedDropPoints === null ? '' : ` (drop ${landedDropPoints.toFixed(1)} pts; allow ≤${rules.landedDropPoints})`}`,
    `reviewer guard: ${s.reviewerGuardViolations} of ${s.reviewerGuardChecked} review-named helpers ran on a different model family (allow ≤${rules.reviewerGuardShare * 100}%); ${s.reviewerGuardUnknown ?? 0} with no known model family`,
  );
  if (landed.landedUnplaced > 0) {
    notes.push(`plan-queue landings with unknown dates: ${landed.landedUnplacedByArm.sonnet} Sonnet, ${landed.landedUnplacedByArm['same-as-session']} same-as-session; possible landing-share drop: ${minLandedDrop === null ? 'n/a' : `${minLandedDrop.toFixed(1)} to ${maxLandedDrop.toFixed(1)} pts`}`);
  }

  let verdict;
  if (guardFail) {
    verdict = 'do-not-adopt (the reviewer rule must be firmer first)';
    notes.push('reviewer guard failed: do not adopt; the reviewer rule must be made firmer first');
  } else if (!sampleReady) {
    verdict = 'pending (sample)';
    notes.push(`sample gates not met yet: ${rules.minDays} days and ${rules.minGeneralPurposePerGroup} general-purpose helpers per group (have ${metrics.sample.days.toFixed(1)} days, ${metrics.sample.gp['sonnet']}/${metrics.sample.gp['same-as-session']})`);
  } else if ((s.respawnUnknown ?? 0) + (c.respawnUnknown ?? 0) > 0) {
    verdict = 'pending (helper turn/return evidence)';
    notes.push('A helper without parent-turn or return evidence cannot establish the re-spawn quality guard.');
  } else if ((s.reviewerGuardUnknown ?? 0) > 0) {
    verdict = 'pending (helper model evidence)';
    notes.push('A review-named helper with no known model family cannot pass the reviewer guard; adoption waits for its model.');
  } else if ((s.outcomesUnknown ?? 0) + (c.outcomesUnknown ?? 0) > 0) {
    verdict = 'pending (helper outcome evidence)';
    notes.push('A helper with no recorded result cannot establish the partial-or-error quality guard.');
  } else {
    const spendHeld = spendDrop + 1e-9 >= rules.spendDrop;
    const measuredQualityFailed =
      respawnRisePoints > rules.respawnRisePoints ||
      badEndRisePoints > rules.errorRisePoints ||
      (minLandedDrop !== null && minLandedDrop > rules.landedDropPoints);
    if (!spendKnown) {
      verdict = measuredQualityFailed
        ? 'keep-same-as-session-for-chats (spend unknown and a quality sign failed; report)'
        : 'pending (helper spend evidence)';
    } else if (!spendHeld) {
      verdict = 'keep-same-as-session (spend saving below the rule)';
    } else if (measuredQualityFailed) {
      verdict = 'keep-same-as-session-for-chats (spend falls but a quality sign failed; report)';
    } else if (maxLandedDrop === null || maxLandedDrop > rules.landedDropPoints) {
      // Step 2 adopts only when the landed share is no more than 10 points
      // lower. With no items, or a range that crosses the rule, it is unknown, and
      // missing quality evidence must withhold adoption, never pass it (the
      // same rule as missing run-time evidence in the waiting rule below).
      verdict = 'pending (plan-queue landing evidence)';
    } else {
      verdict = 'adopt-sonnet';
    }
    if (landedDropPoints === null) {
      notes.push(verdict === 'pending (plan-queue landing evidence)'
        ? 'plan-queue landed share has too few items to judge on either side: the ≤10-point drop check cannot pass without it'
        : 'plan-queue landed share has too few items to judge on either side');
    } else if (verdict === 'pending (plan-queue landing evidence)') {
      notes.push('plan-queue landing dates are incomplete: the possible drop exceeds the allowed limit, so adoption must wait for landing evidence');
    }
  }

  const w = metrics.waitingRule;
  let waitingRule;
  let measuredRuntimeFailed = false;
  if (metrics.waitingRuleActivationMs === null) {
    waitingRule = 'pending (rule not delivered)';
  } else if (w.before.count === 0 && w.after.count === 0) {
    waitingRule = 'pending (no long waits yet)';
  } else if (w.before.count === 0) {
    waitingRule = 'pending (no pre-rule long waits to compare)';
    notes.push('waiting rule: no 5-60 minute gaps with a rewrite before the rule shipped, so the before/after comparison cannot run yet');
  } else {
    const rewriteDrop = 1 - w.after.count / w.before.count;
    // Run time comes from the joined 7i records (toolUseId); a half without
    // recorded durations has unknown run time, not zero.
    const runtimeRise = Number.isFinite(w.before.runMsMedian) && Number.isFinite(w.after.runMsMedian)
      && w.before.runMsMedian > 0
      ? w.after.runMsMedian / w.before.runMsMedian - 1
      : null;
    measuredRuntimeFailed = runtimeRise !== null && runtimeRise > rules.waitingRuleRuntimeRise + 1e-9;
    // Thresholds carry the file's +1e-9 epsilon so an exact rule edge never
    // fails on floating-point noise (the same idiom as spendDrop).
    const rewriteHeld = rewriteDrop + 1e-9 >= rules.waitingRuleRewriteDrop;
    // Step 2 keeps the rule only when BOTH criteria hold. Missing run-time
    // evidence must not pass the <=20% rise check: it is unknown, so the
    // verdict waits instead of keeping.
    if (rewriteHeld && runtimeRise === null) {
      waitingRule = 'pending (runtime evidence)';
      notes.push(
        `waiting rule: long-wait cache rewrites ${w.before.count} → ${w.after.count} (${(rewriteDrop * 100).toFixed(1)}% lower; need ≥${rules.waitingRuleRewriteDrop * 100}%), median helper run time unknown (no recorded helper durations joined on toolUseId) — the ≤${rules.waitingRuleRuntimeRise * 100}% rise check cannot pass without it`,
      );
    } else {
      const runtimeHeld = runtimeRise !== null && runtimeRise <= rules.waitingRuleRuntimeRise + 1e-9;
      waitingRule = rewriteHeld && runtimeHeld ? 'keep' : 'report';
      notes.push(
        `waiting rule: long-wait cache rewrites ${w.before.count} → ${w.after.count} (${(rewriteDrop * 100).toFixed(1)}% lower; need ≥${rules.waitingRuleRewriteDrop * 100}%), median helper run time ${runtimeRise === null ? 'n/a' : (runtimeRise * 100).toFixed(1) + '%'} (allow ≤${rules.waitingRuleRuntimeRise * 100}%)`,
      );
    }
  }

  if ((w.unknownUsageRecords ?? 0) > 0) {
    notes.push(`waiting rule: ${w.unknownUsageRecords} damaged or unplaced usage records in its own comparison; observed rewrites are incomplete`);
    if (!measuredRuntimeFailed && (waitingRule === 'keep' || waitingRule === 'report')) {
      waitingRule = 'pending (waiting-rule usage evidence)';
    }
  }
  return { verdict, waitingRule, notes };
}

function renderArmTable(label, m) {
  console.log(`### ${label}\n`);
  console.log('| metric | value |');
  console.log('|---|---|');
  console.log(`| sessions | ${m.sessions} |`);
  console.log(`| helper agents | ${m.subagents} (general-purpose ${m.gpSubagents}) |`);
  console.log(`| spend | ${fmtUsd(m.spendUsd)} (${fmtUsd(m.spendPerSessionUsd)}/session, ${fmtUsd(m.spendPerGpUsd)}/general-purpose helper) |`);
  const modelRows = [...m.models.entries()].map(([k, v]) => `${k} ×${v}`).join(', ') || '(none)';
  console.log(`| models actually run | ${modelRows} |`);
  console.log(`| final context median / p90 | ${m.finalContextMedian === null ? 'n/a' : fmtTok(m.finalContextMedian)} / ${m.finalContextP90 === null ? 'n/a' : fmtTok(m.finalContextP90)} |`);
  console.log(`| spawn depth median | ${m.spawnDepthMedian ?? 'n/a'} |`);
  console.log(`| tool uses / run time (7i records, joined on toolUseId) | ${m.toolUsesMedian ?? 'n/a'} / ${m.runMsMedian === null ? 'n/a' : (m.runMsMedian / 60000).toFixed(1) + ' min'} (${(m.subagents - (m.runMsUnknown ?? 0))}/${m.subagents} helpers carry a recorded run time) |`);
  console.log(`| re-spawn rate | ${(m.respawnRate * 100).toFixed(1)}% (${m.respawnUnknown ?? 0} helper lifecycles unknown) |`);
  console.log(`| ended partial or on an error | ${m.badEndCount} (${(m.badEndRate * 100).toFixed(1)}%; ${m.partialCount} partial, ${m.errorCount} error; ${m.outcomesUnknown} outcomes unknown) |`);
  console.log(`| reviewer guard | ${m.reviewerGuardViolations} of ${m.reviewerGuardChecked} review-named helpers on a different model family (${m.reviewerGuardUnknown} with no known family) |`);
  console.log('');
}

function renderSubagentSection(metrics, verdict) {
  console.log('## A18 subagent trial (--subagents)\n');
  console.log('Groups come from the last hex digit of the native session id: 0-7 run helpers on Sonnet, 8-f run them same-as-session (the fixed split in claude-subagent-policy.ts; sessions with no id are excluded).\n');
  console.log(`Verified reviewer-rule exposure: ${metrics.trialExposureMs === null ? 'none (trial pending)' : new Date(metrics.trialExposureMs).toISOString()} · elapsed ${(metrics.sample.days).toFixed(1)} days.`);
  console.log(`Waiting-rule delivery: ${metrics.waitingRuleActivationMs === null ? 'none (rollout disabled or unlogged)' : new Date(metrics.waitingRuleActivationMs).toISOString()}\n`);
  renderArmTable('Sonnet helpers', metrics.arms['sonnet']);
  renderArmTable('Same-as-session helpers', metrics.arms['same-as-session']);

  const w = metrics.waitingRule;
  console.log('### Long-wait cache rewrites (5-60 minute gaps followed by a rewrite)\n');
  console.log('| half | rewrites | tokens rewritten | est. dollars | median helper run time |');
  console.log('|---|---:|---:|---:|---:|');
  console.log(`| before the waiting rule | ${w.before.count} | ${fmtTok(w.before.tokens)} | ${fmtUsd(w.before.usd)} | ${w.before.runMsMedian === null ? 'n/a' : (w.before.runMsMedian / 60000).toFixed(1) + ' min'} |`);
  console.log(`| after the waiting rule | ${w.after.count} | ${fmtTok(w.after.tokens)} | ${fmtUsd(w.after.usd)} | ${w.after.runMsMedian === null ? 'n/a' : (w.after.runMsMedian / 60000).toFixed(1) + ' min'} |`);
  console.log('');

  const p = metrics.planQueue;
  console.log('### Plan-queue landing (each item in the group of its first logged worker)\n');
  console.log('| group | items | landed | share |');
  console.log('|---|---:|---:|---:|');
  for (const arm of ['sonnet', 'same-as-session']) {
    const v = p[arm];
    console.log(`| ${arm} | ${v.items} | ${v.landed} | ${v.items > 0 ? ((v.landed / v.items) * 100).toFixed(1) + '%' : 'n/a'} |`);
  }
  console.log(`\nMixed-group items (workers in both groups): ${p.mixedItems}. Unassigned (no logged worker): ${p.unassignedItems}.`);
  console.log(`Landings settled at or after the window cutoff (not counted as landed): ${p.landedAfterWindow ?? 0}. Landings without a usable updated_at (unknown, not counted as landed): ${p.landedUnplaced ?? 0}.\n`);

  console.log('### Verdict\n');
  console.log(`- Claude helper model: **${verdict.verdict}**`);
  console.log(`- Waiting rule: **${verdict.waitingRule}**`);
  for (const note of verdict.notes) console.log(`- ${note}`);
  console.log('');
}

async function runSubagents(attribution = []) {
  const projects = transcriptProjectsDirs(userData, arg('projects', null));
  const policyDir = arg('policy-dir', null) ?? join(userData, 'session-policy');
  const loopDb = arg('loop-db', null) ?? join(userData, 'loop-mode', 'loop-mode.db');
  // Step 2's size-and-effort join: Phase 0's recorded subagent finals carry
  // durationMs/toolUses per toolUseId.
  const sessions = await collectSubagentSessions(projects, priceOverrides,
    { subagentUsage: attribution.filter((r) => r?.subagentUsage === true) });
  const policy = parsePolicyLog(policyDir, 0, untilMs);
  // `updated_at` places each landing in time so the share can be judged as of
  // the reporting cutoff (the Codex report's plan-queue rule).
  const items = queryRows(loopDb, 'SELECT id, state, landed_commit, created_at, updated_at FROM plan_queue_items', []) ?? [];
  const metrics = aggregateSubagentMetrics(sessions, {
    sinceMs,
    untilMs,
    policyEntries: policy.entries,
    policyUnparsableLines: policy.unparsableLines,
    items,
    prices: priceOverrides,
  });
  const verdict = evaluateSubagentVerdict(metrics);
  renderSubagentSection(metrics, verdict);
}

/** Phase0 read-only comparison against isolated Claude transcripts. */
async function runTranscriptComparison() {
  // The Phase0 module is supplied by the controller's rebase. Resolve only
  // when this optional mode is requested so the other reports remain usable.
  const comparisonModule = './claude-transcript-cost-comparison.mjs';
  const { compareTranscriptCosts } = await import(/* @vite-ignore */ comparisonModule);
  const day = arg('day', null);
  if (!day || !/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('--day YYYY-MM-DD is required');
  const start = new Date(`${day}T00:00:00`).getTime();
  const local = new Date(start);
  const localDay = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;
  if (!Number.isFinite(start) || localDay !== day) throw new Error('Invalid --day');
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  const end = next.getTime();
  const rlmDb = join(userData, 'rlm', 'rlm.db');
  const rows = queryRows(rlmDb, 'SELECT * FROM cost_entries WHERE timestamp >= ? AND timestamp < ?', [start, end]);
  if (!rows) throw new Error('Cannot read cost_entries');
  const providers = new Map();
  for (const record of readAttribution()) {
    if (record.instanceId && record.model && record.provider) {
      providers.set(JSON.stringify([record.instanceId, record.model]), record.provider.replace(/-cli$/, ''));
    }
  }
  const claudeRows = rows.filter((row) => {
    const provider = providers.get(JSON.stringify([row.instance_id, row.model]));
    return provider ? provider === 'claude' : /^(opus|sonnet|haiku|fable)(\[1m\])?$/.test(row.model) || row.model.startsWith('claude-');
  });
  const roots = transcriptProjectsDirs(userData, arg('projects', null));
  const threshold = Number(arg('max-diff-pct', '5'));
  if (!Number.isFinite(threshold) || threshold < 0) throw new Error('Invalid --max-diff-pct');
  const byModel = queryRows(rlmDb,
    `SELECT u.model, SUM(u.input_tokens) AS input, SUM(u.output_tokens) AS output,
      SUM(u.cache_read_tokens) AS cacheRead, SUM(u.cache_write_tokens) AS cacheWrite, SUM(u.cost_usd) AS cost
      FROM cost_entry_model_usage u JOIN cost_entries e ON e.id=u.entry_id
      WHERE e.timestamp >= ? AND e.timestamp < ? AND e.id IN (${claudeRows.map(() => '?').join(',') || 'NULL'}) GROUP BY u.model`,
    [start, end, ...claudeRows.map((row) => row.id)]) ?? [];
  const report = compareTranscriptCosts({ rows: claudeRows, roots, start, end, prices: priceOverrides ?? {}, maxDiffPct: threshold, byModel });
  if (process.argv.includes('--json')) console.log(JSON.stringify({ day, ...report }, null, 2));
  else {
    console.log(`Claude ${day}: stored ${fmtUsd(report.stored)}, transcripts ${fmtUsd(report.transcript)} (main ${fmtUsd(report.main)}, subagent ${fmtUsd(report.subagent)}), gap ${report.gapPct ?? 'unbounded'}%`);
    console.log(JSON.stringify(report, null, 2));
  }
  process.exitCode = report.exceeded ? 1 : 0;
}

async function main() {
  if (process.argv.includes('--compare-transcripts')) {
    await runTranscriptComparison();
    return;
  }
  console.log(`# Claude cost audit report\n`);
  console.log(`userData: ${userData}`);
  console.log(`since: ${sinceMs ? new Date(sinceMs).toISOString() : '(all time)'}`);
  console.log(`until: ${untilMs < Number.MAX_SAFE_INTEGER ? new Date(untilMs).toISOString() : '(now)'}\n`);
  const attribution = readAttribution();
  reportAttribution(attribution);
  reportSubagents(attribution);
  reportCostEntries();
  reportLoopIterations();
  if (wantSubagents) await runSubagents(attribution);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
