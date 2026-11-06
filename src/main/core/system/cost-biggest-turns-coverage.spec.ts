import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetCostAttributionForTesting, recordCostAttribution } from './cost-attribution';
import { CostPurposeSummaryService, getCostPurposeSummary } from './cost-purpose-summary';
import { recordSessionTurnShare, type SessionTurnShareRecord } from './session-policy-log';

const now = Date.parse('2026-10-28T12:00:00Z');
const DAY = 86_400_000;
const identity = (turnId: string, threadId = 'thread') => ({ threadId, turnId });
const cost = (tokens: number, options: Record<string, unknown> = {}) => recordCostAttribution({
  source: 'instance-turn', taskType: 'chat:build', provider: 'codex', sessionKind: 'chat', instanceId: 'instance',
  usage: { inputTokens: tokens }, ...options,
});
const share = (tokens: number, options: Partial<SessionTurnShareRecord> = {}) => recordSessionTurnShare({
  event: 'turn-share', provider: 'codex', threadId: 'thread', turnId: 'represented', revision: 0,
  instanceId: 'instance', sessionKind: 'chat', rootTokens: tokens, helperTokens: 0, totalTokens: tokens,
  helperShare: 0, wrapUpDelivered: false, stopRequested: false, ...options,
});
const turns = (startTime = now - 30 * DAY) => getCostPurposeSummary().getSummary({ startTime, endTime: now }).biggestTurns!;

describe('mixed turn-share coverage through the persisted Costs summary', () => {
  let directory: string;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    directory = mkdtempSync(join(tmpdir(), 'turn-coverage-'));
    const costDir = join(directory, 'cost');
    mkdirSync(costDir);
    vi.stubEnv('AIO_COST_ATTRIBUTION_DIR', costDir);
    vi.stubEnv('AIO_SESSION_POLICY_DIR', join(directory, 'policy'));
    vi.stubEnv('AIO_COST_ATTRIBUTION', '1');
    _resetCostAttributionForTesting();
    CostPurposeSummaryService._resetForTesting();
  });
  afterEach(() => {
    CostPurposeSummaryService._resetForTesting();
    _resetCostAttributionForTesting();
    vi.unstubAllEnvs();
    vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });

  it('retains the older unrepresented turn after a newer share arrives for the same session', () => {
    vi.setSystemTime(now - DAY);
    cost(1_000);
    expect(turns().map(row => row.processedTokens)).toEqual([1_000]);
    vi.setSystemTime(now);
    share(100);
    expect(turns().map(row => row.processedTokens)).toEqual([1_000, 100]);
  });

  it('retains newer command-mode and historical rows after an older native share', () => {
    vi.setSystemTime(now - DAY);
    share(100);
    vi.setSystemTime(now);
    cost(1_000); // command mode has no native turn identity
    cost(800, { codexTurn: identity('other-native') });
    expect(turns().map(row => row.processedTokens)).toEqual([1_000, 800, 100]);
  });

  it('deduplicates only a demonstrated thread-and-turn match and leaves other sessions and turns intact', () => {
    cost(50, { codexTurn: identity('represented') });
    cost(1_000, { codexTurn: identity('unrepresented') });
    cost(900, { instanceId: 'different-session', codexTurn: identity('represented', 'other-thread') });
    cost(800, { provider: 'claude', codexTurn: identity('represented') });
    share(100);
    expect(turns().map(row => [row.processedTokens, row.source])).toEqual([
      [1_000, 'turn-cost'], [900, 'turn-cost'], [800, 'turn-cost'], [100, 'codex-round'],
    ]);
    expect(turns()[1]?.instanceId).toBe('different-session');
  });

  it('does not infer coverage from matching timestamps, token counts, session ids or incomplete legacy identities', () => {
    cost(100);
    cost(100, { codexTurn: { threadId: 'thread' } });
    cost(100, { codexTurn: { turnId: 'represented' } });
    cost(100, { codexTurn: { threadId: '', turnId: '' } });
    share(100);
    expect(turns()).toHaveLength(5);
    expect(turns().filter(row => row.source === 'turn-cost')).toHaveLength(4);
  });

  it('uses the latest correction once while keeping distinct unrepresented turns', () => {
    cost(50, { codexTurn: identity('represented') });
    cost(1_000);
    share(100);
    expect(turns().map(row => row.processedTokens)).toEqual([1_000, 100]);
    share(1_500, { revision: 1, rootTokens: 100, helperTokens: 1_400, helperShare: 1_400 / 1_500 });
    expect(turns().map(row => row.processedTokens)).toEqual([1_500, 1_000]);
    expect(turns()[0]).toMatchObject({ helperTokens: 1_400 });
  });

  it('retains a measured cost when a matching share has no usable token total', () => {
    cost(1_000, { codexTurn: identity('represented') });
    share(0);
    expect(turns().map(row => row.processedTokens)).toEqual([1_000]);
  });

  it('applies the weekly window and ten-item limit after individual-turn deduplication', () => {
    vi.setSystemTime(now - 8 * DAY);
    cost(99_000, { codexTurn: identity('old') });
    share(99_000, { turnId: 'old' });
    vi.setSystemTime(now - 7 * DAY);
    cost(500); // exact weekly boundary is included
    vi.setSystemTime(now);
    for (let index = 1; index <= 14; index++) cost(index * 100, { codexTurn: identity(`turn-${index}`) });
    share(1_400, { turnId: 'turn-14' });
    expect(turns().map(row => row.processedTokens)).toEqual([1_400, 1_300, 1_200, 1_100, 1_000, 900, 800, 700, 600, 500]);
    expect(turns().filter(row => row.source === 'codex-round')).toHaveLength(1);
    expect(turns(now + 1)).toEqual([]);
  });
});
