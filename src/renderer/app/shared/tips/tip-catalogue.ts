export interface TipRelevance {
  sessionCount: number;
  hasReply: boolean;
  contextPercentage: number;
  compactPreviewAvailable: boolean;
}

export interface WorkingTip {
  id: string;
  text: string;
  featureId: string;
  shortcutActionId?: string;
  relevantWhen?: (context: TipRelevance) => boolean;
}

export const WORKING_TIPS: readonly WorkingTip[] = [
  { id: 'steer', featureId: 'steer', text: 'While it works, Enter queues your message. Use Steer to change its course right now.' },
  { id: 'side-chat', featureId: 'toggle-side-chat', shortcutActionId: 'toggle-side-chat', text: 'Ask a quick question without interrupting this session: open a side chat ({key}).' },
  { id: 'command-palette', featureId: 'toggle-command-palette', shortcutActionId: 'toggle-command-palette', text: 'Press {key} to jump to any page, setting or command.' },
  { id: 'session-picker', featureId: 'open-session-picker', shortcutActionId: 'open-session-picker', text: 'Press {key} to find and open any session by name or prompt.', relevantWhen: (context) => context.sessionCount >= 4 },
  { id: 'prompt-history', featureId: 'open-prompt-history-search', shortcutActionId: 'open-prompt-history-search', text: 'Press {key} to search the messages you sent before.' },
  { id: 'compact-preview', featureId: 'compact-preview', text: 'Conversation getting long? Preview shows what compaction keeps; Compact Now shortens it.', relevantWhen: (context) => context.compactPreviewAvailable && context.contextPercentage >= 60 },
  { id: 'ask-council', featureId: 'ask-council', text: 'Not sure about an answer? Ask other models the same question in Ask Council.', relevantWhen: (context) => context.hasReply },
];
