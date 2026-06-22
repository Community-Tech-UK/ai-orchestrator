import { describe, expect, it } from 'vitest';
import { LoopStatusSchema } from '@contracts/schemas/loop';
import {
  activityKindLabel,
  buildInspectorProgress,
  completionGateSteps,
  formatCostCents,
  formatTimestamp,
  humanDuration,
  humanTokens,
  loopPauseReason,
  loopStatusLabel,
  loopStatusPill,
  relativeTime,
  shortTime,
  summaryHasDistinctIterationPrompt,
  summarizeToolDetail,
  terminalStatusLabel,
} from './loop-formatters.util';

describe('humanDuration', () => {
  it('renders sub-minute durations as `Ns`', () => {
    expect(humanDuration(0)).toBe('0s');
    expect(humanDuration(999)).toBe('0s');
    expect(humanDuration(1000)).toBe('1s');
    expect(humanDuration(45_000)).toBe('45s');
    expect(humanDuration(59_999)).toBe('59s');
  });

  it('renders sub-hour durations as `NmSs`', () => {
    expect(humanDuration(60_000)).toBe('1m0s');
    expect(humanDuration(125_000)).toBe('2m5s');
    expect(humanDuration(59 * 60_000 + 59_000)).toBe('59m59s');
  });

  it('renders multi-hour durations as `NhMm`', () => {
    expect(humanDuration(60 * 60_000)).toBe('1h0m');
    expect(humanDuration(2 * 60 * 60_000 + 30 * 60_000)).toBe('2h30m');
    expect(humanDuration(24 * 60 * 60_000)).toBe('24h0m');
  });

  it('renders durations over 24 hours as `NdNhNm`', () => {
    expect(humanDuration(24 * 60 * 60_000 + 60_000)).toBe('1d0h1m');
    expect(humanDuration(25 * 60 * 60_000 + 30 * 60_000)).toBe('1d1h30m');
  });
});

describe('humanTokens', () => {
  it('renders sub-thousand counts verbatim', () => {
    expect(humanTokens(0)).toBe('0 tok');
    expect(humanTokens(999)).toBe('999 tok');
  });

  it('renders thousands with one decimal', () => {
    expect(humanTokens(1_000)).toBe('1.0k tok');
    expect(humanTokens(12_345)).toBe('12.3k tok');
    expect(humanTokens(999_999)).toBe('1000.0k tok');
  });

  it('renders millions with two decimals', () => {
    expect(humanTokens(1_000_000)).toBe('1.00M tok');
    expect(humanTokens(2_500_000)).toBe('2.50M tok');
  });
});

describe('shortTime', () => {
  it('zero-pads to HH:MM:SS', () => {
    // Avoid timezone drift by constructing from individual components.
    const ts = new Date(2024, 0, 1, 5, 7, 9).getTime();
    expect(shortTime(ts)).toBe('05:07:09');
  });
});

describe('activityKindLabel', () => {
  it('aliases known kinds and falls through unknown ones', () => {
    expect(activityKindLabel('tool_use')).toBe('tool');
    expect(activityKindLabel('input_required')).toBe('input');
    expect(activityKindLabel('stream-idle')).toBe('quiet');
    expect(activityKindLabel('error')).toBe('error');
    expect(activityKindLabel('something-new')).toBe('something-new');
  });
});

describe('terminalStatusLabel', () => {
  it('renders each terminal status exactly once', () => {
    expect(terminalStatusLabel('completed')).toBe('completed ✓');
    expect(terminalStatusLabel('completed-needs-review')).toBe('needs review');
    expect(terminalStatusLabel('cancelled')).toBe('cancelled');
    expect(terminalStatusLabel('failed')).toBe('failed');
    expect(terminalStatusLabel('cap-reached')).toBe('cap reached');
    expect(terminalStatusLabel('error')).toBe('error');
    expect(terminalStatusLabel('no-progress')).toBe('no progress');
  });
});

describe('loopStatusLabel', () => {
  it('handles terminal + intermediate statuses', () => {
    expect(loopStatusLabel('completed')).toBe('completed');
    expect(loopStatusLabel('completed-needs-review')).toBe('needs review');
    expect(loopStatusLabel('cancelled')).toBe('cancelled');
    expect(loopStatusLabel('cap-reached')).toBe('cap');
    expect(loopStatusLabel('error')).toBe('error');
    expect(loopStatusLabel('no-progress')).toBe('no-progress');
    expect(loopStatusLabel('paused')).toBe('paused');
    expect(loopStatusLabel('running')).toBe('running');
  });

  it('falls through unknown statuses verbatim (forward-compat)', () => {
    expect(loopStatusLabel('not-yet-defined')).toBe('not-yet-defined');
  });
});

describe('summaryHasDistinctIterationPrompt', () => {
  it('requires a non-empty iteration prompt that differs from the initial prompt', () => {
    expect(summaryHasDistinctIterationPrompt({ initialPrompt: 'build it' })).toBe(false);
    expect(summaryHasDistinctIterationPrompt({ initialPrompt: 'build it', iterationPrompt: '' })).toBe(false);
    expect(summaryHasDistinctIterationPrompt({ initialPrompt: 'build it', iterationPrompt: 'build it' })).toBe(false);
    expect(summaryHasDistinctIterationPrompt({ initialPrompt: 'build it', iterationPrompt: 'continue' })).toBe(true);
  });
});

// LF-8 contract: every LoopStatus must resolve to a non-empty label so the UI
// never renders a blank/garbled status cell, and every terminal status must
// resolve via terminalStatusLabel.
describe('LoopStatus label completeness (LF-8 contract)', () => {
  const TERMINAL = new Set(['completed', 'completed-needs-review', 'cancelled', 'failed', 'cap-reached', 'error', 'no-progress']);

  it('every LoopStatus resolves to a non-empty loopStatusLabel', () => {
    for (const status of LoopStatusSchema.options) {
      expect(loopStatusLabel(status), `loopStatusLabel(${status})`).toBeTruthy();
    }
  });

  it('every terminal LoopStatus resolves to a non-empty terminalStatusLabel', () => {
    for (const status of LoopStatusSchema.options) {
      if (!TERMINAL.has(status)) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(terminalStatusLabel(status as any), `terminalStatusLabel(${status})`).toBeTruthy();
    }
  });

  it('does not define the removed dead statuses idle / verify-failed', () => {
    expect(LoopStatusSchema.options).not.toContain('idle');
    expect(LoopStatusSchema.options).not.toContain('verify-failed');
  });
});

describe('loopStatusPill (LF-8)', () => {
  it('maps live + terminal statuses to legible pills', () => {
    expect(loopStatusPill({ status: 'running' })).toEqual({ kind: 'running', label: 'RUNNING' });
    expect(loopStatusPill({ status: 'completed' })).toEqual({ kind: 'done', label: 'DONE' });
    expect(loopStatusPill({ status: 'completed-needs-review' })).toEqual({ kind: 'needs-review', label: 'NEEDS REVIEW' });
    expect(loopStatusPill({ status: 'cancelled' }).kind).toBe('stopped');
    expect(loopStatusPill({ status: 'cap-reached' }).label).toBe('CAP REACHED');
  });

  it('distinguishes the three pause flavours', () => {
    expect(loopStatusPill({ status: 'paused', lastCompletionOutcome: 'unverifiable' }).kind).toBe('awaiting-review');
    expect(loopStatusPill({ status: 'paused', manualReviewOnly: true }).kind).toBe('paused');
    expect(loopStatusPill({ status: 'paused', bannerKind: 'no-progress', bannerSignalId: 'BLOCKED' }).kind).toBe('blocked');
    expect(loopStatusPill({ status: 'paused', bannerKind: 'no-progress', bannerSignalId: 'A' }).kind).toBe('no-progress');
    expect(loopStatusPill({ status: 'paused' }).kind).toBe('paused');
  });
});

describe('loopPauseReason (LF-8)', () => {
  it('prioritises BLOCKED, then unverifiable, then no-progress', () => {
    expect(loopPauseReason({ bannerKind: 'no-progress', bannerSignalId: 'BLOCKED' })).toBe('blocked');
    expect(loopPauseReason({ lastCompletionOutcome: 'unverifiable' })).toBe('awaiting-review');
    expect(loopPauseReason({ bannerKind: 'no-progress', bannerSignalId: 'A' })).toBe('no-progress');
    expect(loopPauseReason({ manualReviewOnly: true })).toBe('paused');
    expect(loopPauseReason({})).toBe('paused');
  });
});

describe('completionGateSteps (LF-8)', () => {
  it('marks the rename step blocked when verify passed but the rename gate did not', () => {
    const steps = completionGateSteps({
      status: 'paused',
      verifyStatus: 'passed',
      requireRename: true,
      renameObserved: false,
      lastCompletionOutcome: 'rename-gate',
    });
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s.state]));
    expect(byKey['verify']).toBe('done');
    expect(byKey['rename']).toBe('blocked');
    expect(byKey['stop']).toBe('pending');
  });

  it('marks verify blocked when verify failed', () => {
    const steps = completionGateSteps({ status: 'paused', verifyStatus: 'failed', lastCompletionOutcome: 'verify-failed' });
    expect(steps.find((s) => s.key === 'verify')?.state).toBe('blocked');
  });

  it('skips verify for manual-review loops and marks review blocked while awaiting sign-off', () => {
    const steps = completionGateSteps({
      status: 'paused',
      manualReviewOnly: true,
      lastCompletionOutcome: 'unverifiable',
    });
    const byKey = Object.fromEntries(steps.map((s) => [s.key, s.state]));
    expect(byKey['verify']).toBe('skipped');
    expect(byKey['review']).toBe('blocked');
  });

  it('marks all gates done on a clean completion', () => {
    const steps = completionGateSteps({
      status: 'completed',
      verifyStatus: 'passed',
      requireRename: true,
      renameObserved: true,
      lastCompletionOutcome: 'accepted',
    });
    expect(steps.find((s) => s.key === 'stop')?.state).toBe('done');
    expect(steps.find((s) => s.key === 'rename')?.state).toBe('done');
  });
});

describe('relativeTime', () => {
  // All assertions pin "now" so the values are deterministic.
  const NOW = 1_700_000_000_000;

  it('renders sub-minute differences as Ns ago, with 1s floor', () => {
    expect(relativeTime(NOW, NOW)).toBe('1s ago');
    expect(relativeTime(NOW - 999, NOW)).toBe('1s ago');
    expect(relativeTime(NOW - 5_000, NOW)).toBe('5s ago');
    expect(relativeTime(NOW - 59_000, NOW)).toBe('59s ago');
  });

  it('renders future timestamps as "just now"', () => {
    expect(relativeTime(NOW + 1000, NOW)).toBe('just now');
  });

  it('renders sub-hour, sub-day, sub-week, and older differences', () => {
    expect(relativeTime(NOW - 5 * 60_000, NOW)).toBe('5m ago');
    expect(relativeTime(NOW - 3 * 3_600_000, NOW)).toBe('3h ago');
    expect(relativeTime(NOW - 2 * 86_400_000, NOW)).toBe('2d ago');
    // 8 days ago → falls into the calendar-date branch.
    const eightDaysAgo = NOW - 8 * 86_400_000;
    const result = relativeTime(eightDaysAgo, NOW);
    // Don't assert the exact month/day — locale + DST vary across CI.
    // Just confirm we left the "Nd ago" branch.
    expect(result).not.toMatch(/ago$/);
    expect(result).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });
});

describe('formatTimestamp', () => {
  it('returns a non-empty locale string for a valid timestamp', () => {
    const result = formatTimestamp(1_700_000_000_000);
    expect(result.length).toBeGreaterThan(0);
  });
});

describe('formatCostCents', () => {
  it('renders dollars-and-cents with two decimals', () => {
    expect(formatCostCents(0)).toBe('$0.00');
    expect(formatCostCents(7)).toBe('$0.07');
    expect(formatCostCents(150)).toBe('$1.50');
    expect(formatCostCents(99_999)).toBe('$999.99');
  });
});

describe('summarizeToolDetail', () => {
  it('returns empty string for missing detail', () => {
    expect(summarizeToolDetail(undefined)).toBe('');
    expect(summarizeToolDetail({})).toBe('');
  });

  it('surfaces the bash command from tool_use input', () => {
    expect(summarizeToolDetail({ name: 'Bash', input: { command: 'npm run test' } })).toBe('npm run test');
  });

  it('collapses internal whitespace to keep it one legible line', () => {
    expect(summarizeToolDetail({ input: { command: 'grep -rn foo\n  bar' } })).toBe('grep -rn foo bar');
  });

  it('shows the file path for read/edit/write tools', () => {
    expect(summarizeToolDetail({ name: 'Read', input: { file_path: '/tmp/x.ts' } })).toBe('/tmp/x.ts');
  });

  it('shows pattern and path for search tools', () => {
    expect(summarizeToolDetail({ name: 'Grep', input: { pattern: 'TODO', path: 'src' } })).toBe('TODO  ·  src');
  });

  it('prefers url then query then prose fields', () => {
    expect(summarizeToolDetail({ input: { url: 'https://example.com' } })).toBe('https://example.com');
    expect(summarizeToolDetail({ input: { query: 'how to' } })).toBe('how to');
    expect(summarizeToolDetail({ input: { description: 'run the migration' } })).toBe('run the migration');
  });

  it('reads from a flat detail object when there is no nested input', () => {
    expect(summarizeToolDetail({ command: 'ls -la' })).toBe('ls -la');
  });

  it('falls back to compact JSON of the args minus identity noise', () => {
    expect(summarizeToolDetail({ name: 'X', id: '1', input: { foo: 1, bar: true } })).toBe('{"foo":1,"bar":true}');
  });
});

describe('buildInspectorProgress', () => {
  const baseCaps = { maxIterations: 20, maxWallTimeMs: 600_000, maxTokens: 100_000, maxCostCents: 500 };
  const base = {
    status: 'running',
    statusPillKind: 'running',
    statusPillLabel: 'RUNNING',
    totalIterations: 0,
    totalTokens: 0,
    totalCostCents: 0,
    currentStage: 'IMPLEMENT',
    iterationsOnCurrentStage: 0,
    completionAttempts: 0,
    runningSeq: null as number | null,
    elapsedMs: 0,
    caps: baseCaps,
  };

  it('flags a just-started run (iteration 0 running, nothing completed)', () => {
    const p = buildInspectorProgress({ ...base, runningSeq: 0 });
    expect(p.headline).toBe('Iteration 0 running · just getting started');
    const iter = p.metrics.find((m) => m.key === 'iterations')!;
    // The in-flight iteration counts: 1 of 20 → 5%.
    expect(iter.valueText).toBe('1 / 20');
    expect(iter.pct).toBe(5);
  });

  it('computes per-cap fill percentages and marks the binding constraint full', () => {
    const p = buildInspectorProgress({
      ...base,
      runningSeq: 18,            // 19 of 20 iterations
      totalTokens: 50_000,       // 50% of tokens
      totalCostCents: 500,       // 100% of cost — binding constraint
      elapsedMs: 300_000,        // 50% of time
    });
    const byKey = Object.fromEntries(p.metrics.map((m) => [m.key, m]));
    expect(byKey['iterations'].pct).toBe(95);
    expect(byKey['time'].pct).toBe(50);
    expect(byKey['tokens'].pct).toBe(50);
    expect(byKey['cost'].pct).toBe(100);
  });

  it('renders uncapped budgets with no bar (pct null) and an ∞ label', () => {
    const p = buildInspectorProgress({
      ...base,
      caps: { ...baseCaps, maxIterations: null, maxTokens: null, maxCostCents: null },
      runningSeq: 4,
      totalTokens: 1234,
    });
    const byKey = Object.fromEntries(p.metrics.map((m) => [m.key, m]));
    expect(byKey['iterations'].pct).toBeNull();
    expect(byKey['iterations'].valueText).toBe('5 / ∞');
    expect(byKey['tokens'].pct).toBeNull();
    expect(byKey['tokens'].valueText).toBe('1.2k tok / ∞');
    // Time is always capped, so it still has a bar.
    expect(byKey['time'].pct).not.toBeNull();
  });

  it('clamps over-budget percentages to 100', () => {
    const p = buildInspectorProgress({ ...base, runningSeq: 0, elapsedMs: 10_000_000 });
    expect(p.metrics.find((m) => m.key === 'time')!.pct).toBe(100);
  });

  it('summarises a paused run between iterations', () => {
    const p = buildInspectorProgress({
      ...base,
      status: 'paused',
      statusPillKind: 'no-progress',
      statusPillLabel: 'PAUSED · NO PROGRESS',
      totalIterations: 3,
      iterationsOnCurrentStage: 2,
      runningSeq: null,
    });
    expect(p.headline).toBe('Paused after 3 iterations');
    expect(p.statusLabel).toBe('PAUSED · NO PROGRESS');
    expect(p.stageText).toBe('IMPLEMENT · 2 iters on stage');
  });

  it('surfaces completion attempts with the last outcome', () => {
    const p = buildInspectorProgress({
      ...base,
      runningSeq: 5,
      completionAttempts: 2,
      lastCompletionOutcome: 'verify-failed',
    });
    expect(p.completionText).toBe('Completion attempt 2 · verify-failed');
  });

  it('has no completion text before any completion attempt', () => {
    expect(buildInspectorProgress({ ...base, runningSeq: 1 }).completionText).toBeNull();
  });

  it('falls back to raw status when no pill is supplied', () => {
    const p = buildInspectorProgress({ ...base, statusPillKind: null, statusPillLabel: null });
    expect(p.status).toBe('running');
    expect(p.statusLabel).toBe('RUNNING');
  });

  it('singularises a one-iteration stage label', () => {
    const p = buildInspectorProgress({ ...base, totalIterations: 1, iterationsOnCurrentStage: 1, runningSeq: null });
    expect(p.headline).toBe('1 iteration run');
    expect(p.stageText).toBe('IMPLEMENT · 1 iter on stage');
  });
});
