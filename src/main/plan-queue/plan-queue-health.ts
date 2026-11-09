/**
 * Queue health: the measures behind the Plan Queue page's "Queue health" summary and `plan_queue_status`.
 *
 * Everything here is computed from stored rows (items, state-change events, verdicts and the timing events of
 * `plan-queue-timings.ts`); nothing is kept in memory. Counting rules, chosen so the numbers match the baseline
 * recorded in the Phase 2 plan:
 *  - An attempt is an item that reached `preparing` inside the window. Only finished attempts count (landed or
 *    parked): work still in flight is not held against the queue, and a document James skipped is his decision, not an outcome.
 *  - A pass not landed is a finished attempt with a PASS verdict that ended parked.
 *  - Time spent working is the finished steps (preparing, working, fixing, verifying, landing); time spent waiting is
 *    the recorded slot waits and usage waits. A step or wait still in progress is not counted until it ends.
 */
import type { SqliteDriver } from '../db/sqlite-driver';
import type { PlanQueueHealth } from '@contracts/schemas/plan-queue';
import { IS_TIMING_SQL, NOT_TIMING_SQL, notTimingSql, TIMING_REASONS } from './plan-queue-timings';

export const HEALTH_WINDOW_DAYS = 14;
const DAY_MS = 24 * 60 * 60_000;
const MAX_REPEAT_FAILING_TESTS = 5;
const LATE_ROUND = 3;
const WORKING_STATES: ReadonlySet<string> = new Set(['preparing', 'working', 'fixing', 'verifying', 'landing']);

export interface HealthItemRow { id: string; sourceRef: string; state: string }
export interface HealthVerdictRow { itemId: string; verdict: string; gates: string; round: number; findings: string }
export interface HealthStateRow { itemId: string; at: number; toState: string }
export interface HealthTimingRow { itemId: string; at: number; reason: string; detail: string | null }
export interface HealthInput {
  now: number;
  windowDays: number;
  /** Items that reached `preparing` inside the window. */
  items: readonly HealthItemRow[];
  /** Verdicts of those items, oldest first. */
  verdicts: readonly HealthVerdictRow[];
  /** State-change events of those items, oldest first per item. */
  states: readonly HealthStateRow[];
  /** Timing events inside the window, oldest first. */
  timings: readonly HealthTimingRow[];
}

const WORKED_ITEMS_SQL = `SELECT i.id FROM plan_queue_items i
  WHERE (SELECT MIN(e.at) FROM plan_queue_item_events e WHERE e.item_id = i.id AND e.to_state = 'preparing' AND ${notTimingSql('e.reason')}) >= ?`;

/** Read the rows for the window and compute the measures. */
export function readQueueHealth(db: SqliteDriver, now: number, windowDays = HEALTH_WINDOW_DAYS): PlanQueueHealth {
  const since = now - windowDays * DAY_MS;
  const items = db.prepare(`SELECT id, document_path AS sourceRef, state FROM plan_queue_items WHERE id IN (${WORKED_ITEMS_SQL})`)
    .all<HealthItemRow>(since);
  const verdicts = db.prepare(`SELECT item_id AS itemId, verdict, gates_json AS gates, round, findings_json AS findings FROM plan_queue_verdicts
    WHERE item_id IN (${WORKED_ITEMS_SQL}) ORDER BY at, rowid`).all<HealthVerdictRow>(since);
  const states = db.prepare(`SELECT item_id AS itemId, at, to_state AS toState FROM plan_queue_item_events
    WHERE item_id IN (${WORKED_ITEMS_SQL}) AND ${NOT_TIMING_SQL} ORDER BY item_id, at, rowid`).all<HealthStateRow>(since);
  const timings = db.prepare(`SELECT item_id AS itemId, at, reason, detail_head AS detail FROM plan_queue_item_events
    WHERE ${IS_TIMING_SQL} AND at >= ? ORDER BY at, rowid`).all<HealthTimingRow>(since);
  return computeQueueHealth({ now, windowDays, items, verdicts, states, timings });
}

function share(count: number, of: number) { return { count, of, share: of ? count / of : null }; }

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function sum(values: readonly number[]): number { return values.reduce((total, value) => total + value, 0); }

function parse(detail: string | null): Record<string, unknown> | null {
  if (!detail) return null;
  try {
    const value: unknown = JSON.parse(detail);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function numbers(rows: readonly (Record<string, unknown> | null)[], key: string): number[] {
  return rows.flatMap(row => typeof row?.[key] === 'number' && Number.isFinite(row[key]) ? [row[key] as number] : []);
}

/** One test failing for unrelated documents points at the test or the computer, not at the work. Measured only. */
function repeatFailingTests(input: HealthInput): PlanQueueHealth['repeatFailingTests'] {
  const documents = new Map(input.items.map(item => [item.id, item.sourceRef]));
  const failedIn = new Map<string, Set<string>>();
  for (const row of input.verdicts) {
    const gates = JSON.parse(row.gates) as { timedOut?: boolean; failingTests?: string[] }[];
    for (const test of gates.flatMap(gate => gate.timedOut ? [] : gate.failingTests ?? [])) {
      failedIn.set(test, (failedIn.get(test) ?? new Set<string>()).add(documents.get(row.itemId)!));
    }
  }
  return [...failedIn].filter(([, jobs]) => jobs.size > 1).map(([test, jobs]) => ({ test, jobs: jobs.size }))
    .sort((a, b) => b.jobs - a.jobs || a.test.localeCompare(b.test)).slice(0, MAX_REPEAT_FAILING_TESTS);
}

/** Whether late rounds still find things worth blocking on (Decision 4). A finding repeated from an earlier round isn't new. */
function lateFindings(verdicts: readonly HealthVerdictRow[]): PlanQueueHealth['lateFindings'] {
  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  const seen = new Map<string, Set<string>>();
  for (const row of verdicts) {
    const known = seen.get(row.itemId) ?? new Set<string>();
    seen.set(row.itemId, known);
    for (const { id, severity } of JSON.parse(row.findings) as { id: string; severity: keyof typeof counts }[]) {
      if (!known.has(id) && row.round >= LATE_ROUND) counts[severity] += 1;
      known.add(id);
    }
  }
  return counts;
}

/** Pure: the same rows always give the same answer. */
export function computeQueueHealth(input: HealthInput): PlanQueueHealth {
  const settled = input.items.filter(item => item.state === 'landed' || item.state === 'parked');
  const landed = settled.filter(item => item.state === 'landed');
  const documents = new Set(settled.map(item => item.sourceRef));
  const landedDocuments = new Set(landed.map(item => item.sourceRef));

  const verdictsByItem = new Map<string, string[]>();
  for (const row of input.verdicts) verdictsByItem.set(row.itemId, [...(verdictsByItem.get(row.itemId) ?? []), row.verdict]);
  const checked = settled.filter(item => verdictsByItem.has(item.id));
  const passed = settled.filter(item => verdictsByItem.get(item.id)?.includes('PASS'));
  const setAside = settled.filter(item => item.state === 'parked');

  const bodies = (reason: string) => input.timings.filter(row => row.reason === reason).map(row => parse(row.detail));
  const slotWaits = bodies(TIMING_REASONS.slotWait);
  const usageWaits = bodies(TIMING_REASONS.usageWait);
  const landings = bodies(TIMING_REASONS.landing).filter(body => body?.['outcome'] === 'landed');

  // A checker's session runs from its start row to the first end row for the same session.
  const checkerStarts = new Map<string, number>();
  const checkMs: number[] = [];
  const sessionRows = input.timings.filter(row => row.reason === TIMING_REASONS.sessionStart || row.reason === TIMING_REASONS.sessionEnd);
  for (const row of sessionRows) {
    const body = parse(row.detail);
    const id = typeof body?.['instanceId'] === 'string' ? body['instanceId'] : null;
    if (!id || body?.['role'] !== 'checker') continue;
    if (row.reason === TIMING_REASONS.sessionStart) checkerStarts.set(id, row.at);
    else if (checkerStarts.has(id)) { checkMs.push(Math.max(0, row.at - checkerStarts.get(id)!)); checkerStarts.delete(id); }
  }

  let workingMs = 0;
  const lastByItem = new Map<string, { at: number; state: string }>();
  for (const row of input.states) {
    const last = lastByItem.get(row.itemId);
    if (last && WORKING_STATES.has(last.state)) workingMs += Math.max(0, row.at - last.at);
    lastByItem.set(row.itemId, { at: row.at, state: row.toState });
  }
  const waitingMs = sum(numbers(slotWaits, 'waitedMs')) + sum(numbers(usageWaits, 'waitedMs'));
  const phase = (key: string) => median(numbers(landings, key));

  return {
    windowDays: input.windowDays,
    since: input.now - input.windowDays * DAY_MS,
    attemptsLanded: share(landed.length, settled.length),
    documentsLanded: share(landedDocuments.size, documents.size),
    passesNotLanded: share(passed.filter(item => item.state === 'parked').length, passed.length),
    firstCheckPassed: share(checked.filter(item => verdictsByItem.get(item.id)![0] === 'PASS').length, checked.length),
    freeSlotToStart: { count: numbers(slotWaits, 'freeToStartMs').length, medianMs: median(numbers(slotWaits, 'freeToStartMs')) },
    checkTime: { count: checkMs.length, medianMs: median(checkMs) },
    landingTime: { count: landings.length, medianMs: phase('totalMs'), syncMs: phase('syncMs'), mergeCheckMs: phase('mergeCheckMs'),
      commitCheckMs: phase('commitCheckMs'), publishMs: phase('publishMs') },
    waiting: { waitingMs, workingMs, share: waitingMs + workingMs ? waitingMs / (waitingMs + workingMs) : null },
    setAsideRounds: { items: setAside.length, rounds: sum(setAside.map(item => verdictsByItem.get(item.id)?.length ?? 0)) },
    repeatFailingTests: repeatFailingTests(input),
    lateFindings: lateFindings(input.verdicts),
  };
}
