import type { TooltipCopyEntry } from './tooltip-copy';

export const AUTOMATIONS_COPY = {
  'automations.hidden': {
    label: 'Hidden',
    meaning:
      "Keeps this automation's sessions out of the project rail. Runs still appear here with their full output, and a run that fails or stops for permission is always shown in the rail.",
  },
} as const satisfies Record<string, TooltipCopyEntry>;

