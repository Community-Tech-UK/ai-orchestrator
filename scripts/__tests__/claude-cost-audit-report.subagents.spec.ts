import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  SUBAGENT_VERDICT_RULES,
  aggregateSubagentMetrics,
  armForSessionId,
  collectSubagentSessions,
  detectRespawns,
  eligibleClaudeExposures,
  evaluateSubagentVerdict,
  longWaitCacheMetric,
  planQueueShare,
  policyMovedAgentType,
  reviewKeywordMatch,
  requestUsd,
  type ParentSessionRecord,
  type SubagentTrialMetrics,
} from '../claude-cost-audit-report.mjs';

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, 'scripts/claude-cost-audit-report.mjs');
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('the trial group split', () => {
  it('takes the last hex digit of the native session id: 0-7 Sonnet, 8-f same-as-session', () => {
    expect(armForSessionId('aaaa-0001')).toBe('sonnet');
    expect(armForSessionId('aaaa-0007')).toBe('sonnet');
    expect(armForSessionId('aaaa-0008')).toBe('same-as-session');
    expect(armForSessionId('aaaa-000f')).toBe('same-as-session');
    expect(armForSessionId('aaaa-000F')).toBe('same-as-session');
    expect(armForSessionId('')).toBe('same-as-session');
  });

  it('records the plan\'s verdict thresholds', () => {
    expect(SUBAGENT_VERDICT_RULES.spendDrop).toBe(0.3);
    expect(SUBAGENT_VERDICT_RULES.respawnRisePoints).toBe(5);
    expect(SUBAGENT_VERDICT_RULES.errorRisePoints).toBe(3);
    expect(SUBAGENT_VERDICT_RULES.landedDropPoints).toBe(10);
    expect(SUBAGENT_VERDICT_RULES.reviewerGuardShare).toBe(0.02);
    expect(SUBAGENT_VERDICT_RULES.minDays).toBe(14);
    expect(SUBAGENT_VERDICT_RULES.minGeneralPurposePerGroup).toBe(300);
    expect(SUBAGENT_VERDICT_RULES.waitingRuleRewriteDrop).toBe(0.3);
    expect(SUBAGENT_VERDICT_RULES.waitingRuleRuntimeRise).toBe(0.2);
  });
});

describe('pricing one request', () => {
  it('prices cache reads at 0.1x and cache writes at 1.25x/2x of the input price', () => {
    const usd = requestUsd(
      { input: 1_000_000, cacheRead: 1_000_000, cacheWrite5m: 1_000_000, cacheWrite1h: 1_000_000, output: 1_000_000, model: 'claude-sonnet-4-5' },
      null,
    );
    // sonnet: input $3/Mtok, output $15/Mtok → 3 + 0.3 + 3.75 + 6 + 15 = 28.05
    expect(usd).toBeCloseTo(28.05, 6);
  });
});

describe('the re-spawn detector', () => {
  it('counts a start within 10 minutes of the previous helper returning, and not one later', () => {
    const t = 1_000_000;
    expect(detectRespawns([
      { firstAt: t, lastAt: t + 60_000 },
      { firstAt: t + 60_000 + 9 * 60_000, lastAt: t + 20 * 60_000 },
    ])).toBe(1);
    expect(detectRespawns([
      { firstAt: t, lastAt: t + 60_000 },
      { firstAt: t + 60_000 + 11 * 60_000, lastAt: t + 20 * 60_000 },
    ])).toBe(0);
    expect(detectRespawns([])).toBe(0);
  });
});

describe('the reviewer-guard keyword match', () => {
  it('matches review, verify, check and gate wording, and not ordinary work', () => {
    expect(reviewKeywordMatch('Review the diff')).toBe(true);
    expect(reviewKeywordMatch('Verify the build')).toBe(true);
    expect(reviewKeywordMatch('check the outputs')).toBe(true);
    expect(reviewKeywordMatch('completion gate run')).toBe(true);
    expect(reviewKeywordMatch('Implement the feature')).toBe(false);
    expect(reviewKeywordMatch(undefined)).toBe(false);
  });
});

describe('the reviewer-guard population', () => {
  it('watches the agents the subagent-model policy moves: general-purpose and the catch-all claude', () => {
    expect(policyMovedAgentType('general-purpose')).toBe(true);
    expect(policyMovedAgentType('claude')).toBe(true);
    expect(policyMovedAgentType('code-reviewer')).toBe(false);
    expect(policyMovedAgentType('fork')).toBe(false);
    expect(policyMovedAgentType(undefined)).toBe(false);
    expect(policyMovedAgentType(null)).toBe(false);
  });
});

describe('the plan-queue landed share', () => {
  const workerPolicy = [
    { provider: 'claude', armKey: 'item-1', arm: 'sonnet', at: '2026-10-01T10:00:00.000Z' },
    { provider: 'claude', armKey: 'item-1', arm: 'same-as-session', at: '2026-10-02T10:00:00.000Z' },
    { provider: 'claude', armKey: 'item-2', arm: 'same-as-session', at: '2026-10-01T10:00:00.000Z' },
    { provider: 'codex', armKey: 'item-3', arm: 'off', at: '2026-10-01T10:00:00.000Z' },
  ];

  it('groups each item by its first logged worker and counts mixed-group items', () => {
    const share = planQueueShare(
      workerPolicy,
      [
        { id: 'item-1', landed_commit: 'abc', updated_at: Date.parse('2026-10-01T12:00:00.000Z') },
        { id: 'item-2', landed_commit: null, updated_at: Date.parse('2026-10-01T12:00:00.000Z') },
      ],
    );
    expect(share['sonnet']).toEqual({ items: 1, landed: 1 });
    expect(share['same-as-session']).toEqual({ items: 1, landed: 0 });
    expect(share.mixedItems).toBe(1);
    expect(share.unassignedItems).toBe(0);
    expect(share.landedAfterWindow).toBe(0);
    expect(share.landedUnplaced).toBe(0);
  });

  it('bounds landings by updated_at to the window cutoff; later and unplaceable landings are never landed', () => {
    const untilMs = Date.parse('2026-10-02T00:00:00.000Z');
    const policy = [
      { provider: 'claude', armKey: 'item-1', arm: 'sonnet', at: '2026-10-01T10:00:00.000Z' },
      { provider: 'claude', armKey: 'item-2', arm: 'sonnet', at: '2026-10-01T10:00:00.000Z' },
      { provider: 'claude', armKey: 'item-3', arm: 'sonnet', at: '2026-10-01T10:00:00.000Z' },
      { provider: 'claude', armKey: 'item-4', arm: 'sonnet', at: '2026-10-01T10:00:00.000Z' },
      { provider: 'claude', armKey: 'item-5', arm: 'sonnet', at: '2026-10-01T10:00:00.000Z' },
    ];
    const items = [
      { id: 'item-1', landed_commit: 'abc', updated_at: untilMs - 1 },
      { id: 'item-2', landed_commit: 'abc', updated_at: untilMs },
      { id: 'item-3', landed_commit: 'abc', updated_at: untilMs + 1 },
      { id: 'item-4', landed_commit: 'abc', updated_at: null },
      { id: 'item-5', landed_commit: null, updated_at: untilMs - 1 },
    ];
    const share = planQueueShare(policy, items, untilMs);
    expect(share['sonnet']).toEqual({ items: 5, landed: 1 });
    expect(share.landedAfterWindow).toBe(2);
    expect(share.landedUnplaced).toBe(1);
    // With no --until every placeable landing counts, as before; a landing
    // without a usable updated_at stays unknown in any window.
    const open = planQueueShare(policy, items);
    expect(open['sonnet']).toEqual({ items: 5, landed: 3 });
    expect(open.landedAfterWindow).toBe(0);
    expect(open.landedUnplaced).toBe(1);
  });

  it('keeps each item in its first worker\'s group when the analysis window starts later', () => {
    // Step 2's first-worker rule: an item keeps the group of its FIRST worker,
    // so a --since that starts after that worker must not re-attribute the item
    // to whoever worked it inside the window (pre-fix: the later control worker
    // won the item and the mixed-group count said 0).
    const policyEntries = [
      { provider: 'claude', sessionId: 'session-a1', arm: 'sonnet', armKey: 'item-1', setting: 'trial',
        applied: true, reviewerRuleDelivered: true, waitingRuleDelivered: false, at: '2026-10-01T10:00:00.000Z' },
      { provider: 'claude', sessionId: 'session-aa', arm: 'same-as-session', armKey: 'item-1', setting: 'trial',
        applied: false, reviewerRuleDelivered: true, waitingRuleDelivered: false, at: '2026-10-03T10:00:00.000Z' },
    ];
    const items = [{ id: 'item-1', landed_commit: 'sha', updated_at: Date.parse('2026-10-03T12:00:00.000Z') }];
    const m = aggregateSubagentMetrics([], {
      sinceMs: Date.parse('2026-10-02T00:00:00.000Z'),
      untilMs: Date.parse('2026-10-05T00:00:00.000Z'),
      policyEntries,
      items,
    });
    expect(m.planQueue['sonnet']).toEqual({ items: 1, landed: 1 });
    expect(m.planQueue['same-as-session']).toEqual({ items: 0, landed: 0 });
    expect(m.planQueue.mixedItems).toBe(1);
  });
});

describe('historical policy cutoffs', () => {
  const sinceMs = Date.parse('2026-10-02T00:00:00.000Z');
  const untilMs = Date.parse('2026-10-05T00:00:00.000Z');
  const worker = (sessionId: string, armKey: string, at: number) => ({
    provider: 'claude', sessionId, armKey, at: new Date(at).toISOString(), setting: 'trial',
    arm: armForSessionId(sessionId), applied: armForSessionId(sessionId) === 'sonnet',
    reviewerRuleDelivered: true, waitingRuleDelivered: true,
  });
  const items = [{ id: 'item-1', landed_commit: null }];

  it.each([0, 1])('keeps future exposure starts out of the exported timeline at cutoff + %i ms', offset => {
    const exposure = eligibleClaudeExposures([worker('session-a1', 'item-1', untilMs + offset)], sinceMs, untilMs);
    expect(exposure.firstBySession.size).toBe(0);
    expect(exposure.intervalsBySession.size).toBe(0);
    expect(exposure.eligible).toEqual([]);
  });

  it.each([0, 1])('keeps future workers out of the exported share at cutoff + %i ms', offset => {
    const share = planQueueShare([worker('session-a1', 'item-1', untilMs + offset)], items, untilMs);
    expect(share.sonnet).toEqual({ items: 0, landed: 0 });
    expect(share.unassignedItems).toBe(1);
  });

  it.each([
    { offset: -1, assigned: 1 },
    { offset: 0, assigned: 0 },
    { offset: 1, assigned: 0 },
    { offset: 86_400_000, assigned: 0 },
  ])('counts a first worker $offset ms from the exclusive cutoff as $assigned assigned items', ({ offset, assigned }) => {
    const at = untilMs + offset;
    const policyEntries = [worker('session-a1', 'item-1', at)];
    const report = aggregateSubagentMetrics([], { sinceMs, untilMs, policyEntries, items });
    expect(report.planQueue.sonnet).toEqual({ items: assigned, landed: 0 });
    expect(report.planQueue.unassignedItems).toBe(1 - assigned);
    expect(report.trialExposureMs).toBe(assigned ? at : null);
    expect(report.waitingRuleActivationMs).toBe(assigned ? at : null);
    expect(report.sample.days).toBe(assigned ? 1 / 86_400_000 : 0);
    // The exported share and exposure helpers must enforce the same cutoff
    // even when called with an unfiltered policy log.
    expect(planQueueShare(policyEntries, items, untilMs)).toEqual(report.planQueue);
    expect(eligibleClaudeExposures(policyEntries, sinceMs, untilMs).firstBySession.size).toBe(assigned);
  });

  it.each([
    { offset: -1, mixed: 1 },
    { offset: 0, mixed: 0 },
    { offset: 1, mixed: 0 },
  ])('counts an opposite-arm worker $offset ms from cutoff as $mixed mixed items, retaining pre-since ownership', ({ offset, mixed }) => {
    const policyEntries = [
      worker('session-aa', 'item-1', untilMs + offset),
      worker('session-a1', 'item-1', sinceMs - 86_400_000),
    ];
    const report = aggregateSubagentMetrics([], { sinceMs, untilMs, policyEntries, items });
    expect(report.planQueue.sonnet).toEqual({ items: 1, landed: 0 });
    expect(report.planQueue['same-as-session']).toEqual({ items: 0, landed: 0 });
    expect(report.planQueue.mixedItems).toBe(mixed);
    expect(planQueueShare(policyEntries, items, untilMs)).toEqual(report.planQueue);
    expect(report.trialExposureMs).toBe(sinceMs - 86_400_000);
  });

  it('retains later workers and rule delivery when there is no cutoff', () => {
    const policyEntries = [
      worker('session-a1', 'item-1', untilMs + 1),
      worker('session-aa', 'item-1', untilMs + 2),
    ];
    const report = aggregateSubagentMetrics([], {
      sinceMs, untilMs: Number.MAX_SAFE_INTEGER, policyEntries, items,
    });
    expect(report.planQueue.sonnet).toEqual({ items: 1, landed: 0 });
    expect(report.planQueue.mixedItems).toBe(1);
    expect(report.planQueue.unassignedItems).toBe(0);
    expect(report.trialExposureMs).toBe(untilMs + 1);
    expect(report.waitingRuleActivationMs).toBe(untilMs + 1);
    expect(planQueueShare(policyEntries, items)).toEqual(report.planQueue);
  });

  it('keeps a measured recommendation and waiting-rule evidence unchanged when future records arrive', () => {
    const start = Date.parse('2026-10-01T00:00:00.000Z');
    const end = Date.parse('2026-10-17T00:00:00.000Z');
    const sessions: ParentSessionRecord[] = ['session-a1', 'session-aa'].map(sessionId => ({
      sessionId, arm: armForSessionId(sessionId), parentModel: 'claude-opus-4-7', firstAt: start,
      subagents: Array.from({ length: 300 }, (_, index) => ({
        meta: { agentType: 'general-purpose' },
        model: sessionId === 'session-a1' ? 'claude-sonnet-4-5' : 'claude-opus-4-7',
        parentModel: 'claude-opus-4-7', spendUsd: sessionId === 'session-a1' ? 0.5 : 1,
        finalContext: 100, runMs: 1000, firstAt: start + 86_400_000 + index * 2000,
        lastAt: start + 86_400_001 + index * 2000,
        returnedAt: start + 86_400_002 + index * 2000, parentTurnId: `turn-${index}`,
        isError: false, longWaits: [{ at: start + 86_400_001 + index * 2000,
          rewrittenTokens: 100, model: 'claude-sonnet-4-5' }],
      })),
    }));
    const policyEntries = [
      { ...worker('session-a1', 'item-1', start), waitingRuleDelivered: false },
      { ...worker('session-aa', 'item-2', start), waitingRuleDelivered: false },
    ];
    const queueItems = [
      { id: 'item-1', landed_commit: 'fixture-landed', updated_at: start + 86_400_000 },
      { id: 'item-2', landed_commit: 'fixture-landed', updated_at: start + 86_400_000 },
      { id: 'future-item', landed_commit: null },
    ];
    const options = { sinceMs: start, untilMs: end, policyEntries, items: queueItems };
    const baseline = aggregateSubagentMetrics(sessions, options);
    const verdict = evaluateSubagentVerdict(baseline);
    expect(verdict.verdict).toBe('adopt-sonnet');
    expect(verdict.waitingRule).toBe('pending (rule not delivered)');
    const withFuture = aggregateSubagentMetrics(sessions, {
      ...options,
      policyEntries: [...policyEntries,
        worker('session-a2', 'future-item', end),
        worker('session-ab', 'item-1', end + 1),
        { ...worker('session-a1', 'item-1', end + 2), setting: 'parent', applied: false },
      ],
    });
    expect(withFuture.waitingRuleActivationMs).toBeNull();
    expect(withFuture).toEqual(baseline);
    expect(evaluateSubagentVerdict(withFuture)).toEqual(verdict);
  });
});

// ── Verdict rules at their edges ────────────────────────────────────────────

function metrics(overrides: {
  sonnet?: Partial<SubagentTrialMetrics['arms']['sonnet']>;
  same?: Partial<SubagentTrialMetrics['arms']['same-as-session']>;
  days?: number;
  gpSonnet?: number;
  gpSame?: number;
  planQueue?: SubagentTrialMetrics['planQueue'];
  waitingRule?: SubagentTrialMetrics['waitingRule'];
}): SubagentTrialMetrics {
  const baseArm = {
    sessions: 50,
    subagents: 320,
    gpSubagents: 310,
    spendUsd: 100,
    spendPerSessionUsd: 2,
    spendPerGpUsd: 0.3,
    models: new Map<string, number>(),
    finalContextMedian: 10_000,
    finalContextP90: 20_000,
    spawnDepthMedian: 1,
    respawnRate: 0.1,
    errorRate: 0.01,
    errorCount: 3,
    outcomesUnknown: 0,
    reviewerGuardChecked: 100,
    reviewerGuardViolations: 0,
    runMsMedian: 60_000,
  };
  return {
    policyUnparsableLines: 0,
    arms: {
      'sonnet': { ...baseArm, ...overrides.sonnet },
      'same-as-session': { ...baseArm, spendPerSessionUsd: 4, ...overrides.same },
    },
    sample: {
      days: overrides.days ?? 15,
      gp: {
        'sonnet': overrides.gpSonnet ?? 310,
        'same-as-session': overrides.gpSame ?? 310,
      },
    },
    waitingRule: overrides.waitingRule ?? {
      before: { count: 10, tokens: 100, usd: 1, runMsMedian: 60_000 },
      after: { count: 5, tokens: 50, usd: 0.5, runMsMedian: 65_000 },
    },
    trialExposureMs: Date.parse('2026-10-01T00:00:00Z'),
    waitingRuleActivationMs: Date.parse('2026-10-01T00:00:00Z'),
    planQueue: overrides.planQueue ?? {
      'sonnet': { items: 12, landed: 10 },
      'same-as-session': { items: 12, landed: 11 },
      mixedItems: 0,
      unassignedItems: 0,
      landedAfterWindow: 0,
      landedUnplaced: 0,
      landedUnplacedByArm: { sonnet: 0, 'same-as-session': 0 },
    },
  };
}

describe('the verdict rules', () => {
  it('withholds model and waiting-rule conclusions when policy history is incomplete', () => {
    const measured = metrics({});
    expect(evaluateSubagentVerdict(measured)).toMatchObject({ verdict: 'adopt-sonnet', waitingRule: 'keep' });
    const damaged = evaluateSubagentVerdict({ ...measured, policyUnparsableLines: 1 });
    expect(damaged).toMatchObject({ verdict: 'pending (policy evidence)', waitingRule: 'pending (policy evidence)' });
    expect(damaged.notes.join(' ')).toContain('1 damaged or unplaceable policy record');
  });

  it('adopts Sonnet when every criterion holds at exactly its threshold', () => {
    // 50% spend drop; +5.0 respawn points; +3.0 error points; -10.0 landed
    // points (9/10 vs 10/10); guard exactly 2%.
    const m = metrics({
      sonnet: {
        spendPerSessionUsd: 2,
        respawnRate: 0.15,
        errorRate: 0.04,
        reviewerGuardChecked: 100,
        reviewerGuardViolations: 2,
      },
      same: { spendPerSessionUsd: 4, respawnRate: 0.1, errorRate: 0.01 },
      planQueue: {
        'sonnet': { items: 10, landed: 9 },
        'same-as-session': { items: 10, landed: 10 },
        mixedItems: 0,
        unassignedItems: 0,
        landedAfterWindow: 0,
        landedUnplaced: 0,
        landedUnplacedByArm: { sonnet: 0, 'same-as-session': 0 },
      },
    });
    const verdict = evaluateSubagentVerdict(m);
    expect(verdict.verdict).toBe('adopt-sonnet');
  });

  it('29.9% lower spend per session is below the rule', () => {
    const m = metrics({ sonnet: { spendPerSessionUsd: 4 * 0.701 } });
    expect(evaluateSubagentVerdict(m).verdict).toBe('keep-same-as-session (spend saving below the rule)');
  });

  it('a quality sign above its threshold keeps the same-as-session default and reports', () => {
    const m = metrics({ sonnet: { respawnRate: 0.16 } }); // +6.0 points
    const verdict = evaluateSubagentVerdict(m);
    expect(verdict.verdict).toBe('keep-same-as-session-for-chats (spend falls but a quality sign failed; report)');
  });

  it('the reviewer guard vetoes even when every other criterion holds', () => {
    const m = metrics({ sonnet: { reviewerGuardChecked: 100, reviewerGuardViolations: 3 } }); // 3% > 2%
    expect(evaluateSubagentVerdict(m).verdict).toBe('do-not-adopt (the reviewer rule must be firmer first)');
  });

  it('the sample gates (14 days, 300 general-purpose helpers per group) hold the verdict at pending', () => {
    expect(evaluateSubagentVerdict(metrics({ days: 13.9 })).verdict).toBe('pending (sample)');
    expect(evaluateSubagentVerdict(metrics({ gpSonnet: 299 })).verdict).toBe('pending (sample)');
    expect(evaluateSubagentVerdict(metrics({ days: 14 })).verdict).toBe('adopt-sonnet');
    expect(evaluateSubagentVerdict(metrics({ gpSonnet: 300 })).verdict).toBe('adopt-sonnet');
  });

  it('does not adopt with unknown parent-turn or helper-return evidence even after sample gates pass', () => {
    expect(evaluateSubagentVerdict(metrics({ sonnet: { respawnUnknown: 1 } })).verdict)
      .toBe('pending (helper turn/return evidence)');
  });

  it('does not adopt Sonnet without the plan-queue landing comparison', () => {
    // Step 2 adopts only when the landed share is no more than 10 points lower.
    // With no items on either side (or on one side) that comparison is unknown,
    // and missing quality evidence must withhold adoption, not pass it.
    const queueless = {
      'sonnet': { items: 0, landed: 0 },
      'same-as-session': { items: 0, landed: 0 },
      mixedItems: 0,
      unassignedItems: 0,
      landedAfterWindow: 0,
      landedUnplaced: 0,
      landedUnplacedByArm: { sonnet: 0, 'same-as-session': 0 },
    };
    const none = evaluateSubagentVerdict(metrics({ planQueue: queueless }));
    expect(none.verdict).toBe('pending (plan-queue landing evidence)');
    expect(none.notes.join(' ')).toContain('cannot pass without it');
    const oneSided = evaluateSubagentVerdict(metrics({
      planQueue: { ...queueless, 'same-as-session': { items: 12, landed: 11 } },
    }));
    expect(oneSided.verdict).toBe('pending (plan-queue landing evidence)');
    // A measured landing drop still reports through the quality-sign rule.
    const dropped = evaluateSubagentVerdict(metrics({
      planQueue: {
        'sonnet': { items: 10, landed: 8 },
        'same-as-session': { items: 10, landed: 10 },
        mixedItems: 0,
        unassignedItems: 0,
        landedAfterWindow: 0,
        landedUnplaced: 0,
        landedUnplacedByArm: { sonnet: 0, 'same-as-session': 0 },
      },
    }));
    expect(dropped.verdict).toBe('keep-same-as-session-for-chats (spend falls but a quality sign failed; report)');
  });

  it('a measured quality miss still reports, and a spend miss still keeps, without the landing comparison', () => {
    // Unknown landing evidence never over-restricts a measured outcome: a
    // quality sign that already failed, or spend below the rule, is decided.
    const queueless = {
      'sonnet': { items: 0, landed: 0 },
      'same-as-session': { items: 0, landed: 0 },
      mixedItems: 0,
      unassignedItems: 0,
      landedAfterWindow: 0,
      landedUnplaced: 0,
      landedUnplacedByArm: { sonnet: 0, 'same-as-session': 0 },
    };
    expect(evaluateSubagentVerdict(metrics({ sonnet: { respawnRate: 0.16 }, planQueue: queueless })).verdict)
      .toBe('keep-same-as-session-for-chats (spend falls but a quality sign failed; report)');
    expect(evaluateSubagentVerdict(metrics({ sonnet: { spendPerSessionUsd: 4 * 0.701 }, planQueue: queueless })).verdict)
      .toBe('keep-same-as-session (spend saving below the rule)');
  });

  it('the waiting rule keeps when rewrites fall 30% and run time rises 20%, and reports otherwise', () => {
    const keep = metrics({
      waitingRule: {
        before: { count: 10, tokens: 1, usd: 0, runMsMedian: 60_000 },
        after: { count: 7, tokens: 1, usd: 0, runMsMedian: 72_000 },
      },
    });
    expect(evaluateSubagentVerdict(keep).waitingRule).toBe('keep');
    const report = metrics({
      waitingRule: {
        before: { count: 10, tokens: 1, usd: 0, runMsMedian: 60_000 },
        after: { count: 7, tokens: 1, usd: 0, runMsMedian: 72_001 },
      },
    });
    expect(evaluateSubagentVerdict(report).waitingRule).toBe('report');
    const noBefore = metrics({
      waitingRule: {
        before: { count: 0, tokens: 0, usd: 0, runMsMedian: null },
        after: { count: 3, tokens: 1, usd: 0, runMsMedian: 60_000 },
      },
    });
    expect(evaluateSubagentVerdict(noBefore).waitingRule).toBe('pending (no pre-rule long waits to compare)');
  });

  it('does not keep the waiting rule without run-time evidence; a missing median never passes the rise check', () => {
    // Step 2 keeps the rule only when rewrites fall >=30% AND run time rises
    // <=20%. Missing run-time evidence is unknown: it must not pass the rise
    // check, so the verdict waits instead of keeping.
    const missingAfter = metrics({
      waitingRule: {
        before: { count: 10, tokens: 1, usd: 0, runMsMedian: 60_000 },
        after: { count: 5, tokens: 1, usd: 0, runMsMedian: null },
      },
    });
    const afterVerdict = evaluateSubagentVerdict(missingAfter);
    expect(afterVerdict.waitingRule).toBe('pending (runtime evidence)');
    expect(afterVerdict.notes.join(' ')).toContain('rise check cannot pass');
    const missingBefore = metrics({
      waitingRule: {
        before: { count: 10, tokens: 1, usd: 0, runMsMedian: null },
        after: { count: 5, tokens: 1, usd: 0, runMsMedian: 60_000 },
      },
    });
    expect(evaluateSubagentVerdict(missingBefore).waitingRule).toBe('pending (runtime evidence)');
    // Unknown run time never over-restricts a measured fail: rewrites that do
    // not fall 30% still report.
    const dropMisses = metrics({
      waitingRule: {
        before: { count: 10, tokens: 1, usd: 0, runMsMedian: null },
        after: { count: 9, tokens: 1, usd: 0, runMsMedian: null },
      },
    });
    expect(evaluateSubagentVerdict(dropMisses).waitingRule).toBe('report');
    // Measured run time keeps the keep/report rule at its exact edge.
    const measured = metrics({
      waitingRule: {
        before: { count: 10, tokens: 1, usd: 0, runMsMedian: 60_000 },
        after: { count: 7, tokens: 1, usd: 0, runMsMedian: 72_000 },
      },
    });
    expect(evaluateSubagentVerdict(measured).waitingRule).toBe('keep');
  });
});

describe('the long-wait cache metric', () => {
  const sub = (firstAt: number, longWaits: ParentSessionRecord['subagents'][number]['longWaits'],
    runMs: number | null = 60_000): ParentSessionRecord => ({
    sessionId: 's',
    arm: 'sonnet',
    parentModel: 'claude-opus-4-7',
    firstAt,
    subagents: [{
      meta: null,
      model: 'claude-sonnet-4-5',
      parentModel: 'claude-opus-4-7',
      spendUsd: 0,
      finalContext: 1,
      runMs,
      firstAt,
      lastAt: firstAt + 60_000,
      isError: null,
      longWaits,
    }],
  });

  it('counts 5-60 minute gaps followed by a rewrite, bucketed around the waiting-rule date', () => {
    const ruleDate = 2_000_000;
    const metric = longWaitCacheMetric([
      sub(1_000_000, [{ at: 1_500_000, rewrittenTokens: 1_000, model: 'claude-sonnet-4-5' }]),
      sub(3_000_000, [{ at: 3_500_000, rewrittenTokens: 2_000, model: 'claude-sonnet-4-5' }]),
    ], ruleDate, null);
    expect(metric.before.count).toBe(1);
    expect(metric.before.tokens).toBe(1_000);
    expect(metric.after.count).toBe(1);
    expect(metric.after.tokens).toBe(2_000);
    // sonnet input $3/Mtok, 5-minute write at 1.25x (a legacy entry without
    // the split is read as one 5-minute write).
    expect(metric.after.usd).toBeCloseTo((2_000 * 3 * 1.25) / 1e6, 9);
  });

  it('keeps the 5-minute/1-hour split when pricing rewrites; one-hour writes are 2x', () => {
    const ruleDate = 2_000_000;
    const metric = longWaitCacheMetric([
      sub(3_000_000, [{
        at: 3_500_000,
        rewrittenTokens: 3_000,
        rewrittenTokens5m: 1_000,
        rewrittenTokens1h: 2_000,
        model: 'claude-sonnet-4-5',
      }]),
    ], ruleDate, null);
    expect(metric.after.count).toBe(1);
    expect(metric.after.tokens).toBe(3_000);
    // 1,000 five-minute tokens at 1.25x plus 2,000 one-hour tokens at 2x of
    // sonnet's $3/Mtok input. Pricing the whole 3,000 at the five-minute rate
    // would report $0.011250 instead of $0.015750.
    expect(metric.after.usd).toBeCloseTo((1_000 * 3 * 1.25 + 2_000 * 3 * 2) / 1e6, 9);
  });

  it('medians helper run time from recorded durations only, never zero-filled', () => {
    const ruleDate = 2_000_000;
    const metric = longWaitCacheMetric([
      sub(1_000_000, [{ at: 1_500_000, rewrittenTokens: 1_000, model: 'claude-sonnet-4-5' }], 60_000),
      sub(1_100_000, [{ at: 1_600_000, rewrittenTokens: 1_000, model: 'claude-sonnet-4-5' }], 90_000),
      sub(3_000_000, [{ at: 3_500_000, rewrittenTokens: 1_000, model: 'claude-sonnet-4-5' }], null),
    ], ruleDate, null);
    expect(metric.before.runMsMedian).toBe(75_000);
    expect(metric.after.runMsMedian).toBeNull();
  });
});

describe('7i records joined on toolUseId (Step 2 size and effort)', () => {
  const helperFixture = () => {
    const root = makeTempDir('cost-audit-7i-join-');
    const store = join(root, 'projects');
    const munged = join(store, '-fixture');
    mkdirSync(join(munged, 'session-c1', 'subagents'), { recursive: true });
    writeFileSync(join(munged, 'session-c1.jsonl'),
      assistant('p1', 10, 0, 0, 5, '2026-10-01T10:00:00.000Z', 'claude-opus-4-7'));
    // Two requests six minutes apart: the transcript span is 360,000 ms, which
    // must never be taken for the helper's run time.
    writeFileSync(join(munged, 'session-c1', 'subagents', 'agent-x.jsonl'), [
      assistant('s1', 5, 0, 0, 2, '2026-10-01T10:05:00.000Z', 'claude-sonnet-4-5'),
      assistant('s2', 0, 5, 0, 2, '2026-10-01T10:11:00.000Z', 'claude-sonnet-4-5'),
    ].join('\n'));
    writeFileSync(join(munged, 'session-c1', 'subagents', 'agent-x.meta.json'), JSON.stringify({
      agentType: 'general-purpose',
      description: 'Implement the feature',
      toolUseId: 'tool-1',
      spawnDepth: 1,
      requestShape: 'full',
      requestNonInteractive: true,
    }));
    return store;
  };

  it('takes helper run time and tool uses from the recorded final joined on toolUseId', async () => {
    const store = helperFixture();
    const sessions = await collectSubagentSessions([store], null, {
      subagentUsage: [
        { subagentUsage: true, toolUseId: 'tool-1', durationMs: 1_234, toolUses: 7 },
        // One final sample per helper: a duplicate record cannot override it.
        { subagentUsage: true, toolUseId: 'tool-1', durationMs: 5_555, toolUses: 9 },
        { subagentUsage: true, toolUseId: 'other-tool', durationMs: 9_999, toolUses: 1 },
        // Not a subagent-usage row at all.
        { toolUseId: 'tool-1', durationMs: 555, toolUses: 3 },
      ],
    });
    const helper = sessions[0].subagents[0];
    expect(helper.runMs).toBe(1_234);
    expect(helper.toolUses).toBe(7);
    expect(helper.runMs).not.toBe(360_000);
  });

  it('keeps run time and tool uses unknown for a helper without a recorded final', async () => {
    const store = helperFixture();
    const sessions = await collectSubagentSessions([store], null, { subagentUsage: [] });
    expect(sessions[0].subagents[0].runMs).toBeNull();
    expect(sessions[0].subagents[0].toolUses).toBeNull();
  });
});

describe('logged trial exposure', () => {
  const from = Date.parse('2026-10-18T00:00:00Z');
  const to = Date.parse('2026-10-20T00:00:00Z');
  const subagent = (at: number) => ({ meta: { agentType: 'general-purpose' }, model: 'claude-sonnet-4-5',
    parentModel: 'claude-opus-4-7', spendUsd: 2, finalContext: 100, runMs: 60_000,
    firstAt: at, lastAt: at + 60_000, isError: false,
    longWaits: [{ at: at + 30_000, rewrittenTokens: 100, model: 'claude-sonnet-4-5' }] });
  const session = (id: string, starts: number[]): ParentSessionRecord => ({ sessionId: id,
    arm: armForSessionId(id), parentModel: 'claude-opus-4-7', firstAt: starts[0], activityAt: starts,
    subagents: starts.map(subagent) });
  const policy = (id: string, at: string, extras: Record<string, unknown> = {}) => ({ provider: 'claude', sessionId: id,
    at, setting: 'trial', arm: armForSessionId(id), applied: armForSessionId(id) === 'sonnet',
    reviewerRuleDelivered: true, waitingRuleDelivered: false, ...extras });
  const aggregate = (sessions: ParentSessionRecord[], policyEntries: Record<string, unknown>[]) =>
    aggregateSubagentMetrics(sessions, { sinceMs: from, untilMs: to, policyEntries });

  it('excludes historical helpers in a session reused after actual exposure', () => {
    const historical = Date.parse('2026-07-01T00:00:00Z');
    const recent = Date.parse('2026-10-18T12:00:00Z');
    const m = aggregate([session('session-a1', [historical, recent])],
      [policy('session-a1', '2026-10-18T11:00:00Z')]);
    expect(m.arms.sonnet.sessions).toBe(1);
    expect(m.arms.sonnet.gpSubagents).toBe(1);
    expect(m.arms.sonnet.spendUsd).toBe(2);
    expect(m.sample.days).toBeLessThan(3);
  });

  it('stops counting helpers once a later resume turns the trial exposure off', () => {
    const early = Date.parse('2026-10-18T10:00:00Z');
    const late = Date.parse('2026-10-18T14:00:00Z');
    const m = aggregate([session('session-a1', [early, late])], [
      policy('session-a1', '2026-10-18T09:00:00Z'),
      policy('session-a1', '2026-10-18T12:00:00Z', { setting: 'parent', applied: false }),
    ]);
    // Only the helper spawned inside the exposure interval counts; the one
    // after the resume that disabled the trial is not trial exposure.
    expect(m.arms.sonnet.gpSubagents).toBe(1);
    expect(m.arms.sonnet.spendUsd).toBe(2);
  });

  it('restores counting when a later record puts the session back in the trial', () => {
    const first = Date.parse('2026-10-18T10:00:00Z');
    const off = Date.parse('2026-10-18T12:30:00Z');
    const again = Date.parse('2026-10-18T14:00:00Z');
    const m = aggregate([session('session-a1', [first, off, again])], [
      policy('session-a1', '2026-10-18T09:00:00Z'),
      policy('session-a1', '2026-10-18T12:00:00Z', { setting: 'parent', applied: false }),
      policy('session-a1', '2026-10-18T13:00:00Z'),
    ]);
    expect(m.arms.sonnet.gpSubagents).toBe(2);
  });

  it('vetoes when a review-named catch-all claude helper runs off the parent family', () => {
    // `CLAUDE_CODE_SUBAGENT_MODEL` moves the built-in catch-all too
    // (claude-subagent-policy.ts), so a review-named one on Sonnet under an
    // Opus parent is the observed mismatch the reviewer guard must veto.
    const recent = Date.parse('2026-10-18T12:00:00Z');
    const catchAll = { ...subagent(recent), meta: { agentType: 'claude', description: 'Verify completed work' } };
    const sonnetSession: ParentSessionRecord = {
      sessionId: 'session-a1', arm: 'sonnet', parentModel: 'claude-opus-4-7',
      firstAt: recent, activityAt: [recent], subagents: [subagent(recent), catchAll],
    };
    const m = aggregate([sonnetSession, session('session-aa', [recent])], [
      policy('session-a1', '2026-10-18T11:00:00Z'),
      policy('session-aa', '2026-10-18T11:00:00Z'),
    ]);
    expect(m.arms.sonnet.reviewerGuardChecked).toBe(1);
    expect(m.arms.sonnet.reviewerGuardViolations).toBe(1);
    expect(evaluateSubagentVerdict(m).verdict).toBe('do-not-adopt (the reviewer rule must be firmer first)');
  });

  it('leaves helpers that name their own model to the model James gave them', () => {
    // The subagent-model policy does not reach them (setting description:
    // "Helper agents that name their own model ... keep their model"), so a
    // family mismatch there is James's own choice, not an ignored rule.
    const recent = Date.parse('2026-10-18T12:00:00Z');
    const named = {
      ...subagent(recent),
      meta: { agentType: 'code-reviewer', description: 'Review the diff' },
      model: 'claude-haiku-4-5',
    };
    const sonnetSession: ParentSessionRecord = {
      sessionId: 'session-a1', arm: 'sonnet', parentModel: 'claude-opus-4-7',
      firstAt: recent, activityAt: [recent], subagents: [named],
    };
    const m = aggregate([sonnetSession, session('session-aa', [recent])], [
      policy('session-a1', '2026-10-18T11:00:00Z'),
      policy('session-aa', '2026-10-18T11:00:00Z'),
    ]);
    expect(m.arms.sonnet.reviewerGuardChecked).toBe(0);
    expect(m.arms.sonnet.reviewerGuardViolations).toBe(0);
    expect(evaluateSubagentVerdict(m).verdict).toBe('pending (sample)');
  });

  it('excludes no-log, disabled-model, missing-reviewer and pre-exposure sessions', () => {
    const recent = Date.parse('2026-10-18T12:00:00Z');
    const sessions = ['session-a1', 'session-a2', 'session-a3', 'session-a4'].map(id => session(id, [recent]));
    const m = aggregate(sessions, [
      policy('session-a2', '2026-10-18T11:00:00Z', { setting: 'parent' }),
      policy('session-a3', '2026-10-18T11:00:00Z', { reviewerRuleDelivered: false }),
      policy('session-a4', '2026-10-18T13:00:00Z'),
    ]);
    expect(m.arms.sonnet.gpSubagents).toBe(0);
    expect(m.trialExposureMs).toBe(Date.parse('2026-10-18T13:00:00Z'));
    expect(evaluateSubagentVerdict(m).verdict).toBe('pending (no data)');
    expect(evaluateSubagentVerdict(m).waitingRule).toBe('pending (no data)');
  });

  it('counts real logged arms, while a disabled waiting rule cannot get KEEP', () => {
    const recent = Date.parse('2026-10-18T12:00:00Z');
    const m = aggregate([session('session-a1', [recent]), session('session-aa', [recent])], [
      policy('session-a1', '2026-10-18T11:00:00Z'),
      policy('session-aa', '2026-10-18T11:00:00Z'),
    ]);
    expect(m.arms.sonnet.gpSubagents).toBe(1);
    expect(m.arms['same-as-session'].gpSubagents).toBe(1);
    expect(m.waitingRuleActivationMs).toBeNull();
    expect(evaluateSubagentVerdict(m).waitingRule).toBe('pending (rule not delivered)');
  });

  it('uses the logged waiting-rule activation and only treated post-rule sessions', () => {
    const before = Date.parse('2026-10-18T10:00:00Z');
    const after = Date.parse('2026-10-18T12:00:00Z');
    const m = aggregate([session('session-a1', [before]), session('session-aa', [after]),
      session('session-ab', [after])], [
      policy('session-aa', '2026-10-18T11:00:00Z', { waitingRuleDelivered: true }),
      policy('session-ab', '2026-10-18T11:00:00Z'),
    ]);
    expect(m.waitingRuleActivationMs).toBe(Date.parse('2026-10-18T11:00:00Z'));
    expect(m.waitingRule.before.count).toBe(1);
    expect(m.waitingRule.after.count).toBe(1);
  });
});

describe('a disabled trial exposure cannot carry a whole sample', () => {
  it('never counts helpers spawned after a resume turned the trial off', () => {
    // The repro shape: trial exposure logged 1 Oct, disabled on a 2 Oct
    // resume, 300 helpers per group on 3 Oct, a 16-day window and a valid
    // plan-queue comparison. The Sonnet arm must count zero helpers — the
    // exposure ended before every one of them — and the verdict must not be
    // adopt-sonnet (pre-fix: 300 counted and adopt-sonnet).
    const day = 24 * 60 * 60 * 1000;
    const start = Date.parse('2026-10-01T00:00:00Z');
    const end = Date.parse('2026-10-17T00:00:00Z');
    const helpers = Array.from({ length: 300 }, (_, i) => start + 2 * day + i * 60_000);
    const subagent = (at: number, arm: 'sonnet' | 'same-as-session'): ParentSessionRecord['subagents'][number] => ({
      meta: { agentType: 'general-purpose' },
      model: arm === 'sonnet' ? 'claude-sonnet-4-5' : 'claude-opus-4-7',
      parentModel: 'claude-opus-4-7',
      spendUsd: arm === 'sonnet' ? 0.5 : 1,
      finalContext: 100,
      runMs: 60_000,
      firstAt: at,
      lastAt: at + 60_000,
      isError: false,
      longWaits: [],
    });
    const session = (id: string, ats: number[]): ParentSessionRecord => ({
      sessionId: id,
      arm: armForSessionId(id),
      parentModel: 'claude-opus-4-7',
      firstAt: ats[0],
      activityAt: ats,
      subagents: ats.map((at) => subagent(at, armForSessionId(id))),
    });
    const policy = (id: string, at: string, extras: Record<string, unknown> = {}) => ({
      provider: 'claude', sessionId: id, at, setting: 'trial',
      arm: armForSessionId(id), applied: armForSessionId(id) === 'sonnet',
      reviewerRuleDelivered: true, waitingRuleDelivered: false, armKey: `item-${id === 'session-a1' ? 0 : 1}`,
      ...extras,
    });
    const policyEntries = [
      policy('session-a1', '2026-10-01T00:00:00.000Z'),
      policy('session-a8', '2026-10-01T00:00:00.000Z'),
      policy('session-a1', '2026-10-02T00:00:00.000Z', { setting: 'parent', applied: false }),
    ];
    const items = [
      { id: 'item-0', landed_commit: 'sha', updated_at: start + 3 * day },
      { id: 'item-1', landed_commit: 'sha', updated_at: start + 3 * day },
    ];
    const m = aggregateSubagentMetrics(
      [session('session-a1', helpers), session('session-a8', helpers)],
      { sinceMs: start, untilMs: end, policyEntries, items },
    );
    expect(m.arms.sonnet.gpSubagents).toBe(0);
    expect(m.arms['same-as-session'].gpSubagents).toBe(300);
    expect(evaluateSubagentVerdict(m).verdict).not.toBe('adopt-sonnet');
  });
});

// ── End-to-end fixture tree (the plan's --subagents fixture) ────────────────
function assistant(id: string, input: number, cacheRead: number, cacheWrite: number, output: number, timestamp: string, model: string): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    entrypoint: 'cli',
    message: {
      id,
      model,
      role: 'assistant',
      usage: {
        input_tokens: input,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: cacheWrite,
        output_tokens: output,
      },
    },
  });
}

describe('claude-cost-audit-report --subagents (end to end)', () => {
  it('prints both groups, the review-named helper, the 6-minute-gap rewrite and a pending verdict', () => {
    const root = makeTempDir('cost-audit-subagents-');
    const projectsDir = join(root, 'projects');
    const userData = join(root, 'userData');
    const munged = join(projectsDir, '-fixture');
    mkdirSync(userData, { recursive: true });
    const policyDir = join(userData, 'session-policy');
    mkdirSync(policyDir);
    writeFileSync(join(policyDir, '2026-10-01.jsonl'), [
      JSON.stringify({ provider: 'claude', sessionId: 'session-a1', at: '2026-10-01T09:00:00.000Z',
        setting: 'trial', arm: 'sonnet', applied: true, reviewerRuleDelivered: true, waitingRuleDelivered: false }),
      JSON.stringify({ provider: 'claude', sessionId: 'session-aa', at: '2026-10-02T10:00:00.000Z',
        setting: 'trial', arm: 'same-as-session', applied: false, reviewerRuleDelivered: true, waitingRuleDelivered: false }),
    ].join('\n'));

    // Session 1 (last hex digit '1' → Sonnet group), parent on Opus.
    mkdirSync(join(munged, 'session-a1', 'subagents'), { recursive: true });
    writeFileSync(join(munged, 'session-a1.jsonl'), [
      assistant('p1', 10, 0, 0, 5, '2026-10-01T10:00:00.000Z', 'claude-opus-4-7'),
      JSON.stringify({
        type: 'assistant', timestamp: '2026-10-01T10:01:00.000Z', entrypoint: 'cli',
        message: { id: 'p2', model: 'claude-opus-4-7', role: 'assistant', usage: { input_tokens: 0, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 1 },
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Task', input: {} }] },
      }),
      JSON.stringify({
        type: 'user', timestamp: '2026-10-01T10:20:00.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: false, content: '' }] },
      }),
    ].join('\n'));
    // One general-purpose subagent on Sonnet, under an Opus parent: a
    // 6-minute gap followed by a cache rewrite (TR-2's long-wait event).
    writeFileSync(join(munged, 'session-a1', 'subagents', 'agent-x.jsonl'), [
      assistant('s1', 5, 0, 0, 2, '2026-10-01T10:05:00.000Z', 'claude-sonnet-4-5'),
      assistant('s2', 0, 5, 500, 2, '2026-10-01T10:11:00.000Z', 'claude-sonnet-4-5'),
    ].join('\n'));
    writeFileSync(join(munged, 'session-a1', 'subagents', 'agent-x.meta.json'), JSON.stringify({
      agentType: 'general-purpose',
      description: 'Implement the feature',
      toolUseId: 'tool-1',
      spawnDepth: 1,
      requestShape: 'full',
      requestNonInteractive: true,
    }));

    // Session 2 (last hex digit 'a' → same-as-session group), parent on Opus.
    mkdirSync(join(munged, 'session-aa', 'subagents'), { recursive: true });
    writeFileSync(join(munged, 'session-aa.jsonl'), [
      assistant('q1', 10, 0, 0, 5, '2026-10-02T11:00:00.000Z', 'claude-opus-4-7'),
    ].join('\n'));
    // The review-named helper, on the parent's own family (guard: 0 of 1).
    writeFileSync(join(munged, 'session-aa', 'subagents', 'agent-y.jsonl'), [
      assistant('s3', 5, 0, 0, 2, '2026-10-02T11:05:00.000Z', 'claude-opus-4-7'),
    ].join('\n'));
    writeFileSync(join(munged, 'session-aa', 'subagents', 'agent-y.meta.json'), JSON.stringify({
      agentType: 'general-purpose',
      description: 'Review the finished output',
      toolUseId: 'tool-2',
      spawnDepth: 1,
      requestShape: 'full',
      requestNonInteractive: true,
    }));

    const result = spawnSync(process.execPath, [
      scriptPath,
      '--subagents',
      '--projects', projectsDir,
      '--userdata', userData,
      '--since', '2026-09-01',
    ], { encoding: 'utf8' });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status).toBe(0);
    expect(output).toContain('## A18 subagent trial');
    expect(output).toContain('### Sonnet helpers');
    expect(output).toContain('### Same-as-session helpers');
    expect(output).toContain('claude-sonnet-4-5 ×1');
    expect(output).toContain('claude-opus-4-7 ×1');
    expect(output).toContain('reviewer guard | 0 of 1');
    expect(output).toContain('reviewer guard | 0 of 0');
    expect(output).toContain('Long-wait cache rewrites');
    expect(output).toContain('Waiting-rule delivery: none');
    expect(output).toContain('Waiting rule: **pending (rule not delivered)**');
    expect(output).toContain('Claude helper model: **pending (sample)**');
    // Step 2's size-and-effort join is shown per group; with no 7i records the
    // helper's run time is unknown, never the transcript span.
    expect(output).toContain('7i records, joined on toolUseId');
    expect(output).toContain('0/1 helpers carry a recorded run time');
    expect(output).toContain('Landings settled at or after the window cutoff (not counted as landed): 0');
  });

  it('never adopts Sonnet without the plan-queue landing comparison (actual CLI)', () => {
    // The repro shape end to end: 16 days, 300 general-purpose helpers per
    // group and 40% lower Sonnet spend, but no loop DB, so both landing shares
    // are n/a. Step 2 adopts only when the landed share is no more than 10
    // points lower; missing quality evidence must withhold adoption.
    const root = makeTempDir('cost-audit-queueless-');
    const projectsDir = join(root, 'projects');
    const userData = join(root, 'userData');
    const munged = join(projectsDir, '-fixture');
    const policyDir = join(userData, 'session-policy');
    mkdirSync(policyDir, { recursive: true });
    const start = Date.parse('2026-10-01T00:00:00.000Z');
    const iso = (at: number) => new Date(at).toISOString();
    const records: string[] = [];
    for (const [sessionId, arm, model] of [
      ['session-a1', 'sonnet', 'claude-sonnet-4-5'],
      ['session-a8', 'same-as-session', 'claude-opus-4-7'],
    ] as const) {
      const subs = join(munged, sessionId, 'subagents');
      mkdirSync(subs, { recursive: true });
      const parent: string[] = [];
      for (let i = 0; i < 300; i++) {
        const at = start + 86_400_000 + i * 60_000;
        const tool = `fixture-tool-${i}`;
        parent.push(JSON.stringify({ type: 'user', uuid: `fixture-turn-${i}`, timestamp: iso(at - 1000), message: { content: 'Fixture task' } }));
        parent.push(JSON.stringify({
          type: 'assistant', timestamp: iso(at),
          message: { id: `parent-${i}`, model: 'claude-opus-4-7', role: 'assistant',
            usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
            content: [{ type: 'tool_use', id: tool, name: 'Task', input: {} }] },
        }));
        parent.push(JSON.stringify({
          type: 'user', timestamp: iso(at + 2000),
          message: { content: [{ type: 'tool_result', tool_use_id: tool, is_error: false, content: 'Fixture complete' }] },
        }));
        writeFileSync(join(subs, `agent-${i}.jsonl`),
          assistant(`helper-${i}`, 1000, 0, 0, 0, iso(at + 1000), model));
        writeFileSync(join(subs, `agent-${i}.meta.json`), JSON.stringify({
          agentType: 'general-purpose', description: 'Implement fixture', toolUseId: tool, spawnDepth: 1,
        }));
      }
      writeFileSync(join(munged, `${sessionId}.jsonl`), parent.join('\n') + '\n');
      records.push(JSON.stringify({ provider: 'claude', sessionId, arm, setting: 'trial',
        applied: arm === 'sonnet', at: iso(start), reviewerRuleDelivered: true, waitingRuleDelivered: false }));
    }
    writeFileSync(join(policyDir, '2026-10-01.jsonl'), records.join('\n') + '\n');

    const result = spawnSync(process.execPath, [
      scriptPath,
      '--subagents',
      '--since', iso(start),
      '--until', '2026-10-17T00:00:00Z',
      '--userdata', userData,
      '--projects', projectsDir,
    ], { encoding: 'utf8', env: { ...process.env, AIO_COST_ATTRIBUTION_DIR: join(root, 'cost-attribution') } });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status).toBe(0);
    expect(output).toContain('plan-queue landed share: n/a vs n/a');
    expect(output).not.toContain('**adopt-sonnet**');
    expect(output).toContain('Claude helper model: **pending (plan-queue landing evidence)**');
    expect(output).toContain('the ≤10-point drop check cannot pass without it');
  });

  it('keeps a queue item in its first worker\'s group under a date filter (actual CLI)', () => {
    // The verifier's repro shape end to end: an item first worked by a Sonnet
    // session on 1 Oct, then by a control session on 3 Oct, queried with
    // --since 2026-10-02 --until 2026-10-05. The item keeps its FIRST worker's
    // group (sonnet, landed) and counts mixed; the later worker must not
    // re-attribute it to the control group (pre-fix: control 1 landed, mixed 0).
    const root = makeTempDir('cost-audit-queue-cohort-');
    const userData = join(root, 'userData');
    const policyDir = join(userData, 'session-policy');
    mkdirSync(join(root, 'projects'), { recursive: true });
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(join(policyDir, '2026-10-01.jsonl'), [
      JSON.stringify({ provider: 'claude', sessionId: 'session-a1', arm: 'sonnet', armKey: 'item-1',
        setting: 'trial', applied: true, reviewerRuleDelivered: true, waitingRuleDelivered: false,
        at: '2026-10-01T10:00:00.000Z' }),
      JSON.stringify({ provider: 'claude', sessionId: 'session-aa', arm: 'same-as-session', armKey: 'item-1',
        setting: 'trial', applied: false, reviewerRuleDelivered: true, waitingRuleDelivered: false,
        at: '2026-10-03T10:00:00.000Z' }),
    ].join('\n') + '\n');
    // plan_queue_items with the RUNTIME schema (loop-schema.ts's own migration
    // SQL, the idiom the read-only fixture pins): the report selects
    // updated_at, so a hand-kept copy would drift. One landed item.
    const schemaSource = readFileSync(join(repoRoot, 'src', 'main', 'orchestration', 'loop-schema.ts'), 'utf8');
    const migrationSql = [...schemaSource.matchAll(/up: `([\s\S]*?)`/g)].map((match) => match[1]).join('\n');
    expect(migrationSql).toContain('CREATE TABLE IF NOT EXISTS plan_queue_items');
    mkdirSync(join(userData, 'loop-mode'), { recursive: true });
    execFileSync('sqlite3', [join(userData, 'loop-mode', 'loop-mode.db'),
      `${migrationSql}
      INSERT INTO plan_queue_items
        (id, run_id, document_path, state, landed_commit, created_at, updated_at)
        VALUES ('item-1', 'run-1', '/repo/docs/plans/item_plan.md', 'landed', 'sha-1',
          ${Date.parse('2026-10-01T10:00:00.000Z')}, ${Date.parse('2026-10-03T12:00:00.000Z')});`]);

    const result = spawnSync(process.execPath, [
      scriptPath,
      '--subagents',
      '--userdata', userData,
      '--projects', join(root, 'projects'),
      '--since', '2026-10-02T00:00:00.000Z',
      '--until', '2026-10-05T00:00:00.000Z',
    ], { encoding: 'utf8', env: { ...process.env, AIO_COST_ATTRIBUTION_DIR: join(root, 'cost-attribution') } });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status).toBe(0);
    expect(output).toContain('| sonnet | 1 | 1 | 100.0% |');
    expect(output).toContain('| same-as-session | 0 | 0 | n/a |');
    expect(output).toContain('Mixed-group items (workers in both groups): 1.');
    expect(output).toContain('Unassigned (no logged worker): 0.');
  });

  it('ignores future-only and opposite-arm workers in a historical report (actual CLI)', () => {
    const root = makeTempDir('cost-audit-future-workers-');
    const userData = join(root, 'userData');
    const projects = join(root, 'projects');
    const policyDir = join(userData, 'session-policy');
    mkdirSync(projects, { recursive: true });
    mkdirSync(policyDir, { recursive: true });
    mkdirSync(join(userData, 'loop-mode'), { recursive: true });
    const cutoff = Date.parse('2026-10-05T00:00:00.000Z');
    const record = (sessionId: string, armKey: string, at: number) => ({
      provider: 'claude', sessionId, armKey, at: new Date(at).toISOString(), setting: 'trial',
      arm: armForSessionId(sessionId), applied: armForSessionId(sessionId) === 'sonnet',
      reviewerRuleDelivered: true, waitingRuleDelivered: false,
    });
    const log = join(policyDir, 'fixture.jsonl');
    const earlier = record('session-a1', 'item-1', Date.parse('2026-10-01T00:00:00.000Z'));
    writeFileSync(log, JSON.stringify(earlier) + '\n');
    const schemaSource = readFileSync(join(repoRoot, 'src/main/orchestration/loop-schema.ts'), 'utf8');
    const migrationSql = [...schemaSource.matchAll(/up: `([\s\S]*?)`/g)].map(match => match[1]).join('\n');
    execFileSync('sqlite3', [join(userData, 'loop-mode/loop-mode.db'), `${migrationSql}
      INSERT INTO plan_queue_items
        (id, run_id, document_path, state, created_at, updated_at)
        VALUES ('item-1', 'fixture-run', '/repo/item_plan.md', 'queued', 1, 2),
          ('future-only', 'fixture-run', '/repo/future_plan.md', 'queued', 1, 2);`]);
    const run = (bounded: boolean) => {
      const result = spawnSync(process.execPath, [scriptPath, '--subagents', '--userdata', userData,
        '--projects', projects, '--since', '2026-10-02T00:00:00.000Z',
        ...(bounded ? ['--until', '2026-10-05T00:00:00.000Z'] : [])], {
        encoding: 'utf8', env: { ...process.env, AIO_COST_ATTRIBUTION_DIR: join(root, 'cost-attribution') },
      });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout;
    };
    const baseline = run(true);
    expect(baseline).toContain('| sonnet | 1 | 0 | 0.0% |');
    expect(baseline).toContain('Mixed-group items (workers in both groups): 0. Unassigned (no logged worker): 1.');
    writeFileSync(log, [earlier,
      record('session-aa', 'item-1', cutoff),
      { ...record('session-a2', 'future-only', cutoff + 1), waitingRuleDelivered: true },
    ].map(entry => JSON.stringify(entry)).join('\n') + '\n');
    expect(run(true)).toBe(baseline);
    const unbounded = run(false);
    expect(unbounded).toContain('| sonnet | 2 | 0 | 0.0% |');
    expect(unbounded).toContain('Mixed-group items (workers in both groups): 1. Unassigned (no logged worker): 0.');
    expect(unbounded).toContain('Waiting-rule delivery: 2026-10-05T00:00:00.001Z');
  });

  it('counts sessions whose transcripts live only under a managed account profile', () => {
    const root = makeTempDir('cost-audit-profiles-');
    const userData = join(root, 'userData');
    const projectsDir = join(userData, 'claude-cli-profiles', 'profile-a', 'projects');
    const munged = join(projectsDir, '-fixture');
    const policyDir = join(userData, 'session-policy');
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(join(policyDir, '2026-10-01.jsonl'), [
      JSON.stringify({ provider: 'claude', sessionId: 'session-b1', at: '2026-10-01T09:00:00.000Z',
        setting: 'trial', arm: 'sonnet', applied: true, reviewerRuleDelivered: true, waitingRuleDelivered: false }),
    ].join('\n'));
    mkdirSync(join(munged, 'session-b1', 'subagents'), { recursive: true });
    writeFileSync(join(munged, 'session-b1.jsonl'), [
      assistant('p1', 10, 0, 0, 5, '2026-10-01T10:00:00.000Z', 'claude-opus-4-7'),
      JSON.stringify({
        type: 'assistant', timestamp: '2026-10-01T10:01:00.000Z', entrypoint: 'cli',
        message: { id: 'p2', model: 'claude-opus-4-7', role: 'assistant', usage: { input_tokens: 0, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 1 },
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Task', input: {} }] },
      }),
      JSON.stringify({
        type: 'user', timestamp: '2026-10-01T10:20:00.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: false, content: '' }] },
      }),
    ].join('\n'));
    writeFileSync(join(munged, 'session-b1', 'subagents', 'agent-x.jsonl'),
      assistant('s1', 5, 0, 0, 2, '2026-10-01T10:05:00.000Z', 'claude-sonnet-4-5'));
    writeFileSync(join(munged, 'session-b1', 'subagents', 'agent-x.meta.json'), JSON.stringify({
      agentType: 'general-purpose',
      description: 'Implement the feature',
      toolUseId: 'tool-1',
      spawnDepth: 1,
      requestShape: 'full',
      requestNonInteractive: true,
    }));

    // No --projects override: discovery must reach the managed profile home
    // (CLAUDE_CONFIG_DIR points the default root at an empty directory).
    const result = spawnSync(process.execPath, [
      scriptPath,
      '--subagents',
      '--userdata', userData,
      '--since', '2026-09-01',
    ], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, 'no-claude-config') } });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status).toBe(0);
    expect(output).toContain('## A18 subagent trial');
    expect(output).toContain('### Sonnet helpers');
    expect(output).toContain('claude-sonnet-4-5 ×1');
  });

  it('counts one helper once when a managed profile aliases the shared transcript store', () => {
    const root = makeTempDir('cost-audit-alias-');
    const configDir = join(root, 'claude-config');
    const sharedStore = join(configDir, 'projects');
    const userData = join(root, 'userData');
    const munged = join(sharedStore, '-fixture');
    const policyDir = join(userData, 'session-policy');
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(join(policyDir, '2026-10-01.jsonl'), [
      JSON.stringify({ provider: 'claude', sessionId: 'session-c1', at: '2026-10-01T09:00:00.000Z',
        setting: 'trial', arm: 'sonnet', applied: true, reviewerRuleDelivered: true, waitingRuleDelivered: false }),
    ].join('\n'));
    mkdirSync(join(munged, 'session-c1', 'subagents'), { recursive: true });
    writeFileSync(join(munged, 'session-c1.jsonl'), [
      assistant('p1', 10, 0, 0, 5, '2026-10-01T10:00:00.000Z', 'claude-opus-4-7'),
      JSON.stringify({
        type: 'assistant', timestamp: '2026-10-01T10:01:00.000Z', entrypoint: 'cli',
        message: { id: 'p2', model: 'claude-opus-4-7', role: 'assistant', usage: { input_tokens: 0, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 1 },
          content: [{ type: 'tool_use', id: 'tool-1', name: 'Task', input: {} }] },
      }),
      JSON.stringify({
        type: 'user', timestamp: '2026-10-01T10:20:00.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', is_error: false, content: '' }] },
      }),
    ].join('\n'));
    // One general-purpose helper costing exactly $0.0045 (sonnet-class
    // $3/$15 per MTok over 1000 input + 100 output tokens).
    writeFileSync(join(munged, 'session-c1', 'subagents', 'agent-x.jsonl'),
      assistant('s1', 1000, 0, 0, 100, '2026-10-01T10:05:00.000Z', 'claude-sonnet-4-5'));
    writeFileSync(join(munged, 'session-c1', 'subagents', 'agent-x.meta.json'), JSON.stringify({
      agentType: 'general-purpose',
      description: 'Implement the feature',
      toolUseId: 'tool-1',
      spawnDepth: 1,
      requestShape: 'full',
      requestNonInteractive: true,
    }));

    const run = () => spawnSync(process.execPath, [
      scriptPath,
      '--subagents',
      '--userdata', userData,
      '--since', '2026-09-01',
    ], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: configDir } });
    const single = run();
    expect(single.status).toBe(0);
    expect(single.stdout).toContain('| helper agents | 1 (general-purpose 1) |');
    expect(single.stdout).toContain('| spend | $0.0045 ($0.0045/session, $0.0045/general-purpose helper) |');

    // The shared-store profile seeder (claude-profile-seed.ts) links
    // <profile>/projects at the shared store. Discovering the same store
    // twice must not count the helper or its spend twice.
    mkdirSync(join(userData, 'claude-cli-profiles', 'profile-a'), { recursive: true });
    symlinkSync(sharedStore, join(userData, 'claude-cli-profiles', 'profile-a', 'projects'));
    const aliased = run();
    expect(aliased.status).toBe(0);
    expect(aliased.stdout).toContain('| helper agents | 1 (general-purpose 1) |');
    expect(aliased.stdout).toContain('| spend | $0.0045 ($0.0045/session, $0.0045/general-purpose helper) |');
    expect(aliased.stdout).not.toContain('| helper agents | 2');
    expect(aliased.stdout).not.toContain('$0.0090');
  });
});

describe('shared-store transcript aliases in collectSubagentSessions', () => {
  const fixture = (store: string, helperName: string) => {
    const munged = join(store, '-fixture');
    mkdirSync(join(munged, 'session-c1', 'subagents'), { recursive: true });
    writeFileSync(join(munged, 'session-c1.jsonl'), assistant('p1', 10, 0, 0, 5, '2026-10-01T10:00:00.000Z', 'claude-opus-4-7'));
    writeFileSync(join(munged, 'session-c1', 'subagents', helperName),
      assistant('s1', 1000, 0, 0, 100, '2026-10-01T10:05:00.000Z', 'claude-sonnet-4-5'));
    writeFileSync(join(munged, 'session-c1', 'subagents', helperName.replace(/\.jsonl$/, '.meta.json')), JSON.stringify({
      agentType: 'general-purpose',
      description: 'Implement the feature',
      toolUseId: 'tool-1',
      spawnDepth: 1,
      requestShape: 'full',
      requestNonInteractive: true,
    }));
  };

  it('counts one helper once when two roots are symlink aliases of one store', async () => {
    const root = makeTempDir('cost-audit-alias-roots-');
    const sharedStore = join(root, 'projects');
    fixture(sharedStore, 'agent-x.jsonl');
    const alias = join(root, 'alias-projects');
    symlinkSync(sharedStore, alias);

    const alone = await collectSubagentSessions([sharedStore]);
    const aliased = await collectSubagentSessions([sharedStore, alias]);
    expect(alone).toHaveLength(1);
    expect(alone[0].subagents).toHaveLength(1);
    expect(aliased).toHaveLength(1);
    expect(aliased[0].subagents).toHaveLength(1);
    expect(aliased[0].subagents[0].spendUsd).toBeCloseTo(0.0045, 9);
    expect(aliased[0].subagents[0].spendUsd).toBe(alone[0].subagents[0].spendUsd);
  });

  it('keeps one helper identity when a store is copied into a second root', async () => {
    const root = makeTempDir('cost-audit-copied-roots-');
    const storeA = join(root, 'store-a', 'projects');
    const storeB = join(root, 'store-b', 'projects');
    fixture(storeA, 'agent-x.jsonl');
    fixture(storeB, 'agent-x.jsonl');

    const sessions = await collectSubagentSessions([storeA, storeB]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].subagents).toHaveLength(1);
    expect(sessions[0].subagents[0].spendUsd).toBeCloseTo(0.0045, 9);
  });

  it('keeps two helpers that share only a file name and nothing else', async () => {
    const root = makeTempDir('cost-audit-distinct-helpers-');
    const storeA = join(root, 'store-a', 'projects');
    const storeB = join(root, 'store-b', 'projects');
    fixture(storeA, 'agent-x.jsonl');
    fixture(storeB, 'agent-x.jsonl');
    // Same parent session and file name, but a distinct Task tool_use id:
    // a genuinely different helper, never merged.
    const metaB = join(storeB, '-fixture', 'session-c1', 'subagents', 'agent-x.meta.json');
    writeFileSync(metaB, JSON.stringify({
      agentType: 'general-purpose',
      description: 'Implement the feature',
      toolUseId: 'tool-2',
      spawnDepth: 1,
      requestShape: 'full',
      requestNonInteractive: true,
    }));

    const sessions = await collectSubagentSessions([storeA, storeB]);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].subagents).toHaveLength(2);
  });
});
