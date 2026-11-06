#!/usr/bin/env node
/**
 * RTK auto-approve hook trial report (A13, Step 18b).
 *
 * Read-only. Joins three sources by session id:
 *   1. the cost-attribution JSONL (explicit eligible trial rows carry arm,
 *      raw trial key, surface and native session id),
 *   2. Harness's hook decision log (<userData>/rtk/hook-decisions/*.jsonl),
 *   3. Claude transcripts under ~/.claude/projects and the managed account
 *      profiles' projects homes (<userData>/claude-cli-profiles/<profile>/projects;
 *      Bash tool calls and results, via scripts/lib/claude-transcripts.mjs
 *      for the window; AIO_RTK_TRIAL_PROJECTS_DIR overrides the roots).
 *
 * Prints, per trial group and surface (interactive session vs loop), the
 * sample counts and the mechanism metrics, then one PASS/FAIL line per
 * guardrail (G1-G5), the benefit check, and the cost-per-turn comparison with
 * a 90 percent bootstrap interval. The verdict rules are exactly the plan's:
 * a guardrail breach means "set rtkAutoApproveScope back to off"; the benefit
 * must hold; cost is reported, with +2% as the roll-out ceiling.
 *
 * Usage:
 *   node scripts/rtk-trial-report.mjs --since 2026-10-20 [--until ...] [--json]
 */

import { existsSync, readdirSync, readFileSync, createReadStream } from 'fs';
import { createInterface } from 'node:readline';
import { homedir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'node:url';
import { listTranscripts, transcriptProjectsDirs } from './lib/claude-transcripts.mjs';

// ── args ────────────────────────────────────────────────────────────────────
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const userData = arg('userdata', join(homedir(), 'Library', 'Application Support', 'harness'));
const sinceArg = arg('since', null);
const untilArg = arg('until', null);
const sinceMs = sinceArg ? new Date(sinceArg).getTime() : 0;
const untilMs = untilArg ? new Date(untilArg).getTime() : Number.POSITIVE_INFINITY;
const asJson = process.argv.includes('--json');

// ── pure statistics (exported for the spec) ────────────────────────────────

/** 90% bootstrap interval for the mean cost per turn. Deterministic LCG. */
export function bootstrapMeanInterval(values, { iterations = 2_000, seed = 42, confidence = 0.9 } = {}) {
  if (!values.length) return { point: 0, lo: 0, hi: 0 };
  const point = values.reduce((a, b) => a + b, 0) / values.length;
  let state = seed >>> 0;
  const rand = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
  const means = [];
  for (let i = 0; i < iterations; i += 1) {
    let sum = 0;
    for (let j = 0; j < values.length; j += 1) {
      sum += values[Math.floor(rand() * values.length)];
    }
    means.push(sum / values.length);
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  return {
    point,
    lo: means[Math.floor(alpha * means.length)],
    hi: means[Math.min(means.length - 1, Math.floor((1 - alpha) * means.length))],
  };
}

/**
 * G1: rewritten Bash calls in the RTK group must fail at most 1.0 percentage
 * point more often than non-rewritten calls in the SAME sessions.
 */
export function evaluateG1(m, rules = { maxDeltaPp: 1.0 }) {
  const unresolved = (m.rewrittenUnresolved ?? 0) + (m.otherUnresolved ?? 0);
  if (unresolved > 0) {
    return {
      name: 'G1 rewritten-call failures', pass: null,
      detail: `not measured: ${unresolved} on-arm Bash calls lack tool results`,
    };
  }
  const rewrittenRate = m.rewrittenTotal > 0 ? (100 * m.rewrittenFail) / m.rewrittenTotal : 0;
  const otherRate = m.otherTotal > 0 ? (100 * m.otherFail) / m.otherTotal : 0;
  const deltaPp = rewrittenRate - otherRate;
  return {
    name: 'G1 rewritten-call failures',
    // The epsilon keeps the boundary honest against float subtraction noise:
    // 4.9% - 3.9% is 1.0pp at rule precision, not 1.0000000000000004.
    pass: m.rewrittenTotal === 0 || m.otherTotal === 0 ? null : deltaPp <= rules.maxDeltaPp + 1e-9,
    detail: `rewritten ${rewrittenRate.toFixed(1)}% vs other ${otherRate.toFixed(1)}% (Δ ${deltaPp.toFixed(1)}pp; limit ${rules.maxDeltaPp}pp)`,
  };
}

/** G2: Bash calls per session in the RTK group ≤ 105% of the other group. */
export function evaluateG2(m, rules = { maxRatio: 1.05 }) {
  const ratio = m.onSessions > 0 && m.offSessions > 0 && m.offCallsPerSession > 0
    ? m.onCallsPerSession / m.offCallsPerSession : null;
  return {
    name: 'G2 Bash calls per session',
    // The epsilon keeps the boundary honest against float division noise.
    pass: ratio === null ? null : ratio <= rules.maxRatio + 1e-9,
    detail: `${(m.onCallsPerSession ?? 0).toFixed(1)} vs ${(m.offCallsPerSession ?? 0).toFixed(1)} per session (ratio ${ratio?.toFixed(2) ?? 'n/a'}; limit ${rules.maxRatio})`,
  };
}

/** G3: turns per session in the RTK group ≤ 105% of the other group. */
export function evaluateG3(m, rules = { maxRatio: 1.05 }) {
  const ratio = m.onSessions > 0 && m.offSessions > 0 && m.offTurnsPerSession > 0
    ? m.onTurnsPerSession / m.offTurnsPerSession : null;
  return {
    name: 'G3 turns per session',
    // The epsilon keeps the boundary honest against float division noise.
    pass: ratio === null ? null : ratio <= rules.maxRatio + 1e-9,
    detail: `${(m.onTurnsPerSession ?? 0).toFixed(1)} vs ${(m.offTurnsPerSession ?? 0).toFixed(1)} per session (ratio ${ratio?.toFixed(2) ?? 'n/a'}; limit ${rules.maxRatio})`,
  };
}

/**
 * G5: retry-after-rewrite (the next Bash call re-sends the same command with
 * `rtk proxy`, `RTK_DISABLED=1` or unchanged) under 3% of rewritten calls.
 */
export function evaluateG5(m, rules = { maxRatePct: 3 }) {
  const rate = m.rewrittenTotal > 0 ? (100 * m.retryAfterRewrite) / m.rewrittenTotal : null;
  return {
    name: 'G5 retry-after-rewrite',
    pass: rate === null ? null : rate < rules.maxRatePct,
    detail: `${m.retryAfterRewrite} of ${m.rewrittenTotal} rewritten calls retried (${rate?.toFixed(1) ?? 'n/a'}%; limit ${rules.maxRatePct}%)`,
  };
}

/**
 * Benefit (must hold): median tool-result characters per rewritten Bash call
 * down at least 30% against the same group's un-rewritten baseline / the
 * other group.
 */
export function evaluateBenefit(m, rules = { minReductionPct: 30 }) {
  if (m.onMedianCharsRewritten === null || m.onMedianCharsRewritten === undefined || !(m.offMedianChars > 0)) {
    return { name: 'Benefit: shorter tool results', pass: null, detail: 'not enough data' };
  }
  const reduction = 100 * (1 - m.onMedianCharsRewritten / m.offMedianChars);
  return {
    name: 'Benefit: shorter tool results',
    pass: reduction >= rules.minReductionPct,
    detail: `median ${Math.round(m.onMedianCharsRewritten)} vs ${Math.round(m.offMedianChars)} chars (${reduction.toFixed(1)}% shorter; need ${rules.minReductionPct}%)`,
  };
}

/** Cost comparison: reported, not required; +2% point estimate is the ceiling. */
export function evaluateCost(m, rules = { maxIncreasePct: 2 }) {
  if (m.onCostPerTurn === null || m.onCostPerTurn === undefined
    || !Number.isFinite(m.onCostPerTurn) || m.onCostPerTurn < 0
    || !Number.isFinite(m.offCostPerTurn) || !(m.offCostPerTurn > 0)) {
    return { name: 'Cost per turn', pass: null, detail: 'no comparison group yet' };
  }
  const increase = 100 * (m.onCostPerTurn / m.offCostPerTurn - 1);
  return {
    name: 'Cost per turn',
    // The epsilon keeps the boundary honest against float division noise.
    pass: increase <= rules.maxIncreasePct + 1e-9,
    detail: `$${m.onCostPerTurn.toFixed(4)} vs $${m.offCostPerTurn.toFixed(4)} (${increase >= 0 ? '+' : ''}${increase.toFixed(1)}%; ceiling +${rules.maxIncreasePct}%)`,
  };
}

/** All criteria in order; `pass: null` means "not measured". */
export function evaluateTrial(metrics, rules) {
  return [
    evaluateG1(metrics, rules?.g1),
    evaluateG2(metrics, rules?.g2),
    evaluateG3(metrics, rules?.g3),
    { name: 'G4 loop verify/stuck signals', pass: null, detail: 'needs Phase 2 B6 loop telemetry; decide loops on G1 and G5 alone if unmeasured' },
    evaluateG5(metrics, rules?.g5),
    evaluateBenefit(metrics, rules?.benefit),
    evaluateCost(metrics, rules?.cost),
  ];
}

export function recommendTrial(verdicts, { sampleReady, stopReached }) {
  // Measured guardrail breaches stop the trial even before the sample matures.
  if (verdicts.some((verdict) => /^G[1235]\b/.test(verdict.name) && verdict.pass === false)) return 'off';
  if (!sampleReady && !stopReached) return 'pending';
  const base = verdicts.filter((verdict) => !verdict.name.startsWith('G4'));
  if (base.some((verdict) => verdict.pass === false)) return 'off';
  if (!sampleReady || base.some((verdict) => verdict.pass === null)) return 'inconclusive';
  const loop = verdicts.find((verdict) => verdict.name.startsWith('G4'));
  return loop?.pass === true ? 'on' : 'sessions-only';
}

// ── data loading ───────────────────────────────────────────────────────────

function readJsonlDir(dir) {
  if (!dir || !existsSync(dir)) return { rows: [], unparsableLines: 0 };
  const rows = [];
  let unparsableLines = 0;
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        unparsableLines += 1;
      }
    }
  }
  return { rows, unparsableLines };
}

function inWindow(tsMs) {
  return tsMs >= sinceMs && tsMs < untilMs;
}

/** Keep every native-session row so an ordinary turn can quarantine its session. */
function readNativeCostRows(dir) {
  const { rows, unparsableLines } = readJsonlDir(dir);
  return { unparsableLines, rows: rows
    .filter((r) => typeof r.sessionId === 'string' && r.sessionId)
    .map((r) => ({
      tsMs: Number(r.ts),
      sessionId: r.sessionId,
      eligible: r.rtkTrialEligible === true && r.provider === 'claude'
      && (r.rtkArm === 'on' || r.rtkArm === 'off')
      && typeof r.rtkTrialKey === 'string' && r.rtkTrialKey.length > 0
      && ((r.rtkTrialSurface === 'interactive' && r.source === 'instance-turn'
          && r.instanceId === r.rtkTrialKey)
        || (r.rtkTrialSurface === 'loop' && r.source === 'one-shot'
          && typeof r.taskType === 'string' && r.taskType.startsWith('loop-orchestration:')
          && typeof r.correlationId === 'string'
          && r.correlationId.startsWith(`${r.rtkTrialKey}::`))),
      arm: r.rtkArm,
      trialKey: r.rtkTrialKey,
      surface: r.rtkTrialSurface,
      source: r.source,
      taskType: r.taskType,
      effort: r.reasoningEffort ?? 'unknown',
      costUsd: r.costKnown === false ? null
        : typeof r.costUsd === 'number' ? r.costUsd
          : typeof r.usage?.cost === 'number' ? r.usage.cost : null,
      newTokens: (r.usage?.inputTokens ?? 0) + (r.usage?.cacheReadTokens ?? 0),
    })) };
}

/** Only explicit Claude auto-approve trial rows; old arm-only rows are unknown. */
export function readTrialCostRows(dir) {
  return readNativeCostRows(dir).rows.filter((row) => row.eligible && inWindow(row.tsMs))
    .map(({ eligible, ...row }) => row);
}

/** Rewrite-only hook lines (the trial hook; defer-mode rows are not the trial). */
export function readHookLines(dir) {
  return readJsonlDir(dir).rows
    .filter((r) => r.mode === 'rewrite-only')
    .filter((r) => inWindow(Date.parse(r.ts) || 0));
}

/**
 * Bash tool calls from one transcript file: { command, at, resultChars, failed }
 * plus whether the FOLLOWING Bash call is a retry-after-rewrite of it.
 */
export async function readBashCalls(path) {
  const calls = [];
  let unparsableLines = 0;
  const seenToolIds = new Set();
  const reader = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of reader) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      unparsableLines += 1;
      continue;
    }
    const message = entry?.message;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === 'tool_use' && block?.name === 'Bash' && typeof block?.input?.command === 'string') {
        if (typeof block.id === 'string' && seenToolIds.has(block.id)) continue;
        if (typeof block.id === 'string') seenToolIds.add(block.id);
        calls.push({
          id: block.id,
          command: block.input.command,
          at: Date.parse(entry.timestamp ?? '') || null,
          resultChars: 0,
          resultObserved: false,
          failed: false,
        });
      } else if (block?.type === 'tool_result') {
        const target = calls.find((c) => c.id === block.tool_use_id && !c.resultObserved);
        if (target) {
          const text = typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('')
              : '';
          target.resultObserved = true;
          target.resultChars = text.length;
          target.failed = block.is_error === true || /(?:^|\n)Exit code:?\s*[1-9]\d*\b/i.test(text);
        }
      }
    }
  }
  for (let i = 0; i < calls.length - 1; i += 1) {
    const next = calls[i + 1].command.trim();
    const current = calls[i].command.trim();
    const unwrap = (command) => command.replace(/^RTK_DISABLED=1\s+/, '').replace(/^rtk\s+(?:proxy\s+)?/, '');
    calls[i].retryAfterRewrite = unwrap(next) === unwrap(current);
  }
  return { calls, unparsableLines };
}

// ── main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!sinceArg || !Number.isFinite(sinceMs) || (untilArg && !Number.isFinite(untilMs))
    || untilMs <= sinceMs) {
    throw new Error('Provide --since YYYY-MM-DD and an optional later --until YYYY-MM-DD.');
  }
  const { rows: costRows, unparsableLines } = readNativeCostRows(process.env.AIO_COST_ATTRIBUTION_DIR || join(userData, 'cost-attribution'));
  // A torn row cannot be assigned to an arm or bounded in cost. Keep observed
  // guardrail failures, but withhold cost comparisons from the known subset.
  const costComplete = unparsableLines === 0;
  const hookLines = readHookLines(join(userData, 'rtk', 'hook-decisions'));

  const bySession = new Map();
  const conflictedSessions = new Set();
  for (const row of costRows) {
    if (conflictedSessions.has(row.sessionId)) continue;
    // The transcript is session-wide. One ordinary or out-of-window turn
    // makes per-session Bash counts incomparable with the cost numerator.
    // Mixed effort also cannot be attributed from a session-wide transcript.
    if (!row.eligible || !Number.isFinite(row.tsMs) || !inWindow(row.tsMs)) {
      bySession.delete(row.sessionId);
      conflictedSessions.add(row.sessionId);
      continue;
    }
    if (bySession.has(row.sessionId) && (
      bySession.get(row.sessionId).arm !== row.arm
      || bySession.get(row.sessionId).trialKey !== row.trialKey
      || bySession.get(row.sessionId).surface !== row.surface
      || bySession.get(row.sessionId).effort !== row.effort
    )) {
      bySession.delete(row.sessionId);
      conflictedSessions.add(row.sessionId);
      continue;
    }
    const s = bySession.get(row.sessionId) ?? {
      sessionId: row.sessionId,
      arm: row.arm,
      trialKey: row.trialKey,
      surface: row.surface,
      effort: row.effort,
      firstTsMs: row.tsMs,
      turns: 0,
      newTokens: 0,
      cost: 0,
      costKnown: true,
      costValues: [],
    };
    s.turns += 1;
    s.firstTsMs = Math.min(s.firstTsMs, row.tsMs);
    s.newTokens += row.newTokens;
    if (row.costUsd !== null) {
      s.cost += row.costUsd;
      s.costValues.push(row.costUsd);
    } else s.costKnown = false;
    bySession.set(row.sessionId, s);
  }

  const bashBySession = new Map();
  let unparsableTranscriptLines = 0;
  let unreadableTranscripts = 0;
  const hookByCall = new Map(hookLines
    .filter((line) => typeof line.session_id === 'string' && typeof line.tool_use_id === 'string')
    .map((line) => [`${line.session_id}:${line.tool_use_id}`, line]));
  const hookedSessions = new Set(hookLines.map((l) => l.session_id).filter(Boolean));
  const projectRoots = transcriptProjectsDirs(userData, process.env.AIO_RTK_TRIAL_PROJECTS_DIR || null);
  for (const projectsDir of projectRoots) {
    for (const transcript of listTranscripts(projectsDir)) {
      if (transcript.kind !== 'main') continue;
      const { sessionId } = transcript;
      if (!bySession.has(sessionId) && !hookedSessions.has(sessionId)) continue;
      if (bashBySession.has(sessionId)) continue;
      try {
        const parsed = await readBashCalls(transcript.path);
        bashBySession.set(sessionId, parsed.calls);
        if (bySession.has(sessionId)) unparsableTranscriptLines += parsed.unparsableLines;
      } catch {
        if (bySession.has(sessionId)) unreadableTranscripts += 1;
      }
    }
  }

  const transcriptsComplete = unparsableTranscriptLines === 0 && unreadableTranscripts === 0;
  const metrics = {
    onSessions: 0,
    offSessions: 0,
    onTurnsPerSession: 0,
    offTurnsPerSession: 0,
    onCallsPerSession: 0,
    offCallsPerSession: 0,
    rewrittenTotal: 0,
    rewrittenFail: 0,
    rewrittenUnresolved: 0,
    otherUnresolved: 0,
    onUnresolved: 0,
    offUnresolved: 0,
    otherTotal: 0,
    otherFail: 0,
    retryAfterRewrite: 0,
    onMedianCharsRewritten: 0,
    offMedianChars: 0,
    onCostPerTurn: 0,
    offCostPerTurn: 0,
    onCostValues: [],
    offCostValues: [],
    onCostKnown: costComplete && transcriptsComplete,
    offCostKnown: costComplete && transcriptsComplete,
    onNewTokensPerTurn: 0,
    offNewTokensPerTurn: 0,
    onBashErrors: 0,
    offBashErrors: 0,
    missingHookDecisions: 0,
  };

  const median = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };

  const strata = new Map();
  const admittedStarts = [];
  const unmeasuredNoBash = { on: 0, off: 0 };
  const offCharsByCommand = new Map();
  const onRewrittenByCommand = new Map();
  const baseCommand = (command) => command.trim().replace(/^rtk\s+(?:proxy\s+)?/, '').replace(/^RTK_DISABLED=1\s+/, '');
  for (const [sessionId, session] of bySession) {
    // A requested on arm is not proof that Claude installed and ran the
    // rewrite-only hook. An actual matching hook call is required. The off
    // control has no hook by design, and any hook call disqualifies it.
    const calls = bashBySession.get(sessionId);
    if (!calls) continue;
    if (calls.length === 0) {
      unmeasuredNoBash[session.arm] += 1;
      continue;
    }
    const delivered = calls.some((call) => hookByCall.has(`${sessionId}:${call.id}`));
    if (session.arm === 'on' ? !delivered : hookedSessions.has(sessionId)) continue;
    admittedStarts.push(session.firstTsMs);
    const stratumKey = `${session.surface}/${session.effort}/${session.arm}`;
    const stratum = strata.get(stratumKey) ?? {
      sessions: 0, turns: 0, bashCalls: 0, bashErrors: 0, unresolvedCalls: 0, rewrittenUnresolved: 0,
      rewrittenCalls: 0, rewrittenErrors: 0, retryAfterRewrite: 0,
      resultChars: [], costValues: [],
      newInputPlusCacheReadTokens: 0, costUsd: 0, costKnown: costComplete && transcriptsComplete,
    };
    stratum.sessions += 1;
    stratum.turns += session.turns;
    stratum.bashCalls += calls.length;
    stratum.unresolvedCalls += calls.filter(c => !c.resultObserved).length;
    stratum.bashErrors += calls.filter((c) => c.failed).length;
    stratum.resultChars.push(...calls.filter((c) => c.resultObserved).map((c) => c.resultChars));
    stratum.costValues.push(...session.costValues);
    stratum.newInputPlusCacheReadTokens += session.newTokens;
    stratum.costUsd += session.cost;
    stratum.costKnown &&= session.costKnown;
    strata.set(stratumKey, stratum);
    const rewritten = calls.filter((c) => hookByCall.get(`${sessionId}:${c.id}`)?.decision === 'rewritten');
    const other = calls.filter((c) => hookByCall.get(`${sessionId}:${c.id}`)?.decision !== 'rewritten');
    stratum.rewrittenCalls += rewritten.length;
    stratum.rewrittenUnresolved += rewritten.filter(c => !c.resultObserved).length;
    stratum.rewrittenErrors += rewritten.filter((c) => c.failed).length;
    stratum.retryAfterRewrite += rewritten.filter((c) => c.retryAfterRewrite).length;
    if (session.arm === 'on') {
      metrics.onSessions += 1;
      metrics.onTurnsPerSession += session.turns;
      metrics.onNewTokensPerTurn += session.newTokens;
      metrics.onCallsPerSession += calls.length;
      metrics.rewrittenTotal += rewritten.length;
      metrics.rewrittenUnresolved += rewritten.filter(c => !c.resultObserved).length;
      metrics.otherUnresolved += other.filter(c => !c.resultObserved).length;
      metrics.onUnresolved += calls.filter(c => !c.resultObserved).length;
      metrics.rewrittenFail += rewritten.filter((c) => c.failed).length;
      metrics.otherTotal += other.length;
      metrics.otherFail += other.filter((c) => c.failed).length;
      metrics.retryAfterRewrite += rewritten.filter((c) => c.retryAfterRewrite).length;
      metrics.onBashErrors += calls.filter((c) => c.failed).length;
      metrics.missingHookDecisions += calls.filter((c) => !hookByCall.has(`${sessionId}:${c.id}`)).length;
      metrics.onCostKnown &&= session.costKnown;
      if (session.costKnown) metrics.onCostValues.push(...session.costValues);
    } else {
      metrics.offSessions += 1;
      metrics.offUnresolved += calls.filter(c => !c.resultObserved).length;
      metrics.offTurnsPerSession += session.turns;
      metrics.offNewTokensPerTurn += session.newTokens;
      metrics.offCallsPerSession += calls.length;
      metrics.offBashErrors += calls.filter((c) => c.failed).length;
      metrics.offCostKnown &&= session.costKnown;
      if (session.costKnown) metrics.offCostValues.push(...session.costValues);
    }
    if (session.arm === 'off') {
      for (const call of calls) {
        if (call.resultObserved) {
          const key = baseCommand(call.command);
          offCharsByCommand.set(key, [...(offCharsByCommand.get(key) ?? []), call.resultChars]);
        }
      }
    }
    if (session.arm === 'on') {
      for (const call of rewritten) {
        if (call.resultObserved) {
          const key = baseCommand(call.command);
          onRewrittenByCommand.set(key, [...(onRewrittenByCommand.get(key) ?? []), call.resultChars]);
        }
      }
    }
  }

  metrics.onTurnsPerSession = metrics.onSessions ? metrics.onTurnsPerSession / metrics.onSessions : 0;
  metrics.offTurnsPerSession = metrics.offSessions ? metrics.offTurnsPerSession / metrics.offSessions : 0;
  metrics.onCallsPerSession = metrics.onSessions ? metrics.onCallsPerSession / metrics.onSessions : 0;
  metrics.offCallsPerSession = metrics.offSessions ? metrics.offCallsPerSession / metrics.offSessions : 0;
  metrics.onNewTokensPerTurn = metrics.onTurnsPerSession > 0 ? metrics.onNewTokensPerTurn / (metrics.onTurnsPerSession * metrics.onSessions) : 0;
  metrics.offNewTokensPerTurn = metrics.offTurnsPerSession > 0 ? metrics.offNewTokensPerTurn / (metrics.offTurnsPerSession * metrics.offSessions) : 0;
  const matchedCommands = [...onRewrittenByCommand.keys()].filter((key) => offCharsByCommand.has(key));
  metrics.onMedianCharsRewritten = median(matchedCommands.flatMap((key) => onRewrittenByCommand.get(key)));
  metrics.offMedianChars = median(matchedCommands.flatMap((key) => offCharsByCommand.get(key)));
  metrics.onCostPerTurn = metrics.onCostKnown && metrics.onCostValues.length
    ? metrics.onCostValues.reduce((a, b) => a + b, 0) / metrics.onCostValues.length
    : null;
  metrics.offCostPerTurn = metrics.offCostKnown && metrics.offCostValues.length
    ? metrics.offCostValues.reduce((a, b) => a + b, 0) / metrics.offCostValues.length
    : null;

  const verdicts = evaluateTrial(metrics);
  if (!costComplete) {
    const costVerdict = verdicts.find(verdict => verdict.name === 'Cost per turn');
    costVerdict.detail = `not measured: ${unparsableLines} unparsable cost row(s); missing cost cannot be bounded`;
  }
  if (metrics.missingHookDecisions > 0) {
    for (const verdict of verdicts) {
      if (verdict.name.startsWith('G1') || verdict.name.startsWith('G5') || verdict.name.startsWith('Benefit')) {
        verdict.pass = null;
        verdict.detail = `not measured: ${metrics.missingHookDecisions} on-arm Bash calls lack hook decisions`;
      }
    }
  }
  if (!transcriptsComplete) {
    for (const verdict of verdicts) {
      // Observed stops stay conservative; a partial sample cannot certify a pass.
      if (verdict.pass !== false) {
        verdict.pass = null;
        verdict.detail = `not measured: ${unparsableTranscriptLines} unparsable transcript line(s), `
          + `${unreadableTranscripts} unreadable transcript(s); Bash call counts are unknown`;
      }
    }
  }
  const onInterval = bootstrapMeanInterval(metrics.onCostValues);
  const offInterval = bootstrapMeanInterval(metrics.offCostValues);

  const trialStartMs = admittedStarts.length ? Math.min(...admittedStarts) : null;
  const elapsedMs = trialStartMs === null ? 0 : Math.max(0, Math.min(Date.now(), untilMs) - trialStartMs);
  const sampleReady = metrics.onSessions >= 150 && metrics.offSessions >= 150
    && elapsedMs >= 14 * 24 * 60 * 60 * 1000;
  const stopReached = trialStartMs !== null && elapsedMs >= 28 * 24 * 60 * 60 * 1000;
  const stratumSummary = Object.fromEntries([...strata].map(([key, value]) => [key, {
    sessions: value.sessions,
    turns: value.turns,
    turnsPerSession: value.sessions ? value.turns / value.sessions : null,
    bashCalls: transcriptsComplete ? value.bashCalls : null,
    bashCallsPerSession: transcriptsComplete && value.sessions ? value.bashCalls / value.sessions : null,
    bashErrors: value.bashErrors,
    unresolvedCalls: value.unresolvedCalls,
    rewrittenUnresolvedCalls: value.rewrittenUnresolved,
    rewrittenCalls: transcriptsComplete ? value.rewrittenCalls : null,
    rewrittenErrorRate: transcriptsComplete && value.rewrittenCalls && value.rewrittenUnresolved === 0 ? value.rewrittenErrors / value.rewrittenCalls : null,
    retryAfterRewriteRate: transcriptsComplete && value.rewrittenCalls ? value.retryAfterRewrite / value.rewrittenCalls : null,
    medianToolResultChars: transcriptsComplete && value.resultChars.length ? median(value.resultChars) : null,
    newInputPlusCacheReadTokensPerTurn: value.turns ? value.newInputPlusCacheReadTokens / value.turns : null,
    costPerTurn: value.costKnown && value.costValues.length ? bootstrapMeanInterval(value.costValues) : null,
  }]));
  const out = {
    window: { since: new Date(sinceMs).toISOString(), until: untilMs < Number.MAX_SAFE_INTEGER ? new Date(untilMs).toISOString() : null },
    trialStart: trialStartMs === null ? null : new Date(trialStartMs).toISOString(),
    sessions: { withHook: metrics.onSessions, withoutHook: metrics.offSessions },
    costRecords: { complete: costComplete, unparsableLines },
    transcriptRecords: { complete: transcriptsComplete, unparsableLines: unparsableTranscriptLines, unreadable: unreadableTranscripts },
    unmeasuredNoBash,
    perSession: {
      onTurnsPerSession: Number(metrics.onTurnsPerSession.toFixed(2)),
      offTurnsPerSession: Number(metrics.offTurnsPerSession.toFixed(2)),
      onCallsPerSession: transcriptsComplete ? Number(metrics.onCallsPerSession.toFixed(2)) : null,
      offCallsPerSession: transcriptsComplete ? Number(metrics.offCallsPerSession.toFixed(2)) : null,
    },
    costPerTurn: {
      on: metrics.onCostKnown && metrics.onCostValues.length ? onInterval : null,
      off: metrics.offCostKnown && metrics.offCostValues.length ? offInterval : null,
    },
    strata: stratumSummary,
    bash: { onErrors: metrics.onBashErrors, offErrors: metrics.offBashErrors, onUnresolvedCalls: metrics.onUnresolved, offUnresolvedCalls: metrics.offUnresolved, rewrittenUnresolvedCalls: metrics.rewrittenUnresolved, rewrittenCalls: metrics.rewrittenTotal, rewrittenErrorRate: metrics.rewrittenTotal && metrics.rewrittenUnresolved === 0 ? metrics.rewrittenFail / metrics.rewrittenTotal : null, retryAfterRewriteRate: metrics.rewrittenTotal ? metrics.retryAfterRewrite / metrics.rewrittenTotal : null, matchedCommandMedianChars: { on: metrics.onMedianCharsRewritten, off: metrics.offMedianChars }, newInputPlusCacheReadTokensPerTurn: { on: metrics.onNewTokensPerTurn, off: metrics.offNewTokensPerTurn } },
    sampleReady,
    stopReached,
    recommendation: recommendTrial(verdicts, { sampleReady, stopReached }),
    verdicts,
    note: '150 sessions per group resolves only a 15-20% cost difference; RTK is expected to move input 2-4%, so the trial proves "no harm and shorter results". Any real bill change shows in the Phase 0 day check.',
  };
  if (!transcriptsComplete) {
    out.bash.rewrittenCalls = null;
    out.bash.rewrittenErrorRate = null;
    out.bash.retryAfterRewriteRate = null;
    out.bash.matchedCommandMedianChars = { on: null, off: null };
  }

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }
  console.log(`# RTK auto-approve hook trial (${out.window.since} → ${out.window.until ?? 'now'})\n`);
  console.log(`Sessions: ${out.sessions.withHook} with RTK, ${out.sessions.withoutHook} without.`);
  console.log(`Unmeasured (no Bash): ${unmeasuredNoBash.on} assigned on, ${unmeasuredNoBash.off} assigned off.`);
  if (!transcriptsComplete) console.log(`Transcript evidence unknown: ${unparsableTranscriptLines} unparsable line(s), ${unreadableTranscripts} unreadable file(s). Counts and errors below cover observed records only.`);
  console.log(`Turns/session: ${out.perSession.onTurnsPerSession} vs ${out.perSession.offTurnsPerSession}.`);
  console.log(`Bash calls/session: ${out.perSession.onCallsPerSession ?? 'not measured'} vs ${out.perSession.offCallsPerSession ?? 'not measured'}.`);
  for (const [key, value] of Object.entries(out.strata)) {
    console.log(`${key}: ${value.sessions} sessions, ${value.turnsPerSession?.toFixed(2) ?? 'n/a'} turns/session, ${value.bashCallsPerSession?.toFixed(2) ?? 'n/a'} Bash calls/session (${value.bashErrors} errors); rewritten error ${value.rewrittenErrorRate === null ? 'n/a' : `${(100 * value.rewrittenErrorRate).toFixed(1)}%`}, retry after rewrite ${value.retryAfterRewriteRate === null ? 'n/a' : `${(100 * value.retryAfterRewriteRate).toFixed(1)}%`}; median result ${value.medianToolResultChars ?? 'n/a'} chars; ${value.newInputPlusCacheReadTokensPerTurn?.toFixed(0) ?? 'n/a'} new-input + cache-read tokens/turn; cost/turn ${value.costPerTurn ? `$${value.costPerTurn.point.toFixed(4)} [${value.costPerTurn.lo.toFixed(4)}, ${value.costPerTurn.hi.toFixed(4)}]` : 'not measured'}.`);
  }
  console.log(`Matched-command Bash result median: ${out.bash.matchedCommandMedianChars.on ?? 'n/a'} vs ${out.bash.matchedCommandMedianChars.off ?? 'n/a'} chars.`);
  console.log(`Sample ready: ${out.sampleReady ? 'yes' : 'no — need 14 days and 150 sessions per arm'}.`);
  console.log(`Recommendation: ${out.recommendation}.`);
  const formatInterval = (value) => value
    ? `$${value.point.toFixed(4)} [${value.lo.toFixed(4)}, ${value.hi.toFixed(4)}]`
    : 'not measured';
  console.log(`Cost/turn: ${formatInterval(out.costPerTurn.on)} vs ${formatInterval(out.costPerTurn.off)}.\n`);
  console.log(`Bash calls without observed results: ${out.bash.onUnresolvedCalls} with RTK, ${out.bash.offUnresolvedCalls} without.`);
  console.log(`Bash errors: ${out.bash.onErrors} with RTK, ${out.bash.offErrors} without; rewritten-call error rate ${out.bash.rewrittenErrorRate === null ? 'n/a' : `${(100 * out.bash.rewrittenErrorRate).toFixed(1)}%`}; retry-after-rewrite rate ${out.bash.retryAfterRewriteRate === null ? 'n/a' : `${(100 * out.bash.retryAfterRewriteRate).toFixed(1)}%`}.`);
  for (const v of verdicts) {
    console.log(`${v.pass === null ? 'NOT MEASURED' : v.pass ? 'PASS' : 'FAIL'} — ${v.name}: ${v.detail}`);
  }
  console.log(`\n${out.note}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
