import type { TooltipCopyEntry } from './tooltip-copy';

export const VERIFICATION_CONFIG_COPY = {
  'verificationHints.lastAgent': { label: 'Remove agent', meaning: 'At least one agent is required' },
  'verificationHints.lastPersonality': { label: 'Remove personality', meaning: 'At least one personality is required' },
  'verificationHints.enterKeyToTest': { label: 'Test Key', meaning: 'Enter an API key to test it' },
  'verificationHints.completeKeyToSave': { label: 'Save Key', meaning: 'Choose a provider and enter a key to save it' },
} as const satisfies Record<string, TooltipCopyEntry>;
