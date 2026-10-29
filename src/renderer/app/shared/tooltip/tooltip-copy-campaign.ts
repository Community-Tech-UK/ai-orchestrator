import type { TooltipCopyEntry } from './tooltip-copy';

export const CAMPAIGN_COPY = {
  'campaign.run': {
    label: 'Run',
    meaning: 'Run campaign',
  },
  'campaign.halt': {
    label: 'Halt',
    meaning: 'Halt campaign',
  },
} as const satisfies Record<string, TooltipCopyEntry>;
