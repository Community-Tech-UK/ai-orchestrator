import type { HelpEntry } from '../help-content.types';

export const GLOSSARY_HELP: HelpEntry = {
  sections: [
    { kind: 'callout', variant: 'info', heading: 'Words used in Harness', body: 'Short explanations of words you may see in Harness. Select an underlined word on screen to jump to it here.' },
    { kind: 'terms', heading: 'Controls', terms: ['auto-approve', 'fast-mode', 'steer', 'side-chat', 'asleep', 'ask-several-models', 'second-opinion', 'helper-agent'] },
    { kind: 'terms', heading: 'Loops', terms: ['worktree', 'fresh-start', 'same-session', 'new-session-each-round', 'finish-by-checks', 'finish-by-reviews', 'back-and-forth-review', 'independent-review', 'final-round', 'retry-new-approach', 'set-aside'] },
    { kind: 'terms', heading: 'Memory and tools', terms: ['rtk', 'learning-database', 'code-index', 'tool-servers', 'code-intelligence', 'acp', 'helper-models', 'shortening', 'context-window'] },
    { kind: 'terms', heading: 'Costs', terms: ['tokens', 'cache-read-write'] },
    { kind: 'callout', variant: 'tip', heading: 'Return to your work', body: 'Press Escape to close this panel and return to the control that opened it.' },
  ],
};
