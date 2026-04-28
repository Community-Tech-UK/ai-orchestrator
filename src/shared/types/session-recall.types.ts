export type SessionRecallSource = 'child_result' | 'automation_run' | 'agent_tree';

export interface SessionRecallQuery {
  query: string;
  parentId?: string;
  automationId?: string;
  limit?: number;
}

export interface SessionRecallResult {
  source: SessionRecallSource;
  id: string;
  title: string;
  summary: string;
  score: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}
