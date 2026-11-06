/**
 * A15 / 8f — how often a schedule would start new AI sessions.
 *
 * `estimateDailyRuns` returns the busiest single day's fire count over the
 * next 7 days, so a weekday-only job created on a Saturday is still measured
 * at its weekday cadence. Used by the agent-facing cadence guard (a firm
 * reminder to ask James above {@link AGENT_AUTOMATION_MAX_RUNS_PER_DAY}) and
 * by the Automations form's live "Starts the AI about N times a day" line.
 */

import { Cron } from 'croner';
import type { AutomationSchedule } from '../types/automation.types';

export const AGENT_AUTOMATION_MAX_RUNS_PER_DAY = 24;

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const HORIZON_MS = 7 * DAY_MS;
/** Hard bound so a pathological cron can never spin unbounded. */
const MAX_OCCURRENCES = 20_000;
/** How far apart to look for a change of UTC offset; real changes are months apart. */
const OFFSET_SCAN_STEP_MS = 3 * HOUR_MS;
/**
 * A schedule with no seconds field fires on whole minutes, and croner skips
 * the repeated hour when clocks go back, so no local day holds more than 1,440
 * of its fires. Once a day reaches that, no later day can beat it.
 */
const MAX_MINUTE_SCHEDULE_RUNS_PER_DAY = 1440;
/** Extra margin around a daylight saving change, on top of the size of the jump. */
const CHANGE_WINDOW_SLACK_MS = 15 * MINUTE_MS;

/*
 * croner's timezone mode costs about 90 microseconds a step, so counting a
 * week of an every-minute schedule took over a second. croner's fixed
 * `utcOffset` mode costs about a microsecond and gives the same fire times
 * wherever the offset is not changing. So the week is cut at each daylight
 * saving change: far from a change, croner runs with the fixed offset in
 * force; in a short window around a change, where croner applies its own
 * rules for the skipped and repeated hour, it still runs in timezone mode.
 */

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();

function offsetFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = offsetFormatters.get(timezone);
  if (!formatter) {
    // Throws RangeError for an unknown timezone, before anything is cached.
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    if (offsetFormatters.size >= 64) offsetFormatters.clear();
    offsetFormatters.set(timezone, formatter);
  }
  return formatter;
}

/** UTC offset of `timezone` at `instant`, in minutes east of UTC. */
function offsetMinutesAt(timezone: string, instant: number): number {
  const parts: Record<string, number> = {};
  for (const part of offsetFormatter(timezone).formatToParts(new Date(instant))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  const wallAsUtc = Date.UTC(
    parts['year'],
    parts['month'] - 1,
    parts['day'],
    parts['hour'] % 24,
    parts['minute'],
    parts['second'],
  );
  return Math.round((wallAsUtc - Math.floor(instant / 1000) * 1000) / MINUTE_MS);
}

interface OffsetChange {
  /** First instant on the new offset. */
  at: number;
  before: number;
  after: number;
}

/** Offset changes inside [from, to], found by scanning and then bisecting. */
function findOffsetChanges(timezone: string, from: number, to: number): OffsetChange[] {
  const changes: OffsetChange[] = [];
  let previousAt = from;
  let previous = offsetMinutesAt(timezone, from);
  for (let t = from; t < to; ) {
    t = Math.min(t + OFFSET_SCAN_STEP_MS, to);
    const current = offsetMinutesAt(timezone, t);
    if (current === previous) {
      previousAt = t;
      continue;
    }
    let low = previousAt; // still on `previous`
    let high = t; // on the new offset
    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);
      if (offsetMinutesAt(timezone, middle) === previous) low = middle;
      else high = middle;
    }
    changes.push({ at: high, before: previous, after: current });
    previous = current;
    previousAt = t;
  }
  return changes;
}

interface Piece {
  /** Fires strictly after `from` and at or before `to`. */
  from: number;
  to: number;
  /** Fixed offset in minutes, or null for croner's own timezone handling. */
  offsetMinutes: number | null;
  /** Offset change this piece sits next to, for local-day keys in timezone mode. */
  change?: OffsetChange;
}

function planPieces(timezone: string, now: number, until: number): Piece[] {
  // A change this close to the week's edges can still move fires inside it.
  const margin = 6 * HOUR_MS;
  const changes = findOffsetChanges(timezone, now - margin, until + margin);
  const pieces: Piece[] = [];
  let position = now;
  let offset = offsetMinutesAt(timezone, now);
  for (const change of changes) {
    const padding = Math.abs(change.after - change.before) * MINUTE_MS + CHANGE_WINDOW_SLACK_MS;
    const windowStart = change.at - padding;
    const windowEnd = change.at + padding;
    if (windowEnd <= position) {
      offset = change.after;
      continue;
    }
    if (windowStart >= until) break;
    if (windowStart > position) {
      pieces.push({ from: position, to: windowStart, offsetMinutes: change.before });
    }
    pieces.push({
      from: Math.max(position, windowStart),
      to: Math.min(windowEnd, until),
      offsetMinutes: null,
      change,
    });
    position = Math.min(windowEnd, until);
    offset = change.after;
  }
  if (position < until) pieces.push({ from: position, to: until, offsetMinutes: offset });
  return pieces;
}

export function estimateDailyRuns(schedule: AutomationSchedule, now: Date = new Date()): number {
  if (schedule.type === 'oneTime') {
    return schedule.runAt > now.getTime() ? 1 : 0;
  }

  const { expression, timezone } = schedule;
  // Built first so a bad expression or timezone fails exactly as it always did.
  const zoned = new Cron(expression, { timezone, paused: true });
  const fixedOffsetCrons: Cron[] = [];
  try {
    const start = now.getTime();
    const until = start + HORIZON_MS;
    // An empty timezone is croner's system zone; days were then keyed in UTC.
    const pieces: Piece[] = timezone
      ? planPieces(timezone, start, until)
      : [{ from: start, to: until, offsetMinutes: null }];
    const counts = new Map<number, number>();
    const perDayCeiling = expression.trim().split(/\s+/).length <= 5
      ? MAX_MINUTE_SCHEDULE_RUNS_PER_DAY
      : Number.POSITIVE_INFINITY;
    let fires = 0;
    let busiest = 0;
    const settled = (): boolean => fires >= MAX_OCCURRENCES || busiest >= perDayCeiling;
    for (const piece of pieces) {
      if (settled()) break;
      let cron = zoned;
      if (piece.offsetMinutes !== null) {
        cron = new Cron(expression, { utcOffset: piece.offsetMinutes, paused: true });
        fixedOffsetCrons.push(cron);
      }
      let cursor = new Date(piece.from);
      while (!settled()) {
        const next = cron.nextRun(cursor);
        if (!next || next.getTime() > piece.to) break;
        const instant = next.getTime();
        const { change } = piece;
        const offsetMinutes = piece.offsetMinutes
          ?? (change ? (instant >= change.at ? change.after : change.before) : 0);
        // Local calendar day number: the same day gives the same key in every piece.
        const key = Math.floor((instant + offsetMinutes * MINUTE_MS) / DAY_MS);
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        if (count > busiest) busiest = count;
        fires += 1;
        cursor = next;
      }
    }
    return busiest;
  } finally {
    zoned.stop();
    for (const cron of fixedOffsetCrons) cron.stop();
  }
}

/**
 * The agent-facing 8f guard, shared by the `create_automation` /
 * `update_automation` tools and the marker `create_automation` command. It is a
 * firm instruction, not a lock: only a literal `true` counts as confirmation,
 * and the agent sets that flag itself after asking James. `confirmationHint`
 * tells the caller's agent where the flag goes in its own command shape.
 */
export function assertAgentCadenceAllowed(
  schedule: AutomationSchedule,
  confirmedByUser: unknown,
  confirmationHint?: string,
): void {
  const estimate = estimateDailyRuns(schedule);
  if (estimate <= AGENT_AUTOMATION_MAX_RUNS_PER_DAY || confirmedByUser === true) return;
  throw new Error(
    `This schedule would start a new AI session about ${estimate} times a day. Each session re-reads `
    + `James's setup before it does anything, so frequent schedules cost a lot. Choose one of these: `
    + `use a slower schedule; or ask James whether he wants this many runs and, once he says yes in `
    + `this chat, call again with confirmedByUser: true; or suggest that James adds a check on the `
    + `Automations page so the AI only starts when something has changed.`
    + (confirmationHint ? ` ${confirmationHint}` : ''),
  );
}
