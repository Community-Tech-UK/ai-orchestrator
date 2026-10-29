import type { TooltipCopyEntry } from './tooltip-copy';

export const RESUME_LOOP_COPY = {
  'loop.noFolder': { label: 'Loop', meaning: 'Pick a working folder to enable Loop Mode' },
  'loop.noStoredPrompt': { label: 'Prompt unavailable', meaning: 'No prompt recorded for this run' },
  'loop.reattempt': { label: 'Reattempt', meaning: 'Open the loop config pre-filled with this prompt' },
  'loop.requireRenameReason': { label: 'Require plan rename', meaning: 'A plan file is configured, so its completed rename is required before stopping.' },
} as const satisfies Record<string, TooltipCopyEntry>;
