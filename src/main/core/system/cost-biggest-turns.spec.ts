import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BIGGEST_TURNS_LIMIT, collectBiggestTurns, kindOfCostRow, processedTokensOf, summariseCodexCredits } from './cost-biggest-turns';
import { CostPurposeSummaryService, getCostPurposeSummary } from './cost-purpose-summary';
import { _resetCostAttributionForTesting } from './cost-attribution';
import type { SessionThreadCreditsRecord, SessionTurnShareRecord } from './session-policy-log';

const M = 1_000_000;
const share = (overrides: Partial<SessionTurnShareRecord> & { at: number }): SessionTurnShareRecord & { at: number } => ({
  event: 'turn-share', provider: 'codex', threadId: 't', turnId: 'x', revision: 0, sessionKind: 'plan-queue', instanceId: 'i-share',
  rootTokens: 10, helperTokens: 0, totalTokens: 10, helperShare: 0, wrapUpDelivered: false, stopRequested: false, ...overrides,
});
const cost = (ts: number, overrides: Record<string, unknown> = {}) => ({
  ts, source: 'instance-turn' as const, taskType: 'chat:x', provider: 'claude', model: 'claude-opus-5-5', instanceId: 'i-cost', usage: { inputTokens: 5 }, ...overrides,
});

describe('processed tokens', () => {
  it('adds input, cached input, cache writes and output so a cache-heavy turn is not hidden', () => {
    expect(processedTokensOf({ inputTokens: 1, cacheReadTokens: 100, cacheWriteTokens: 10, outputTokens: 5, reasoningTokens: 2 })).toBe(118);
    expect(processedTokensOf(undefined)).toBe(0);
    expect(processedTokensOf({ inputTokens: Number.NaN, outputTokens: -4 })).toBe(0);
  });
});

describe('kind of a cost row', () => {
  it('prefers the recorded session kind and falls back to the purpose', () => {
    expect(kindOfCostRow({ taskType: 'chat:x', sessionKind: 'loop' })).toBe('loop');
    expect(kindOfCostRow({ taskType: 'child:x' })).toBe('child');
    expect(kindOfCostRow({ taskType: 'whatever', purpose: 'plan-queue' })).toBe('plan-queue');
    expect(kindOfCostRow({ taskType: 'whatever', purpose: 'cross-model-review' })).toBe('review');
    expect(kindOfCostRow({ taskType: 'something-else' })).toBe('unknown');
  });
});

describe('collectBiggestTurns', () => {
  it('ranks the largest turns first, keeps ten, and names session and kind', () => {
    const rows = Array.from({ length: 14 }, (_, index) => cost(1_000 + index, { instanceId: `i-${index}`, sessionKind: 'child', usage: { inputTokens: (index + 1) * M } }));
    const turns = collectBiggestTurns({ costRows: rows, shareRows: [share({ at: 5, totalTokens: 6.5 * M, rootTokens: 4 * M, helperTokens: 2.5 * M, helperShare: 2.5 / 6.5 })] });
    expect(turns).toHaveLength(BIGGEST_TURNS_LIMIT);
    expect(turns.map((turn) => turn.processedTokens)).toEqual([14, 13, 12, 11, 10, 9, 8, 7, 6.5, 6].map((millions) => millions * M));
    expect(turns[0]).toMatchObject({ instanceId: 'i-13', kind: 'child', provider: 'claude', model: 'claude-opus-5-5', source: 'turn-cost' });
    expect(turns[8]).toMatchObject({ instanceId: 'i-share', kind: 'plan-queue', provider: 'codex', source: 'codex-round', helperTokens: 2.5 * M, stopRequested: false });
  });

  it('lists a Codex round once, from its share row, and never from its own cost row', () => {
    const turns = collectBiggestTurns({
      shareRows: [share({ at: 10, instanceId: 'codex-a', totalTokens: 320 * M, rootTokens: 160 * M, helperTokens: 160 * M, helperShare: 0.5, stopRequested: true })],
      costRows: [
        cost(11, { provider: 'codex', instanceId: 'codex-a', codexTurn: { threadId: 't', turnId: 'x' }, usage: { inputTokens: 300 * M } }),
        cost(12, { provider: 'codex', instanceId: 'codex-b', usage: { inputTokens: 40 * M } }),
      ],
    });
    expect(turns.map((turn) => [turn.instanceId, turn.processedTokens, turn.source])).toEqual([
      ['codex-a', 320 * M, 'codex-round'], ['codex-b', 40 * M, 'turn-cost'],
    ]);
    expect(turns[0]).toMatchObject({ stopRequested: true, helperShare: 0.5 });
  });

  it('ignores rows that are not turns or that spent nothing', () => {
    expect(collectBiggestTurns({
      shareRows: [share({ at: 1, totalTokens: 0 })],
      costRows: [cost(2, { source: 'auxiliary', usage: { inputTokens: 5 * M } }), cost(3, { usage: {} })],
    })).toEqual([]);
  });
});

describe('summariseCodexCredits', () => {
  const credits = (threadId: string, micros: number, usd: number | null, kind: SessionThreadCreditsRecord['sessionKind']): SessionThreadCreditsRecord & { at: number } =>
    ({ event: 'thread-credits', provider: 'codex', threadId, sessionKind: kind, estimatedUsageCreditsMicros: micros, estimatedUsageUsdMicros: usd, totalTokens: null, groups: [], at: 1 });

  it('totals credits and dollars where Codex gave them, and splits by kind', () => {
    const summary = summariseCodexCredits([
      credits('a', 4_000_000, 1_000_000, 'plan-queue'), credits('b', 2_500_000, null, 'chat'), credits('c', 1_500_000, 500_000, 'plan-queue'),
    ]);
    expect(summary).toEqual({
      threads: 3, credits: 8, estimatedUsd: 1.5,
      byKind: [{ kind: 'plan-queue', threads: 2, credits: 5.5 }, { kind: 'chat', threads: 1, credits: 2.5 }],
    });
  });

  it('reports no dollar figure when Codex gave none', () => {
    expect(summariseCodexCredits([credits('a', 1_000_000, null, 'chat')]).estimatedUsd).toBeNull();
    expect(summariseCodexCredits([])).toEqual({ threads: 0, credits: 0, estimatedUsd: null, byKind: [] });
  });
});

describe('Costs summary reads the cost log and the session-policy log together', () => {
  let costDir: string;
  let policyDir: string;
  const now = Date.parse('2026-10-20T12:00:00Z');
  const day = (offsetDays: number) => new Date(now - offsetDays * 86_400_000).toISOString().slice(0, 10);

  beforeEach(() => {
    costDir = fs.mkdtempSync(join(tmpdir(), 'biggest-cost-'));
    policyDir = fs.mkdtempSync(join(tmpdir(), 'biggest-policy-'));
    vi.stubEnv('AIO_COST_ATTRIBUTION_DIR', costDir);
    vi.stubEnv('AIO_COST_ATTRIBUTION', '1');
    vi.stubEnv('AIO_SESSION_POLICY_DIR', policyDir);
    _resetCostAttributionForTesting();
    CostPurposeSummaryService._resetForTesting();
  });
  afterEach(() => {
    CostPurposeSummaryService._resetForTesting();
    _resetCostAttributionForTesting();
    vi.unstubAllEnvs();
    fs.rmSync(costDir, { recursive: true, force: true });
    fs.rmSync(policyDir, { recursive: true, force: true });
  });

  const writeJsonl = (dir: string, name: string, rows: object[]) =>
    fs.writeFileSync(join(dir, name), rows.map((row) => JSON.stringify(row)).join('\n') + '\npartial');

  it('lists this week\'s biggest turns with the latest receipt per round, and Codex credits per thread', () => {
    writeJsonl(costDir, `cost-attribution-${day(0)}.jsonl`, [
      { ts: now - 1000, source: 'instance-turn', taskType: 'chat:a', provider: 'claude', model: 'claude-opus-5-5', instanceId: 'claude-1', sessionKind: 'chat', usage: { inputTokens: 2 * M, cacheReadTokens: 30 * M, outputTokens: M } },
      { ts: now - 900, source: 'instance-turn', taskType: 'child:b', provider: 'codex', instanceId: 'codex-1', codexTurn: { threadId: 'thread-1', turnId: 'turn-1' }, sessionKind: 'plan-queue', usage: { inputTokens: 5 * M } },
    ]);
    writeJsonl(costDir, `cost-attribution-${day(10)}.jsonl`, [
      { ts: now - 10 * 86_400_000, source: 'instance-turn', taskType: 'chat:old', provider: 'claude', instanceId: 'old', usage: { inputTokens: 900 * M } },
    ]);
    const at = now - 500;
    const roundRow = { event: 'turn-share', provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', sessionKind: 'plan-queue', instanceId: 'codex-1', wrapUpDelivered: true, stopRequested: true };
    writeJsonl(policyDir, `${day(0)}.jsonl`, [
      { at, ...roundRow, revision: 0, rootTokens: 200 * M, helperTokens: 0, totalTokens: 200 * M, helperShare: 0 },
      { at: at + 5, ...roundRow, revision: 1, rootTokens: 200 * M, helperTokens: 110 * M, totalTokens: 310 * M, helperShare: 110 / 310 },
      { at: at + 6, event: 'thread-credits', provider: 'codex', threadId: 'thread-1', sessionKind: 'plan-queue', estimatedUsageCreditsMicros: 3_000_000, estimatedUsageUsdMicros: null, totalTokens: null, groups: [] },
      { at: at + 7, event: 'thread-credits', provider: 'codex', threadId: 'thread-1', sessionKind: 'plan-queue', estimatedUsageCreditsMicros: 9_000_000, estimatedUsageUsdMicros: 2_000_000, totalTokens: null, groups: [] },
      { at: at + 8, provider: 'codex', threadId: 'thread-1', sessionKind: 'plan-queue', level: 'off', applied: true },
    ]);

    const summary = getCostPurposeSummary().getSummary({ startTime: now - 30 * 86_400_000, endTime: now });

    expect(summary.biggestTurns).toEqual([
      expect.objectContaining({ instanceId: 'codex-1', provider: 'codex', source: 'codex-round', kind: 'plan-queue', processedTokens: 310 * M, helperTokens: 110 * M, stopRequested: true }),
      expect.objectContaining({ instanceId: 'claude-1', provider: 'claude', source: 'turn-cost', kind: 'chat', processedTokens: 33 * M }),
    ]);
    expect(summary.codexCredits).toEqual({ threads: 1, credits: 9, estimatedUsd: 2, byKind: [{ kind: 'plan-queue', threads: 1, credits: 9 }] });
  });

  it('is empty, not broken, when nothing was recorded', () => {
    const summary = getCostPurposeSummary().getSummary({ startTime: now - 86_400_000, endTime: now });
    expect(summary.biggestTurns ?? []).toEqual([]);
    expect(summary.codexCredits ?? { threads: 0 }).toMatchObject({ threads: 0 });
  });
});
