import type {
  Experience,
  LearningInsight,
  TaskOutcome,
  TaskPattern,
  PatternType,
} from '../../shared/types/self-improvement.types';
import type {
  BaselineSnapshot,
  SessionMetrics,
} from '../../shared/types/metrics.types';
import { getRLMDatabase, type RLMDatabase } from '../persistence/rlm-database';
import type { HabitType, UserAction, UserHabit } from './habit-tracker';
import type {
  HabitTrackerStateSnapshot,
  MetricsCollectorStateSnapshot,
  OutcomeTrackerStateSnapshot,
} from './learning-state.types';

interface PersistedUserActionRow {
  id: string;
  type: string;
  action: string;
  timestamp: number;
  context_json: string | null;
  metadata_json: string | null;
}

interface PersistedUserHabitRow {
  id: string;
  type: string;
  pattern: string;
  frequency: number;
  confidence: number;
  context_json: string | null;
  observations: number;
  last_observed: number;
  first_observed: number;
}

export function loadOutcomeTrackerStateSnapshot(
  maxExperiences: number,
  db: RLMDatabase = getRLMDatabase(),
): OutcomeTrackerStateSnapshot {
  const outcomes: TaskOutcome[] = db.getOutcomes({ limit: maxExperiences }).map((row) => {
    const metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {};
    const toolsData = row.tools_json ? JSON.parse(row.tools_json) : [];
    return {
      id: row.id,
      instanceId: metadata.instanceId || 'unknown',
      taskType: row.task_type,
      taskDescription: metadata.taskDescription || '',
      prompt: row.prompt_hash || '',
      context: undefined,
      agentUsed: row.agent_id || 'unknown',
      modelUsed: row.model || 'unknown',
      toolsUsed: toolsData.map((tool: string) => ({
        tool,
        count: 1,
        avgDuration: 0,
        errorCount: 0,
      })),
      success: row.success === 1,
      errorType: row.error_type || undefined,
      duration: row.duration_ms || 0,
      tokensUsed: row.token_usage || 0,
      timestamp: row.timestamp,
      patterns: [],
      userSatisfaction: metadata.userSatisfaction,
    } satisfies TaskOutcome;
  });

  const patterns: TaskPattern[] = db.getPatterns().map((row) => ({
    type: row.type as PatternType,
    value: row.key,
    effectiveness: row.effectiveness,
    sampleSize: row.sample_size,
    lastUpdated: row.last_updated,
  }));

  const experiences: Experience[] = db.getAllExperiences().map((row) => ({
    id: row.id,
    taskType: row.task_type,
    description: '',
    successfulPatterns: row.success_patterns_json ? JSON.parse(row.success_patterns_json) : [],
    failurePatterns: row.failure_patterns_json ? JSON.parse(row.failure_patterns_json) : [],
    examplePrompts: row.example_prompts_json ? JSON.parse(row.example_prompts_json) : [],
    sampleSize: row.success_count + row.failure_count,
    avgSuccessRate: row.success_count / Math.max(1, row.success_count + row.failure_count),
    lastUpdated: row.last_updated,
  }));

  const insights: LearningInsight[] = db.getInsights().map((row) => ({
    id: row.id,
    type: row.type as LearningInsight['type'],
    description: row.description || row.title,
    confidence: row.confidence,
    evidence: row.supporting_patterns_json ? JSON.parse(row.supporting_patterns_json) : [],
    taskTypes: [],
    createdAt: row.created_at,
    appliedCount: 0,
    successRate: 0,
  }));

  return { outcomes, patterns, experiences, insights };
}

export function loadMetricsCollectorStateSnapshot(
  db: RLMDatabase = getRLMDatabase(),
): MetricsCollectorStateSnapshot {
  const sessions: SessionMetrics[] = [];
  for (const pattern of db.getPatterns('metrics_session')) {
    try {
      const session = JSON.parse(pattern.metadata_json || '{}') as SessionMetrics;
      if (session.sessionId) {
        sessions.push(session);
      }
    } catch {
      // Skip malformed rows.
    }
  }

  const baselines: BaselineSnapshot[] = [];
  for (const pattern of db.getPatterns('metrics_baseline')) {
    try {
      const baseline = JSON.parse(pattern.metadata_json || '{}') as BaselineSnapshot;
      if (baseline.id) {
        baselines.push(baseline);
      }
    } catch {
      // Skip malformed rows.
    }
  }

  sessions.sort((left, right) => left.timestamp - right.timestamp);
  return { sessions, baselines };
}

export function loadHabitTrackerStateSnapshot(
  trackingWindowDays: number,
  db: RLMDatabase = getRLMDatabase(),
): HabitTrackerStateSnapshot {
  const rawDb = db.getRawDb();
  const cutoff = Date.now() - trackingWindowDays * 24 * 60 * 60 * 1000;
  const actionRows: PersistedUserActionRow[] = rawDb.prepare(`
    SELECT * FROM user_actions
    WHERE timestamp > ?
    ORDER BY timestamp DESC
    LIMIT 1000
  `).all(cutoff) as PersistedUserActionRow[];

  const actions: UserAction[] = actionRows.map((row) => ({
    id: row.id,
    type: row.type,
    action: row.action,
    timestamp: row.timestamp,
    context: row.context_json ? JSON.parse(row.context_json) : {},
    metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
  }));

  const habitRows: PersistedUserHabitRow[] = rawDb.prepare(
    'SELECT * FROM user_habits ORDER BY confidence DESC'
  ).all() as PersistedUserHabitRow[];
  const habits: UserHabit[] = habitRows.map((row) => ({
    id: row.id,
    type: row.type as HabitType,
    pattern: row.pattern,
    frequency: row.frequency,
    confidence: row.confidence,
    context: row.context_json ? JSON.parse(row.context_json) : {},
    observations: row.observations,
    lastObserved: row.last_observed,
    firstObserved: row.first_observed,
  }));

  return { actions, habits };
}
