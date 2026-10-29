import type { TooltipCopyEntry } from './tooltip-copy';

export const ROLLING_INSTANCE_COPY = {
  'skills.badge': {
    label: 'Active skills',
    meaning: 'Skills injected into this session — click for details',
  },
  'skills.disable': {
    label: 'Disable',
    meaning: 'Disable this skill everywhere (takes effect next turn)',
  },
  'skills.enable': {
    label: 'Enable',
    meaning: 'Re-enable this skill',
  },
  'compaction.confirmBlocked': {
    label: 'Confirm',
    meaning: "Compaction can't run because of the error above. Cancel and reopen the preview to try again.",
  },
} as const satisfies Record<string, TooltipCopyEntry>;
