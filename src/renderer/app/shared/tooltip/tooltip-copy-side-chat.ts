import type { TooltipCopyEntry } from './tooltip-copy';

export const SIDE_CHAT_COPY = {
  'sideChat.close': {
    label: 'Close panel',
    meaning: 'Close panel. Running sidechats keep going.',
  },
} as const satisfies Record<string, TooltipCopyEntry>;
