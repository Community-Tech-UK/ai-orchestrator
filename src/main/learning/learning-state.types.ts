import type {
  Experience,
  LearningInsight,
  TaskOutcome,
  TaskPattern,
} from '../../shared/types/self-improvement.types';
import type {
  SessionMetrics,
  BaselineSnapshot,
} from '../../shared/types/metrics.types';
import type {
  UserAction,
  UserHabit,
} from './habit-tracker';

export interface OutcomeTrackerStateSnapshot {
  outcomes: TaskOutcome[];
  patterns: TaskPattern[];
  experiences: Experience[];
  insights: LearningInsight[];
}

export interface MetricsCollectorStateSnapshot {
  sessions: SessionMetrics[];
  baselines: BaselineSnapshot[];
}

export interface HabitTrackerStateSnapshot {
  actions: UserAction[];
  habits: UserHabit[];
}
