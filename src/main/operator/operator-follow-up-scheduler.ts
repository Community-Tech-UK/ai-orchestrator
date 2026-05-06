import type {
  Automation,
  AutomationSchedule,
  CreateAutomationInput,
} from '../../shared/types/automation.types';
import type {
  OperatorProjectRecord,
  OperatorRunGraph,
} from '../../shared/types/operator.types';
import { createAutomationWithScheduling } from '../automations/automation-create-service';

export type OperatorFollowUpScheduleResult =
  | {
      status: 'created';
      automationId: string;
      name: string;
      schedule: AutomationSchedule;
    }
  | {
      status: 'skipped';
      reason: string;
    };

export interface OperatorFollowUpSchedulerConfig {
  createAutomation?: (input: CreateAutomationInput) => Promise<Automation | null>;
  now?: () => number;
  timezone?: string;
}

export class OperatorFollowUpScheduler {
  private readonly createAutomation: (input: CreateAutomationInput) => Promise<Automation | null>;
  private readonly now: () => number;
  private readonly timezone: string;

  constructor(config: OperatorFollowUpSchedulerConfig = {}) {
    this.createAutomation = config.createAutomation ?? createAutomationWithScheduling;
    this.now = config.now ?? Date.now;
    this.timezone = config.timezone ?? defaultTimezone();
  }

  async schedule(input: {
    graph: OperatorRunGraph;
    projects: OperatorProjectRecord[];
  }): Promise<OperatorFollowUpScheduleResult> {
    const schedule = parseOperatorFollowUpSchedule(input.graph.run.goal, {
      now: this.now(),
      timezone: this.timezone,
    });
    if (!schedule) {
      return {
        status: 'skipped',
        reason: 'no-explicit-schedule',
      };
    }

    const automationInput = buildAutomationInput(input.graph, input.projects, schedule);
    const automation = await this.createAutomation(automationInput);
    if (!automation) {
      return {
        status: 'skipped',
        reason: 'automation-create-returned-null',
      };
    }

    return {
      status: 'created',
      automationId: automation.id,
      name: automation.name,
      schedule: automation.schedule,
    };
  }
}

export function getOperatorFollowUpScheduler(): OperatorFollowUpScheduler {
  return new OperatorFollowUpScheduler();
}

export function parseOperatorFollowUpSchedule(
  text: string,
  options: {
    now: number;
    timezone: string;
  },
): AutomationSchedule | null {
  const normalized = text.toLowerCase();
  const intervalMatch = normalized.match(/\bin\s+(\d{1,3})\s+(minutes?|hours?|days?)\b/);
  if (intervalMatch) {
    const amount = Number(intervalMatch[1]);
    const unit = intervalMatch[2];
    const multiplier = unit.startsWith('minute')
      ? 60 * 1000
      : unit.startsWith('hour')
        ? 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;
    return {
      type: 'oneTime',
      runAt: options.now + amount * multiplier,
      timezone: options.timezone,
    };
  }

  if (/\btomorrow\b/.test(normalized)) {
    return {
      type: 'oneTime',
      runAt: nextWallClockInTimezone(options.now, 1, 9, 0, options.timezone),
      timezone: options.timezone,
    };
  }

  const everyMinutesMatch = normalized.match(/\bevery\s+(\d{1,2})\s+minutes?\b/);
  if (everyMinutesMatch) {
    const minutes = Number(everyMinutesMatch[1]);
    if (minutes >= 1 && minutes <= 59) {
      return {
        type: 'cron',
        expression: minutes === 1 ? '* * * * *' : `*/${minutes} * * * *`,
        timezone: options.timezone,
      };
    }
  }

  const everyHoursMatch = normalized.match(/\bevery\s+(\d{1,2})\s+hours?\b/);
  if (everyHoursMatch) {
    const hours = Number(everyHoursMatch[1]);
    if (hours >= 1 && hours <= 23) {
      return {
        type: 'cron',
        expression: hours === 1 ? '0 * * * *' : `0 */${hours} * * *`,
        timezone: options.timezone,
      };
    }
  }

  if (/\b(daily|every day|every morning)\b/.test(normalized)) {
    return {
      type: 'cron',
      expression: '0 9 * * *',
      timezone: options.timezone,
    };
  }

  if (/\b(weekly|every week)\b/.test(normalized)) {
    return {
      type: 'cron',
      expression: '0 9 * * 1',
      timezone: options.timezone,
    };
  }

  return null;
}

function buildAutomationInput(
  graph: OperatorRunGraph,
  projects: OperatorProjectRecord[],
  schedule: AutomationSchedule,
): CreateAutomationInput {
  const primaryProject = projects[0];
  const projectLines = projects.map((project) => `- ${project.displayName}: ${project.canonicalPath}`);
  return {
    name: truncate(`Operator follow-up: ${graph.run.title}`, 200),
    description: truncate(`Created from operator run ${graph.run.id}`, 1000),
    enabled: true,
    schedule,
    missedRunPolicy: 'notify',
    concurrencyPolicy: 'skip',
    action: {
      prompt: [
        `Follow up on operator run "${graph.run.title}".`,
        '',
        `Original goal: ${graph.run.goal}`,
        projects.length > 0 ? ['Projects:', ...projectLines].join('\n') : '',
        '',
        'Check the current state, summarize anything important, and call out any action needed.',
      ].filter(Boolean).join('\n'),
      workingDirectory: primaryProject?.canonicalPath ?? process.cwd(),
      provider: 'auto',
    },
  };
}

function nextWallClockInTimezone(
  now: number,
  daysFromNow: number,
  hour: number,
  minute: number,
  timezone: string,
): number {
  const current = zonedDateParts(now, timezone);
  return zonedWallClockToUtc({
    year: current.year,
    month: current.month,
    day: current.day + daysFromNow,
    hour,
    minute,
    timezone,
  });
}

function zonedWallClockToUtc(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timezone: string;
}): number {
  const targetAsUtc = Date.UTC(input.year, input.month - 1, input.day, input.hour, input.minute, 0, 0);
  let guess = targetAsUtc;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = zonedDateParts(guess, input.timezone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
      0,
    );
    const offset = targetAsUtc - actualAsUtc;
    if (offset === 0) {
      return guess;
    }
    guess += offset;
  }

  return guess;
}

function zonedDateParts(timestamp: number, timezone: string): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(timestamp));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    second: value('second'),
  };
}

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength - 1).trimEnd() : value;
}
