import { describe, expect, it } from 'vitest';
import { computeTokenCost } from '../data/model-pricing';
import { CLAUDE_MODELS } from '../types/provider.types';
import {
  EFFORT_MATCH_MAX_GAP_MS,
  calculateUsageCauses,
  effortAt,
  hasExactPrice,
  priceWeight,
  type UsageCalculatorInput,
} from './usage-cause-calculator';
import {
  USAGE_CAUSE_IDS,
  type UsageCauseId,
  type UsageInsightReport,
  type UsageRequestFact,
  type UsageSessionFact,
} from './usage-insight.types';

const NOW = Date.parse('2026-10-20T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Everything below happens a couple of days ago, safely inside the 7-day window. */
const BASE = NOW - 2 * DAY;

function request(overrides: Partial<UsageRequestFact> = {}): UsageRequestFact {
  return {
    sessionId: 's1',
    at: BASE,
    model: 'claude-opus-5',
    input: 1_000,
    cacheWrite: 0,
    cacheRead: 0,
    output: 100,
    helper: false,
    bigResult: false,
    ...overrides,
  };
}

function session(sessionId: string, overrides: Partial<UsageSessionFact> = {}): UsageSessionFact {
  return { sessionId, groupKey: sessionId, isHelperSession: false, efforts: [], ...overrides };
}

/** Every request weighs 1, so shares equal request counts. */
const COUNT = (): number => 1;

function run(
  requests: UsageRequestFact[],
  sessions: UsageSessionFact[] = [],
  extra: Partial<UsageCalculatorInput> = {},
): UsageInsightReport {
  return calculateUsageCauses({
    requests,
    sessions: new Map(sessions.map((entry) => [entry.sessionId, entry] as const)),
    now: NOW,
    scope: { kind: 'all' },
    weigh: COUNT,
    ...extra,
  });
}

function cause(report: UsageInsightReport, id: UsageCauseId) {
  const found = report.causes.find((entry) => entry.id === id);
  if (!found) throw new Error(`missing cause ${id}`);
  return found;
}

describe('calculateUsageCauses', () => {
  describe('window and totals', () => {
    it('returns all nine causes in the plan order', () => {
      const report = run([request()]);
      expect(report.causes.map((entry) => entry.id)).toEqual([...USAGE_CAUSE_IDS]);
      expect(USAGE_CAUSE_IDS).toEqual([
        'cacheMiss', 'longContext', 'helperHeavy', 'parallelSessions', 'longRunning',
        'maxEffort', 'workflows', 'alwaysOnContext', 'bigToolResults',
      ]);
    });

    it('ignores requests older than 7 days and counts those just inside', () => {
      const report = run([
        request({ at: NOW - 7 * DAY - MINUTE, input: 200_000 }),
        request({ at: NOW - 7 * DAY + MINUTE, input: 200_000 }),
        request({ at: BASE }),
      ]);
      expect(report.totals.requests).toBe(2);
      expect(report.windowStart).toBe(NOW - 7 * DAY);
      expect(cause(report, 'cacheMiss').requests).toBe(1);
    });

    it('reports no Claude usage instead of dividing by zero', () => {
      const report = run([]);
      expect(report.totals.requests).toBe(0);
      expect(cause(report, 'cacheMiss')).toMatchObject({ share: 0, percent: 0, shown: false });
      expect(report.notes).toContainEqual({ code: 'no-claude-usage' });
    });

    it('skips requests that carry no usage at all', () => {
      const report = run([request({ input: 0, output: 0 }), request()], [], { weigh: priceWeight });
      expect(report.totals.requests).toBe(1);
    });

    it('passes through the evidence notes from reading the files', () => {
      const report = run([request()], [], { notes: [{ code: 'files-skipped-large', count: 2 }] });
      expect(report.notes).toContainEqual({ code: 'files-skipped-large', count: 2 });
    });
  });

  describe('weighting', () => {
    it('weighs each request by its API-price equivalent, not by count', () => {
      const big = request({ at: BASE, cacheRead: 400_000, input: 10, output: 10 });
      const small = request({ at: BASE + HOUR, input: 100, output: 10 });
      const report = run([big, small], [], { weigh: priceWeight });
      const bigCost = computeTokenCost(big.model, { inputTokens: 10, outputTokens: 10, cacheReadTokens: 400_000 });
      const smallCost = computeTokenCost(small.model, { inputTokens: 100, outputTokens: 10 });
      expect(cause(report, 'longContext').share).toBeCloseTo(bigCost / (bigCost + smallCost), 10);
      // By count it would be 50%; by price the one huge read is nearly all of it.
      expect(cause(report, 'longContext').percent).toBeGreaterThan(50);
    });
  });

  describe('cache misses over 100K', () => {
    it('counts fresh-read tokens (input plus cache writes) strictly over 100K', () => {
      const report = run([
        request({ at: BASE, input: 50_000, cacheWrite: 50_000 }),
        request({ at: BASE + HOUR, input: 50_000, cacheWrite: 50_001 }),
        request({ at: BASE + 2 * HOUR, input: 10, cacheWrite: 0, cacheRead: 900_000 }),
      ]);
      expect(cause(report, 'cacheMiss').requests).toBe(1);
      expect(cause(report, 'cacheMiss').share).toBeCloseTo(1 / 3, 10);
    });
  });

  describe('context over 150K', () => {
    it('counts the whole prompt (fresh plus cached) strictly over 150K', () => {
      const report = run([
        request({ at: BASE, input: 10, cacheRead: 149_990 }),
        request({ at: BASE + HOUR, input: 10, cacheRead: 150_000 }),
        request({ at: BASE + 2 * HOUR, input: 60_000, cacheWrite: 40_000, cacheRead: 50_001 }),
      ]);
      expect(cause(report, 'longContext').requests).toBe(2);
    });
  });

  describe('4 or more sessions in parallel', () => {
    const together = (id: string, offsetMs = 0) => request({ sessionId: id, at: BASE + offsetMs });

    it('flags requests made in a five-minute stretch with four sessions working', () => {
      const report = run([
        together('a'), together('b'), together('c'), together('d'),
        request({ sessionId: 'e', at: BASE + 3 * HOUR }),
      ]);
      expect(cause(report, 'parallelSessions').requests).toBe(4);
      expect(cause(report, 'parallelSessions').share).toBeCloseTo(0.8, 10);
    });

    it('does not flag three sessions', () => {
      const report = run([together('a'), together('b'), together('c')]);
      expect(cause(report, 'parallelSessions').requests).toBe(0);
    });

    it('counts a session once however many requests it makes in the stretch', () => {
      const report = run([together('a'), together('a', 1_000), together('a', 2_000), together('b'), together('c')]);
      expect(cause(report, 'parallelSessions').requests).toBe(0);
    });

    it('does not join sessions that fall in different five-minute stretches', () => {
      const report = run([together('a'), together('b', 6 * MINUTE), together('c', 12 * MINUTE), together('d', 18 * MINUTE)]);
      expect(cause(report, 'parallelSessions').requests).toBe(0);
    });

    it('counts a helper agent as part of its own session, not as an extra session', () => {
      const report = run([
        together('a'), request({ sessionId: 'a', at: BASE + 1_000, helper: true }),
        together('b'), together('c'),
      ]);
      expect(cause(report, 'parallelSessions').requests).toBe(0);
    });
  });

  describe('sessions active 8 hours or more', () => {
    const steady = (id: string, everyMinutes: number, hours: number): UsageRequestFact[] => {
      const out: UsageRequestFact[] = [];
      for (let minute = 0; minute <= hours * 60; minute += everyMinutes) out.push(request({ sessionId: id, at: BASE + minute * MINUTE }));
      return out;
    };

    it('flags a session that kept working for more than eight hours', () => {
      const long = steady('long', 20, 8.5);
      const short = steady('short', 20, 6);
      const report = run([...long, ...short]);
      expect(cause(report, 'longRunning').requests).toBe(long.length);
      expect(cause(report, 'longRunning').sessions).toBe(1);
      // 25 gaps of 20 minutes of work.
      expect(cause(report, 'longRunning').typicalHours).toBe(8.3);
    });

    it('counts long idle gaps as only half an hour of work', () => {
      const report = run([request({ sessionId: 'idle', at: BASE }), request({ sessionId: 'idle', at: BASE + 10 * HOUR })]);
      expect(cause(report, 'longRunning').requests).toBe(0);
    });

    it('counts exactly eight hours of work as long running', () => {
      const exact = steady('exact', 30, 8);
      const report = run(exact);
      expect(cause(report, 'longRunning').requests).toBe(exact.length);
    });
  });

  describe('helper-heavy sessions', () => {
    it('flags a session where helper agents did at least half of the work', () => {
      const report = run([
        request({ sessionId: 'heavy' }),
        request({ sessionId: 'heavy', helper: true, at: BASE + 1 }),
        request({ sessionId: 'heavy', helper: true, at: BASE + 2 }),
        request({ sessionId: 'light' }),
        request({ sessionId: 'light', at: BASE + 1 }),
        request({ sessionId: 'light', helper: true, at: BASE + 2 }),
      ]);
      expect(cause(report, 'helperHeavy').requests).toBe(3);
      expect(cause(report, 'helperHeavy').sessions).toBe(1);
    });

    it('treats exactly half as helper-heavy', () => {
      const report = run([request({ sessionId: 'half' }), request({ sessionId: 'half', helper: true, at: BASE + 1 })]);
      expect(cause(report, 'helperHeavy').requests).toBe(2);
    });

    it('counts sessions Harness started as helpers towards their parent session', () => {
      const report = run(
        [
          request({ sessionId: 'parent' }),
          request({ sessionId: 'child-1', at: BASE + 1 }),
          request({ sessionId: 'child-2', at: BASE + 2 }),
          request({ sessionId: 'solo' }),
        ],
        [
          session('parent', { groupKey: 'harness:root', instanceId: 'root' }),
          session('child-1', { groupKey: 'harness:root', instanceId: 'c1', isHelperSession: true }),
          session('child-2', { groupKey: 'harness:root', instanceId: 'c2', isHelperSession: true }),
        ],
      );
      // Two of the three requests in the parent's group came from helpers: all three are flagged.
      expect(cause(report, 'helperHeavy').requests).toBe(3);
      expect(cause(report, 'helperHeavy').sessions).toBe(3);
    });

    it('weighs by price so one big helper turn outweighs many small main turns', () => {
      const report = run(
        [
          request({ sessionId: 'mix', input: 100, output: 10 }),
          request({ sessionId: 'mix', at: BASE + 1, input: 100, output: 10 }),
          request({ sessionId: 'mix', at: BASE + 2, helper: true, cacheRead: 500_000 }),
        ],
        [],
        { weigh: priceWeight },
      );
      expect(cause(report, 'helperHeavy').requests).toBe(3);
    });
  });

  describe('always-on context over 40K', () => {
    it('flags sessions whose first request already carried more than 40K tokens', () => {
      const report = run(
        [
          request({ sessionId: 'heavy' }), request({ sessionId: 'heavy', at: BASE + 1 }),
          request({ sessionId: 'lean' }),
          request({ sessionId: 'edge' }),
          request({ sessionId: 'unknown' }),
        ],
        [
          session('heavy', { startPromptTokens: 52_000 }),
          session('lean', { startPromptTokens: 18_000 }),
          session('edge', { startPromptTokens: 40_000 }),
        ],
      );
      expect(cause(report, 'alwaysOnContext').requests).toBe(2);
      expect(cause(report, 'alwaysOnContext').typicalTokens).toBe(52_000);
    });

    it('reports the typical start size as the middle one', () => {
      const report = run(
        [request({ sessionId: 'a' }), request({ sessionId: 'b' }), request({ sessionId: 'c' })],
        [session('a', { startPromptTokens: 45_000 }), session('b', { startPromptTokens: 60_000 }), session('c', { startPromptTokens: 90_000 })],
      );
      expect(cause(report, 'alwaysOnContext').typicalTokens).toBe(60_000);
    });
  });

  describe('tool results over 10K', () => {
    it('counts requests that were made while a big tool result was in the chat', () => {
      const report = run([request({ bigResult: true }), request({ at: BASE + 1 }), request({ at: BASE + 2, bigResult: true })]);
      expect(cause(report, 'bigToolResults').requests).toBe(2);
      expect(cause(report, 'bigToolResults').share).toBeCloseTo(2 / 3, 10);
    });
  });

  describe('max effort and workflows', () => {
    const efforts = (effort: string, at = BASE + HOUR) => [{ at, effort }];

    it('measures usage at max effort and in workflow mode separately', () => {
      const report = run(
        [
          request({ sessionId: 'max' }), request({ sessionId: 'max', at: BASE + 1 }),
          request({ sessionId: 'flow' }),
          request({ sessionId: 'normal' }), request({ sessionId: 'normal', at: BASE + 1 }), request({ sessionId: 'normal', at: BASE + 2 }),
        ],
        [
          session('max', { efforts: efforts('max') }),
          session('flow', { efforts: efforts('workflow') }),
          session('normal', { efforts: efforts('high') }),
        ],
      );
      expect(cause(report, 'maxEffort').requests).toBe(2);
      expect(cause(report, 'maxEffort').atLeast).toBeUndefined();
      expect(cause(report, 'maxEffort').share).toBeCloseTo(2 / 6, 10);
      expect(cause(report, 'workflows').share).toBeCloseTo(1 / 6, 10);
      expect(report.coverage.effortKnown).toBe(1);
    });

    it('says "at least" when effort is only known for part of the usage', () => {
      const report = run(
        [request({ sessionId: 'known' }), request({ sessionId: 'known', at: BASE + 1 }), request({ sessionId: 'external' }), request({ sessionId: 'external2' })],
        [session('known', { efforts: efforts('max') })],
      );
      expect(cause(report, 'maxEffort').atLeast).toBe(true);
      expect(cause(report, 'maxEffort').share).toBeCloseTo(0.5, 10);
      expect(report.coverage.effortKnown).toBeCloseTo(0.5, 10);
      expect(report.notes).toContainEqual({ code: 'effort-partly-recorded', knownPercent: 50 });
    });

    it('does not guess when the effort was never recorded', () => {
      const report = run([request({ sessionId: 'external' })]);
      expect(cause(report, 'maxEffort')).toMatchObject({ share: null, percent: null, shown: false, unavailable: 'effort-not-recorded' });
      expect(cause(report, 'workflows')).toMatchObject({ share: null, unavailable: 'effort-not-recorded' });
      expect(report.coverage.effortKnown).toBe(0);
    });

    it('applies the 10% rule to the lower bound', () => {
      // One request is known to be max effort; nine more have no recorded setting.
      const requests = [request({ sessionId: 'max' }), ...Array.from({ length: 9 }, (_, index) => request({ sessionId: 'x', at: BASE + index + 1 }))];
      const report = run(requests, [session('max', { efforts: efforts('max') })]);
      expect(cause(report, 'maxEffort')).toMatchObject({ percent: 10, shown: true, atLeast: true });
    });

    it('hides the cause when even the lower bound is under 10%', () => {
      const requests = [request({ sessionId: 'max' }), ...Array.from({ length: 10 }, (_, index) => request({ sessionId: 'x', at: BASE + index + 1 }))];
      const report = run(requests, [session('max', { efforts: efforts('max') })]);
      expect(cause(report, 'maxEffort')).toMatchObject({ percent: 9, shown: false, atLeast: true });
    });

    it('hides a lower bound of 9.5% even though it rounds to 10%', () => {
      const known = Array.from({ length: 19 }, (_, index) => request({ sessionId: 'max', at: BASE + index }));
      const unknown = Array.from({ length: 181 }, (_, index) => request({ sessionId: 'x', at: BASE + 1_000 + index }));
      const report = run([...known, ...unknown], [session('max', { efforts: efforts('max') })]);
      expect(cause(report, 'maxEffort')).toMatchObject({ percent: 10, shown: false, atLeast: true });
    });
  });

  describe('the 10% rule', () => {
    it('shows a cause at 10% and hides it at 9%', () => {
      const at10 = run([...Array.from({ length: 9 }, (_, index) => request({ at: BASE + index })), request({ at: BASE + 99, bigResult: true })]);
      expect(cause(at10, 'bigToolResults')).toMatchObject({ percent: 10, shown: true });
      const at9 = run([...Array.from({ length: 10 }, (_, index) => request({ at: BASE + index })), request({ at: BASE + 99, bigResult: true })]);
      expect(cause(at9, 'bigToolResults')).toMatchObject({ percent: 9, shown: false });
    });

    // `percent` is only the label. The decision is made on the exact share, so a cause
    // that is 9.5% of the usage must stay hidden even though its label would read 10%.
    const bigResults = (big: number, total: number) => [
      ...Array.from({ length: total - big }, (_, index) => request({ at: BASE + index })),
      ...Array.from({ length: big }, (_, index) => request({ at: BASE + total + index, bigResult: true })),
    ];

    it('hides a cause at 9.5% even though it rounds to 10%', () => {
      const report = run(bigResults(19, 200));
      expect(cause(report, 'bigToolResults').share).toBeCloseTo(0.095, 10);
      expect(cause(report, 'bigToolResults')).toMatchObject({ percent: 10, shown: false });
    });

    it('hides a cause at 9.95% and shows one at exactly 10%', () => {
      const justUnder = run(bigResults(199, 2_000));
      expect(cause(justUnder, 'bigToolResults')).toMatchObject({ percent: 10, shown: false });
      const exactly = run(bigResults(20, 200));
      expect(cause(exactly, 'bigToolResults')).toMatchObject({ percent: 10, shown: true });
    });

    it('uses the stored weighted share strictly, without a tolerance below 10%', () => {
      // 0.3 of 3.0 total: 0.3 / 3 is 0.09999999999999999 in floating point.
      const weights = new Map<number, number>([[0, 0.3], [1, 1.2], [2, 1.5]]);
      const report = run(
        [request({ at: BASE, bigResult: true }), request({ at: BASE + 1 }), request({ at: BASE + 2 })],
        [],
        { weigh: (fact) => weights.get(fact.at - BASE) ?? 0 },
      );
      expect(0.3 / 3).toBeLessThan(0.1);
      expect(cause(report, 'bigToolResults').share).toBeLessThan(0.1);
      expect(cause(report, 'bigToolResults')).toMatchObject({ percent: 10, shown: false });
    });

    it('lets one request count towards several causes, so shares can add up to more than 100%', () => {
      const report = run([request({ input: 10, cacheWrite: 120_000, cacheRead: 100_000, bigResult: true })]);
      const total = report.causes.reduce((sum, entry) => sum + (entry.share ?? 0), 0);
      expect(cause(report, 'cacheMiss').percent).toBe(100);
      expect(cause(report, 'longContext').percent).toBe(100);
      expect(cause(report, 'bigToolResults').percent).toBe(100);
      expect(total).toBeGreaterThan(2);
    });
  });

  describe('scoping to one session', () => {
    it('divides by the session\'s own usage but still sees who else was working at the time', () => {
      const requests = [
        request({ sessionId: 'mine', at: BASE }),
        request({ sessionId: 'mine', at: BASE + 2 * HOUR, bigResult: true }),
        request({ sessionId: 'o1', at: BASE }), request({ sessionId: 'o2', at: BASE }), request({ sessionId: 'o3', at: BASE }),
        request({ sessionId: 'elsewhere', at: BASE + 5 * HOUR, bigResult: true }),
      ];
      const report = run(requests, [], {
        scope: { kind: 'session', instanceId: 'inst-1' },
        scopeSessionIds: new Set(['mine']),
      });
      expect(report.totals.requests).toBe(2);
      expect(cause(report, 'bigToolResults').share).toBeCloseTo(0.5, 10);
      // The first request had three other sessions working beside it.
      expect(cause(report, 'parallelSessions').share).toBeCloseTo(0.5, 10);
      expect(report.scope).toEqual({ kind: 'session', instanceId: 'inst-1' });
    });

    it('returns an empty report for a session with no requests in the window', () => {
      const report = run([request({ sessionId: 'other' })], [], {
        scope: { kind: 'session', instanceId: 'inst-1' },
        scopeSessionIds: new Set(['mine']),
      });
      expect(report.totals.requests).toBe(0);
      expect(report.notes).toContainEqual({ code: 'no-claude-usage' });
    });
  });

  describe('Harness link coverage', () => {
    it('reports how much of the usage came from sessions Harness started', () => {
      const report = run(
        [request({ sessionId: 'linked' }), request({ sessionId: 'linked', at: BASE + 1 }), request({ sessionId: 'external' })],
        [session('linked', { instanceId: 'inst-1' })],
      );
      expect(report.totals).toEqual({ requests: 3, sessions: 2, harnessSessions: 1 });
      expect(report.coverage.harnessLinked).toBeCloseTo(2 / 3, 10);
    });
  });
});

describe('priceWeight', () => {
  const usage = { input: 10_000, cacheRead: 200_000, cacheWrite: 5_000, output: 2_000 };
  const weight = (model: string) => priceWeight(request({ model, ...usage }));
  const expected = (model: string) =>
    computeTokenCost(model, { inputTokens: usage.input, outputTokens: usage.output, cacheReadTokens: usage.cacheRead, cacheWriteTokens: usage.cacheWrite });

  it('uses the price table entry for a model it knows', () => {
    expect(weight('claude-opus-5')).toBe(expected('claude-opus-5'));
    expect(weight('claude-haiku-4-5-20251001')).toBe(expected('claude-haiku-4-5-20251001'));
  });

  it('ignores a date suffix or a context-size tag when that leaves a model it knows', () => {
    expect(weight('claude-opus-5-20261015')).toBe(expected('claude-opus-5'));
    expect(weight('claude-opus-5[1m]')).toBe(expected('claude-opus-5'));
  });

  it('prices a model it has never seen as the nearest current model in its family, not at a flat default', () => {
    expect(weight('claude-opus-9-20301212')).toBe(expected(CLAUDE_MODELS.OPUS));
    expect(weight('claude-sonnet-9-20301212')).toBe(expected(CLAUDE_MODELS.SONNET));
    expect(weight('claude-haiku-9-20301212')).toBe(expected(CLAUDE_MODELS.HAIKU));
    // The families keep their relative weight, so a helper on a small model is not counted like the lead.
    expect(weight('claude-haiku-9-20301212')).toBeLessThan(weight('claude-sonnet-9-20301212'));
    expect(weight('claude-sonnet-9-20301212')).toBeLessThan(weight('claude-opus-9-20301212'));
  });

  it('falls back to the default rate for a model that is not a Claude family at all', () => {
    expect(weight('mystery-model')).toBe(expected('mystery-model'));
  });

  it('knows which models it has an exact price for', () => {
    expect(hasExactPrice('claude-opus-5')).toBe(true);
    expect(hasExactPrice('claude-opus-5-20261015')).toBe(true);
    expect(hasExactPrice('claude-opus-9-20301212')).toBe(false);
    expect(hasExactPrice('mystery-model')).toBe(false);
  });
});

describe('approximate prices are disclosed', () => {
  it('counts the requests that were priced by family and says so', () => {
    const report = calculateUsageCauses({
      requests: [request({ model: 'claude-opus-5' }), request({ model: 'claude-opus-9-20301212', at: BASE + 1 }), request({ model: 'mystery', at: BASE + 2 })],
      sessions: new Map(),
      now: NOW,
      scope: { kind: 'all' },
    });
    expect(report.notes).toContainEqual({ code: 'prices-approximate', count: 2 });
  });

  it('says nothing when every model has an exact price', () => {
    const report = calculateUsageCauses({
      requests: [request({ model: 'claude-opus-5' }), request({ model: 'claude-haiku-4-5-20251001', at: BASE + 1 })],
      sessions: new Map(), now: NOW, scope: { kind: 'all' },
    });
    expect(report.notes.some((note) => note.code === 'prices-approximate')).toBe(false);
  });

  it('only counts the requests in the scope being reported', () => {
    const report = calculateUsageCauses({
      requests: [request({ sessionId: 'mine', model: 'claude-opus-5' }), request({ sessionId: 'other', model: 'claude-opus-9-20301212', at: BASE + 1 })],
      sessions: new Map(), now: NOW, scope: { kind: 'session', instanceId: 'a' }, scopeSessionIds: new Set(['mine']),
    });
    expect(report.notes.some((note) => note.code === 'prices-approximate')).toBe(false);
  });
});

describe('effortAt', () => {
  const at = (minutes: number, effort: string) => ({ at: BASE + minutes * MINUTE, effort });

  it('uses the record written when the turn finished', () => {
    expect(effortAt([at(10, 'max')], BASE + 2 * MINUTE)).toBe('max');
  });

  it('keeps the effort across a long gap when both neighbours agree', () => {
    expect(effortAt([at(0, 'high'), at(24 * 60, 'high')], BASE + 12 * HOUR)).toBe('high');
  });

  it('prefers the record just after when the setting changed in between', () => {
    expect(effortAt([at(0, 'high'), at(60, 'max')], BASE + 30 * MINUTE)).toBe('max');
  });

  it('falls back to the record just before when nothing follows soon', () => {
    expect(effortAt([at(0, 'workflow')], BASE + 2 * HOUR)).toBe('workflow');
  });

  it('reports unknown when no record is close enough', () => {
    const far = EFFORT_MATCH_MAX_GAP_MS + MINUTE;
    expect(effortAt([at(0, 'max')], BASE + far)).toBeUndefined();
    expect(effortAt([at(0, 'high'), at(((far * 3) / MINUTE), 'max')], BASE + far)).toBeUndefined();
    expect(effortAt([], BASE)).toBeUndefined();
  });
});
