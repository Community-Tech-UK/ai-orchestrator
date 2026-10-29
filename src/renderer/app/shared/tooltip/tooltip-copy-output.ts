import type { TooltipCopyEntry } from './tooltip-copy';

/** Transcript (output stream) hints that repeat or carry a state. */
export const OUTPUT_COPY = {
  'output.compactionRecovery': {
    label: 'Recover context',
    meaning: 'Queue preserved context for the next turn',
  },
  'output.compactionQueued': {
    label: 'Queued',
    meaning: 'Preserved context is already queued for the next turn',
  },
} as const satisfies Record<string, TooltipCopyEntry>;
