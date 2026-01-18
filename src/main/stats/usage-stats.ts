/**
 * Usage Statistics - Track and display usage statistics (14.1)
 *
 * Tracks sessions, tokens, costs, and tool usage over time.
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

/**
 * Time period for statistics
 */
export type StatsPeriod = 'day' | 'week' | 'month' | 'year' | 'all';

/**
 * Tool usage entry
 */
export interface ToolUsageEntry {
  tool: string;
  count: number;
  lastUsed: number;
}

/**
 * Session statistics
 */
export interface SessionStats {
  sessionId: string;
  instanceId: string;
  startTime: number;
  endTime?: number;
  duration: number;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  toolsUsed: string[];
  agentId: string;
  workingDirectory: string;
}

/**
 * Daily statistics snapshot
 */
export interface DailyStats {
  date: string;  // YYYY-MM-DD format
  sessions: number;
  messages: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  toolUsage: Record<string, number>;
  agentUsage: Record<string, number>;
  avgSessionDuration: number;
  peakConcurrentSessions: number;
}

/**
 * Aggregated statistics
 */
export interface AggregatedStats {
  period: StatsPeriod;
  startDate: number;
  endDate: number;
  totalSessions: number;
  totalMessages: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  avgSessionDuration: number;
  avgTokensPerSession: number;
  avgCostPerSession: number;
  mostUsedTools: ToolUsageEntry[];
  mostUsedAgents: Array<{ agent: string; count: number }>;
  dailyBreakdown: DailyStats[];
}

/**
 * Usage Statistics Manager
 */
export class UsageStatsManager {
  private statsDir: string;
  private sessionStats: Map<string, SessionStats> = new Map();
  private dailyStats: Map<string, DailyStats> = new Map();
  private toolUsage: Map<string, ToolUsageEntry> = new Map();
  private currentDate: string;

  constructor() {
    this.statsDir = path.join(app.getPath('userData'), 'stats');
    this.currentDate = this.getDateString(new Date());
    this.ensureStatsDir();
    this.loadStats();
  }

  /**
   * Ensure stats directory exists
   */
  private ensureStatsDir(): void {
    if (!fs.existsSync(this.statsDir)) {
      fs.mkdirSync(this.statsDir, { recursive: true });
    }
  }

  /**
   * Get date string in YYYY-MM-DD format
   */
  private getDateString(date: Date): string {
    return date.toISOString().split('T')[0];
  }

  /**
   * Load statistics from disk
   */
  private loadStats(): void {
    // Load daily stats for current month
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth();

    for (let day = 1; day <= 31; day++) {
      const date = new Date(year, month, day);
      if (date.getMonth() !== month) break;

      const dateStr = this.getDateString(date);
      const filePath = path.join(this.statsDir, `daily-${dateStr}.json`);

      if (fs.existsSync(filePath)) {
        try {
          const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
          this.dailyStats.set(dateStr, data);
        } catch (error) {
          console.error(`Failed to load stats for ${dateStr}:`, error);
        }
      }
    }

    // Load tool usage
    const toolUsagePath = path.join(this.statsDir, 'tool-usage.json');
    if (fs.existsSync(toolUsagePath)) {
      try {
        const data = JSON.parse(fs.readFileSync(toolUsagePath, 'utf-8'));
        this.toolUsage = new Map(Object.entries(data));
      } catch (error) {
        console.error('Failed to load tool usage stats:', error);
      }
    }
  }

  /**
   * Save daily stats to disk
   */
  private saveDailyStats(dateStr: string): void {
    const stats = this.dailyStats.get(dateStr);
    if (!stats) return;

    const filePath = path.join(this.statsDir, `daily-${dateStr}.json`);
    try {
      fs.writeFileSync(filePath, JSON.stringify(stats, null, 2));
    } catch (error) {
      console.error(`Failed to save stats for ${dateStr}:`, error);
    }
  }

  /**
   * Save tool usage to disk
   */
  private saveToolUsage(): void {
    const filePath = path.join(this.statsDir, 'tool-usage.json');
    try {
      const data = Object.fromEntries(this.toolUsage);
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    } catch (error) {
      console.error('Failed to save tool usage stats:', error);
    }
  }

  /**
   * Get or create daily stats
   */
  private getOrCreateDailyStats(dateStr: string): DailyStats {
    if (!this.dailyStats.has(dateStr)) {
      this.dailyStats.set(dateStr, {
        date: dateStr,
        sessions: 0,
        messages: 0,
        inputTokens: 0,
        outputTokens: 0,
        cost: 0,
        toolUsage: {},
        agentUsage: {},
        avgSessionDuration: 0,
        peakConcurrentSessions: 0,
      });
    }
    return this.dailyStats.get(dateStr)!;
  }

  /**
   * Record session start
   */
  recordSessionStart(
    sessionId: string,
    instanceId: string,
    agentId: string,
    workingDirectory: string
  ): void {
    const now = Date.now();
    const stats: SessionStats = {
      sessionId,
      instanceId,
      startTime: now,
      duration: 0,
      messageCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      cost: 0,
      toolsUsed: [],
      agentId,
      workingDirectory,
    };

    this.sessionStats.set(sessionId, stats);

    // Update daily stats
    const dateStr = this.getDateString(new Date(now));
    const daily = this.getOrCreateDailyStats(dateStr);
    daily.sessions++;
    daily.agentUsage[agentId] = (daily.agentUsage[agentId] || 0) + 1;

    // Update peak concurrent sessions
    const activeSessions = Array.from(this.sessionStats.values()).filter(
      (s) => !s.endTime
    ).length;
    if (activeSessions > daily.peakConcurrentSessions) {
      daily.peakConcurrentSessions = activeSessions;
    }

    this.saveDailyStats(dateStr);
  }

  /**
   * Record session end
   */
  recordSessionEnd(sessionId: string): void {
    const stats = this.sessionStats.get(sessionId);
    if (!stats) return;

    stats.endTime = Date.now();
    stats.duration = stats.endTime - stats.startTime;

    // Update daily average duration
    const dateStr = this.getDateString(new Date(stats.startTime));
    const daily = this.getOrCreateDailyStats(dateStr);

    // Recalculate average duration
    const sessionsToday = Array.from(this.sessionStats.values()).filter(
      (s) => this.getDateString(new Date(s.startTime)) === dateStr && s.endTime
    );
    daily.avgSessionDuration =
      sessionsToday.reduce((sum, s) => sum + s.duration, 0) / sessionsToday.length;

    this.saveDailyStats(dateStr);
  }

  /**
   * Record message
   */
  recordMessage(
    sessionId: string,
    inputTokens: number,
    outputTokens: number,
    cost: number
  ): void {
    const stats = this.sessionStats.get(sessionId);
    if (!stats) return;

    stats.messageCount++;
    stats.inputTokens += inputTokens;
    stats.outputTokens += outputTokens;
    stats.cost += cost;

    // Update daily stats
    const dateStr = this.getDateString(new Date());
    const daily = this.getOrCreateDailyStats(dateStr);
    daily.messages++;
    daily.inputTokens += inputTokens;
    daily.outputTokens += outputTokens;
    daily.cost += cost;

    this.saveDailyStats(dateStr);
  }

  /**
   * Record tool usage
   */
  recordToolUsage(sessionId: string, tool: string): void {
    const stats = this.sessionStats.get(sessionId);
    if (stats && !stats.toolsUsed.includes(tool)) {
      stats.toolsUsed.push(tool);
    }

    // Update global tool usage
    const entry = this.toolUsage.get(tool) || { tool, count: 0, lastUsed: 0 };
    entry.count++;
    entry.lastUsed = Date.now();
    this.toolUsage.set(tool, entry);

    // Update daily stats
    const dateStr = this.getDateString(new Date());
    const daily = this.getOrCreateDailyStats(dateStr);
    daily.toolUsage[tool] = (daily.toolUsage[tool] || 0) + 1;

    this.saveDailyStats(dateStr);
    this.saveToolUsage();
  }

  /**
   * Get aggregated statistics for a period
   */
  getStats(period: StatsPeriod): AggregatedStats {
    const now = new Date();
    let startDate: Date;

    switch (period) {
      case 'day':
        startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        break;
      case 'week':
        startDate = new Date(now);
        startDate.setDate(startDate.getDate() - 7);
        break;
      case 'month':
        startDate = new Date(now.getFullYear(), now.getMonth(), 1);
        break;
      case 'year':
        startDate = new Date(now.getFullYear(), 0, 1);
        break;
      case 'all':
        startDate = new Date(0);
        break;
    }

    return this.aggregateStats(startDate.getTime(), now.getTime(), period);
  }

  /**
   * Aggregate statistics for a date range
   */
  private aggregateStats(startTime: number, endTime: number, period: StatsPeriod): AggregatedStats {
    const dailyBreakdown: DailyStats[] = [];
    let totalSessions = 0;
    let totalMessages = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    let totalDuration = 0;
    let sessionCount = 0;

    const toolCounts: Record<string, number> = {};
    const agentCounts: Record<string, number> = {};

    // Aggregate from daily stats
    for (const [dateStr, daily] of this.dailyStats) {
      const date = new Date(dateStr);
      if (date.getTime() >= startTime && date.getTime() <= endTime) {
        dailyBreakdown.push(daily);
        totalSessions += daily.sessions;
        totalMessages += daily.messages;
        totalInputTokens += daily.inputTokens;
        totalOutputTokens += daily.outputTokens;
        totalCost += daily.cost;
        totalDuration += daily.avgSessionDuration * daily.sessions;
        sessionCount += daily.sessions;

        for (const [tool, count] of Object.entries(daily.toolUsage)) {
          toolCounts[tool] = (toolCounts[tool] || 0) + count;
        }

        for (const [agent, count] of Object.entries(daily.agentUsage)) {
          agentCounts[agent] = (agentCounts[agent] || 0) + count;
        }
      }
    }

    // Sort daily breakdown by date
    dailyBreakdown.sort((a, b) => a.date.localeCompare(b.date));

    // Build most used tools list
    const mostUsedTools: ToolUsageEntry[] = Object.entries(toolCounts)
      .map(([tool, count]) => ({
        tool,
        count,
        lastUsed: this.toolUsage.get(tool)?.lastUsed || 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Build most used agents list
    const mostUsedAgents = Object.entries(agentCounts)
      .map(([agent, count]) => ({ agent, count }))
      .sort((a, b) => b.count - a.count);

    return {
      period,
      startDate: startTime,
      endDate: endTime,
      totalSessions,
      totalMessages,
      totalInputTokens,
      totalOutputTokens,
      totalCost,
      avgSessionDuration: sessionCount > 0 ? totalDuration / sessionCount : 0,
      avgTokensPerSession: totalSessions > 0 ? (totalInputTokens + totalOutputTokens) / totalSessions : 0,
      avgCostPerSession: totalSessions > 0 ? totalCost / totalSessions : 0,
      mostUsedTools,
      mostUsedAgents,
      dailyBreakdown,
    };
  }

  /**
   * Get session statistics
   */
  getSessionStats(sessionId: string): SessionStats | undefined {
    return this.sessionStats.get(sessionId);
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): SessionStats[] {
    return Array.from(this.sessionStats.values()).filter((s) => !s.endTime);
  }

  /**
   * Get tool usage statistics
   */
  getToolUsage(): ToolUsageEntry[] {
    return Array.from(this.toolUsage.values())
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Export statistics to JSON
   */
  exportStats(filePath: string, period: StatsPeriod = 'all'): void {
    const stats = this.getStats(period);
    fs.writeFileSync(filePath, JSON.stringify(stats, null, 2));
  }

  /**
   * Clear all statistics
   */
  clearStats(): void {
    this.sessionStats.clear();
    this.dailyStats.clear();
    this.toolUsage.clear();

    // Remove stats files
    const files = fs.readdirSync(this.statsDir);
    for (const file of files) {
      fs.unlinkSync(path.join(this.statsDir, file));
    }
  }

  /**
   * Get storage usage
   */
  getStorageUsage(): { files: number; totalBytes: number } {
    let files = 0;
    let totalBytes = 0;

    try {
      const entries = fs.readdirSync(this.statsDir);
      for (const entry of entries) {
        const stat = fs.statSync(path.join(this.statsDir, entry));
        if (stat.isFile()) {
          files++;
          totalBytes += stat.size;
        }
      }
    } catch (error) {
      console.error('Failed to calculate storage usage:', error);
    }

    return { files, totalBytes };
  }
}

// Singleton instance
let usageStatsInstance: UsageStatsManager | null = null;

export function getUsageStatsManager(): UsageStatsManager {
  if (!usageStatsInstance) {
    usageStatsInstance = new UsageStatsManager();
  }
  return usageStatsInstance;
}
