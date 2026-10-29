import type { TooltipCopyEntry } from './tooltip-copy';

/** Existing conversation-tool wording, kept verbatim during migration. */
export const CONVERSATION_TOOLS_COPY = {
  'context.estimated': {
    label: 'Estimated context',
    meaning: 'Estimated from aggregate token spend — actual context occupancy may be lower',
  },
  'context.aggregateSpend': {
    label: 'Tokens used',
    meaning: 'Tokens used this session. This provider does not report context-window occupancy, so no percentage is shown.',
  },
  'context.noOccupancy': {
    label: 'No data',
    meaning: 'This provider has not reported context occupancy for this session',
  },
  'attribution.estimates': {
    label: 'Estimated sources',
    meaning: 'Char-heuristic estimates (same family as the compactor); the provider-owned system prompt is not observable and lands in Other.',
  },
  'attribution.composedSources': {
    label: 'Owned sources only',
    meaning: "AIO can only prove what it composed and sent — never what the provider's own process actually kept or used from it.",
  },
} as const satisfies Record<string, TooltipCopyEntry>;
