/**
 * Human-readable schedule labels for automations.
 *
 * Renders a standard 5-field cron expression (minute hour day-of-month month
 * day-of-week) into a short label like "Daily at 20:00", "Weekdays at 9:00",
 * or "Every 30 minutes". Falls back to the raw expression for shapes it does
 * not recognise, so it never lies about what an automation will do.
 */

import type { AutomationSchedule } from '../../../../shared/types/automation.types';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Format an hour/minute pair like the reference UI: unpadded hour, padded minute. */
function formatTime(hour: number, minute: number): string {
  return `${hour}:${String(minute).padStart(2, '0')}`;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** Parse a single numeric cron field, returning null if it is not a plain integer. */
function asInt(field: string): number | null {
  if (!/^\d+$/.test(field)) return null;
  return Number.parseInt(field, 10);
}

/**
 * Describe a 5-field cron expression in plain English. Returns null when the
 * expression does not match a known friendly shape (caller should fall back to
 * the raw expression).
 */
export function describeCron(expression: string): string | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields;

  // Every N minutes — "*/15 * * * *"
  const minuteStep = /^\*\/(\d+)$/.exec(minute);
  if (minuteStep && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const n = Number.parseInt(minuteStep[1], 10);
    return n === 1 ? 'Every minute' : `Every ${n} minutes`;
  }

  // Every N hours — "0 */2 * * *"
  const hourStep = /^\*\/(\d+)$/.exec(hour);
  if (asInt(minute) === 0 && hourStep && dom === '*' && month === '*' && dow === '*') {
    const n = Number.parseInt(hourStep[1], 10);
    return n === 1 ? 'Every hour' : `Every ${n} hours`;
  }

  // Hourly — "0 * * * *"
  if (asInt(minute) === 0 && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return 'Every hour';
  }

  const minuteVal = asInt(minute);
  const hourVal = asInt(hour);
  // Anything below here needs a concrete time of day.
  if (minuteVal === null || hourVal === null) return null;
  const time = formatTime(hourVal, minuteVal);

  // Daily — "0 9 * * *"
  if (dom === '*' && month === '*' && dow === '*') {
    return `Daily at ${time}`;
  }

  // Day-of-week based schedules (day-of-month must be wildcard).
  if (dom === '*' && month === '*') {
    if (dow === '1-5') return `Weekdays at ${time}`;
    if (dow === '0,6' || dow === '6,0' || dow === '6,7' || dow === '7,6') return `Weekends at ${time}`;
    const dowVal = asInt(dow);
    if (dowVal !== null && dowVal >= 0 && dowVal <= 7) {
      return `Weekly on ${DAY_NAMES[dowVal % 7]} at ${time}`;
    }
    return null;
  }

  // Monthly on a fixed day — "0 9 15 * *"
  const domVal = asInt(dom);
  if (domVal !== null && month === '*' && dow === '*') {
    return `Monthly on the ${ordinal(domVal)} at ${time}`;
  }

  return null;
}

/** Full schedule label for an automation, including the one-time case. */
export function describeSchedule(schedule: AutomationSchedule): string {
  if (schedule.type === 'oneTime') {
    const when = new Date(schedule.runAt);
    if (Number.isNaN(when.getTime())) return 'Once';
    const date = when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return `Once on ${date} at ${time}`;
  }
  return describeCron(schedule.expression) ?? schedule.expression;
}
