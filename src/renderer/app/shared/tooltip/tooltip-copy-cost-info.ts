import type { TooltipCopyEntry } from './tooltip-copy';

export const COST_INFO_COPY = {
  'cost.estimatedTotal': {
    label: 'Includes estimates',
    meaning: 'Total includes one or more estimated entries — not a fully measured figure',
  },
  'cost.estimatedEntry': {
    label: 'Estimated entry',
    meaning: 'No provider-reported usage for this turn — tokens/cost are a heuristic estimate',
  },
} as const satisfies Record<string, TooltipCopyEntry>;
