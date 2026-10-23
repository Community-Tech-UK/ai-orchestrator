/** Reliability floors shared by local probes and remote-computer guidance. */
export const CLAUDE_CLI_FEATURE_FLOORS = {
  resumedSessions: { minimumVersion: '2.1.300', label: 'Reliable resumed sessions' },
  sideQuestions: { minimumVersion: '2.1.299', label: 'Side questions' },
  toolSearchCache: { minimumVersion: '2.1.302', label: 'Stable tool-search caching' },
} as const;

/** Also used by the plan queue's Copilot compatibility warning. */
export const COPILOT_CLI_MIN_VERSION = '1.0.100';
