import { Cron } from 'croner';
import type { AutomationSchedule } from '../../shared/types/automation.types';

export function computeNextFireAt(schedule: AutomationSchedule, after: number): number | null {
  if (schedule.type === 'oneTime') {
    return schedule.runAt > after ? schedule.runAt : null;
  }

  const cron = new Cron(schedule.expression, {
    timezone: schedule.timezone,
    paused: true,
  });
  try {
    return cron.nextRun(new Date(after))?.getTime() ?? null;
  } finally {
    cron.stop();
  }
}

export function computeMissedFireTimes(
  schedule: AutomationSchedule,
  since: number,
  until: number,
  maxRuns = 50,
): number[] {
  if (until <= since) {
    return [];
  }

  if (schedule.type === 'oneTime') {
    return schedule.runAt > since && schedule.runAt <= until ? [schedule.runAt] : [];
  }

  const cron = new Cron(schedule.expression, {
    timezone: schedule.timezone,
    paused: true,
  });
  try {
    return cron
      .previousRuns(maxRuns, new Date(until))
      .map((date) => date.getTime())
      .filter((time) => time > since && time <= until)
      .sort((a, b) => a - b);
  } finally {
    cron.stop();
  }
}

export function validateCronExpression(expression: string, timezone: string): Date | null {
  const cron = new Cron(expression, {
    timezone,
    paused: true,
  });
  try {
    return cron.nextRun(new Date());
  } finally {
    cron.stop();
  }
}
