/**
 * Episodic Store
 * Specialized store for episodic memories (session history and learned patterns)
 * Part of the unified memory system
 */

import { EventEmitter } from 'events';
import type {
  SessionMemory,
  LearnedPattern,
  SessionOutcome,
} from '../../shared/types/unified-memory.types';

export interface EpisodicStoreConfig {
  maxSessions: number;
  maxPatterns: number;
  patternDecayRate: number; // How fast unused patterns decay
  sessionRetentionDays: number;
  enablePatternLearning: boolean;
}

export interface SessionQuery {
  outcome?: SessionOutcome;
  startDate?: number;
  endDate?: number;
  searchTerm?: string;
  limit?: number;
}

export interface PatternQuery {
  minSuccessRate?: number;
  minUsageCount?: number;
  contextMatch?: string;
  limit?: number;
}

export interface EpisodicStats {
  totalSessions: number;
  sessionsByOutcome: Record<SessionOutcome, number>;
  totalPatterns: number;
  avgPatternSuccessRate: number;
  mostUsedPatterns: LearnedPattern[];
}

export class EpisodicStore extends EventEmitter {
  private static instance: EpisodicStore;
  private config: EpisodicStoreConfig;
  private sessions: SessionMemory[] = [];
  private patterns: LearnedPattern[] = [];

  private defaultConfig: EpisodicStoreConfig = {
    maxSessions: 1000,
    maxPatterns: 500,
    patternDecayRate: 0.01, // 1% per day
    sessionRetentionDays: 90,
    enablePatternLearning: true,
  };

  static getInstance(): EpisodicStore {
    if (!this.instance) {
      this.instance = new EpisodicStore();
    }
    return this.instance;
  }

  private constructor() {
    super();
    this.config = { ...this.defaultConfig };
  }

  configure(config: Partial<EpisodicStoreConfig>): void {
    this.config = { ...this.config, ...config };
  }

  // ============ Session Management ============

  addSession(session: SessionMemory): void {
    this.sessions.push(session);

    // Enforce max sessions limit
    if (this.sessions.length > this.config.maxSessions) {
      // Remove oldest sessions first
      this.sessions.sort((a, b) => b.timestamp - a.timestamp);
      this.sessions = this.sessions.slice(0, this.config.maxSessions);
    }

    // Extract patterns from successful sessions
    if (this.config.enablePatternLearning && session.outcome === 'success') {
      this.extractPatternsFromSession(session);
    }

    this.emit('session:added', session);
  }

  getSession(sessionId: string): SessionMemory | undefined {
    return this.sessions.find(s => s.sessionId === sessionId);
  }

  querySessions(query: SessionQuery): SessionMemory[] {
    let results = [...this.sessions];

    if (query.outcome) {
      results = results.filter(s => s.outcome === query.outcome);
    }

    if (query.startDate) {
      results = results.filter(s => s.timestamp >= query.startDate!);
    }

    if (query.endDate) {
      results = results.filter(s => s.timestamp <= query.endDate!);
    }

    if (query.searchTerm) {
      const term = query.searchTerm.toLowerCase();
      results = results.filter(
        s =>
          s.summary.toLowerCase().includes(term) ||
          s.keyEvents.some(e => e.toLowerCase().includes(term)) ||
          s.lessonsLearned.some(l => l.toLowerCase().includes(term))
      );
    }

    // Sort by recency
    results.sort((a, b) => b.timestamp - a.timestamp);

    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  getRecentSessions(limit: number): SessionMemory[] {
    return this.querySessions({ limit });
  }

  getSimilarSessions(session: SessionMemory, limit: number = 5): SessionMemory[] {
    const keywords = this.extractKeywords(session.summary);

    const scored = this.sessions
      .filter(s => s.sessionId !== session.sessionId)
      .map(s => ({
        session: s,
        score: this.calculateSimilarity(keywords, this.extractKeywords(s.summary)),
      }))
      .filter(item => item.score > 0.2);

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(item => item.session);
  }

  // ============ Pattern Management ============

  addPattern(pattern: LearnedPattern): void {
    // Check for existing similar pattern
    const existing = this.findSimilarPattern(pattern.pattern);

    if (existing) {
      // Merge into existing pattern
      existing.usageCount += pattern.usageCount;
      existing.successRate =
        (existing.successRate * (existing.usageCount - 1) + pattern.successRate) /
        existing.usageCount;
      existing.contexts = [...new Set([...existing.contexts, ...pattern.contexts])];
      this.emit('pattern:merged', existing);
    } else {
      this.patterns.push(pattern);

      // Enforce max patterns limit
      if (this.patterns.length > this.config.maxPatterns) {
        // Remove lowest performing patterns
        this.patterns.sort((a, b) => b.successRate * b.usageCount - a.successRate * a.usageCount);
        this.patterns = this.patterns.slice(0, this.config.maxPatterns);
      }

      this.emit('pattern:added', pattern);
    }
  }

  getPattern(patternId: string): LearnedPattern | undefined {
    return this.patterns.find(p => p.id === patternId);
  }

  queryPatterns(query: PatternQuery): LearnedPattern[] {
    let results = [...this.patterns];

    if (query.minSuccessRate !== undefined) {
      results = results.filter(p => p.successRate >= query.minSuccessRate!);
    }

    if (query.minUsageCount !== undefined) {
      results = results.filter(p => p.usageCount >= query.minUsageCount!);
    }

    if (query.contextMatch) {
      const match = query.contextMatch.toLowerCase();
      results = results.filter(p => p.contexts.some(c => c.toLowerCase().includes(match)));
    }

    // Sort by effectiveness (success rate * usage count)
    results.sort((a, b) => b.successRate * b.usageCount - a.successRate * a.usageCount);

    if (query.limit) {
      results = results.slice(0, query.limit);
    }

    return results;
  }

  findMatchingPatterns(input: string): LearnedPattern[] {
    const keywords = this.extractKeywords(input);

    return this.patterns
      .map(pattern => ({
        pattern,
        score: this.calculateSimilarity(keywords, this.extractKeywords(pattern.pattern)),
      }))
      .filter(item => item.score > 0.3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(item => item.pattern);
  }

  recordPatternUsage(patternId: string, success: boolean, contextId: string): void {
    const pattern = this.patterns.find(p => p.id === patternId);
    if (!pattern) return;

    pattern.usageCount++;
    pattern.successRate =
      (pattern.successRate * (pattern.usageCount - 1) + (success ? 1 : 0)) / pattern.usageCount;

    if (!pattern.contexts.includes(contextId)) {
      pattern.contexts.push(contextId);
    }

    this.emit('pattern:used', { patternId, success, contextId });
  }

  // ============ Pattern Learning ============

  private extractPatternsFromSession(session: SessionMemory): void {
    // Extract patterns from lessons learned
    for (const lesson of session.lessonsLearned) {
      if (lesson.length > 20) {
        // Only meaningful lessons
        const existing = this.findSimilarPattern(lesson);

        if (existing) {
          existing.usageCount++;
          existing.successRate = (existing.successRate * (existing.usageCount - 1) + 1) / existing.usageCount;
          existing.contexts.push(session.sessionId);
        } else {
          this.addPattern({
            id: `pattern-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            pattern: lesson,
            successRate: 1.0,
            usageCount: 1,
            contexts: [session.sessionId],
          });
        }
      }
    }
  }

  private findSimilarPattern(text: string): LearnedPattern | undefined {
    const keywords = this.extractKeywords(text);

    for (const pattern of this.patterns) {
      const similarity = this.calculateSimilarity(keywords, this.extractKeywords(pattern.pattern));
      if (similarity > 0.7) {
        return pattern;
      }
    }

    return undefined;
  }

  // ============ Decay and Cleanup ============

  applyDecay(): void {
    const now = Date.now();

    // Decay patterns based on time since last use
    for (const pattern of this.patterns) {
      // Find most recent context timestamp
      const lastUsed = this.findLastUsedTime(pattern);
      const daysSinceUse = (now - lastUsed) / (24 * 60 * 60 * 1000);

      if (daysSinceUse > 7) {
        pattern.successRate *= 1 - this.config.patternDecayRate * Math.floor(daysSinceUse / 7);
        pattern.successRate = Math.max(0, pattern.successRate);
      }
    }

    // Remove very old sessions
    const retentionMs = this.config.sessionRetentionDays * 24 * 60 * 60 * 1000;
    this.sessions = this.sessions.filter(s => now - s.timestamp < retentionMs);

    // Remove very low performing patterns
    this.patterns = this.patterns.filter(p => p.successRate > 0.1 || p.usageCount > 10);

    this.emit('decay:applied');
  }

  private findLastUsedTime(pattern: LearnedPattern): number {
    let lastUsed = 0;

    for (const contextId of pattern.contexts) {
      const session = this.sessions.find(s => s.sessionId === contextId);
      if (session && session.timestamp > lastUsed) {
        lastUsed = session.timestamp;
      }
    }

    return lastUsed || Date.now() - 30 * 24 * 60 * 60 * 1000; // Default to 30 days ago
  }

  // ============ Utilities ============

  private extractKeywords(text: string): Set<string> {
    const stopWords = new Set([
      'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
      'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
      'should', 'may', 'might', 'must', 'can', 'to', 'of', 'in', 'for',
      'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
      'before', 'after', 'above', 'below', 'between', 'under', 'again',
      'further', 'then', 'once', 'here', 'there', 'when', 'where', 'why',
      'how', 'all', 'each', 'few', 'more', 'most', 'other', 'some', 'such',
      'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
      'and', 'but', 'if', 'or', 'because', 'until', 'while', 'this', 'that',
    ]);

    const words = text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(word => word.length > 2 && !stopWords.has(word));

    return new Set(words);
  }

  private calculateSimilarity(set1: Set<string>, set2: Set<string>): number {
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    return union.size > 0 ? intersection.size / union.size : 0;
  }

  // ============ Statistics ============

  getStats(): EpisodicStats {
    const sessionsByOutcome: Record<SessionOutcome, number> = {
      success: 0,
      partial: 0,
      failure: 0,
    };

    for (const session of this.sessions) {
      sessionsByOutcome[session.outcome]++;
    }

    const avgPatternSuccessRate =
      this.patterns.length > 0
        ? this.patterns.reduce((sum, p) => sum + p.successRate, 0) / this.patterns.length
        : 0;

    const mostUsedPatterns = this.queryPatterns({ limit: 5 });

    return {
      totalSessions: this.sessions.length,
      sessionsByOutcome,
      totalPatterns: this.patterns.length,
      avgPatternSuccessRate,
      mostUsedPatterns,
    };
  }

  // ============ Persistence ============

  exportState(): {
    sessions: SessionMemory[];
    patterns: LearnedPattern[];
  } {
    return {
      sessions: this.sessions,
      patterns: this.patterns,
    };
  }

  importState(state: { sessions?: SessionMemory[]; patterns?: LearnedPattern[] }): void {
    if (state.sessions) {
      this.sessions = state.sessions;
    }
    if (state.patterns) {
      this.patterns = state.patterns;
    }

    this.emit('state:imported');
  }

  clear(): void {
    this.sessions = [];
    this.patterns = [];
    this.emit('store:cleared');
  }
}

// Export singleton getter
export function getEpisodicStore(): EpisodicStore {
  return EpisodicStore.getInstance();
}
