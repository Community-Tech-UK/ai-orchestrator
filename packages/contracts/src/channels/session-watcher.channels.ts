export const SESSION_WATCHER_CHANNELS = {
  // Commands (renderer -> main). Renderer only: no agent-reachable route calls any of these.
  SESSION_WATCHER_LIST_FLAGS: 'session-watcher:list-flags',
  SESSION_WATCHER_ANSWER_YES: 'session-watcher:answer-yes',
  SESSION_WATCHER_SET_MUTED: 'session-watcher:set-muted',
  SESSION_WATCHER_TYPING_HOLD: 'session-watcher:typing-hold',
  // Event (main -> renderer): the full list of sessions that need the user, on every change.
  SESSION_WATCHER_FLAGS_CHANGED: 'session-watcher:flags-changed',
} as const;
