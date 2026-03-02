/**
 * Habit Tracker
 * Tracks user habits and preferences over time for personalized orchestration
 *
 * Key insight: By observing user patterns over time, we can:
 * 1. Detect recurring preferences (time of day, tools, agents, models)
 * 2. Learn workspace-specific workflows
 * 3. Provide proactive suggestions based on context
 * 4. Adapt orchestration to user working style
 *
 * Persistence via SQLite for durability across sessions
 * Note: Uses better-sqlite3 Database.exec() for SQL execution (not child_process.exec)
 */

import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import { RLMDatabase, getRLMDatabase } from '../persistence/rlm-database';
import { getLogger } from '../logging/logger';

const logger = getLogger('HabitTracker');

// ============ Interfaces ============

export interface HabitTrackerConfig {
  minObservations: number; // Min observations for habit detection (default: 5)
  habitDecayRate: number; // How quickly old habits lose weight (default: 0.95)
  confidenceThreshold: number; // Confidence needed to suggest habit (default: 0.7)
  trackingWindow: number; // Days to track (default: 30)
  enableTimePatterns: boolean; // Track time-of-day patterns (default: true)
  enableWorkspacePatterns: boolean; // Track workspace-specific patterns (default: true)
}

export type HabitType =
  | 'time_of_day'
  | 'day_of_week'
  | 'workspace'
  | 'tool_preference'
  | 'agent_preference'
  | 'model_preference'
  | 'workflow_sequence'
  | 'error_recovery'
  | 'communication_style';

export type TimeSlot = 'morning' | 'afternoon' | 'evening' | 'night';

export interface HabitContext {
  workspaceId?: string;
  timeSlot?: TimeSlot;
  dayOfWeek?: number; // 0-6 (Sunday-Saturday)
  projectType?: string;
  taskType?: string;
}

export interface UserHabit {
  id: string;
  type: HabitType;
  pattern: string; // The detected pattern
  frequency: number; // How often this happens (0-1)
  confidence: number; // Confidence in this habit (0-1)
  context: HabitContext;
  observations: number; // Number of times observed
  lastObserved: number; // Timestamp
  firstObserved: number; // Timestamp
}

export interface UserAction {
  id: string;
  type: string;
  action: string;
  timestamp: number;
  context: HabitContext;
  metadata?: Record<string, unknown>;
}

export interface HabitSuggestion {
  habit: UserHabit;
  suggestion: string;
  reason: string;
  confidence: number;
}

export interface HabitStats {
  totalActions: number;
  totalHabits: number;
  habitsByType: Record<HabitType, number>;
  topHabits: UserHabit[];
  recentActions: number;
  confidenceAvg: number;
}

// ============ HabitTracker Class ============

export class HabitTracker extends EventEmitter {
  private static instance: HabitTracker;
  private actions: UserAction[] = [];
  private habits: Map<string, UserHabit> = new Map();
  private config: HabitTrackerConfig;
  private db: RLMDatabase | null = null;
  private persistenceEnabled = true;

  private defaultConfig: HabitTrackerConfig = {
    minObservations: 5,
    habitDecayRate: 0.95,
    confidenceThreshold: 0.7,
    trackingWindow: 30,
    enableTimePatterns: true,
    enableWorkspacePatterns: true,
  };

  static getInstance(): HabitTracker {
    if (!this.instance) {
      this.instance = new HabitTracker();
    }
    return this.instance;
  }

  private constructor() {
    super();
    this.config = { ...this.defaultConfig };
    this.initializePersistence();
  }

  /**
   * Initialize database persistence and load existing data
   */
  private initializePersistence(): void {
    try {
      this.db = getRLMDatabase();
      this.ensureTables();
      this.loadFromPersistence();
      this.emit('persistence:initialized', { success: true });
    } catch (error) {
      logger.error('Failed to initialize persistence', error instanceof Error ? error : undefined);
      this.persistenceEnabled = false;
      this.emit('persistence:initialized', { success: false, error });
    }
  }

  /**
   * Ensure habit tracking tables exist using better-sqlite3 Database.exec()
   */
  private ensureTables(): void {
    if (!this.db) return;

    const db = (this.db as any).db;
    if (!db) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS user_actions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        action TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        context_json TEXT,
        metadata_json TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_actions_timestamp
        ON user_actions(timestamp);
      CREATE INDEX IF NOT EXISTS idx_actions_type
        ON user_actions(type);

      CREATE TABLE IF NOT EXISTS user_habits (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        pattern TEXT NOT NULL,
        frequency REAL NOT NULL,
        confidence REAL NOT NULL,
        context_json TEXT,
        observations INTEGER NOT NULL,
        last_observed INTEGER NOT NULL,
        first_observed INTEGER NOT NULL,
        UNIQUE(type, pattern, context_json)
      );

      CREATE INDEX IF NOT EXISTS idx_habits_type
        ON user_habits(type);
      CREATE INDEX IF NOT EXISTS idx_habits_confidence
        ON user_habits(confidence);
    `);
  }

  /**
   * Load persisted data into memory on startup
   */
  private loadFromPersistence(): void {
    if (!this.db) return;

    const db = (this.db as any).db;
    if (!db) return;

    const cutoff = Date.now() - this.config.trackingWindow * 24 * 60 * 60 * 1000;
    const actionStmt = db.prepare(`
      SELECT * FROM user_actions
      WHERE timestamp > ?
      ORDER BY timestamp DESC
      LIMIT 1000
    `);
    const actionRows = actionStmt.all(cutoff);

    for (const row of actionRows) {
      const action: UserAction = {
        id: row.id,
        type: row.type,
        action: row.action,
        timestamp: row.timestamp,
        context: row.context_json ? JSON.parse(row.context_json) : {},
        metadata: row.metadata_json ? JSON.parse(row.metadata_json) : undefined,
      };
      this.actions.push(action);
    }

    const habitStmt = db.prepare(`SELECT * FROM user_habits ORDER BY confidence DESC`);
    const habitRows = habitStmt.all();

    for (const row of habitRows) {
      const habit: UserHabit = {
        id: row.id,
        type: row.type as HabitType,
        pattern: row.pattern,
        frequency: row.frequency,
        confidence: row.confidence,
        context: row.context_json ? JSON.parse(row.context_json) : {},
        observations: row.observations,
        lastObserved: row.last_observed,
        firstObserved: row.first_observed,
      };
      this.habits.set(habit.id, habit);
    }

    this.emit('persistence:loaded', {
      actions: actionRows.length,
      habits: habitRows.length,
    });
  }

  isPersistenceEnabled(): boolean {
    return this.persistenceEnabled && this.db !== null;
  }

  configure(config: Partial<HabitTrackerConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('configured', this.config);
  }

  getConfig(): HabitTrackerConfig {
    return { ...this.config };
  }

  // ============ Action Recording ============

  recordAction(action: Omit<UserAction, 'id' | 'timestamp'>): UserAction {
    const fullAction: UserAction = {
      ...action,
      id: this.generateId('action'),
      timestamp: Date.now(),
      context: {
        ...action.context,
        timeSlot: action.context.timeSlot || this.getTimeSlot(),
        dayOfWeek: action.context.dayOfWeek ?? new Date().getDay(),
      },
    };

    this.actions.push(fullAction);

    if (this.db && this.persistenceEnabled) {
      try {
        const db = (this.db as any).db;
        const stmt = db.prepare(`
          INSERT INTO user_actions (id, type, action, timestamp, context_json, metadata_json)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          fullAction.id,
          fullAction.type,
          fullAction.action,
          fullAction.timestamp,
          JSON.stringify(fullAction.context),
          fullAction.metadata ? JSON.stringify(fullAction.metadata) : null
        );
      } catch (error) {
        logger.error('Failed to persist action', error instanceof Error ? error : undefined);
      }
    }

    this.emit('action:recorded', fullAction);
    this.detectHabitsForAction(fullAction);
    this.pruneOldActions();

    return fullAction;
  }

  recordCorrection(habitId: string, wasCorrect: boolean): void {
    const habit = this.habits.get(habitId);
    if (!habit) return;

    const adjustment = wasCorrect ? 0.1 : -0.15;
    habit.confidence = Math.max(0, Math.min(1, habit.confidence + adjustment));

    if (habit.confidence < 0.3) {
      this.habits.delete(habitId);
      this.deleteHabitFromDb(habitId);
      this.emit('habit:expired', habit);
    } else {
      this.persistHabit(habit);
      this.emit('habit:updated', habit);
    }

    this.emit('correction:recorded', { habitId, wasCorrect, newConfidence: habit.confidence });
  }

  // ============ Habit Detection ============

  detectHabits(): UserHabit[] {
    const detectedHabits: UserHabit[] = [];
    const actionsByType = new Map<string, UserAction[]>();

    for (const action of this.actions) {
      const existing = actionsByType.get(action.type) || [];
      existing.push(action);
      actionsByType.set(action.type, existing);
    }

    for (const [type, actions] of actionsByType) {
      const habits = this.detectHabitsForType(type, actions);
      detectedHabits.push(...habits);
    }

    return detectedHabits;
  }

  private detectHabitsForType(actionType: string, actions: UserAction[]): UserHabit[] {
    if (actions.length < this.config.minObservations) {
      return [];
    }

    const detectedHabits: UserHabit[] = [];
    const patternCounts = new Map<string, { count: number; contexts: HabitContext[]; timestamps: number[] }>();

    for (const action of actions) {
      const key = this.getPatternKey(action);
      const existing = patternCounts.get(key) || { count: 0, contexts: [], timestamps: [] };
      existing.count++;
      existing.contexts.push(action.context);
      existing.timestamps.push(action.timestamp);
      patternCounts.set(key, existing);
    }

    for (const [pattern, data] of patternCounts) {
      if (data.count >= this.config.minObservations) {
        const frequency = data.count / actions.length;
        const confidence = this.calculateConfidence(data.count, actions.length, data.timestamps);

        if (confidence >= this.config.confidenceThreshold) {
          const habitType = this.inferHabitType(actionType);
          const habitId = this.generateHabitId(habitType, pattern);

          const habit: UserHabit = {
            id: habitId,
            type: habitType,
            pattern,
            frequency,
            confidence,
            context: this.aggregateContext(data.contexts),
            observations: data.count,
            lastObserved: Math.max(...data.timestamps),
            firstObserved: Math.min(...data.timestamps),
          };

          const existing = this.habits.get(habitId);
          if (existing) {
            this.updateHabit(existing, habit);
          } else {
            this.habits.set(habitId, habit);
            this.persistHabit(habit);
            this.emit('habit:detected', habit);
            detectedHabits.push(habit);
          }
        }
      }
    }

    return detectedHabits;
  }

  private detectHabitsForAction(action: UserAction): void {
    const recentActions = this.getRecentActionsByType(action.type);
    this.detectHabitsForType(action.type, recentActions);
  }

  private getRecentActionsByType(type: string): UserAction[] {
    const cutoff = Date.now() - this.config.trackingWindow * 24 * 60 * 60 * 1000;
    return this.actions.filter(a => a.type === type && a.timestamp > cutoff);
  }

  private calculateConfidence(count: number, total: number, timestamps: number[]): number {
    const frequency = count / total;
    let confidence = frequency;

    const now = Date.now();
    const recentCount = timestamps.filter(t => now - t < 7 * 24 * 60 * 60 * 1000).length;
    const recencyBoost = recentCount / count;
    confidence = confidence * 0.7 + recencyBoost * 0.3;

    const avgAge = timestamps.reduce((sum, t) => sum + (now - t), 0) / timestamps.length;
    const ageDays = avgAge / (24 * 60 * 60 * 1000);
    const decayFactor = Math.pow(this.config.habitDecayRate, ageDays);
    confidence *= decayFactor;

    return Math.max(0, Math.min(1, confidence));
  }

  private updateHabit(existing: UserHabit, update: UserHabit): void {
    const alpha = 1 / (existing.observations + update.observations);
    existing.frequency = (1 - alpha) * existing.frequency + alpha * update.frequency;
    existing.confidence = (1 - alpha) * existing.confidence + alpha * update.confidence;
    existing.observations += update.observations;
    existing.lastObserved = Math.max(existing.lastObserved, update.lastObserved);

    this.persistHabit(existing);
    this.emit('habit:updated', existing);
  }

  private getPatternKey(action: UserAction): string {
    const parts = [action.action];

    if (this.config.enableTimePatterns && action.context.timeSlot) {
      parts.push(action.context.timeSlot);
    }

    if (this.config.enableWorkspacePatterns && action.context.workspaceId) {
      parts.push(action.context.workspaceId);
    }

    if (action.context.taskType) {
      parts.push(action.context.taskType);
    }

    return parts.join(':');
  }

  private inferHabitType(actionType: string): HabitType {
    const typeMap: Record<string, HabitType> = {
      model_selection: 'model_preference',
      agent_selection: 'agent_preference',
      tool_usage: 'tool_preference',
      workflow_step: 'workflow_sequence',
      error_handling: 'error_recovery',
      communication: 'communication_style',
    };

    return typeMap[actionType] || 'workspace';
  }

  private aggregateContext(contexts: HabitContext[]): HabitContext {
    const aggregated: HabitContext = {};

    const workspaces = contexts.map(c => c.workspaceId).filter(Boolean);
    if (workspaces.length > 0) {
      aggregated.workspaceId = this.mostCommon(workspaces as string[]);
    }

    const timeSlots = contexts.map(c => c.timeSlot).filter(Boolean);
    if (timeSlots.length > 0) {
      aggregated.timeSlot = this.mostCommon(timeSlots as TimeSlot[]) as TimeSlot;
    }

    const daysOfWeek = contexts.map(c => c.dayOfWeek).filter(d => d !== undefined);
    if (daysOfWeek.length > 0) {
      aggregated.dayOfWeek = Math.round(
        daysOfWeek.reduce((sum, d) => sum + (d as number), 0) / daysOfWeek.length
      );
    }

    const taskTypes = contexts.map(c => c.taskType).filter(Boolean);
    if (taskTypes.length > 0) {
      aggregated.taskType = this.mostCommon(taskTypes as string[]);
    }

    return aggregated;
  }

  private mostCommon<T>(arr: T[]): T {
    const counts = new Map<T, number>();
    for (const item of arr) {
      counts.set(item, (counts.get(item) || 0) + 1);
    }
    let maxCount = 0;
    let mostCommon = arr[0];
    for (const [item, count] of counts) {
      if (count > maxCount) {
        maxCount = count;
        mostCommon = item;
      }
    }
    return mostCommon;
  }

  // ============ Query Methods ============

  getHabit(habitId: string): UserHabit | undefined {
    return this.habits.get(habitId);
  }

  getHabitsByType(type: HabitType): UserHabit[] {
    return Array.from(this.habits.values())
      .filter(h => h.type === type)
      .sort((a, b) => b.confidence - a.confidence);
  }

  getHabitsForContext(context: HabitContext): UserHabit[] {
    return Array.from(this.habits.values()).filter(habit => {
      return this.contextMatches(habit.context, context);
    }).sort((a, b) => b.confidence - a.confidence);
  }

  private contextMatches(habitContext: HabitContext, queryContext: HabitContext): boolean {
    if (queryContext.workspaceId && habitContext.workspaceId !== queryContext.workspaceId) {
      return false;
    }
    if (queryContext.timeSlot && habitContext.timeSlot !== queryContext.timeSlot) {
      return false;
    }
    if (queryContext.dayOfWeek !== undefined && habitContext.dayOfWeek !== queryContext.dayOfWeek) {
      return false;
    }
    if (queryContext.taskType && habitContext.taskType !== queryContext.taskType) {
      return false;
    }
    return true;
  }

  getSuggestions(context: HabitContext): HabitSuggestion[] {
    const relevantHabits = this.getHabitsForContext(context);
    const suggestions: HabitSuggestion[] = [];

    for (const habit of relevantHabits) {
      if (habit.confidence >= this.config.confidenceThreshold) {
        const suggestion = this.generateSuggestion(habit, context);
        suggestions.push(suggestion);
      }
    }

    this.emit('suggestion:generated', { context, count: suggestions.length });
    return suggestions.sort((a, b) => b.confidence - a.confidence);
  }

  private generateSuggestion(habit: UserHabit, context: HabitContext): HabitSuggestion {
    const suggestion = this.formatSuggestion(habit);
    const reason = this.formatReason(habit, context);

    return {
      habit,
      suggestion,
      reason,
      confidence: habit.confidence,
    };
  }

  private formatSuggestion(habit: UserHabit): string {
    const percent = Math.round(habit.frequency * 100);

    switch (habit.type) {
      case 'model_preference':
        return `Use ${habit.pattern} (you use this ${percent}% of the time)`;
      case 'agent_preference':
        return `Use ${habit.pattern} agent (your preferred choice ${percent}% of the time)`;
      case 'tool_preference':
        return `Consider using ${habit.pattern} (you frequently use this tool)`;
      case 'workflow_sequence':
        return `Follow ${habit.pattern} workflow (your usual approach)`;
      case 'time_of_day':
        return `Based on your ${habit.pattern} patterns`;
      default:
        return `Consider ${habit.pattern} (${percent}% preference)`;
    }
  }

  private formatReason(habit: UserHabit, context: HabitContext): string {
    const reasons: string[] = [];

    if (habit.context.timeSlot && context.timeSlot === habit.context.timeSlot) {
      reasons.push(`during ${habit.context.timeSlot}`);
    }

    if (habit.context.workspaceId && context.workspaceId === habit.context.workspaceId) {
      reasons.push(`in this workspace`);
    }

    if (habit.context.taskType && context.taskType === habit.context.taskType) {
      reasons.push(`for ${habit.context.taskType} tasks`);
    }

    reasons.push(`based on ${habit.observations} observations`);

    const joinedReasons = reasons.join(', ');
    return `You typically do this ${joinedReasons}`;
  }

  getTimePatterns(): UserHabit[] {
    return this.getHabitsByType('time_of_day');
  }

  getWorkspacePatterns(workspaceId: string): UserHabit[] {
    return Array.from(this.habits.values())
      .filter(h => h.context.workspaceId === workspaceId)
      .sort((a, b) => b.confidence - a.confidence);
  }

  // ============ Utility Methods ============

  private getTimeSlot(): TimeSlot {
    const hour = new Date().getHours();
    if (hour >= 5 && hour < 12) return 'morning';
    if (hour >= 12 && hour < 17) return 'afternoon';
    if (hour >= 17 && hour < 22) return 'evening';
    return 'night';
  }

  private generateId(prefix: string): string {
    return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  }

  private generateHabitId(type: HabitType, pattern: string): string {
    const hash = crypto.createHash('sha256').update(`${type}:${pattern}`).digest('hex').slice(0, 8);
    return `habit-${type}-${hash}`;
  }

  pruneOldActions(): void {
    const cutoff = Date.now() - this.config.trackingWindow * 24 * 60 * 60 * 1000;
    const oldCount = this.actions.length;
    this.actions = this.actions.filter(a => a.timestamp > cutoff);

    if (this.actions.length < oldCount && this.db && this.persistenceEnabled) {
      try {
        const db = (this.db as any).db;
        const stmt = db.prepare(`DELETE FROM user_actions WHERE timestamp < ?`);
        stmt.run(cutoff);
      } catch (error) {
        logger.error('Failed to prune old actions', error instanceof Error ? error : undefined);
      }
    }
  }

  getStats(): HabitStats {
    const habitsByType: Record<string, number> = {};
    for (const habit of this.habits.values()) {
      habitsByType[habit.type] = (habitsByType[habit.type] || 0) + 1;
    }

    const now = Date.now();
    const last24h = now - 24 * 60 * 60 * 1000;
    const recentActions = this.actions.filter(a => a.timestamp > last24h).length;

    const allHabits = Array.from(this.habits.values());
    const confidenceAvg = allHabits.length > 0
      ? allHabits.reduce((sum, h) => sum + h.confidence, 0) / allHabits.length
      : 0;

    return {
      totalActions: this.actions.length,
      totalHabits: this.habits.size,
      habitsByType: habitsByType as Record<HabitType, number>,
      topHabits: Array.from(this.habits.values())
        .sort((a, b) => b.confidence - a.confidence)
        .slice(0, 10),
      recentActions,
      confidenceAvg,
    };
  }

  // ============ Persistence ============

  private persistHabit(habit: UserHabit): void {
    if (!this.db || !this.persistenceEnabled) return;

    try {
      const db = (this.db as any).db;
      const stmt = db.prepare(`
        INSERT INTO user_habits
          (id, type, pattern, frequency, confidence, context_json, observations, last_observed, first_observed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          frequency = excluded.frequency,
          confidence = excluded.confidence,
          observations = excluded.observations,
          last_observed = excluded.last_observed
      `);
      stmt.run(
        habit.id,
        habit.type,
        habit.pattern,
        habit.frequency,
        habit.confidence,
        JSON.stringify(habit.context),
        habit.observations,
        habit.lastObserved,
        habit.firstObserved
      );
    } catch (error) {
      logger.error('Failed to persist habit', error instanceof Error ? error : undefined);
    }
  }

  private deleteHabitFromDb(habitId: string): void {
    if (!this.db || !this.persistenceEnabled) return;

    try {
      const db = (this.db as any).db;
      const stmt = db.prepare(`DELETE FROM user_habits WHERE id = ?`);
      stmt.run(habitId);
    } catch (error) {
      logger.error('Failed to delete habit', error instanceof Error ? error : undefined);
    }
  }

  destroy(): void {
    this.actions = [];
    this.habits.clear();
    this.removeAllListeners();
  }
}

// ============ Export ============

export function getHabitTracker(): HabitTracker {
  return HabitTracker.getInstance();
}
