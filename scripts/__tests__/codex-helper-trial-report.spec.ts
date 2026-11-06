import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aggregateKind,
  aggregatePlanQueue,
  buildComparisons,
  computeVerdict,
  helperCountsFromLog,
  indexTurnContainment,
  parseArgs,
  parsePolicyLog,
  parseRolloutSync,
  readCostAttribution,
  readThreadGraph,
  UNREADABLE_COST_RECORDS,
  VERDICT_RULES,
} from '../codex-helper-trial-report.mjs';
import {
  costRow, helperCountRecord, writeCostDir, writeLoopDb,
  type QueueItemRow,
} from './codex-helper-trial-fixtures';

const repoRoot = process.cwd();
const scriptPath = join(repoRoot, 'scripts/codex-helper-trial-report.mjs');
const tempDirs: string[] = [];

const trialTurn = (start: number, end: number, input: number) => ({
  start, end, input, cached: 0, output: 0, requests: 1, helperInput: 0, helperThreads: 0,
});
const trialRollout = (...turns: ReturnType<typeof trialTurn>[]) => ({ turns, compactions: [] });

function hasSqlite3(): boolean {
  return spawnSync('sqlite3', ['--version'], { encoding: 'utf8' }).status === 0;
}

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

// ── Verdict rules at their edges (Step 1d item 4) ───────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
/** Both comparisons on one clock, for verdict rules that do not need them apart. */
const bothDays = (days: number) => ({ chats: days, harnessWork: days });

function baseCounts() {
  return {
    daysElapsed: bothDays(21),
    chatThreads: { cheaper: VERDICT_RULES.minChatThreadsPerGroup, full: VERDICT_RULES.minChatThreadsPerGroup },
    decidedItems: { off: VERDICT_RULES.minDecidedItemsPerGroup, full: VERDICT_RULES.minDecidedItemsPerGroup },
    measuredLandedItems: { off: 20, full: 20 },
  };
}

function verdictFor(overrides: {
  offInput?: number;
  fullInput?: number;
  offLandedShare?: number;
  fullLandedShare?: number;
  offWallMs?: number;
  fullWallMs?: number;
  cheaperInput?: number;
  chatFullInput?: number;
  cheaperWallMs?: number;
  chatFullWallMs?: number;
}) {
  return computeVerdict({
    chats: {
      cheaper: {
        meanInputPerTurn: overrides.cheaperInput ?? 85,
        medianWallClockMs: overrides.cheaperWallMs ?? 1000,
      },
      full: {
        meanInputPerTurn: overrides.chatFullInput ?? 100,
        medianWallClockMs: overrides.chatFullWallMs ?? 1000,
      },
    },
    planQueue: {
      off: {
        meanInputPerLandedItem: overrides.offInput ?? 75,
        landedShare: overrides.offLandedShare ?? 0.5,
        medianWallClockMsPerItem: overrides.offWallMs ?? 1000,
      },
      full: {
        meanInputPerLandedItem: overrides.fullInput ?? 100,
        landedShare: overrides.fullLandedShare ?? 0.5,
        medianWallClockMsPerItem: overrides.fullWallMs ?? 1000,
      },
    },
    kinds: {},
    counts: baseCounts(),
  });
}

describe('verdict rules at their edges', () => {
  it('25% fewer input tokens per landed item is enough; 24% is not', () => {
    expect(verdictFor({ offInput: 75, fullInput: 100 }).harnessWork).toBe('off-justified');
    expect(verdictFor({ offInput: 76, fullInput: 100 }).harnessWork).toBe('full-keeps-plan-queue');
  });

  it('a landed share 10 points down passes; 11 points does not', () => {
    expect(verdictFor({ offLandedShare: 0.4, fullLandedShare: 0.5 }).harnessWork).toBe('off-justified');
    const eleven = verdictFor({ offLandedShare: 0.39, fullLandedShare: 0.5 });
    expect(eleven.harnessWork).toBe('split');
    expect(eleven.notes.join(' ')).toContain('keep Full for the plan queue');
  });

  it('judges a landed share exactly 10 points down as passing, whatever the floating-point noise', () => {
    // 16 of 20 against 14 of 20, 8 of 20 against 6 of 20, and 9 of 20 against 7 of 20:
    // each is exactly 10 points, but (a - b) * 100 comes out just above 10.
    for (const [offLandedShare, fullLandedShare] of [[0.7, 0.8], [0.3, 0.4], [0.35, 0.45]]) {
      expect((fullLandedShare - offLandedShare) * 100).toBeGreaterThan(10);
      expect(verdictFor({ offLandedShare, fullLandedShare }).harnessWork).toBe('off-justified');
    }
  });

  it('a wall-clock ratio above 1.5 blocks the Off verdict', () => {
    expect(verdictFor({ offWallMs: 1500, fullWallMs: 1000 }).harnessWork).toBe('off-justified');
    expect(verdictFor({ offWallMs: 1501, fullWallMs: 1000 }).harnessWork).toBe('full-keeps-plan-queue');
  });

  it('chats: 15% fewer tokens and no more wall clock justifies Cheaper; 14% does not', () => {
    expect(verdictFor({ cheaperInput: 85, chatFullInput: 100 }).chats).toBe('cheaper-justified');
    expect(verdictFor({ cheaperInput: 86, chatFullInput: 100 }).chats).toBe('full-stays');
    expect(verdictFor({ cheaperInput: 85, cheaperWallMs: 1251, chatFullWallMs: 1000 }).chats).toBe('full-stays');
    expect(verdictFor({ cheaperInput: 85, cheaperWallMs: 1250, chatFullWallMs: 1000 }).chats).toBe('cheaper-justified');
  });

  it('no verdict before the sample is complete; Decision 3 defaults after 35 short days', () => {
    const early = computeVerdict({
      chats: {}, planQueue: {}, kinds: {},
      counts: { ...baseCounts(), daysElapsed: bothDays(20) },
    });
    expect(early.harnessWork).toBe('pending');
    expect(early.notes.join(' ')).toContain('No verdict yet');

    const late = computeVerdict({
      chats: {}, planQueue: {}, kinds: {},
      counts: {
        daysElapsed: bothDays(35),
        chatThreads: { cheaper: 10, full: 10 },
        decidedItems: { off: 5, full: 5 },
        measuredLandedItems: { off: 5, full: 5 },
      },
    });
    expect(late.harnessWork).toBe('apply-defaults');
    expect(late.notes.join(' ')).toContain('Decision 3 defaults');
  });

  it('applies the choice-2 kind outcome rule at the 35-day fallback too', () => {
    // The kind rule ("more than 10 points worse goes back to the chats
    // setting") must survive an incomplete plan-queue sample: the fallback
    // recommends Off for the other kinds only while their outcomes hold.
    const kinds = {
      automation: {
        off: { threads: 10, runs: { succeeded: 8, failed: 2, decided: 10, unknown: 0, settledAfterWindow: 0 } },
        full: { threads: 10, runs: { succeeded: 10, failed: 0, decided: 10, unknown: 0, settledAfterWindow: 0 } },
      },
    };
    const counts = {
      ...baseCounts(), daysElapsed: bothDays(35),
      decidedItems: { off: 19, full: 19 }, measuredLandedItems: { off: 19, full: 19 },
    };
    const short = computeVerdict({ chats: {}, planQueue: {}, kinds, counts });
    expect(short.harnessWork).toBe('apply-defaults');
    expect(short.notes.join(' ')).toContain('Decision 3 defaults');
    expect(short.notes.join(' ')).toContain('"automation" completes more than 10 points worse');
    expect(short.notes.join(' ')).toContain('move it back to the chats setting');
    expect(short.notes.join(' ')).toContain('their outcomes hold');

    const healthy = computeVerdict({
      chats: {}, planQueue: {}, counts,
      kinds: {
        automation: {
          off: { threads: 10, runs: { succeeded: 10, failed: 0, decided: 10, unknown: 0, settledAfterWindow: 0 } },
          full: { threads: 10, runs: { succeeded: 10, failed: 0, decided: 10, unknown: 0, settledAfterWindow: 0 } },
        },
      },
    });
    expect(healthy.harnessWork).toBe('apply-defaults');
    expect(healthy.notes.join(' ')).toContain('Decision 3 defaults');
    expect(healthy.notes.join(' ')).not.toContain('completes more than 10 points worse');
    expect(healthy.notes.join(' ')).not.toContain('their outcomes hold');
  });

  it('an empty trial reports no-data rather than a default change', () => {
    const empty = computeVerdict({
      chats: {}, planQueue: {}, kinds: {},
      counts: { daysElapsed: bothDays(44), chatThreads: {}, decidedItems: {}, measuredLandedItems: {} },
    });
    expect(empty.harnessWork).toBe('no-data');
    expect(empty.chats).toBe('no-data');
  });

  it('a choice-2 kind that completes more than 10 points worse with Off is flagged', () => {
    const result = computeVerdict({
      chats: {
        cheaper: { meanInputPerTurn: 85, medianWallClockMs: 1000 },
        full: { meanInputPerTurn: 100, medianWallClockMs: 1000 },
      },
      planQueue: {
        off: { meanInputPerLandedItem: 75, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
        full: { meanInputPerLandedItem: 100, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
      },
      kinds: {
        child: {
          off: { threads: 10, completed: 10, outcomes: { succeeded: 8, failed: 2, decided: 10, unknown: 0 } },
          full: { threads: 10, completed: 10, outcomes: { succeeded: 10, failed: 0, decided: 10, unknown: 0 } },
        },
      },
      counts: baseCounts(),
    });
    expect(result.notes.join(' ')).toContain('"child" completes more than 10 points worse');
  });

  it('a choice-2 kind exactly 10 points worse with Off is not flagged', () => {
    // 14 of 20 against 16 of 20 is exactly 10 points; raw subtraction gives 10.000000000000009.
    const result = computeVerdict({
      chats: {
        cheaper: { meanInputPerTurn: 85, medianWallClockMs: 1000 },
        full: { meanInputPerTurn: 100, medianWallClockMs: 1000 },
      },
      planQueue: {
        off: { meanInputPerLandedItem: 75, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
        full: { meanInputPerLandedItem: 100, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
      },
      kinds: {
        child: {
          off: { threads: 20, completed: 20, outcomes: { succeeded: 14, failed: 6, decided: 20, unknown: 0 } },
          full: { threads: 20, completed: 20, outcomes: { succeeded: 16, failed: 4, decided: 20, unknown: 0 } },
        },
      },
      counts: baseCounts(),
    });
    expect(result.notes.join(' ')).not.toContain('completes more than 10 points worse');
  });

  it('does not justify Off from fewer than 20 measured landed items in either arm', () => {
    const result = computeVerdict({
      chats: { cheaper: { meanInputPerTurn: 85, medianWallClockMs: 1000 }, full: { meanInputPerTurn: 100, medianWallClockMs: 1000 } },
      planQueue: {
        off: { meanInputPerLandedItem: 0, landedShare: 0.5, medianWallClockMsPerItem: 0 },
        full: { meanInputPerLandedItem: 100, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
      },
      kinds: {},
      counts: { ...baseCounts(), measuredLandedItems: { off: 19, full: 20 } },
    });
    expect(result.harnessWork).toBe('pending');
    expect(result.notes.join(' ')).toContain('20 measured landed plan-queue items per group');
  });

  it('does not print a favorable verdict while any rollout is unreadable', () => {
    const result = computeVerdict({
      chats: { cheaper: { meanInputPerTurn: 85, medianWallClockMs: 1000 }, full: { meanInputPerTurn: 100, medianWallClockMs: 1000 } },
      planQueue: {
        off: { meanInputPerLandedItem: 75, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
        full: { meanInputPerLandedItem: 100, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
      },
      kinds: {},
      counts: { ...baseCounts(), unreadableRollouts: 1 },
    });
    expect(result.harnessWork).toBe('pending');
    expect(result.chats).toBe('pending');
    expect(result.notes.join(' ')).toContain('unreadable rollout');
  });
});

// ── Each comparison runs its own exposure clock (Step 1d) ───────────────────

describe('trial clocks per comparison', () => {
  const shortCounts = {
    chatThreads: { cheaper: 10, full: 10 },
    decidedItems: { off: 5, full: 5 },
    measuredLandedItems: { off: 5, full: 5 },
  };

  it('applies the 35-day stop to one comparison without dragging the other', () => {
    const chatsOld = computeVerdict({
      chats: {}, planQueue: {}, kinds: {},
      counts: { daysElapsed: { chats: 40, harnessWork: 1 }, ...shortCounts },
    });
    expect(chatsOld.chats).toBe('apply-defaults');
    expect(chatsOld.harnessWork).toBe('pending');
    expect(chatsOld.notes.join(' ')).toContain('Trial sample incomplete after 1 days for Harness work');

    const harnessOld = computeVerdict({
      chats: {}, planQueue: {}, kinds: {},
      counts: { daysElapsed: { chats: 1, harnessWork: 40 }, ...shortCounts },
    });
    expect(harnessOld.harnessWork).toBe('apply-defaults');
    expect(harnessOld.chats).toBe('pending');
    expect(harnessOld.notes.join(' ')).toContain('Trial sample incomplete after 1 days for chats');
  });

  it('a comparison with no exposure never reaches the 35-day default', () => {
    const neverHarness = computeVerdict({
      chats: {}, planQueue: {}, kinds: {},
      counts: { daysElapsed: { chats: 40, harnessWork: 0 }, ...shortCounts },
    });
    expect(neverHarness.chats).toBe('apply-defaults');
    expect(neverHarness.harnessWork).toBe('pending');
    expect(neverHarness.notes.join(' ')).toContain('after 0 days for Harness work');

    const neverChats = computeVerdict({
      chats: {}, planQueue: {}, kinds: {},
      counts: { daysElapsed: { chats: 0, harnessWork: 40 }, ...shortCounts },
    });
    expect(neverChats.harnessWork).toBe('apply-defaults');
    expect(neverChats.chats).toBe('pending');
    expect(neverChats.notes.join(' ')).toContain('after 0 days for chats');
  });
});

// ── Unknown measures withhold their verdict even when the sample is complete ─

describe('unknown measures with a complete sample', () => {
  const eligibleChats = {
    cheaper: { meanInputPerTurn: 85, medianWallClockMs: 1000 },
    full: { meanInputPerTurn: 100, medianWallClockMs: 1000 },
  };
  const eligibleQueue = {
    off: { meanInputPerLandedItem: 75, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
    full: { meanInputPerLandedItem: 100, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
  };
  const verdictWith = (counts: { unknownItems?: number; unknownChatThreads?: number }, daysElapsed = 21) => computeVerdict({
    chats: eligibleChats,
    planQueue: eligibleQueue,
    kinds: {},
    counts: { ...baseCounts(), daysElapsed: bothDays(daysElapsed), ...counts },
  });

  it('fully measured controls keep exactly their current verdicts', () => {
    for (const zeroed of [{}, { unknownItems: 0, unknownChatThreads: 0 }]) {
      const result = verdictWith(zeroed);
      expect(result.harnessWork).toBe('off-justified');
      expect(result.chats).toBe('cheaper-justified');
      expect(result.notes.join(' ')).not.toContain('unknown');
    }
  });

  it('withholds the Harness-work verdict while plan-queue items are unmeasured', () => {
    const result = verdictWith({ unknownItems: 160 });
    expect(result.harnessWork).toBe('pending');
    expect(result.chats).toBe('cheaper-justified');
    const notes = result.notes.join(' ');
    expect(notes).toContain('160 plan-queue item(s) have unknown Harness-record measures');
    expect(notes).toContain('Harness-work verdict withheld');
    expect(notes).not.toContain('direction, not proof');
  });

  it('withholds a Harness-work split or fall-back verdict too, not only the favorable one', () => {
    const short = computeVerdict({
      chats: eligibleChats,
      planQueue: { ...eligibleQueue, off: { ...eligibleQueue.off, landedShare: 0.3 } },
      kinds: {},
      counts: { ...baseCounts(), unknownItems: 1 },
    });
    expect(short.harnessWork).toBe('pending');
    const slow = computeVerdict({
      chats: eligibleChats,
      planQueue: { ...eligibleQueue, off: { ...eligibleQueue.off, medianWallClockMsPerItem: 5000 } },
      kinds: {},
      counts: { ...baseCounts(), unknownItems: 1 },
    });
    expect(slow.harnessWork).toBe('pending');
  });

  it('withholds the chat verdict while chat roots have unknown usage receipts', () => {
    const result = verdictWith({ unknownChatThreads: 3 });
    expect(result.chats).toBe('pending');
    expect(result.harnessWork).toBe('off-justified');
    expect(result.notes.join(' ')).toContain('3 chat root(s) have unknown usage receipts; chat verdict withheld');
  });

  it('withholds both verdicts and names both counts when both parts have unknowns', () => {
    const result = verdictWith({ unknownItems: 4, unknownChatThreads: 7 });
    expect(result.harnessWork).toBe('pending');
    expect(result.chats).toBe('pending');
    const notes = result.notes.join(' ');
    expect(notes).toContain('4 plan-queue item(s) have unknown Harness-record measures');
    expect(notes).toContain('7 chat root(s) have unknown usage receipts');
  });

  it('keeps withholding after 35 days when the sample is complete', () => {
    const result = verdictWith({ unknownItems: 2, unknownChatThreads: 2 }, 40);
    expect(result.harnessWork).toBe('pending');
    expect(result.chats).toBe('pending');
  });

  it('leaves the incomplete-sample outcomes unchanged', () => {
    const early = verdictWith({ unknownItems: 5, unknownChatThreads: 2 }, 20);
    expect(early.harnessWork).toBe('pending');
    expect(early.chats).toBe('pending');
    const earlyNotes = early.notes.join(' ');
    expect(earlyNotes).toContain('No verdict yet');
    expect(earlyNotes).toContain('5 plan-queue item(s) have unknown Harness-record measures');
    expect(earlyNotes).toContain('2 chat root(s) have unknown usage receipts');

    const shortCounts = {
      daysElapsed: bothDays(35),
      chatThreads: { cheaper: 10, full: 10 },
      decidedItems: { off: 5, full: 5 },
      measuredLandedItems: { off: 5, full: 5 },
    };
    const defaults = computeVerdict({ chats: {}, planQueue: {}, kinds: {}, counts: shortCounts });
    expect(defaults.harnessWork).toBe('apply-defaults');
    const blocked = computeVerdict({
      chats: {}, planQueue: {}, kinds: {}, counts: { ...shortCounts, unknownItems: 1 },
    });
    expect(blocked.harnessWork).toBe('pending');
    expect(blocked.notes.join(' ')).toContain('No verdict yet');
  });
});

// ── The chat verdict stands on the chat sample alone (R3J1) ─────────────────

describe('chat verdict independent of the plan-queue sample (R3J1)', () => {
  const eligibleChats = {
    cheaper: { meanInputPerTurn: 85, medianWallClockMs: 1000 },
    full: { meanInputPerTurn: 100, medianWallClockMs: 1000 },
  };
  const noQueueSample = { decidedItems: {}, measuredLandedItems: {} };

  it('reaches the chat verdict with no plan-queue items at all', () => {
    const result = computeVerdict({
      chats: eligibleChats, planQueue: {}, kinds: {},
      counts: { ...baseCounts(), ...noQueueSample },
    });
    expect(result.chats).toBe('cheaper-justified');
    expect(result.harnessWork).toBe('pending');
    expect(result.notes.join(' ')).toContain('for Harness work');
  });

  it.each([
    ['unmeasured landed items', { measuredLandedItems: { off: 0, full: 0 } }],
    ['too few decided items', { decidedItems: { off: 3, full: 3 }, measuredLandedItems: { off: 3, full: 3 } }],
    ['unknown plan-queue items', { unknownItems: 40 }],
  ])('is not held back by %s', (_label, overrides) => {
    const result = computeVerdict({
      chats: eligibleChats, planQueue: {}, kinds: {},
      counts: { ...baseCounts(), ...overrides },
    });
    expect(result.chats).toBe('cheaper-justified');
    expect(result.harnessWork).toBe('pending');
  });

  it('applies the chat default at 35 days even while plan-queue items are unknown, but still withholds Harness work', () => {
    const result = computeVerdict({
      chats: {}, planQueue: {}, kinds: {},
      counts: { daysElapsed: bothDays(36), chatThreads: { cheaper: 10, full: 10 }, decidedItems: { off: 5, full: 5 },
        measuredLandedItems: { off: 0, full: 0 }, unknownItems: 10 },
    });
    expect(result.chats).toBe('apply-defaults');
    expect(result.harnessWork).toBe('pending');
  });

  it('still withholds the chat verdict for the chat sample\'s own shortfall and unknowns', () => {
    const short = computeVerdict({
      chats: eligibleChats, planQueue: {}, kinds: {},
      counts: { ...baseCounts(), chatThreads: { cheaper: 39, full: 40 } },
    });
    expect(short.chats).toBe('pending');
    expect(short.notes.join(' ')).toContain('needs 40 chat threads');
    const unknown = computeVerdict({
      chats: eligibleChats, planQueue: {}, kinds: {},
      counts: { ...baseCounts(), unknownChatThreads: 2, daysElapsed: bothDays(40) },
    });
    expect(unknown.chats).toBe('pending');
  });

  it('lets a favourable plan-queue sample reach its verdict without a chat sample', () => {
    const result = computeVerdict({
      chats: {}, kinds: {},
      planQueue: {
        off: { meanInputPerLandedItem: 70, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
        full: { meanInputPerLandedItem: 100, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
      },
      counts: { ...baseCounts(), chatThreads: { cheaper: 1, full: 1 } },
    });
    expect(result.harnessWork).toBe('off-justified');
    expect(result.chats).toBe('pending');
  });
});

describe('the adapter\'s helper counts in the policy log (R3J1)', () => {
  it('reads helper-count follow-up records, keeps the largest count per thread and reports invalid counts as unknown', () => {
    const dir = makeTempDir('codex-trial-helper-log-');
    writeFileSync(join(dir, '2026-09-02.jsonl'), [
      { at: '2026-09-02T10:00:00.000Z', provider: 'codex', threadId: 't-1', sessionKind: 'plan-queue', arm: 'off', level: 'off', armKey: 'i', applied: true },
      helperCountRecord({ at: '2026-09-02T10:01:00.000Z', threadId: 't-1', instanceId: 'inst-1', helperThreads: 1 }),
      helperCountRecord({ at: '2026-09-02T10:02:00.000Z', threadId: 't-1', instanceId: 'inst-1', helperThreads: 3 }),
      helperCountRecord({ at: '2026-09-02T10:03:00.000Z', threadId: 't-1', instanceId: 'inst-1', helperThreads: 2 }),
      helperCountRecord({ at: '2026-09-02T10:04:00.000Z', threadId: 't-2', helperThreads: -1 }),
      helperCountRecord({ at: '2026-09-02T10:05:00.000Z', threadId: 't-3', helperThreads: 1.5 }),
      { ...helperCountRecord({ at: '2026-09-02T10:06:00.000Z', threadId: 't-4', helperThreads: 4 }), provider: 'claude' },
    ].map((row) => JSON.stringify(row)).join('\n'));
    const { entries: records, unparsableLines } = parsePolicyLog(dir, 0, Number.MAX_SAFE_INTEGER, 'helper-count');
    expect(unparsableLines).toBe(2);
    expect(records.map((row) => row['threadId'])).toEqual(['t-1', 't-1', 't-1']);
    expect([...helperCountsFromLog(records)]).toEqual([['t-1', 3]]);
    // The follow-up records never appear as policy entries, so they cannot create a thread.
    expect(parsePolicyLog(dir, 0, Number.MAX_SAFE_INTEGER).entries.map((row) => row['threadId'])).toEqual(['t-1']);
  });
});

// ── Plan-queue item grouping (Step 1d item 1) ───────────────────────────────

const emptyGraph = () => ({ childrenOf: new Map<string, string[]>(), rolloutPath: new Map<string, string>() });

/** A live-shape `plan_queue_items` row as the report's query returns it. */
const queueItem = (id: string, state: string, round = 1, wallMs = 60_000) => ({
  id, state, round, created_at: 1_000_000, updated_at: 1_000_000 + wallMs,
});

/** Write real-shape cost files and read them back with the report's own reader. */
function usageFor(rows: Record<string, unknown>[], wanted?: string[], window: { sinceMs?: number; untilMs?: number } = {}) {
  const dir = makeTempDir('codex-trial-cost-');
  writeCostDir(dir, rows);
  return readCostAttribution(dir, window.sinceMs ?? 0, window.untilMs ?? Number.MAX_SAFE_INTEGER,
    new Set(wanted ?? rows.map((row) => row['instanceId'] as string)));
}

/** One policy-log line for a plan-queue worker or verifier thread, with its Harness instance id. */
const queueLog = (threadId: string, armKey: string, arm: 'off' | 'full' | 'unassigned', extra: Record<string, unknown> = {}) => ({
  threadId, instanceId: `i-${threadId}`, sessionKind: 'plan-queue', level: arm === 'unassigned' ? 'full' : arm, arm,
  armKey, armSource: 'plan-queue-item', applied: true, ...extra,
});

describe('plan-queue item grouping', () => {
  const items = [
    queueItem('item-1', 'landed', 2),
    queueItem('item-2', 'parked', 1),
    queueItem('item-3', 'landed', 1),
  ];
  const logEntries = [
    queueLog('w1', 'item-1', 'off'),
    queueLog('v1', 'item-1', 'off'),
    queueLog('w2', 'item-1', 'off'),
    queueLog('w3', 'item-2', 'full'),
    queueLog('w4', 'item-3', 'off'),
    queueLog('v4', 'item-3', 'full'),
    queueLog('w5', 'item-3', 'unassigned'),
  ];
  const allCosts = usageFor(['w1', 'v1', 'w2', 'w3', 'w4', 'v4', 'w5']
    .map((id) => costRow({ instanceId: `i-${id}`, input: 10, cacheRead: 90 })));

  it('worker round 1, verifier round 1 and worker round 2 of one item count as one item in one group', () => {
    const result = aggregatePlanQueue(logEntries, items, allCosts, emptyGraph());
    expect(result.perArm['off']?.items).toBe(1);
    expect(result.perArm['off']?.landed).toBe(1);
    expect(result.perArm['full']?.items).toBe(1);
    expect(result.perArm['full']?.parked).toBe(1);
    // Three instances of item-1 each have one 100-token row.
    expect(result.rows.find((r) => r.id === 'item-1')).toMatchObject({ input: 300, unknownReason: null });
  });

  it('an item with two arms is listed and excluded; unassigned does not rescue it', () => {
    const result = aggregatePlanQueue(logEntries, items, allCosts, emptyGraph());
    expect(result.mixedArmItems).toEqual(['item-3']);
    expect(result.excludedItems).toContain('item-3');
    expect(result.rows.find((r) => r.id === 'item-3')).toBeUndefined();
  });

  it('sums every turn of an instance once, however many times its thread started or resumed', () => {
    const entries = [0, 1, 2].map(() => queueLog('worker', 'item-1', 'off'));
    const usage = usageFor([
      costRow({ instanceId: 'i-worker', input: 40, cacheRead: 60 }),
      costRow({ instanceId: 'i-worker', input: 30, cacheRead: 70 }),
    ]);
    const result = aggregatePlanQueue(entries, [items[0]], usage, emptyGraph());
    expect(result.rows[0]).toMatchObject({ id: 'item-1', input: 200, wallClockMs: 60_000 });
    expect(result.perArm['off']?.medianWallClockMsPerItem).toBe(60_000);
  });

  it('excludes an item if any start or resume was unapplied or exposure is unknown', () => {
    const entries = [
      queueLog('started', 'item-1', 'off'),
      queueLog('started', 'item-1', 'off', { applied: false }),
      { threadId: 'unknown', sessionKind: 'plan-queue', level: 'full', arm: 'full', armKey: 'item-2' },
    ];
    const result = aggregatePlanQueue(entries, items, allCosts, emptyGraph());
    expect(result.rows).toEqual([]);
    expect(result.excludedItems).toEqual(expect.arrayContaining(['item-1', 'item-2']));
  });

  it('excludes a thread whose resumes disagree about its raw key or arm', () => {
    const entries = [
      queueLog('one', 'item-1', 'off'),
      queueLog('one', 'item-2', 'full'),
    ];
    const result = aggregatePlanQueue(entries, items, allCosts, emptyGraph());
    expect(result.rows).toEqual([]);
    expect(result.excludedItems).toEqual(expect.arrayContaining(['item-1', 'item-2']));
  });

  it('excludes an item when a resumed thread kept its Off arm but applied Full', () => {
    const entries = [
      queueLog('worker', 'item-1', 'off'),
      queueLog('worker', 'item-1', 'off', { level: 'full' }),
    ];
    const result = aggregatePlanQueue(entries, [items[0]], allCosts, emptyGraph());
    expect(result.rows).toEqual([]);
    expect(result.excludedItems).toContain('item-1');
  });

  it('excludes items when an applied start or resume has no recognized level', () => {
    for (const level of [undefined, 'mystery']) {
      const entries = [queueLog('worker', 'item-1', 'off', { level })];
      const result = aggregatePlanQueue(entries, [items[0]], allCosts, emptyGraph());
      expect(result.excludedItems).toContain('item-1');
      expect(result.rows).toEqual([]);
    }
  });
});

describe('plan-queue items measured from Harness records (R3J1)', () => {
  const landed = queueItem('item-1', 'landed');
  const oneWorker = [queueLog('worker', 'item-1', 'off')];
  const workerAndVerifier = [queueLog('worker', 'item-1', 'off'), queueLog('verifier', 'item-1', 'off')];

  it('takes gross input as input plus cache reads, not the queue ledger and not rollouts', () => {
    const usage = usageFor([costRow({ instanceId: 'i-worker', input: 100, cacheRead: 900 })]);
    // The live table's own `tokens` ledger is mostly 0 and must not be used.
    const result = aggregatePlanQueue(oneWorker, [{ ...landed, tokens: 7, cost_usd: 0.5 }], usage, emptyGraph());
    expect(result.rows[0]).toMatchObject({ input: 1000 });
    expect(result.perArm['off']).toMatchObject({ measuredLanded: 1, meanInputPerLandedItem: 1000, unknownItems: 0 });
  });

  it('leaves an item unknown until every worker and verifier instance has cost rows', () => {
    const usage = usageFor([costRow({ instanceId: 'i-worker', input: 100, cacheRead: 100 })], ['i-worker', 'i-verifier']);
    const result = aggregatePlanQueue(workerAndVerifier, [landed], usage, emptyGraph());
    expect(result.perArm['off']).toMatchObject({ decided: 1, landed: 1, measuredLanded: 0, unknownItems: 1 });
    expect(result.perArm['off']?.meanInputPerLandedItem).toBeNull();
    expect(result.perArm['off']?.medianWallClockMsPerItem).toBeNull();
    expect(result.unknownItems).toEqual(['item-1']);
    expect(result.unknownItemReasons).toEqual({ 'item-1': 'no-cost-rows' });
    expect(result.rows[0]).toMatchObject({ id: 'item-1', input: null, wallClockMs: null });
  });

  it('keeps a genuine zero-token row distinct from a missing row', () => {
    const zero = usageFor([costRow({ instanceId: 'i-worker', input: 0, cacheRead: 0 })]);
    expect(aggregatePlanQueue(oneWorker, [landed], zero, emptyGraph()).rows[0]).toMatchObject({ input: 0, unknownReason: null });
    const missing = usageFor([], ['i-worker']);
    expect(aggregatePlanQueue(oneWorker, [landed], missing, emptyGraph()).rows[0]).toMatchObject({ input: null, unknownReason: 'no-cost-rows' });
  });

  it.each([
    ['unreadable or missing cost records', () => UNREADABLE_COST_RECORDS, oneWorker, landed, 'cost-records-unreadable'],
    ['a policy record with no instance id', () => usageFor([costRow({ instanceId: 'i-worker', input: 1, cacheRead: 1 })]),
      [queueLog('worker', 'item-1', 'off', { instanceId: undefined })], landed, 'no-instance-id'],
    ['a cost row without its cache-read counter', () => usageFor([costRow({ instanceId: 'i-worker', input: 1, cacheRead: 1, omit: 'cacheReadTokens' })]),
      oneWorker, landed, 'invalid-cost-row'],
    ['a cost row without its input counter', () => usageFor([costRow({ instanceId: 'i-worker', input: 1, cacheRead: 1, omit: 'inputTokens' })]),
      oneWorker, landed, 'invalid-cost-row'],
    ['an item updated before it was created', () => usageFor([costRow({ instanceId: 'i-worker', input: 1, cacheRead: 1 })]),
      oneWorker, { ...landed, created_at: 5_000, updated_at: 4_000 }, 'bad-timestamps'],
    ['an item with no timestamps', () => usageFor([costRow({ instanceId: 'i-worker', input: 1, cacheRead: 1 })]),
      oneWorker, { ...landed, created_at: null, updated_at: null }, 'bad-timestamps'],
  ])('is unknown, never zero, for %s', (_label, makeUsage, entries, item, reason) => {
    const result = aggregatePlanQueue(entries, [item], makeUsage(), emptyGraph());
    expect(result.unknownItems).toEqual(['item-1']);
    expect(result.unknownItemReasons['item-1']).toBe(reason);
    expect(result.perArm['off']).toMatchObject({ measuredLanded: 0, meanInputPerLandedItem: null, medianWallClockMsPerItem: null });
  });

  it('counts an item still queued or running as neither measured nor unknown', () => {
    const running = queueItem('item-1', 'verifying');
    const result = aggregatePlanQueue(oneWorker, [running], UNREADABLE_COST_RECORDS, emptyGraph());
    expect(result.unknownItems).toEqual([]);
    expect(result.inFlightItems).toEqual(['item-1']);
    expect(result.perArm['off']).toMatchObject({ items: 1, decided: 0, inFlight: 1, measuredItems: 0, unknownItems: 0 });
  });

  it('leaves an outcome settled at or after --until undecided; the cutoff is exclusive', () => {
    // The outcome of an item is part of the window only when its row settles
    // before the cutoff. A later landing must not be counted against costs that
    // stop at --until: as of the cutoff the item had not finished, so it is
    // neither decided nor unknown — exactly like an item still queued or running.
    const usage = usageFor([costRow({ instanceId: 'i-worker', input: 40, cacheRead: 60 })]);
    const landed = queueItem('item-1', 'landed', 1, 60_000); // settled at 1_060_000
    expect(aggregatePlanQueue(oneWorker, [landed], usage, emptyGraph(), 1_060_001).perArm['off']).toMatchObject({
      items: 1, decided: 1, landed: 1, measuredLanded: 1, meanInputPerLandedItem: 100, settledAfterWindow: 0,
    });
    for (const untilMs of [1_060_000, 1_059_999]) {
      const result = aggregatePlanQueue(oneWorker, [landed], usage, emptyGraph(), untilMs);
      expect(result.perArm['off']).toMatchObject({
        items: 1, decided: 0, landed: 0, measuredLanded: 0, unknownItems: 0, inFlight: 0, settledAfterWindow: 1,
      });
      expect(result.perArm['off']?.meanInputPerLandedItem).toBeNull();
      expect(result.settledAfterWindowItems).toEqual(['item-1']);
      expect(result.rows[0]).toMatchObject({
        id: 'item-1', input: null, wallClockMs: null, unknownReason: null, settledAfterWindow: true,
      });
    }
    // No --until keeps every settled outcome: the live report to now is unchanged.
    expect(aggregatePlanQueue(oneWorker, [landed], usage, emptyGraph()).perArm['off']).toMatchObject({
      items: 1, decided: 1, measuredLanded: 1, settledAfterWindow: 0,
    });
  });

  it('uses landed items for tokens and decided items for time, and flags estimated rows', () => {
    const entries = [queueLog('a', 'landed-1', 'off'), queueLog('b', 'parked-1', 'off'), queueLog('c', 'skipped-1', 'off')];
    const usage = usageFor([
      costRow({ instanceId: 'i-a', input: 100, cacheRead: 100, isEstimated: true }),
      costRow({ instanceId: 'i-b', input: 500, cacheRead: 500 }),
      costRow({ instanceId: 'i-c', input: 900, cacheRead: 900 }),
    ]);
    const result = aggregatePlanQueue(entries, [
      queueItem('landed-1', 'landed', 1, 30_000), queueItem('parked-1', 'parked', 1, 90_000), queueItem('skipped-1', 'skipped', 0, 5_000),
    ], usage, emptyGraph());
    // Tokens per landed item ignore the parked and skipped items; time covers landed and parked only.
    expect(result.perArm['off']).toMatchObject({
      decided: 2, landed: 1, parked: 1, skipped: 1, measuredItems: 3, measuredLanded: 1,
      meanInputPerLandedItem: 200, medianWallClockMsPerItem: 60_000, estimatedItems: 1, landedShare: 0.5,
    });
  });
});

describe('the cost-record reader', () => {
  it('reads only instance-turn rows of the wanted instances and counts torn lines instead of guessing', () => {
    const dir = makeTempDir('codex-trial-cost-reader-');
    const other = { ...costRow({ instanceId: 'i-other', input: 1, cacheRead: 1 }) };
    const oneShot = { ...costRow({ instanceId: 'i-worker', input: 9, cacheRead: 9 }), source: 'one-shot' };
    writeCostDir(dir, [
      costRow({ instanceId: 'i-worker', input: 10, cacheRead: 90 }),
      costRow({ instanceId: 'i-worker', input: 5, cacheRead: 45, ts: Date.parse('2026-10-02T09:00:00.000Z') }),
      other, oneShot,
    ], ['{"ts":123,"source":"instance-turn","instanceId":"i-wor']);
    const read = readCostAttribution(dir, 0, Number.MAX_SAFE_INTEGER, new Set(['i-worker']));
    expect(read.readable).toBe(true);
    expect([...read.byInstance.keys()]).toEqual(['i-worker']);
    expect(read.byInstance.get('i-worker')).toMatchObject({ rows: 2, gross: 150, invalidRows: 0, estimatedRows: 0 });
    expect(read.files).toBe(2);
    expect(read.unparsableLines).toBe(2);
  });

  it('skips files older than the window start and reports a missing directory as unreadable', () => {
    const dir = makeTempDir('codex-trial-cost-reader-');
    writeCostDir(dir, [
      costRow({ instanceId: 'i-old', input: 1, cacheRead: 1, ts: Date.parse('2026-09-01T09:00:00.000Z') }),
      costRow({ instanceId: 'i-new', input: 1, cacheRead: 1, ts: Date.parse('2026-10-05T09:00:00.000Z') }),
    ]);
    const read = readCostAttribution(dir, Date.parse('2026-10-01T00:00:00.000Z'), Number.MAX_SAFE_INTEGER, new Set(['i-old', 'i-new']));
    expect([...read.byInstance.keys()]).toEqual(['i-new']);
    expect(readCostAttribution(join(dir, 'absent'), 0, Number.MAX_SAFE_INTEGER, new Set()).readable).toBe(false);
    expect(readCostAttribution(null, 0, Number.MAX_SAFE_INTEGER, new Set()).readable).toBe(false);
  });

  it('counts only rows inside the requested window; work after --until is not measured', () => {
    const dir = makeTempDir('codex-trial-cost-window-');
    const at = Date.parse('2026-10-03T12:00:00.000Z');
    writeCostDir(dir, [
      costRow({ instanceId: 'i-worker', input: 40, cacheRead: 60, ts: at - 3_600_000 }),
      costRow({ instanceId: 'i-worker', input: 40, cacheRead: 60, ts: at + 1_000 }),
      costRow({ instanceId: 'i-worker', input: 5_000, cacheRead: 5_000, ts: at + 3_600_000 }),
    ]);
    const read = readCostAttribution(dir, at, at + 1_800_000, new Set(['i-worker']));
    expect(read.byInstance.get('i-worker')).toMatchObject({ rows: 1, gross: 100, invalidRows: 0 });
  });

  it('fails closed on a row without a usable timestamp: unknown, never absent or zero', () => {
    const dir = makeTempDir('codex-trial-cost-noclock-');
    writeCostDir(dir, [costRow({ instanceId: 'i-worker', input: 40, cacheRead: 60 })]);
    appendFileSync(join(dir, 'cost-attribution-2026-10-01.jsonl'),
      `${JSON.stringify({ ...costRow({ instanceId: 'i-worker', input: 1, cacheRead: 1 }), ts: 'not a time' })}\n`);
    const read = readCostAttribution(dir, 0, Number.MAX_SAFE_INTEGER, new Set(['i-worker']));
    expect(read.byInstance.get('i-worker')).toMatchObject({ rows: 2, gross: 100, invalidRows: 1 });
  });
});

describe('observed helper graph integrity', () => {
  it('includes child and grandchild input in the containing Cheaper chat turn', () => {
    const graph = { childrenOf: new Map([
      ['chat', ['chat-child']], ['chat-child', ['chat-grand']],
    ]), rolloutPath: new Map() };
    const rollouts = new Map([
      ['chat', trialRollout(trialTurn(0, 100, 100))],
      ['chat-child', trialRollout(trialTurn(10, 90, 10))],
      ['chat-grand', trialRollout(trialTurn(20, 80, 50))],
    ]);
    const entries = [
      { threadId: 'chat', sessionKind: 'chat', level: 'economy', arm: 'cheaper', armKey: 'chat', applied: true },
    ];
    const compared = buildComparisons(entries, graph, rollouts, []);
    expect(compared.chats['cheaper']).toMatchObject({ meanInputPerTurn: 160, helperInputShare: 60 / 160 });
  });

  it('measures a queue item from its instances\' cost rows even when stale rollouts and graph edges exist', () => {
    // Plan-queue threads are ephemeral, so any rollout or edge here is stray. They
    // must neither be required nor added on top of the Harness-recorded total.
    const graph = { childrenOf: new Map([['queue', ['queue-child']]]), rolloutPath: new Map() };
    const rollouts = new Map([
      ['queue', trialRollout(trialTurn(0, 100, 100))],
      ['queue-child', trialRollout(trialTurn(10, 90, 10))],
    ]);
    const entries = [queueLog('queue', 'item', 'full')];
    const usage = usageFor([costRow({ instanceId: 'i-queue', input: 120, cacheRead: 40 })]);
    const compared = buildComparisons(entries, graph, rollouts, [queueItem('item', 'landed')], usage);
    expect(compared.planQueue.rows[0]).toMatchObject({ id: 'item', input: 160 });
    expect(compared.planQueue.perArm['full']).toMatchObject({ measuredLanded: 1, meanInputPerLandedItem: 160 });
    expect(compared.kindTable['plan-queue']).toBeUndefined();
  });

  it('counts a descendant once through duplicate edges, cycles and two logged roots', () => {
    const graph = { childrenOf: new Map([
      ['a', ['child', 'child']], ['b', ['child']], ['child', ['grand']], ['grand', ['a', 'child']],
    ]), rolloutPath: new Map() };
    const rollouts = new Map([
      ['a', trialRollout(trialTurn(0, 100, 100))],
      ['b', trialRollout(trialTurn(0, 100, 100))],
      ['child', trialRollout(trialTurn(10, 90, 10))],
      ['grand', trialRollout(trialTurn(20, 80, 50))],
    ]);
    const entries = ['a', 'b'].map((threadId) => ({
      threadId, sessionKind: 'automation', level: 'full', arm: 'full', armKey: 'automation-key', applied: true,
    }));
    const result = aggregateKind('automation', entries, graph, rollouts) as Record<string, { totalInput: number }>;
    expect(result['full'].totalInput).toBe(260);
    expect(rollouts.get('a')?.turns[0].helperInput).toBe(0);
    expect(rollouts.get('b')?.turns[0].helperInput).toBe(0);
  });

  it('flags observed Off helper edges and excludes the whole queue item and Off kind aggregates', () => {
    const entries = [
      queueLog('worker', 'item', 'off'),
      queueLog('verifier', 'item', 'off'),
      { threadId: 'loop', sessionKind: 'loop', level: 'off', arm: 'off', armKey: 'loop-key', applied: true },
      { threadId: 'automation', sessionKind: 'automation', level: 'off', arm: 'off', armKey: 'automation-key', applied: true },
    ];
    const graph = { childrenOf: new Map([
      ['worker', ['helper']], ['loop', ['loop-helper']], ['automation', ['automation-helper']],
    ]), rolloutPath: new Map() };
    const rollouts = new Map(entries.map((entry) => [entry.threadId, trialRollout(trialTurn(0, 100, 100))]));
    for (const id of ['helper', 'loop-helper', 'automation-helper']) rollouts.set(id, trialRollout(trialTurn(10, 90, 50)));
    const usage = usageFor([costRow({ instanceId: 'i-worker', input: 1, cacheRead: 1 }), costRow({ instanceId: 'i-verifier', input: 1, cacheRead: 1 })]);
    const compared = buildComparisons(entries, graph, rollouts, [queueItem('item', 'landed')], usage);
    expect(compared.offGraphBreaches).toEqual(expect.arrayContaining(['worker', 'loop', 'automation']));
    expect(compared.planQueue.excludedItems).toContain('item');
    expect(compared.planQueue.rows).toEqual([]);
    expect(compared.kindTable['loop']['off']).toBeUndefined();
    expect(compared.kindTable['automation']['off']).toBeUndefined();
  });

  it('flags an Off thread from the adapter\'s logged helper count when Codex has no spawn edge for it', () => {
    // The real situation for ephemeral threads: no state-database row, so no edge.
    const entries = [
      queueLog('worker', 'item', 'off'),
      { threadId: 'loop', sessionKind: 'loop', level: 'off', arm: 'off', armKey: 'loop-key', applied: true },
      queueLog('quiet', 'quiet-item', 'off'),
    ];
    const graph = { ...emptyGraph(), loggedHelperThreads: new Map([['worker', 2], ['loop', 1], ['quiet', 0]]) };
    const usage = usageFor(['worker', 'quiet'].map((id) => costRow({ instanceId: `i-${id}`, input: 1, cacheRead: 1 })));
    const compared = buildComparisons(entries, graph, new Map(), [queueItem('item', 'landed'), queueItem('quiet-item', 'landed')], usage);
    expect(compared.offGraphBreaches).toEqual(['loop', 'worker']);
    expect(compared.planQueue.excludedItems).toEqual(['item']);
    expect(compared.planQueue.rows.map((row) => row.id)).toEqual(['quiet-item']);
  });

  it('does not treat a Full thread\'s helpers as a breach', () => {
    const entries = [queueLog('worker', 'item', 'full')];
    const graph = { ...emptyGraph(), loggedHelperThreads: new Map([['worker', 3]]) };
    const compared = buildComparisons(entries, graph, new Map(), [queueItem('item', 'landed')],
      usageFor([costRow({ instanceId: 'i-worker', input: 1, cacheRead: 1 })]));
    expect(compared.offGraphBreaches).toEqual([]);
    expect(compared.planQueue.rows).toHaveLength(1);
  });

  it('flags an Off chat with a helper even though Off chats are not trial comparison arms', () => {
    const entries = [{ threadId: 'chat-off', sessionKind: 'chat', level: 'off', arm: 'off', armKey: 'chat-off', applied: true }];
    const graph = { childrenOf: new Map([['chat-off', ['helper']]]), rolloutPath: new Map() };
    const rollouts = new Map([
      ['chat-off', trialRollout(trialTurn(0, 100, 100))],
      ['helper', trialRollout(trialTurn(10, 90, 50))],
    ]);
    const compared = buildComparisons(entries, graph, rollouts, []);
    expect(compared.offGraphBreaches).toEqual(['chat-off']);
    expect(compared.chats['off']).toBeUndefined();
  });

  it('does not recommend Off or 35-day Off defaults after an observed breach', () => {
    for (const daysElapsed of [21, 35]) {
      const result = computeVerdict({
        chats: {}, planQueue: {}, kinds: {},
        counts: { ...baseCounts(), daysElapsed: bothDays(daysElapsed), offGraphBreaches: 1 },
      });
      expect(result.harnessWork).toBe('pending');
      expect(result.notes.join(' ')).toContain('Off helper');
    }
    const eligibleChats = {
      cheaper: { meanInputPerTurn: 85, medianWallClockMs: 1000 },
      full: { meanInputPerTurn: 100, medianWallClockMs: 1000 },
    };
    const complete = computeVerdict({
      chats: eligibleChats,
      planQueue: {
        off: { meanInputPerLandedItem: 75, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
        full: { meanInputPerLandedItem: 100, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
      },
      kinds: {}, counts: { ...baseCounts(), offGraphBreaches: 1 },
    });
    expect(complete.harnessWork).toBe('pending');
    expect(complete.chats).toBe('cheaper-justified');
    // The plan-queue sample is short, but the chat sample is complete: chats are
    // judged on their own counts (R3J1), so Cheaper is justified here.
    const shortAtStop = computeVerdict({
      chats: eligibleChats, planQueue: {}, kinds: {},
      counts: { ...baseCounts(), daysElapsed: bothDays(35), decidedItems: { off: 1, full: 1 },
        measuredLandedItems: { off: 1, full: 1 }, offGraphBreaches: 1 },
    });
    expect(shortAtStop.harnessWork).toBe('pending');
    expect(shortAtStop.chats).toBe('cheaper-justified');
  });
});

describe('unknown loop database (R2E / S12)', () => {
  const shortCounts = () => ({
    daysElapsed: bothDays(35),
    chatThreads: { cheaper: 10, full: 10 },
    decidedItems: { off: 5, full: 5 },
    measuredLandedItems: { off: 5, full: 5 },
  });

  it('an unknown loop database withholds the Harness-work defaults at 35 days but not the chat defaults', () => {
    const unknown = computeVerdict({
      chats: {}, planQueue: {}, kinds: {},
      counts: { ...shortCounts(), loopDbReadable: false },
    });
    expect(unknown.harnessWork).toBe('pending');
    expect(unknown.chats).toBe('apply-defaults');
    expect(unknown.notes.join(' ')).toMatch(/loop database.*unknown/i);
    // Same counts with a readable database still apply the defaults.
    expect(computeVerdict({ chats: {}, planQueue: {}, kinds: {}, counts: { ...shortCounts(), loopDbReadable: true } }).harnessWork)
      .toBe('apply-defaults');
  });

  it('an unknown loop database blocks even a complete-sample Off verdict', () => {
    const complete = verdictFor({});
    expect(complete.harnessWork).toBe('off-justified');
    const blocked = computeVerdict({
      chats: { cheaper: { meanInputPerTurn: 85, medianWallClockMs: 1000 }, full: { meanInputPerTurn: 100, medianWallClockMs: 1000 } },
      planQueue: {
        off: { meanInputPerLandedItem: 75, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
        full: { meanInputPerLandedItem: 100, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
      },
      kinds: {}, counts: { ...baseCounts(), loopDbReadable: false },
    });
    expect(blocked.harnessWork).toBe('pending');
  });

  it('an unknown loop database is not reported as "no data" when the trial is empty', () => {
    const empty = computeVerdict({ chats: {}, planQueue: {}, kinds: {}, counts: { ...shortCounts(), decidedItems: {}, chatThreads: {}, measuredLandedItems: {}, loopDbReadable: false } });
    expect(empty.harnessWork).toBe('pending');
  });
});

it('excludes a chat thread after an unapplied resume, even when its start applied', () => {
  const entries = [
    { threadId: 'chat-1', sessionKind: 'chat', level: 'economy', arm: 'cheaper', armKey: 'chat-1', applied: true },
    { threadId: 'chat-1', sessionKind: 'chat', level: 'economy', arm: 'cheaper', armKey: 'chat-1', applied: false },
  ];
  const result = aggregateKind('chat', entries, { childrenOf: new Map(), rolloutPath: new Map() }, new Map());
  expect(result).toEqual({});
});

it('uses decided automation runs for the ten-point quality rule', () => {
  const verdict = (offSucceeded: number) => computeVerdict({
    chats: { cheaper: { meanInputPerTurn: 85, medianWallClockMs: 1000 }, full: { meanInputPerTurn: 100, medianWallClockMs: 1000 } },
    planQueue: {
      off: { meanInputPerLandedItem: 75, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
      full: { meanInputPerLandedItem: 100, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
    },
    kinds: { automation: {
      off: { threads: 1, completed: 1, runs: { succeeded: offSucceeded, failed: 10 - offSucceeded, decided: 10 } },
      full: { threads: 1, completed: 0, runs: { succeeded: 10, failed: 0, decided: 10 } },
    } },
    counts: baseCounts(),
  });
  expect(verdict(9).notes.join(' ')).not.toContain('"automation" completes more than 10 points worse');
  expect(verdict(8).notes.join(' ')).toContain('"automation" completes more than 10 points worse');
});

it('withholds the automation outcome comparison when decision timestamps are unusable', () => {
  // Unknown outcomes are never zero-filled into the rate: with part of either
  // arm's settled runs unplaceable in time, the comparison itself is unknown
  // (the child-outcome path's fail-closed rule), not a guessed ten-point call.
  const verdict = computeVerdict({
    chats: { cheaper: { meanInputPerTurn: 85, medianWallClockMs: 1000 }, full: { meanInputPerTurn: 100, medianWallClockMs: 1000 } },
    planQueue: {
      off: { meanInputPerLandedItem: 75, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
      full: { meanInputPerLandedItem: 100, landedShare: 0.5, medianWallClockMsPerItem: 1000 },
    },
    kinds: { automation: {
      off: { threads: 1, completed: 1, runs: { succeeded: 8, failed: 2, decided: 10, unknown: 3, settledAfterWindow: 0 } },
      full: { threads: 1, completed: 1, runs: { succeeded: 10, failed: 0, decided: 10, unknown: 0, settledAfterWindow: 0 } },
    } },
    counts: baseCounts(),
  });
  expect(verdict.notes.join(' ')).toContain('Automation outcome comparison unknown');
  expect(verdict.notes.join(' ')).not.toContain('"automation" completes more than 10 points worse');
});

// ── Rollout parsing ─────────────────────────────────────────────────────────

// ── Turn containment is indexed, with the scan's exact first-match rule ─────

describe('indexTurnContainment', () => {
  const naive = (turns: Array<{ start: number | null; end: number | null }>, at: number) =>
    turns.findIndex(t => t.start !== null && at >= t.start && (t.end === null || at <= t.end));

  it('matches the old turns.findIndex walk exactly on overlapping, open and closed windows', () => {
    // Deterministic pseudo-random windows: closed, open-ended, zero-length,
    // out-of-order starts and null starts — the shapes a crash-truncated or
    // interleaved rollout can produce. The index must answer every query the
    // way the scan it replaces did.
    let seed = 0x20261023;
    const rand = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const turns: Array<{ start: number | null; end: number | null }> = [];
    for (let i = 0; i < 200; i++) {
      if (rand() < 0.08) {
        turns.push({ start: null, end: null });
        continue;
      }
      const start = Math.floor(rand() * 1_000);
      const end = rand() < 0.25 ? null : start + Math.floor(rand() * 1_500);
      turns.push({ start, end });
    }
    const ats = Array.from({ length: 300 }, () => Math.floor(rand() * 2_500));
    expect(indexTurnContainment(turns, ats)).toEqual(ats.map(at => naive(turns, at)));
    // A query with no finite timestamp answers -1 at every call site.
    expect(indexTurnContainment(turns, [null, Number.NaN, undefined])).toEqual([-1, -1, -1]);
  });

  it('keeps the earliest turn when windows overlap, like the old scan', () => {
    const turns = [
      { start: 100, end: null },
      { start: 150, end: 400 },
      { start: 200, end: 250 },
    ];
    expect(indexTurnContainment(turns, [120, 220, 300, 500])).toEqual([0, 0, 0, 0]);
    // A gap after a closed window has no containing turn.
    expect(indexTurnContainment([{ start: 100, end: 200 }], [250, 150])).toEqual([-1, 0]);
  });

  it('answers snapshots over 64,000 turns in linear time, not a per-snapshot turn walk', () => {
    // The finding's own repro scale (about 14 s at 64k turns with the old
    // `turns.find` per snapshot). The fixture write is outside the timed
    // region: only the parse is measured, and the indexed pass runs it in
    // ~130 ms here against ~12.6 s for the scan it replaces.
    const dir = makeTempDir('codex-trial-containment-scale-');
    const path = join(dir, 'root.jsonl');
    const base = Date.parse('2026-10-01T00:00:00.000Z');
    const lines: string[] = [];
    for (let i = 0; i < 64_000; i++) {
      const t0 = base + i * 10_000;
      lines.push(JSON.stringify({ type: 'event_msg', timestamp: new Date(t0).toISOString(), payload: { type: 'task_started' } }));
      lines.push(JSON.stringify({
        type: 'token_usage_record', timestamp: new Date(t0 + 5_000).toISOString(),
        payload: { thread_token_usage: { input_tokens: (i + 1) * 10, cached_input_tokens: 0, output_tokens: i + 1 } },
      }));
      lines.push(JSON.stringify({ type: 'event_msg', timestamp: new Date(t0 + 9_000).toISOString(), payload: { type: 'task_complete' } }));
    }
    writeFileSync(path, lines.join('\n'));
    const started = performance.now();
    const parsed = parseRolloutSync(path);
    expect(performance.now() - started).toBeLessThan(3_000);
    expect(parsed.turns).toHaveLength(64_000);
    // Every turn measured exactly its own snapshot's growth.
    expect(parsed.turns[0]).toMatchObject({ requests: 1, input: 10, output: 1 });
    expect(parsed.turns[63_999]).toMatchObject({ requests: 1, input: 10, output: 1 });
  }, 60_000);
});

describe('parseRolloutSync', () => {
  it('folds usage deltas into turns and counts one request per distinct snapshot', () => {
    const dir = makeTempDir('codex-trial-rollout-');
    const path = join(dir, 'root.jsonl');
    const lines = [
      JSON.stringify({ type: 'event_msg', timestamp: '2026-10-01T10:00:00.000Z', payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'token_usage_record', timestamp: '2026-10-01T10:00:10.000Z', payload: { thread_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10 } } }),
      // The same cumulative counters again (the duplicate record type) must not double-count.
      JSON.stringify({ type: 'event_msg', timestamp: '2026-10-01T10:00:11.000Z', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10 } } } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-10-01T10:00:20.000Z', payload: { type: 'task_complete' } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-10-01T10:00:21.000Z', payload: { type: 'compacted' } }),
    ];
    writeFileSync(path, lines.join('\n'));
    const parsed = parseRolloutSync(path);
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].requests).toBe(1);
    expect(parsed.turns[0].input).toBe(100);
    expect(parsed.turns[0].output).toBe(10);
    expect(parsed.compactions).toEqual([{ at: Date.parse('2026-10-01T10:00:21.000Z'), midTask: false }]);
  });

  it('bounds turns, usage and compactions to the window and keeps the cumulative baseline', () => {
    const dir = makeTempDir('codex-trial-rollout-window-');
    const path = join(dir, 'root.jsonl');
    const at = (offsetMs: number) => new Date(Date.parse('2026-10-01T10:00:00.000Z') + offsetMs).toISOString();
    const usage = (offsetMs: number, input: number, output: number) => JSON.stringify({
      type: 'token_usage_record', timestamp: at(offsetMs),
      payload: { thread_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } },
    });
    writeFileSync(path, [
      // Turn A before the window: cumulative usage ends at 100 input.
      JSON.stringify({ type: 'event_msg', timestamp: at(0), payload: { type: 'task_started' } }),
      usage(10_000, 100, 5),
      JSON.stringify({ type: 'event_msg', timestamp: at(20_000), payload: { type: 'task_complete' } }),
      // Turn B inside the window: cumulative grows 100 → 150.
      JSON.stringify({ type: 'event_msg', timestamp: at(40_000), payload: { type: 'task_started' } }),
      usage(50_000, 150, 9),
      JSON.stringify({ type: 'event_msg', timestamp: at(60_000), payload: { type: 'task_complete' } }),
      JSON.stringify({ type: 'event_msg', timestamp: at(65_000), payload: { type: 'compacted' } }),
      // Turn C after the cutoff: none of its work is measured.
      JSON.stringify({ type: 'event_msg', timestamp: at(120_000), payload: { type: 'task_started' } }),
      usage(130_000, 900, 50),
      JSON.stringify({ type: 'event_msg', timestamp: at(135_000), payload: { type: 'compacted' } }),
      JSON.stringify({ type: 'event_msg', timestamp: at(140_000), payload: { type: 'task_complete' } }),
    ].join('\n'));
    const parsed = parseRolloutSync(path,
      Date.parse('2026-10-01T10:00:30.000Z'), Date.parse('2026-10-01T10:01:45.000Z'));
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].start).toBe(Date.parse('2026-10-01T10:00:40.000Z'));
    // The in-window turn measures its own growth (150 − 100 = 50), not the
    // thread's cumulative total: the pre-window snapshot is the baseline.
    expect(parsed.turns[0]).toMatchObject({ input: 50, output: 4, requests: 1 });
    expect(parsed.compactions).toEqual([{ at: Date.parse('2026-10-01T10:01:05.000Z'), midTask: false }]);
  });

  it('counts a turn that runs past --until only up to the cutoff', () => {
    const dir = makeTempDir('codex-trial-rollout-straddle-');
    const path = join(dir, 'root.jsonl');
    const at = (offsetMs: number) => new Date(Date.parse('2026-10-01T10:00:00.000Z') + offsetMs).toISOString();
    writeFileSync(path, [
      JSON.stringify({ type: 'event_msg', timestamp: at(0), payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'token_usage_record', timestamp: at(10_000),
        payload: { thread_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 5 } } }),
      JSON.stringify({ type: 'token_usage_record', timestamp: at(50_000),
        payload: { thread_token_usage: { input_tokens: 500, cached_input_tokens: 0, output_tokens: 25 } } }),
      JSON.stringify({ type: 'event_msg', timestamp: at(60_000), payload: { type: 'task_complete' } }),
    ].join('\n'));
    const cutoff = Date.parse('2026-10-01T10:00:30.000Z');
    const parsed = parseRolloutSync(path, 0, cutoff);
    expect(parsed.turns).toHaveLength(1);
    // Wall clock is capped at the cutoff and post-cutoff usage is not counted.
    expect(parsed.turns[0].end).toBe(cutoff);
    expect(parsed.turns[0]).toMatchObject({ input: 100, output: 5, requests: 1 });
  });

  it('attributes a snapshot in overlapping turn windows to the earliest turn, as the scan did', () => {
    const dir = makeTempDir('codex-trial-rollout-overlap-');
    const path = join(dir, 'root.jsonl');
    const at = (offsetMs: number) => new Date(Date.parse('2026-10-01T10:00:00.000Z') + offsetMs).toISOString();
    writeFileSync(path, [
      // Turn A is never closed (a crash-truncated rollout); turn B starts later.
      JSON.stringify({ type: 'event_msg', timestamp: at(0), payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'event_msg', timestamp: at(40_000), payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'token_usage_record', timestamp: at(50_000),
        payload: { thread_token_usage: { input_tokens: 100, cached_input_tokens: 0, output_tokens: 5 } } }),
      JSON.stringify({ type: 'event_msg', timestamp: at(60_000), payload: { type: 'task_complete' } }),
    ].join('\n'));
    const parsed = parseRolloutSync(path);
    expect(parsed.turns).toHaveLength(2);
    // The snapshot sits in both windows (A is open); the earliest turn wins,
    // exactly like the old first-match scan.
    expect(parsed.turns[0]).toMatchObject({ requests: 1, input: 100 });
    expect(parsed.turns[1]).toMatchObject({ requests: 0, input: 0 });
  });
});

describe('missing cache counters', () => {
  const stamp = (second: number) => `2026-10-01T10:00:${String(second).padStart(2, '0')}.000Z`;
  const writeTurnFile = (name: string, usage: Record<string, number>) => {
    const path = join(makeTempDir('codex-cache-unknown-'), name);
    writeFileSync(path, [
      JSON.stringify({ type: 'event_msg', timestamp: stamp(0), payload: { type: 'task_started' } }),
      JSON.stringify({ type: 'token_usage_record', timestamp: stamp(5), payload: { thread_token_usage: usage } }),
      JSON.stringify({ type: 'event_msg', timestamp: stamp(10), payload: { type: 'task_complete' } }),
    ].join('\n'));
    return parseRolloutSync(path);
  };
  const aggregate = (rollout: ReturnType<typeof parseRolloutSync>) => aggregateKind(
    'chat',
    [{ threadId: 'chat-1', sessionKind: 'chat', level: 'economy', arm: 'cheaper', armKey: 'chat-1', applied: true }],
    { childrenOf: new Map(), rolloutPath: new Map([['chat-1', '/rollout']]) },
    new Map([['chat-1', rollout]]),
  ) as Record<string, { meanInputPerTurn: number | null; meanUncachedInputPerTurn: number | null }>;

  it('shows uncached input as unknown, not as the whole input, when the counter is missing', () => {
    const missing = writeTurnFile('missing.jsonl', { input_tokens: 100, output_tokens: 5 });
    expect(missing.turns[0].cacheUnknown).toBe(true);
    const unknown = aggregate(missing)['cheaper'];
    expect(unknown.meanInputPerTurn).toBe(100);
    expect(unknown.meanUncachedInputPerTurn).toBeNull();
  });

  it('keeps the uncached figure when the counter is present, including a real zero', () => {
    const present = writeTurnFile('present.jsonl', { input_tokens: 100, cached_input_tokens: 0, output_tokens: 5 });
    expect(present.turns[0].cacheUnknown).toBeUndefined();
    expect(aggregate(present)['cheaper'].meanUncachedInputPerTurn).toBe(100);
  });
});

// ── The spawn graph is bounded by the reporting cutoff ──────────────────────

describe('the spawn graph is bounded by the reporting cutoff', () => {
  const createdSeconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);
  const untilMs = Date.parse('2026-10-01T00:00:00.000Z');

  it('drops a helper created at or after --until and keeps in-window and unplaceable ones', () => {
    const stateDb = join(makeTempDir('codex-trial-graph-cutoff-'), 'state.sqlite');
    execFileSync('sqlite3', [stateDb, `
      CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER);
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
      INSERT INTO threads VALUES
        ('root', '/root.jsonl', ${createdSeconds('2026-09-01T10:00:00.000Z')}),
        ('in-window', '/in.jsonl', ${createdSeconds('2026-09-15T10:00:00.000Z')}),
        ('future', '/future.jsonl', ${createdSeconds('2026-10-02T10:00:00.000Z')}),
        ('unplaceable', '/unplaceable.jsonl', NULL);
      INSERT INTO thread_spawn_edges VALUES
        ('root', 'in-window'), ('root', 'future'), ('root', 'unplaceable');`]);
    expect([...readThreadGraph(stateDb, untilMs).childrenOf.get('root')!].sort())
      .toEqual(['in-window', 'unplaceable']);
    // Without --until nothing is cut; the cutoff must not over-restrict.
    expect([...readThreadGraph(stateDb).childrenOf.get('root')!].sort())
      .toEqual(['future', 'in-window', 'unplaceable']);
  });

  it('keeps every edge when the threads table carries no creation timestamps', () => {
    const stateDb = join(makeTempDir('codex-trial-graph-no-timestamps-'), 'state.sqlite');
    execFileSync('sqlite3', [stateDb, `
      CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT);
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
      INSERT INTO threads VALUES ('root', '/root.jsonl'), ('future', '/future.jsonl');
      INSERT INTO thread_spawn_edges VALUES ('root', 'future');`]);
    // Fail closed: a helper that cannot be placed in time stays visible as
    // exposure, keeping the Off-breach guard and the measured-rollout rule.
    expect([...readThreadGraph(stateDb, untilMs).childrenOf.get('root')!]).toEqual(['future']);
  });
});

// ── The requested window is validated ───────────────────────────────────────

describe('the CLI window is validated', () => {
  it('rejects unreadable dates and a reversed window', () => {
    expect(() => parseArgs(['--since', 'not a date'])).toThrow(/--since is not a readable date/);
    expect(() => parseArgs(['--until', 'not a date'])).toThrow(/--until is not a readable date/);
    expect(() => parseArgs(['--since', '2026-10-02', '--until', '2026-10-01'])).toThrow(/--since must be earlier than --until/);
    expect(parseArgs(['--since', '2026-10-01', '--until', '2026-10-02'])).toMatchObject({
      sinceMs: Date.parse('2026-10-01T00:00:00.000Z'),
      untilMs: Date.parse('2026-10-02T00:00:00.000Z'),
    });
  });

  it('fails the CLI loudly instead of silently emptying the window', () => {
    const result = spawnSync(process.execPath, [scriptPath, '--since', 'not a date', '--json'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(`${result.stdout ?? ''}${result.stderr ?? ''}`).toContain('--since is not a readable date');
  });
});

// ── End-to-end fixture run ──────────────────────────────────────────────────

function writeRollout(path: string, turns: { startMs: number; endMs: number; input: number; cached?: number; output?: number }[]): void {
  const lines: string[] = [];
  let cumulative = 0;
  for (const turn of turns) {
    cumulative += turn.input;
    lines.push(JSON.stringify({ type: 'event_msg', timestamp: new Date(turn.startMs).toISOString(), payload: { type: 'task_started' } }));
    lines.push(JSON.stringify({
      type: 'token_usage_record',
      timestamp: new Date(turn.endMs - 1000).toISOString(),
      payload: {
        thread_token_usage: {
          input_tokens: cumulative,
          cached_input_tokens: cumulative - (turn.cached ?? Math.floor(turn.input / 2)),
          output_tokens: turn.output ?? 5,
        },
      },
    }));
    lines.push(JSON.stringify({ type: 'event_msg', timestamp: new Date(turn.endMs).toISOString(), payload: { type: 'task_complete' } }));
  }
  writeFileSync(path, lines.join('\n'));
}

function createFixture(options: { dropCostFor?: string; baseMs?: number } = {}): { root: string; policyDir: string; sessionsDir: string; stateDb: string; loopDb: string; rlmDb: string; costDir: string; base: number } {
  const root = makeTempDir('codex-trial-report-');
  const policyDir = join(root, 'session-policy');
  const sessionsDir = join(root, 'sessions');
  mkdirSync(policyDir, { recursive: true });
  mkdirSync(sessionsDir, { recursive: true });
  const stateDb = join(root, 'state_5.sqlite');
  const loopDb = join(root, 'loop-mode.db');
  const rlmDb = join(root, 'rlm.db');
  const costDir = join(root, 'cost-attribution');
  const base = options.baseMs ?? Date.parse('2026-10-01T10:00:00.000Z');

  writeRollout(join(sessionsDir, 'chat-a.jsonl'), [
    { startMs: base, endMs: base + 30_000, input: 100 },
    { startMs: base + 60_000, endMs: base + 90_000, input: 100 },
    { startMs: base + 120_000, endMs: base + 150_000, input: 100 },
  ]);
  // Helper of chat-a runs inside turn 2 and adds 10 input tokens.
  writeRollout(join(sessionsDir, 'chat-a-helper.jsonl'), [
    { startMs: base + 61_000, endMs: base + 80_000, input: 10 },
  ]);
  writeRollout(join(sessionsDir, 'chat-b.jsonl'), [
    { startMs: base, endMs: base + 30_000, input: 120 },
    { startMs: base + 60_000, endMs: base + 90_000, input: 120 },
    { startMs: base + 120_000, endMs: base + 150_000, input: 120 },
  ]);
  // Plan-queue threads are ephemeral: no rollout and no state-database row, as on the real machine.
  writeRollout(join(sessionsDir, 'automation-off.jsonl'), [
    { startMs: base, endMs: base + 30_000, input: 40 },
  ]);
  writeRollout(join(sessionsDir, 'automation-full.jsonl'), [
    { startMs: base, endMs: base + 30_000, input: 50 },
  ]);

  execFileSync('sqlite3', [stateDb, `
    CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT);
    CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
    INSERT INTO threads VALUES
      ('chat-a', '${join(sessionsDir, 'chat-a.jsonl')}'),
      ('chat-a-helper', '${join(sessionsDir, 'chat-a-helper.jsonl')}'),
      ('chat-b', '${join(sessionsDir, 'chat-b.jsonl')}'),
      ('automation-off', '${join(sessionsDir, 'automation-off.jsonl')}'),
      ('automation-full', '${join(sessionsDir, 'automation-full.jsonl')}');
    INSERT INTO thread_spawn_edges VALUES ('chat-a', 'chat-a-helper');
  `]);

  // The live table's real columns; an item's wall-clock is updated_at - created_at.
  writeLoopDb(loopDb, [
    { id: 'item-1', state: 'landed', round: 1, createdAt: base, updatedAt: base + 90_000 },
    { id: 'item-2', state: 'landed', round: 1, createdAt: base, updatedAt: base + 180_000 },
    { id: 'item-3', state: 'landed', round: 1, createdAt: base, updatedAt: base + 90_000 },
  ]);
  // Harness cost rows, keyed by the instance ids the policy log records.
  const costRows = [
    costRow({ instanceId: 'inst-pq-1', input: 40, cacheRead: 60, ts: base + 300_000 }),
    costRow({ instanceId: 'inst-pq-2', input: 100, cacheRead: 100, ts: base + 300_000 }),
    costRow({ instanceId: 'inst-pq-2', input: 100, cacheRead: 100, ts: base + 300_000 }),
    costRow({ instanceId: 'inst-mixed-a', input: 10, cacheRead: 0, ts: base + 300_000 }),
    costRow({ instanceId: 'inst-v3', input: 10, cacheRead: 0, ts: base + 300_000 }),
  ].filter((row) => row['instanceId'] !== options.dropCostFor);
  writeCostDir(costDir, costRows);
  // The live table's run-outcome columns; finished_at places the settled
  // outcome in time (the report's windowing regression controls below).
  execFileSync('sqlite3', [rlmDb, `
    CREATE TABLE automation_runs (id TEXT PRIMARY KEY, automation_id TEXT, instance_id TEXT, status TEXT, started_at INTEGER, finished_at INTEGER);
    INSERT INTO automation_runs VALUES
      ('off-run-1', 'automation-off-key', 'off-instance', 'succeeded', ${base}, ${base + 30_000}),
      ('off-run-2', 'automation-off-key', 'off-instance', 'succeeded', ${base + 1000}, ${base + 31_000}),
      ('off-run-3', 'automation-off-key', 'off-instance', 'failed', ${base + 2000}, ${base + 32_000}),
      ('full-run-1', 'automation-full-key', 'full-instance', 'succeeded', ${base}, ${base + 30_000}),
      ('full-run-2', 'automation-full-key', 'full-instance', 'succeeded', ${base + 1000}, ${base + 31_000}),
      ('full-run-3', 'automation-full-key', 'full-instance', 'succeeded', ${base + 2000}, ${base + 32_000});
  `]);

  const entries = [
    { at: new Date(base).toISOString(), provider: 'codex', threadId: 'chat-a', sessionKind: 'chat', level: 'economy', arm: 'cheaper', armKey: 'chat-a', armSource: 'instance', outputLimit: 6000, postTurnCompactPercent: 70, applied: true },
    { at: new Date(base).toISOString(), provider: 'codex', threadId: 'chat-b', sessionKind: 'chat', level: 'full', arm: 'full', armKey: 'chat-b', armSource: 'instance', outputLimit: 6000, postTurnCompactPercent: 70, applied: true },
    { at: new Date(base).toISOString(), provider: 'codex', threadId: 'pq-1', instanceId: 'inst-pq-1', sessionKind: 'plan-queue', level: 'off', arm: 'off', armKey: 'item-1', armSource: 'plan-queue-item', outputLimit: 4000, postTurnCompactPercent: 60, applied: true },
    { at: new Date(base).toISOString(), provider: 'codex', threadId: 'pq-2', instanceId: 'inst-pq-2', sessionKind: 'plan-queue', level: 'full', arm: 'full', armKey: 'item-2', armSource: 'plan-queue-item', outputLimit: 4000, postTurnCompactPercent: 60, applied: true },
    { at: new Date(base).toISOString(), provider: 'codex', threadId: 'mixed-a', instanceId: 'inst-mixed-a', sessionKind: 'plan-queue', level: 'off', arm: 'off', armKey: 'item-3', armSource: 'plan-queue-item', outputLimit: 4000, postTurnCompactPercent: 60, applied: true },
    { at: new Date(base + 1000).toISOString(), provider: 'codex', threadId: 'v3', instanceId: 'inst-v3', sessionKind: 'plan-queue', level: 'full', arm: 'full', armKey: 'item-3', armSource: 'plan-queue-item', outputLimit: 4000, postTurnCompactPercent: 60, applied: true },
    { at: new Date(base + 1000).toISOString(), provider: 'codex', threadId: 'chat-u', sessionKind: 'chat', level: 'full', arm: 'unassigned', outputLimit: 6000, postTurnCompactPercent: 70, applied: true },
    { at: new Date(base).toISOString(), provider: 'codex', threadId: 'automation-off', instanceId: 'off-instance', sessionKind: 'automation', level: 'off', arm: 'off', armKey: 'automation-off-key', armSource: 'automation', applied: true },
    { at: new Date(base).toISOString(), provider: 'codex', threadId: 'automation-full', instanceId: 'full-instance', sessionKind: 'automation', level: 'full', arm: 'full', armKey: 'automation-full-key', armSource: 'automation', applied: true },
  ];
  writeFileSync(join(policyDir, '2026-10-01.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n'));

  return { root, policyDir, sessionsDir, stateDb, loopDb, rlmDb, costDir, base };
}

describe.skipIf(!hasSqlite3())('codex-helper-trial-report (end to end)', () => {
  it('measures a Full queue item from its Harness cost rows; stray rollouts and graph edges add nothing', () => {
    const fixture = createFixture();
    const base = Date.parse('2026-10-01T10:00:00.000Z');
    // Ephemeral plan-queue threads leave no rollout in practice. If a helper rollout and its
    // spawn edge did exist, the Harness-recorded total must not be inflated or required.
    writeRollout(join(fixture.sessionsDir, 'pq-child.jsonl'), [
      { startMs: base + 1_000, endMs: base + 20_000, input: 10 },
    ]);
    execFileSync('sqlite3', [fixture.stateDb, `
      INSERT INTO threads VALUES ('pq-child', '${join(fixture.sessionsDir, 'pq-child.jsonl')}');
      INSERT INTO thread_spawn_edges VALUES ('pq-2', 'pq-child');
    `]);
    const result = spawnSync(process.execPath, [
      scriptPath, '--since', '2026-10-01', '--json',
      '--policy-dir', fixture.policyDir, '--state-db', fixture.stateDb,
      '--sessions-dir', fixture.sessionsDir, '--loop-db', fixture.loopDb, '--cost-dir', fixture.costDir, '--rlm-db', fixture.rlmDb,
    ], { encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' } });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      planQueueArms: Record<string, { measuredLanded: number; meanInputPerLandedItem: number; medianWallClockMsPerItem: number }>;
      kindTable: Record<string, unknown>;
      unknownRollouts: { missing: number; unreadable: number };
      unknownItems: string[];
    };
    // pq-2's instance has two cost rows of 200 gross input each. The unlisted pq-1 is Off.
    expect(report.planQueueArms['full']).toMatchObject({ measuredLanded: 1, meanInputPerLandedItem: 400, medianWallClockMsPerItem: 180_000 });
    expect(report.planQueueArms['off']).toMatchObject({ measuredLanded: 1, meanInputPerLandedItem: 100, medianWallClockMsPerItem: 90_000 });
    expect(report.kindTable['plan-queue']).toBeUndefined();
    // Only the unassigned chat-u thread (never given a state row in this fixture) has no rollout;
    // the four plan-queue threads are not looked up at all.
    expect(report.unknownRollouts.missing).toBe(1);
    expect(report.unknownItems).toEqual([]);
  });

  it('reports Off chat, queue and automation spawn breaches and quarantines their treatment rows', () => {
    const fixture = createFixture();
    const base = Date.parse('2026-10-01T10:00:00.000Z');
    writeRollout(join(fixture.sessionsDir, 'off-helper.jsonl'), [
      { startMs: base + 1_000, endMs: base + 20_000, input: 50 },
    ]);
    writeRollout(join(fixture.sessionsDir, 'chat-off.jsonl'), [
      { startMs: base, endMs: base + 30_000, input: 100 },
    ]);
    execFileSync('sqlite3', [fixture.stateDb, `
      INSERT INTO threads VALUES ('off-helper', '${join(fixture.sessionsDir, 'off-helper.jsonl')}');
      INSERT INTO threads VALUES ('chat-off', '${join(fixture.sessionsDir, 'chat-off.jsonl')}');
      INSERT INTO thread_spawn_edges VALUES
        ('pq-1', 'off-helper'), ('automation-off', 'off-helper'), ('chat-off', 'off-helper');
    `]);
    writeFileSync(join(fixture.policyDir, '2026-10-02.jsonl'), JSON.stringify({
      at: '2026-10-02T10:00:00.000Z', provider: 'codex', threadId: 'chat-off',
      sessionKind: 'chat', level: 'off', arm: 'off', armKey: 'chat-off', applied: true,
    }));
    const args = [scriptPath, '--since', '2026-10-01',
      '--policy-dir', fixture.policyDir, '--state-db', fixture.stateDb,
      '--sessions-dir', fixture.sessionsDir, '--loop-db', fixture.loopDb, '--cost-dir', fixture.costDir, '--rlm-db', fixture.rlmDb];
    const json = spawnSync(process.execPath, [...args, '--json'], {
      encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' },
    });
    expect(json.status).toBe(0);
    const report = JSON.parse(json.stdout) as {
      offGraphBreaches: string[];
      planQueueArms: Record<string, unknown>;
      kindTable: { automation: Record<string, unknown> };
      verdict: { harnessWork: string; notes: string[] };
    };
    expect(report.offGraphBreaches).toEqual(['automation-off', 'chat-off', 'pq-1']);
    expect(report.planQueueArms['off']).toBeUndefined();
    expect(report.kindTable.automation['off']).toBeUndefined();
    expect(report.verdict.harnessWork).toBe('pending');
    expect(report.verdict.notes.join(' ')).toContain('Off helper spawn breach');
    const text = spawnSync(process.execPath, args, {
      encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' },
    });
    expect(text.status).toBe(0);
    expect(text.stdout).toContain('Off helper spawn breaches');
    expect(text.stdout).toContain('pq-1');
  });

  it('prints both comparisons, groups items by arm and excludes mixed or unassigned entries', () => {
    const fixture = createFixture();
    const result = spawnSync(process.execPath, [
      scriptPath,
      '--since', '2026-10-01',
      // A fixed --until keeps the trial clock at two days whatever the calendar
      // says, so the incomplete-sample verdict below stays stable.
      '--until', new Date(fixture.base + 2 * DAY_MS).toISOString(),
      '--policy-dir', fixture.policyDir,
      '--state-db', fixture.stateDb,
      '--sessions-dir', fixture.sessionsDir,
      '--loop-db', fixture.loopDb, '--cost-dir', fixture.costDir,
      '--rlm-db', fixture.rlmDb,
    ], {
      encoding: 'utf8',
      env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' },
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    expect(result.status).toBe(0);

    // Both comparisons print, with the fixture's per-turn inputs (the helper's
    // 10 tokens land in chat-a turn 2: mean (100+110+100)/3 ≈ 103).
    expect(output).toContain('### Chats (cheaper/economy vs full)');
    expect(output).toContain('| cheaper | 1 | 3 | 103 |');
    expect(output).toContain('| full | 1 | 3 | 120 |');
    expect(output).toContain('### Plan queue (off vs full)');
    expect(output).toContain('| off | 1 | 1 | 1 | 0 | 1 | 100.0% |');
    expect(output).toContain('| full | 1 | 1 | 1 | 0 | 1 | 100.0% |');

    // Item grouping: item-3 shows two arms and is listed and excluded; the
    // unassigned chat thread is excluded from the comparison count.
    expect(output).toContain('Items with two arms');
    expect(output).toContain('item-3');
    expect(output).toContain('unassigned threads excluded: 1');

    // The fixture is far below the sample sizes, so no verdict is claimed.
    expect(output).toContain('Trial sample incomplete');
    expect(output).toContain('- Harness work: pending');
    expect(output).toContain('- Chats: pending');
  });

  it('reports multi-run automation outcomes separately from thread completion', () => {
    const fixture = createFixture();
    const result = spawnSync(process.execPath, [
      scriptPath,
      '--since', '2026-10-01', '--json',
      '--policy-dir', fixture.policyDir,
      '--state-db', fixture.stateDb,
      '--sessions-dir', fixture.sessionsDir,
      '--loop-db', fixture.loopDb, '--cost-dir', fixture.costDir,
      '--rlm-db', fixture.rlmDb,
    ], { encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' } });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      kindTable: { automation: Record<string, { threads: number; completed: number; runs: { succeeded: number; failed: number; decided: number } }> };
    };
    expect(report.kindTable.automation['off']).toMatchObject({
      threads: 1, completed: 1, runs: { succeeded: 2, failed: 1, decided: 3 },
    });
    expect(report.kindTable.automation['full']).toMatchObject({
      threads: 1, completed: 1, runs: { succeeded: 3, failed: 0, decided: 3 },
    });
  });

  it('keeps known automation-run failures in the quality comparison when the token rollout is incomplete', () => {
    const fixture = createFixture();
    // The Off arm's only thread has a crash-truncated rollout (no final
    // boundary, no usage): its billed token measures are unavailable, but its
    // authoritative run outcomes are not. Membership in the quality comparison
    // must rest on valid policy/instance identities, exactly as the child
    // outcome path does, never on hasMeasuredRolloutTree.
    writeFileSync(join(fixture.sessionsDir, 'automation-off.jsonl'),
      '{"type":"event_msg","timestamp":"2026-10-01T10:00:00.000Z","payload":{"type":"task_started"}}\n{"type":');
    const report = JSON.parse(spawnSync(process.execPath, [
      scriptPath, '--since', '2026-10-01', '--json',
      '--policy-dir', fixture.policyDir, '--state-db', fixture.stateDb, '--sessions-dir', fixture.sessionsDir,
      '--loop-db', fixture.loopDb, '--cost-dir', fixture.costDir, '--rlm-db', fixture.rlmDb,
    ], { encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' } }).stdout) as {
      kindTable: { automation: Record<string, { threads: number; completed: number; threadIds: string[]; unmeasuredThreadIds: string[]; runs: Record<string, number> }> };
    };
    expect(report.kindTable.automation['off']).toMatchObject({
      threads: 0, threadIds: [], unmeasuredThreadIds: ['automation-off'],
      runs: { succeeded: 2, failed: 1, decided: 3, unknown: 0, settledAfterWindow: 0 },
    });
    // The control: the identity-based rule does not over-count either.
    expect(report.kindTable.automation['full']).toMatchObject({
      threads: 1, threadIds: ['automation-full'], unmeasuredThreadIds: [],
      runs: { succeeded: 3, failed: 0, decided: 3, unknown: 0, settledAfterWindow: 0 },
    });
  });

  it('keeps a decided automation run with unusable decision timestamps explicitly unknown', () => {
    const fixture = createFixture();
    execFileSync('sqlite3', [fixture.rlmDb, `
      UPDATE automation_runs SET finished_at = NULL WHERE id = 'off-run-1';
      UPDATE automation_runs SET finished_at = started_at - 1 WHERE id = 'off-run-2';
      UPDATE automation_runs SET started_at = NULL WHERE id = 'off-run-3';
    `]);
    const report = JSON.parse(spawnSync(process.execPath, [
      scriptPath, '--since', '2026-10-01', '--json',
      '--policy-dir', fixture.policyDir, '--state-db', fixture.stateDb, '--sessions-dir', fixture.sessionsDir,
      '--loop-db', fixture.loopDb, '--cost-dir', fixture.costDir, '--rlm-db', fixture.rlmDb,
    ], { encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' } }).stdout) as {
      kindTable: { automation: Record<string, { runs: Record<string, number> }> };
    };
    // A missing finish, a finish before the start and a run with no start
    // cannot be placed in the window: explicitly unknown, never counted and
    // never silently dropped. The untouched arm stays fully decided.
    expect(report.kindTable.automation['off'].runs).toEqual({
      succeeded: 0, failed: 0, decided: 0, unknown: 3, settledAfterWindow: 0,
    });
    expect(report.kindTable.automation['full'].runs).toEqual({
      succeeded: 3, failed: 0, decided: 3, unknown: 0, settledAfterWindow: 0,
    });
  });

  it('leaves an automation outcome settled at or after --until undecided; the cutoff is exclusive', () => {
    const fixture = createFixture();
    const settledAt = fixture.base + 30_000;
    execFileSync('sqlite3', [fixture.rlmDb, `UPDATE automation_runs SET finished_at = ${settledAt};`]);
    const counts = (until?: number) => {
      const args = [scriptPath, '--since', '2026-10-01', '--json',
        '--policy-dir', fixture.policyDir, '--state-db', fixture.stateDb, '--sessions-dir', fixture.sessionsDir,
        '--loop-db', fixture.loopDb, '--cost-dir', fixture.costDir, '--rlm-db', fixture.rlmDb];
      if (until !== undefined) args.push('--until', new Date(until).toISOString());
      return JSON.parse(spawnSync(process.execPath, args, {
        encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' },
      }).stdout) as { kindTable: { automation: Record<string, { runs: Record<string, number> }> } };
    };
    // Each report covers both arms, so run the CLI once per cutoff.
    const atOrBefore = [counts(settledAt), counts(settledAt - 1)];
    const afterSettled = counts(settledAt + 1);
    const unbounded = counts();
    for (const arm of ['off', 'full'] as const) {
      // Settled exactly at the cutoff is outside it, and so is an earlier
      // cutoff: as of --until the runs had not finished, so their outcomes are
      // neither decided nor unknown — exactly like runs still in flight.
      for (const report of atOrBefore) {
        expect(report.kindTable.automation[arm].runs).toEqual({
          succeeded: 0, failed: 0, decided: 0, unknown: 0, settledAfterWindow: 3,
        });
      }
      const inside = arm === 'off'
        ? { succeeded: 2, failed: 1, decided: 3, unknown: 0, settledAfterWindow: 0 }
        : { succeeded: 3, failed: 0, decided: 3, unknown: 0, settledAfterWindow: 0 };
      // One millisecond after settlement the outcomes are inside the window.
      expect(afterSettled.kindTable.automation[arm].runs).toEqual(inside);
      // No --until keeps every settled outcome: the live report to now is unchanged.
      expect(unbounded.kindTable.automation[arm].runs).toEqual(inside);
    }
  });

  it('excludes a thread with pre-window policy history before its in-window resume', () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.policyDir, '2026-09-30.jsonl'), JSON.stringify({
      at: '2026-09-30T23:00:00.000Z', provider: 'codex', threadId: 'chat-a',
      sessionKind: 'chat', arm: 'cheaper', armKey: 'chat-a', armSource: 'instance', applied: false,
    }));
    const result = spawnSync(process.execPath, [
      scriptPath,
      '--since', '2026-10-01', '--json',
      '--policy-dir', fixture.policyDir,
      '--state-db', fixture.stateDb,
      '--sessions-dir', fixture.sessionsDir,
      '--loop-db', fixture.loopDb, '--cost-dir', fixture.costDir,
      '--rlm-db', fixture.rlmDb,
    ], { encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' } });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as { chats: Record<string, unknown>; preexistingThreadsExcluded: number };
    expect(report.chats['cheaper']).toBeUndefined();
    expect(report.preexistingThreadsExcluded).toBe(1);
  });

  // R2E / S11: the build before the rebuild logged `at` as epoch milliseconds,
  // arms 'control'/'candidate' (opposite even/odd polarity) and hashed keys.
  const legacyRecord = (threadId: string, arm: 'control' | 'candidate', atMs: number) => JSON.stringify({
    at: atMs, provider: 'codex', threadId, sessionKind: 'chat', level: arm === 'candidate' ? 'economy' : 'full',
    arm, armKey: 'a'.repeat(64), outputLimit: 6000, postTurnCompactPercent: 70, applied: true,
  });

  it('parsePolicyLog accepts numeric epoch `at`, keeps old arm names verbatim and flags the old format (R2E)', () => {
    const dir = makeTempDir('codex-trial-legacy-log-');
    const atMs = Date.parse('2026-10-18T10:00:00.000Z');
    writeFileSync(join(dir, '2026-10-18.jsonl'), [
      legacyRecord('old-a', 'control', atMs),
      legacyRecord('old-b', 'candidate', atMs + 1),
      JSON.stringify({ at: '2026-10-20T09:00:00.000Z', provider: 'codex', threadId: 'new-a', sessionKind: 'chat', arm: 'cheaper', armKey: 'raw', applied: true }),
      JSON.stringify({ at: 'not a date', provider: 'codex', threadId: 'bad', arm: 'full' }),
    ].join('\n'));
    const { entries: rows, unparsableLines } = parsePolicyLog(dir, 0, Number.MAX_SAFE_INTEGER);
    expect(unparsableLines).toBe(1);
    expect(rows.map((row) => [row['threadId'], row['arm'], row['atMs'], row['legacyFormat']])).toEqual([
      ['old-a', 'control', atMs, true],
      ['old-b', 'candidate', atMs + 1, true],
      ['new-a', 'cheaper', Date.parse('2026-10-20T09:00:00.000Z'), false],
    ]);
    // Window filtering uses the numeric time too.
    expect(parsePolicyLog(dir, atMs + 1, Number.MAX_SAFE_INTEGER).entries.map((row) => row['threadId'])).toEqual(['old-b', 'new-a']);
  });

  it('excludes a thread whose pre-rebuild record is old-format (numeric `at`, control arm) before its first new resume (R2E)', () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.policyDir, '2026-09-30.jsonl'), legacyRecord('chat-a', 'control', Date.parse('2026-09-30T23:00:00.000Z')));
    const result = spawnSync(process.execPath, [
      scriptPath, '--since', '2026-10-01', '--json',
      '--policy-dir', fixture.policyDir, '--state-db', fixture.stateDb,
      '--sessions-dir', fixture.sessionsDir, '--loop-db', fixture.loopDb, '--cost-dir', fixture.costDir, '--rlm-db', fixture.rlmDb,
    ], { encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' } });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      chats: Record<string, { threadIds: string[] }>; preexistingThreadsExcluded: number; logEntries: number;
    };
    expect(report.preexistingThreadsExcluded).toBe(1);
    // chat-a's new-format resume is gone; chat-b (new format only) is untouched.
    expect(report.chats['cheaper']).toBeUndefined();
    expect(report.chats['full'].threadIds).toEqual(['chat-b']);
    expect(report.logEntries).toBe(8);
  });

  it('excludes a thread with an old-format record even inside the window, and never reads control/candidate as the new arms (R2E)', () => {
    const fixture = createFixture();
    const inWindow = Date.parse('2026-10-01T11:00:00.000Z');
    // chat-a: old 'candidate' (the old build's even/odd polarity differs) inside the window.
    // old-only: a thread only the old build knew; its 'control' must not land in any new arm.
    writeFileSync(join(fixture.policyDir, '2026-10-01-legacy.jsonl'), [
      legacyRecord('chat-a', 'candidate', inWindow),
      legacyRecord('old-only', 'control', inWindow),
    ].join('\n'));
    const result = spawnSync(process.execPath, [
      scriptPath, '--since', '2026-10-01', '--json',
      '--policy-dir', fixture.policyDir, '--state-db', fixture.stateDb,
      '--sessions-dir', fixture.sessionsDir, '--loop-db', fixture.loopDb, '--cost-dir', fixture.costDir, '--rlm-db', fixture.rlmDb,
    ], { encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' } });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      chats: Record<string, { threadIds: string[] }>; preexistingThreadsExcluded: number;
      unassignedThreads: number; ineligibleThreads: number; logEntries: number;
    };
    expect(report.preexistingThreadsExcluded).toBe(2);
    expect(Object.keys(report.chats).sort()).toEqual(['full']);
    expect(report.chats['full'].threadIds).toEqual(['chat-b']);
    expect(report.unassignedThreads).toBe(1); // only the chat-u fixture row
    expect(report.ineligibleThreads).toBe(0);
    expect(report.logEntries).toBe(8);
  });

  // R2E / S12: an unreadable loop database is unknown evidence, not an empty queue.
  // The clock runs from first exposure, so "past 35 days" needs exposures older
  // than 35 days, not a long --since window (see the trial-clock regressions).
  const pastStopArgs = (fixture: ReturnType<typeof createFixture>, loopDb: string) => [
    scriptPath, '--since', new Date(fixture.base - DAY_MS).toISOString(), '--json',
    '--policy-dir', fixture.policyDir, '--state-db', fixture.stateDb,
    '--sessions-dir', fixture.sessionsDir, '--loop-db', loopDb, '--cost-dir', fixture.costDir, '--rlm-db', fixture.rlmDb,
  ];
  const runVerdict = (args: string[]) => {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' } });
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout) as { verdict: { harnessWork: string; chats: string; notes: string[] }; loopDbReadable: boolean };
  };

  it('control: a readable loop database past 35 days with short counts still applies the defaults (R2E)', () => {
    const fixture = createFixture({ baseMs: Date.now() - 40 * DAY_MS });
    const report = runVerdict(pastStopArgs(fixture, fixture.loopDb));
    expect(report.loopDbReadable).toBe(true);
    expect(report.verdict.harnessWork).toBe('apply-defaults');
  });

  it.each([
    ['missing', (fixture: ReturnType<typeof createFixture>) => join(fixture.root, 'no-such-loop-mode.db')],
    ['unreadable', (fixture: ReturnType<typeof createFixture>) => {
      const path = join(fixture.root, 'corrupt-loop-mode.db');
      writeFileSync(path, 'this is not a sqlite database');
      return path;
    }],
  ])('a %s loop database makes Harness-work evidence unknown, never apply-defaults (R2E)', (_label, makeLoopDb) => {
    const fixture = createFixture({ baseMs: Date.now() - 40 * DAY_MS });
    const report = runVerdict(pastStopArgs(fixture, makeLoopDb(fixture)));
    expect(report.loopDbReadable).toBe(false);
    expect(report.verdict.harnessWork).toBe('pending');
    expect(report.verdict.notes.join('\n')).toMatch(/loop database.*unknown/i);
    // Chat evidence does not depend on the loop database.
    expect(report.verdict.chats).toBe('apply-defaults');
  });

  it('reports an Off item with no cost rows as unknown instead of crediting zero tokens or wall time', () => {
    const fixture = createFixture({ dropCostFor: 'inst-pq-1' });
    const result = spawnSync(process.execPath, [
      scriptPath, '--since', '2026-10-01', '--json',
      '--policy-dir', fixture.policyDir, '--state-db', fixture.stateDb,
      '--sessions-dir', fixture.sessionsDir, '--loop-db', fixture.loopDb, '--cost-dir', fixture.costDir, '--rlm-db', fixture.rlmDb,
    ], { encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' } });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      planQueueArms: Record<string, { landed: number; measuredLanded: number; meanInputPerLandedItem: number | null; medianWallClockMsPerItem: number | null }>;
      unknownItems: string[];
      unknownItemReasons: Record<string, string>;
      verdict: { harnessWork: string };
    };
    expect(report.planQueueArms['off']).toMatchObject({
      landed: 1, measuredLanded: 0, meanInputPerLandedItem: null, medianWallClockMsPerItem: null,
    });
    expect(report.unknownItems).toContain('item-1');
    expect(report.unknownItemReasons['item-1']).toBe('no-cost-rows');
    expect(report.verdict.harnessWork).not.toBe('off-justified');
  });

  it('treats a missing cost directory as unknown plan-queue evidence, not an empty queue', () => {
    const fixture = createFixture();
    const result = spawnSync(process.execPath, [
      scriptPath, '--since', '2026-10-01', '--json',
      '--policy-dir', fixture.policyDir, '--state-db', fixture.stateDb,
      '--sessions-dir', fixture.sessionsDir, '--loop-db', fixture.loopDb, '--cost-dir', join(fixture.root, 'no-such-cost-dir'),
      '--rlm-db', fixture.rlmDb,
    ], { encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' } });
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout) as {
      costRecords: { readable: boolean }; unknownItems: string[]; unknownItemReasons: Record<string, string>;
    };
    expect(report.costRecords.readable).toBe(false);
    expect(report.unknownItems).toEqual(expect.arrayContaining(['item-1', 'item-2']));
    expect(report.unknownItemReasons['item-1']).toBe('cost-records-unreadable');
  });

  it('fails the CLI on an unreadable chat rollout with counts and no file content in diagnostics', () => {
    const fixture = createFixture();
    const unreadablePath = join(fixture.sessionsDir, 'chat-b.jsonl');
    rmSync(unreadablePath);
    mkdirSync(unreadablePath);
    const result = spawnSync(process.execPath, [
      scriptPath, '--since', '2026-10-01', '--json',
      '--policy-dir', fixture.policyDir, '--state-db', fixture.stateDb,
      '--sessions-dir', fixture.sessionsDir, '--loop-db', fixture.loopDb, '--cost-dir', fixture.costDir, '--rlm-db', fixture.rlmDb,
    ], { encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/1 unreadable rollout/);
    expect(result.stderr).not.toContain('thread_token_usage');
    const report = JSON.parse(result.stdout) as { unknownRollouts: { unreadable: number }; verdict: { harnessWork: string; chats: string } };
    expect(report.unknownRollouts.unreadable).toBe(1);
    expect(report.verdict.chats).not.toBe('cheaper-justified');
    expect(report.verdict.harnessWork).not.toBe('off-justified');
  });

  it('fails closed when the state graph cannot establish helper descendants', () => {
    const fixture = createFixture();
    const result = spawnSync(process.execPath, [
      scriptPath, '--since', '2026-10-01', '--json',
      '--policy-dir', fixture.policyDir, '--state-db', join(fixture.root, 'missing-state.sqlite'),
      '--sessions-dir', fixture.sessionsDir, '--loop-db', fixture.loopDb, '--cost-dir', fixture.costDir, '--rlm-db', fixture.rlmDb,
    ], { encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' } });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Codex state graph unavailable');
    expect(result.stderr).not.toContain('thread_token_usage');
  });

  /** One measured chat root per arm exposed at `chatExposureMs`, an empty
   * readable queue, and optionally one landed plan-queue item with cost rows at
   * `queueExposureMs`. Real shapes throughout; no message text is written. */
  function clockFixture(options: { chatExposureMs: number; queueExposureMs?: number }) {
    const root = makeTempDir('codex-trial-clock-');
    const policyDir = join(root, 'session-policy');
    const sessionsDir = join(root, 'sessions');
    mkdirSync(policyDir, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
    const stateDb = join(root, 'state_5.sqlite');
    const loopDb = join(root, 'loop-mode.db');
    const costDir = join(root, 'cost-attribution');
    const threadRows: string[] = [];
    const entries: Record<string, unknown>[] = [];
    for (const [arm, level] of [['cheaper', 'economy'], ['full', 'full']] as const) {
      const id = `chat-${arm}`;
      writeRollout(join(sessionsDir, `${id}.jsonl`), [0, 1, 2].map((turn) => ({
        startMs: options.chatExposureMs + turn * 60_000,
        endMs: options.chatExposureMs + turn * 60_000 + 30_000,
        input: 100,
      })));
      threadRows.push(`('${id}', '${join(sessionsDir, `${id}.jsonl`)}')`);
      entries.push({ at: new Date(options.chatExposureMs).toISOString(), provider: 'codex', threadId: id,
        sessionKind: 'chat', level, arm, armKey: id, armSource: 'instance', applied: true });
    }
    const items: QueueItemRow[] = [];
    if (options.queueExposureMs !== undefined) {
      entries.push({ at: new Date(options.queueExposureMs).toISOString(), provider: 'codex',
        threadId: 'pq-1', instanceId: 'inst-pq-1', sessionKind: 'plan-queue', level: 'off', arm: 'off',
        armKey: 'item-1', armSource: 'plan-queue-item', applied: true });
      items.push({ id: 'item-1', state: 'landed', round: 1,
        createdAt: options.queueExposureMs, updatedAt: options.queueExposureMs + 60_000 });
      writeCostDir(costDir, [costRow({ instanceId: 'inst-pq-1', input: 40, cacheRead: 60, ts: options.queueExposureMs + 50 })]);
    }
    writeLoopDb(loopDb, items);
    writeFileSync(join(policyDir, 'log.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n'));
    execFileSync('sqlite3', [stateDb, `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT);
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
      INSERT INTO threads VALUES ${threadRows.join(',')};`]);
    return {
      costDir,
      args: ['--policy-dir', policyDir, '--state-db', stateDb, '--sessions-dir', sessionsDir,
        '--loop-db', loopDb, '--cost-dir', costDir, '--rlm-db', join(root, 'absent-rlm.db')],
    };
  }

  const runCli = (args: string[]) => {
    const result = spawnSync(process.execPath, [scriptPath, ...args, '--json'], {
      encoding: 'utf8', env: { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' },
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as {
      verdict: { harnessWork: string; chats: string; notes: string[] };
      trialAgeDays: { chats: number; harnessWork: number };
      firstExposureAt: { chats: string | null; harnessWork: string | null };
      chats: Record<string, { threads: number; turns: number; meanInputPerTurn: number | null }>;
      planQueueArms: Record<string, { meanInputPerLandedItem: number | null }>;
    };
  };

  it('runs each comparison\'s clock from its first eligible exposure, not from --since', () => {
    const chatExposureMs = Date.now() - 3_600_000;
    const fixture = clockFixture({ chatExposureMs });
    // Control: the query window starts at the exposure itself.
    const control = runCli(['--since', new Date(chatExposureMs - 1_000).toISOString(), ...fixture.args]);
    expect(control.verdict.chats).toBe('pending');
    expect(control.verdict.harnessWork).toBe('pending');
    expect(control.firstExposureAt.harnessWork).toBeNull();

    // An omitted or earlier --since must not age the trial: it is one hour old
    // whatever the query window, and the Harness-work comparison (no plan-queue
    // exposure at all) never started, so neither may reach the 35-day default.
    for (const window of [[], ['--since', new Date(Date.now() - 90 * DAY_MS).toISOString()]]) {
      const report = runCli([...window, ...fixture.args]);
      expect(report.verdict).toEqual(control.verdict);
      expect(report.trialAgeDays.chats).toBeLessThan(1);
      expect(report.trialAgeDays.harnessWork).toBe(0);
    }
  });

  it('keeps the Harness-work clock on plan-queue exposure even when chats are 35+ days old', () => {
    const fixture = clockFixture({
      chatExposureMs: Date.now() - 40 * DAY_MS,
      queueExposureMs: Date.now() - 3_600_000,
    });
    const report = runCli(['--since', new Date(Date.now() - 41 * DAY_MS).toISOString(), ...fixture.args]);
    // Chats have run 40 days with a short sample: their 35-day default applies.
    expect(report.verdict.chats).toBe('apply-defaults');
    // The plan-queue sample is an hour old: the Harness-work verdict waits.
    expect(report.verdict.harnessWork).toBe('pending');
    expect(report.verdict.notes.join(' ')).toContain('Trial sample incomplete after 0 days for Harness work');
    expect(report.trialAgeDays.harnessWork).toBeLessThan(1);
  });

  it('bounds rollout turns and sample qualification to --until', () => {
    // 40 roots per arm: two turns inside the window and a third after the
    // cutoff. Without a turn count inside the window, no root has the three
    // in-window turns the chat sample needs.
    const dir = makeTempDir('codex-trial-cutoff-');
    const policyDir = join(dir, 'session-policy');
    const sessionsDir = join(dir, 'sessions');
    mkdirSync(policyDir, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
    const stateDb = join(dir, 'state_5.sqlite');
    const since = Date.parse('2026-09-01T00:00:00.000Z');
    const until = Date.parse('2026-09-22T00:00:00.000Z');
    const lateTurn = Date.parse('2026-09-23T00:00:00.000Z');
    const threadRows: string[] = [];
    const entries: Record<string, unknown>[] = [];
    for (const [arm, level, perTurn, lateInput] of [
      ['cheaper', 'economy', 80, 8_000], ['full', 'full', 100, 10_000],
    ] as const) {
      for (let n = 0; n < 40; n++) {
        const id = `${arm}-${n}`;
        writeRollout(join(sessionsDir, `${id}.jsonl`), [
          { startMs: since + 60_000, endMs: since + 70_000, input: perTurn },
          { startMs: since + 120_000, endMs: since + 130_000, input: perTurn },
          { startMs: lateTurn, endMs: lateTurn + 10_000, input: lateInput },
        ]);
        threadRows.push(`('${id}', '${join(sessionsDir, `${id}.jsonl`)}')`);
        entries.push({ at: new Date(since).toISOString(), provider: 'codex', threadId: id,
          sessionKind: 'chat', level, arm, armKey: id, armSource: 'instance', applied: true });
      }
    }
    execFileSync('sqlite3', [stateDb, `CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT);
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
      INSERT INTO threads VALUES ${threadRows.join(',')};`]);
    writeFileSync(join(policyDir, 'log.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n'));
    const report = runCli([
      '--since', new Date(since).toISOString(), '--until', new Date(until).toISOString(),
      '--policy-dir', policyDir, '--state-db', stateDb, '--sessions-dir', sessionsDir,
      '--loop-db', join(dir, 'absent-loop.db'), '--cost-dir', join(dir, 'absent-cost'), '--rlm-db', join(dir, 'absent-rlm.db'),
    ]);
    expect(report.chats['cheaper']).toMatchObject({ threads: 40, turns: 80, meanInputPerTurn: 80 });
    expect(report.chats['full']).toMatchObject({ threads: 40, turns: 80, meanInputPerTurn: 100 });
    expect(report.verdict.chats).toBe('pending');
    expect(report.verdict.notes.join(' ')).toContain('needs 40 chat threads with 3+ turns per group');
    expect(report.verdict.notes.join(' ')).toContain('Trial sample incomplete after 21 days for chats');
  });

  it('bounds plan-queue cost receipts to --until', () => {
    const at = Date.parse('2026-10-03T00:00:00.000Z');
    const fixture = clockFixture({ chatExposureMs: at, queueExposureMs: at });
    const window = ['--since', new Date(at).toISOString(), '--until', new Date(at + 12 * 3_600_000).toISOString()];
    expect(runCli([...window, ...fixture.args]).planQueueArms['off'].meanInputPerLandedItem).toBe(100);

    // A row written after --until is not part of the measurement and cannot
    // change input per landed item.
    appendFileSync(join(fixture.costDir, `cost-attribution-${new Date(at).toISOString().slice(0, 10)}.jsonl`),
      `${JSON.stringify(costRow({ instanceId: 'inst-pq-1', input: 5_000, cacheRead: 5_000, ts: at + 13 * 3_600_000 }))}\n`);
    expect(runCli([...window, ...fixture.args]).planQueueArms['off'].meanInputPerLandedItem).toBe(100);
  });
});

// ── Plan queue measured from Harness's own records (R3J1) ───────────────────
//
// Non-root Codex threads are ephemeral, so on the real machine no plan-queue
// thread has a rollout or a state-database row. The report must measure plan-queue
// work from `plan_queue_items` and the cost-attribution rows instead.

describe.skipIf(!hasSqlite3())('plan queue from Harness records, with no rollouts (R3J1)', () => {
  const base = Date.parse('2026-09-01T10:00:00.000Z');
  const at = new Date(base).toISOString();
  const cliEnv = { ...process.env, AIO_CODEX_HELPERS_SQLITE_DRIVER: 'cli' };

  /** One live `automation_runs` row as the report's query returns it. */
  interface AutomationRunRow {
    id: string;
    automationId: string;
    instanceId: string;
    status: 'succeeded' | 'failed' | 'running';
    startedAt: number;
    finishedAt: number | null;
  }

  /** 40 chats per arm with rollouts (durable), and 20 landed plan-queue items per arm with NO rollouts. */
  function realSituation(options: {
    dropCostFor?: string;
    estimateRowsFor?: string[];
    itemMutator?: (rows: QueueItemRow[]) => void;
    /** The reporting cutoff (default 2026-10-01, the fixed-window controls). */
    until?: string;
    /** Adds 10 automation threads and 10 runs per arm (Off: 8 succeeded, 2 failed; Full: 10 succeeded). */
    automation?: {
      /** Rollout evidence for the two failed Off runs' threads (default 'complete'). */
      targetRollout?: 'complete' | 'missing' | 'crashed';
      /** Rollout evidence for every Off-arm automation thread (overrides targetRollout). */
      allOffRollout?: 'complete' | 'missing' | 'crashed';
      runMutator?: (rows: AutomationRunRow[]) => void;
    };
  } = {}) {
    const root = makeTempDir('codex-trial-harness-records-');
    const policyDir = join(root, 'session-policy');
    const sessionsDir = join(root, 'sessions');
    const costDir = join(root, 'cost-attribution');
    mkdirSync(policyDir, { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
    const entries: Record<string, unknown>[] = [];
    const threadRows: string[] = [];
    for (const arm of ['cheaper', 'full'] as const) {
      for (let n = 0; n < 40; n++) {
        const id = `chat-${arm}-${n}`;
        const path = join(sessionsDir, `${id}.jsonl`);
        writeRollout(path, [0, 1, 2].map((turn) => ({
          startMs: base + turn * 60_000, endMs: base + turn * 60_000 + 30_000, input: arm === 'full' ? 100 : 80,
        })));
        threadRows.push(`('${id}', '${path}', ${Math.floor(base / 1000)})`);
        entries.push({ at, provider: 'codex', threadId: id, instanceId: `inst-${id}`, sessionKind: 'chat',
          level: arm === 'full' ? 'full' : 'economy', arm, armKey: id, armSource: 'instance',
          outputLimit: 6000, postTurnCompactPercent: 70, applied: true });
      }
    }
    const items: QueueItemRow[] = [];
    const costRows: Record<string, unknown>[] = [];
    for (const arm of ['off', 'full'] as const) {
      for (let n = 0; n < 20; n++) {
        const itemId = `item-${arm}-${n}`;
        items.push({ id: itemId, state: 'landed', round: 1, createdAt: base, updatedAt: base + 60_000 });
        for (const [role, input, cacheRead] of [
          ['w', arm === 'off' ? 100 : 150, arm === 'off' ? 500 : 650],
          ['v', arm === 'off' ? 50 : 100, arm === 'off' ? 50 : 100],
        ] as const) {
          const instanceId = `inst-${role}-${itemId}`;
          entries.push({ at, provider: 'codex', threadId: `${role}-${itemId}`, instanceId, sessionKind: 'plan-queue',
            level: arm, arm, armKey: itemId, armSource: 'plan-queue-item',
            outputLimit: 4000, postTurnCompactPercent: 60, applied: true });
          if (instanceId !== options.dropCostFor) {
            // Inside the fixture's --since/--until window: a cost row after
            // --until is not measured (the window-boundary regressions below).
            costRows.push(costRow({ instanceId, input, cacheRead, ts: base + 50, isEstimated: options.estimateRowsFor?.includes(instanceId) }));
          }
        }
      }
    }
    const runs: AutomationRunRow[] = [];
    if (options.automation) {
      for (const arm of ['off', 'full'] as const) {
        for (let n = 0; n < 10; n++) {
          const id = `auto-${arm}-${n}`;
          const failed = arm === 'off' && n >= 8;
          const rollout = arm === 'off'
            ? options.automation.allOffRollout ?? (failed ? options.automation.targetRollout ?? 'complete' : 'complete')
            : 'complete';
          const path = join(sessionsDir, `${id}.jsonl`);
          if (rollout === 'crashed') {
            writeFileSync(path, `{"type":"event_msg","timestamp":${JSON.stringify(new Date(base).toISOString())},"payload":{"type":"task_started"}}\n{"type":`);
          } else if (rollout !== 'missing') {
            writeRollout(path, [{ startMs: base + n * 1_000, endMs: base + n * 1_000 + 500, input: 40 }]);
          }
          // A missing rollout is missing, not unreadable: no file and no state row.
          if (rollout !== 'missing') threadRows.push(`('${id}', '${path}', ${Math.floor(base / 1000)})`);
          entries.push({ at, provider: 'codex', threadId: id, instanceId: `inst-${id}`, sessionKind: 'automation',
            level: arm, arm, armKey: `key-auto-${arm}`, armSource: 'automation',
            outputLimit: 6000, postTurnCompactPercent: 70, applied: true });
          runs.push({ id: `run-${arm}-${n}`, automationId: `key-auto-${arm}`, instanceId: `inst-${id}`,
            status: failed ? 'failed' : 'succeeded', startedAt: base + n * 1_000, finishedAt: base + 60_000 + n * 1_000 });
        }
      }
      options.automation.runMutator?.(runs);
    }
    options.itemMutator?.(items);
    writeFileSync(join(policyDir, '2026-09-01.jsonl'), entries.map((e) => JSON.stringify(e)).join('\n'));
    writeCostDir(costDir, costRows);
    const stateDb = join(root, 'state_5.sqlite');
    // The live threads table carries `created_at` (Unix seconds): the report's
    // spawn cutoff places a helper with it, so the fixture does too.
    execFileSync('sqlite3', [stateDb, `
      CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT, created_at INTEGER);
      CREATE TABLE thread_spawn_edges (parent_thread_id TEXT, child_thread_id TEXT);
      INSERT INTO threads VALUES ${threadRows.join(',')};`]);
    const loopDb = join(root, 'loop-mode.db');
    writeLoopDb(loopDb, items);
    const rlmDb = join(root, 'rlm.db');
    if (options.automation) {
      execFileSync('sqlite3', [rlmDb, `CREATE TABLE automation_runs (id TEXT PRIMARY KEY, automation_id TEXT, instance_id TEXT, status TEXT, started_at INTEGER, finished_at INTEGER);
        ${runs.map((r) => `INSERT INTO automation_runs VALUES ('${r.id}', '${r.automationId}', '${r.instanceId}', '${r.status}', ${r.startedAt}, ${r.finishedAt === null ? 'NULL' : r.finishedAt});`).join('\n')}`]);
    }
    const args = [scriptPath, '--since', '2026-09-01', '--until', options.until ?? '2026-10-01', '--json',
      '--policy-dir', policyDir, '--state-db', stateDb, '--sessions-dir', sessionsDir,
      '--cost-dir', costDir, '--loop-db', loopDb, '--rlm-db', rlmDb];
    return { root, policyDir, sessionsDir, stateDb, loopDb, rlmDb, costDir, args };
  }

  interface HarnessReport {
    unknownItems: string[];
    unknownRollouts: { missing: number; unreadable: number };
    unknownChatThreads: string[];
    chats: Record<string, { threads: number; turns: number }>;
    planQueueArms: Record<string, {
      items: number; decided: number; measuredLanded: number; landed: number; inFlight: number;
      settledAfterWindow: number;
      meanInputPerLandedItem: number | null; medianWallClockMsPerItem: number | null;
    }>;
    settledAfterWindowItems: string[];
    offGraphBreaches: string[];
    kindTable: Record<string, Record<string, {
      threads: number; threadIds: string[]; unmeasuredThreadIds?: string[];
      runs?: { succeeded: number; failed: number; decided: number; unknown: number; settledAfterWindow: number };
    }>>;
    verdict: { harnessWork: string; chats: string; notes: string[] };
  }
  const run = (args: string[]) => {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', env: cliEnv });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as HarnessReport;
  };

  it('reaches both verdicts when plan-queue items have Harness records but no rollouts', () => {
    const report = run(realSituation().args);
    // Soft assertions so a failing run prints every symptom at once.
    expect.soft(report.verdict.harnessWork).toBe('off-justified');
    expect.soft(report.verdict.chats).toBe('cheaper-justified');
    expect.soft(report.unknownItems).toEqual([]);
    expect.soft(report.unknownRollouts).toEqual({ missing: 0, unreadable: 0 });
    expect.soft(report.planQueueArms['off']).toMatchObject({ items: 20, landed: 20, measuredLanded: 20, meanInputPerLandedItem: 700, medianWallClockMsPerItem: 60_000 });
    expect.soft(report.planQueueArms['full']).toMatchObject({ measuredLanded: 20, meanInputPerLandedItem: 1000 });
  });

  it('withholds only the Harness-work verdict when one item has a worker with no cost rows', () => {
    const report = run(realSituation({ dropCostFor: 'inst-w-item-off-0' }).args);
    expect(report.unknownItems).toEqual(['item-off-0']);
    expect(report.verdict.harnessWork).toBe('pending');
    expect(report.verdict.notes.join(' ')).toContain('1 plan-queue item(s) have unknown Harness-record measures');
    // The chat comparison has its own complete sample and is not held back.
    expect(report.verdict.chats).toBe('cheaper-justified');
  });

  it('says how many measured items rest on estimated cost rows without excluding them', () => {
    const report = run(realSituation({ estimateRowsFor: ['inst-w-item-off-0', 'inst-w-item-full-3'] }).args) as HarnessReport & { planQueueArms: Record<string, { estimatedItems: number }> };
    expect(report.planQueueArms['off'].estimatedItems).toBe(1);
    expect(report.planQueueArms['full'].estimatedItems).toBe(1);
    expect(report.verdict.harnessWork).toBe('off-justified');
    expect(report.verdict.notes.join(' ')).toContain('2 measured plan-queue item(s) include estimated');
  });

  it('measures in-flight items as neither unknown nor decided', () => {
    const report = run(realSituation({ itemMutator: (rows) => { rows[0].state = 'verifying'; } }).args);
    expect(report.unknownItems).toEqual([]);
    expect(report.planQueueArms['off']).toMatchObject({ items: 20, decided: 19, landed: 19, measuredLanded: 19 });
    // 19 decided Off items is short of 20, so the Harness-work verdict waits.
    expect(report.verdict.harnessWork).toBe('pending');
    expect(report.verdict.chats).toBe('cheaper-justified');
  });

  it('does not count a queue outcome settled after --until against costs cut off at --until', () => {
    // The verifier's reproduction: 20 items per arm, in-window input costs far
    // cheaper in Off, and none of the items finished by --until. Landing them
    // after the cutoff must not change the report that ends there.
    const fixture = realSituation({ itemMutator: (rows) => { for (const row of rows) row.state = 'verifying'; } });
    const running = run(fixture.args);
    expect(running.planQueueArms['off']).toMatchObject({ items: 20, decided: 0, inFlight: 20, measuredLanded: 0 });
    expect(running.verdict.harnessWork).toBe('pending');

    // Change only the items' DB state: landed, with updated_at after --until.
    execFileSync('sqlite3', [fixture.loopDb,
      `UPDATE plan_queue_items SET state = 'landed', updated_at = ${Date.parse('2026-10-02T00:00:00.000Z')};`]);
    const settled = run(fixture.args);
    // None had finished by the cutoff, so the window still holds no decided item.
    expect(settled.verdict.harnessWork).toBe('pending');
    expect(settled.settledAfterWindowItems).toHaveLength(40);
    for (const arm of ['off', 'full']) {
      expect(settled.planQueueArms[arm]).toMatchObject({
        items: 20, decided: 0, landed: 0, measuredLanded: 0, inFlight: 0, settledAfterWindow: 20,
      });
      expect(settled.planQueueArms[arm].meanInputPerLandedItem).toBeNull();
    }
  });

  it('bounds helper-count records to --until so a later record cannot change a historical verdict', () => {
    const fixture = realSituation();
    const before = run(fixture.args);
    expect(before.offGraphBreaches).toEqual([]);
    expect(before.verdict.harnessWork).toBe('off-justified');

    // One helper-count record dated after --until must not change the report
    // for the window that ends there (the verifier's post-cutoff helper).
    writeFileSync(join(fixture.policyDir, '2026-10-02.jsonl'), JSON.stringify(helperCountRecord({
      at: '2026-10-02T00:00:00.000Z', threadId: 'w-item-off-0', instanceId: 'inst-w-item-off-0', helperThreads: 1,
    })));
    const after = run(fixture.args);
    expect(after.offGraphBreaches).toEqual([]);
    expect(after.verdict.harnessWork).toBe('off-justified');

    // A record inside the window still counts: the bound must not over-restrict.
    writeFileSync(join(fixture.policyDir, '2026-09-15.jsonl'), JSON.stringify(helperCountRecord({
      at: '2026-09-15T00:00:00.000Z', threadId: 'w-item-off-1', instanceId: 'inst-w-item-off-1', helperThreads: 1,
    })));
    const inside = run(fixture.args);
    expect(inside.offGraphBreaches).toEqual(['w-item-off-1']);
    expect(inside.verdict.harnessWork).toBe('pending');
  });

  it('does not let a helper spawned after --until change an earlier fixed window', () => {
    // The verifier's reproduction: one helper whose thread creation and
    // rollout are on 2026-10-02, after this fixture's --until 2026-10-01
    // cutoff. Adding it under a Full chat and then under an Off queue thread
    // changes no policy record, no in-window rollout and no cost row.
    const fixture = realSituation();
    const before = run(fixture.args);
    expect(before.verdict.chats).toBe('cheaper-justified');
    expect(before.verdict.harnessWork).toBe('off-justified');

    const createdSeconds = Math.floor(Date.parse('2026-10-02T10:00:00.000Z') / 1000);
    const helperPath = join(fixture.sessionsDir, 'future-helper.jsonl');
    writeRollout(helperPath, [{
      startMs: Date.parse('2026-10-02T10:00:00.000Z'),
      endMs: Date.parse('2026-10-02T10:01:00.000Z'),
      input: 100,
    }]);
    execFileSync('sqlite3', [fixture.stateDb, `
      INSERT INTO threads VALUES ('future-helper', '${helperPath}', ${createdSeconds});
      INSERT INTO thread_spawn_edges VALUES ('chat-full-0', 'future-helper');`]);
    const underFullChat = run(fixture.args);
    // The post-cutoff helper cannot drop the Full chat out of the measured
    // sample (which would leave 39 roots and flip chats to pending).
    expect(underFullChat.verdict).toEqual(before.verdict);
    expect(underFullChat.chats['full'].threads).toBe(40);
    expect(underFullChat.unknownChatThreads).toEqual([]);

    execFileSync('sqlite3', [fixture.stateDb, `
      DELETE FROM thread_spawn_edges;
      INSERT INTO thread_spawn_edges VALUES ('w-item-off-0', 'future-helper');`]);
    const underOffQueue = run(fixture.args);
    // And it cannot be a false in-window Off helper-spawn breach either: it
    // did not exist inside the window (which would flip Harness work to
    // pending and quarantine item-off-0).
    expect(underOffQueue.verdict).toEqual(before.verdict);
    expect(underOffQueue.offGraphBreaches).toEqual([]);
    expect(underOffQueue.planQueueArms['off']).toMatchObject({ items: 20, decided: 20, measuredLanded: 20 });
  });

  it('applies the choice-2 kind outcome rule at the 35-day fallback, not only on a complete sample', () => {
    // The verifier's reproduction: the same 20-point automation regression
    // (Off 8 succeeded / 2 failed against Full 10 / 0), but one queue item in
    // each arm is still verifying — 19 decided per arm — so the sample never
    // completes and the 35-day fallback chooses Decision 3's defaults.
    const fixture = realSituation({
      until: '2026-10-10',
      automation: {},
      itemMutator: (rows) => { rows[0].state = 'verifying'; rows[20].state = 'verifying'; },
    });
    const report = run(fixture.args);
    expect(report.verdict.harnessWork).toBe('apply-defaults');
    expect(report.planQueueArms['off']).toMatchObject({ items: 20, decided: 19, inFlight: 1 });
    expect(report.planQueueArms['full']).toMatchObject({ items: 20, decided: 19, inFlight: 1 });
    // Step 1d item 4 applies at the fallback too: the degraded kind is named
    // and returns to the chats setting instead of riding the Off default.
    const notes = report.verdict.notes.join(' ');
    expect(notes).toContain('Decision 3 defaults');
    expect(notes).toContain('"automation" completes more than 10 points worse');
    expect(notes).toContain('move it back to the chats setting');
    expect(notes).toContain('their outcomes hold');
  });

  it('does not flag a kind at the 35-day fallback when its outcomes hold', () => {
    const fixture = realSituation({
      until: '2026-10-10',
      automation: { runMutator: (rows) => { for (const row of rows) row.status = 'succeeded'; } },
      itemMutator: (rows) => { rows[0].state = 'verifying'; rows[20].state = 'verifying'; },
    });
    const report = run(fixture.args);
    expect(report.verdict.harnessWork).toBe('apply-defaults');
    expect(report.verdict.notes.join(' ')).toContain('Decision 3 defaults');
    expect(report.verdict.notes.join(' ')).not.toContain('completes more than 10 points worse');
    expect(report.verdict.notes.join(' ')).not.toContain('their outcomes hold');
  });

  it('flags an Off plan-queue thread from the adapter\'s helper count alone, with no spawn edge in Codex\'s database', () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.policyDir, '2026-10-02.jsonl'), JSON.stringify(helperCountRecord({
      at: '2026-10-02T10:00:00.000Z', threadId: 'pq-1', instanceId: 'inst-pq-1', helperThreads: 2,
    })));
    const report = JSON.parse(spawnSync(process.execPath, [
      scriptPath, '--since', '2026-10-01', '--json',
      '--policy-dir', fixture.policyDir, '--state-db', fixture.stateDb, '--sessions-dir', fixture.sessionsDir,
      '--loop-db', fixture.loopDb, '--cost-dir', fixture.costDir, '--rlm-db', fixture.rlmDb,
    ], { encoding: 'utf8', env: cliEnv }).stdout) as HarnessReport & {
      offGraphBreaches: string[]; logEntries: number;
    };
    expect(report.offGraphBreaches).toEqual(['pq-1']);
    expect(report.planQueueArms['off']).toBeUndefined();
    expect(report.verdict.notes.join(' ')).toContain('Off helper spawn breach');
    // The follow-up record is not a policy entry: the fixture's nine policy lines stay nine.
    expect(report.logEntries).toBe(9);
  });

  it('does not call a Full plan-queue thread with helpers a breach', () => {
    const fixture = createFixture();
    writeFileSync(join(fixture.policyDir, '2026-10-02.jsonl'), JSON.stringify(helperCountRecord({
      at: '2026-10-02T10:00:00.000Z', threadId: 'pq-2', instanceId: 'inst-pq-2', helperThreads: 4,
    })));
    const report = JSON.parse(spawnSync(process.execPath, [
      scriptPath, '--since', '2026-10-01', '--json',
      '--policy-dir', fixture.policyDir, '--state-db', fixture.stateDb, '--sessions-dir', fixture.sessionsDir,
      '--loop-db', fixture.loopDb, '--cost-dir', fixture.costDir, '--rlm-db', fixture.rlmDb,
    ], { encoding: 'utf8', env: cliEnv }).stdout) as HarnessReport & { offGraphBreaches: string[] };
    expect(report.offGraphBreaches).toEqual([]);
    expect(report.planQueueArms['full']).toMatchObject({ measuredLanded: 1 });
  });

  describe('automation-run outcomes for the choice 2 quality rule', () => {
    it('warns when Off automation outcomes are more than 10 points worse even with incomplete token rollouts', () => {
      // The two failed Off runs' threads have crash-truncated rollouts, so the
      // token columns cannot measure them — but their authoritative failed
      // outcomes are known and must reach the quality comparison, exactly as
      // the child outcome path keeps its failures.
      const report = run(realSituation({ automation: { targetRollout: 'crashed' } }).args);
      expect(report.kindTable['automation']['off']).toMatchObject({
        threads: 8,
        unmeasuredThreadIds: ['auto-off-8', 'auto-off-9'],
        runs: { succeeded: 8, failed: 2, decided: 10, unknown: 0, settledAfterWindow: 0 },
      });
      expect(report.kindTable['automation']['full']).toMatchObject({
        threads: 10,
        runs: { succeeded: 10, failed: 0, decided: 10, unknown: 0, settledAfterWindow: 0 },
      });
      expect(report.verdict.notes.join(' ')).toContain('"automation" completes more than 10 points worse');
    });

    it('prints known automation failures with unknown token measures when the whole Off arm has no measured rollout', () => {
      const fixture = realSituation({ automation: { allOffRollout: 'missing' } });
      const report = run(fixture.args);
      expect(report.kindTable['automation']['off']).toMatchObject({
        threads: 0, threadIds: [],
        runs: { succeeded: 8, failed: 2, decided: 10, unknown: 0, settledAfterWindow: 0 },
      });
      expect(report.kindTable['automation']['off'].unmeasuredThreadIds).toHaveLength(10);
      expect(report.verdict.notes.join(' ')).toContain('"automation" completes more than 10 points worse');
      const text = spawnSync(process.execPath, [
        scriptPath, '--since', '2026-09-01', '--until', '2026-10-01',
        '--policy-dir', fixture.policyDir, '--state-db', fixture.stateDb, '--sessions-dir', fixture.sessionsDir,
        '--cost-dir', fixture.costDir, '--loop-db', fixture.loopDb, '--rlm-db', fixture.rlmDb,
      ], { encoding: 'utf8', env: cliEnv });
      expect(text.status).toBe(0);
      expect(text.stdout).toContain('| automation | off | 0 | 0 | — | 0/0 | 8/2/0 | — | — |');
    });

    it('does not change the fixed-window recommendation for automation outcomes settled after --until', () => {
      // The verifier's reproduction shape: none of the runs has finished by
      // --until. Settling them after the cutoff must leave the window's
      // recommendation exactly as it was while they were still running.
      const fixture = realSituation({
        automation: { runMutator: (rows) => { for (const row of rows) { row.status = 'running'; row.finishedAt = null; } } },
      });
      const running = run(fixture.args);
      expect(running.kindTable['automation']['off'].runs).toMatchObject({ succeeded: 0, failed: 0, decided: 0 });
      expect(running.verdict.notes.join(' ')).not.toContain('"automation" completes more than 10 points worse');

      execFileSync('sqlite3', [fixture.rlmDb, `
        UPDATE automation_runs SET status = CASE WHEN id IN ('run-off-8', 'run-off-9') THEN 'failed' ELSE 'succeeded' END,
          finished_at = ${Date.parse('2026-10-02T00:00:00.000Z')};`]);
      const settled = run(fixture.args);
      // The headline oracle: the recommendation the window ends with must not
      // move when outcomes settle after its cutoff.
      expect(settled.verdict).toEqual(running.verdict);
      for (const arm of ['off', 'full']) {
        expect(settled.kindTable['automation'][arm].runs).toEqual({
          succeeded: 0, failed: 0, decided: 0, unknown: 0, settledAfterWindow: 10,
        });
      }
      expect(settled.verdict.notes.join(' ')).not.toContain('"automation" completes more than 10 points worse');
    });

    it('keeps automation runs with unusable decision timestamps explicitly unknown and withholds the comparison', () => {
      const report = run(realSituation({
        automation: { runMutator: (rows) => { for (const row of rows) row.finishedAt = null; } },
      }).args);
      expect(report.kindTable['automation']['off'].runs).toEqual({
        succeeded: 0, failed: 0, decided: 0, unknown: 10, settledAfterWindow: 0,
      });
      expect(report.kindTable['automation']['full'].runs).toEqual({
        succeeded: 0, failed: 0, decided: 0, unknown: 10, settledAfterWindow: 0,
      });
      expect(report.verdict.notes.join(' ')).toContain('Automation outcome comparison unknown');
      expect(report.verdict.notes.join(' ')).not.toContain('"automation" completes more than 10 points worse');
    });
  });
});
