export type SessionRecallSource =
  | 'history-transcript'
  | 'child_result'
  | 'child_diagnostic'
  | 'automation_run'
  | 'provider_event'
  | 'agent_tree'
  | 'archived_session';

export type SessionRecallIntent =
  | 'general'
  | 'priorFailuresByProviderModel'
  | 'priorFixesByRepositoryPath'
  | 'priorDecisions'
  | 'stuckSessionDiagnostics'
  | 'automationRunHistory';

export interface SessionRecallQuery {
  query: string;
  intent?: SessionRecallIntent;
  parentId?: string;
  automationId?: string;
  provider?: string;
  model?: string;
  repositoryPath?: string;
  sources?: SessionRecallSource[];
  limit?: number;
  /** Opt in to scanning history-transcript snippets. Default false. */
  includeHistoryTranscripts?: boolean;
  /** Cap on history-transcript results merged. Default 25. */
  maxHistoryTranscriptResults?: number;
}

export interface SessionRecallSourceLink {
  type: 'child_result' | 'automation_run' | 'agent_tree_snapshot' | 'archived_session' | 'file';
  ref: string;
  label?: string;
}

export interface SessionRecallResult {
  source: SessionRecallSource;
  id: string;
  title: string;
  summary: string;
  score: number;
  timestamp: number;
  sourceLink?: SessionRecallSourceLink;
  hasMore?: boolean;
  metadata?: Record<string, unknown>;
}
