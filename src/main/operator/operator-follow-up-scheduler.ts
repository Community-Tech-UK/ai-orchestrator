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
      runAt: nextLocalWallClock(options.now, 1, 9, 0),
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

function nextLocalWallClock(now: number, daysFromNow: number, hour: number, minute: number): number {
  const date = new Date(now);
  date.setDate(date.getDate() + daysFromNow);
  date.setHours(hour, minute, 0, 0);
  return date.getTime();
}

function defaultTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength - 1).trimEnd() : value;
}
