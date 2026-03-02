/**
 * Unified Episodic-RLM Store
 *
 * Refactors the EpisodicStore to use RLMDatabase for persistence and VectorStore
 * for semantic search of past sessions and learned patterns.
 *
 * Key Changes:
 * 1. Sessions and patterns are stored as ContextSections with type: 'episode' or 'pattern'
 * 2. Session summaries and patterns are indexed in VectorStore for semantic retrieval
 * 3. Enables "What did I do last time when..." queries
 * 4. Full persistence across app restarts
 */

import { EventEmitter } from 'events';
import type {
  SessionMemory,
  LearnedPattern,
  SessionOutcome
} from '../../shared/types/unified-memory.types';
import { RLMDatabase, getRLMDatabase } from '../persistence/rlm-database';
import { VectorStore, getVectorStore } from '../rlm/vector-store';
import { ContextSectionRow } from '../persistence/rlm-database.types';
import { getLogger } from '../logging/logger';

const logger = getLogger('EpisodicRlmStore');

export interface EpisodicRLMStoreConfig {
  memoryCacheSize: number;
  maxPatterns: number;
  patternDecayRate: number;
  sessionRetentionDays: number;
  enablePatternLearning: boolean;
  minPatternSimilarity: number;
  minSessionSimilarity: number;
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

export interface EpisodicRLMStats {
  totalSessions: number;
  cachedSessions: number;
  sessionsByOutcome: Record<SessionOutcome, number>;
  totalPatterns: number;
  avgPatternSuccessRate: number;
  mostUsedPatterns: LearnedPattern[];
  vectorsIndexed: number;
}

export interface SemanticSearchResult {
  session: SessionMemory;
  similarity: number;
}

export interface PatternSearchResult {
  pattern: LearnedPattern;
  similarity: number;
}

const DEFAULT_CONFIG: EpisodicRLMStoreConfig = {
  memoryCacheSize: 100,
  maxPatterns: 500,
  patternDecayRate: 0.05,
  sessionRetentionDays: 180,
  enablePatternLearning: true,
  minPatternSimilarity: 0.6,
  minSessionSimilarity: 0.5
};

const EPISODIC_STORE_ID = 'episodic-unified-store';
const EPISODIC_INSTANCE_ID = 'episodic-system';
const SESSION_TYPE = 'episode';
const PATTERN_TYPE = 'pattern';

export class EpisodicRLMStore extends EventEmitter {
  private static instance: EpisodicRLMStore;
  private config: EpisodicRLMStoreConfig;
  private db: RLMDatabase;
  private vectorStore: VectorStore;
  private sessionCache = new Map<string, SessionMemory>();
  private patternCache = new Map<string, LearnedPattern>();
  private initialized = false;

  private constructor(config: Partial<EpisodicRLMStoreConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.db = getRLMDatabase();
    this.vectorStore = getVectorStore();
    this.initialize();
  }

  static getInstance(
    config?: Partial<EpisodicRLMStoreConfig>
  ): EpisodicRLMStore {
    if (!this.instance) {
      this.instance = new EpisodicRLMStore(config);
    }
    return this.instance;
  }

  configure(config: Partial<EpisodicRLMStoreConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): EpisodicRLMStoreConfig {
    return { ...this.config };
  }

  private async initialize(): Promise<void> {
    try {
      this.ensureStore();
      this.loadFromPersistence();
      this.initialized = true;
      this.emit('initialized', { success: true });
    } catch (error) {
      logger.error('Init failed', error instanceof Error ? error : undefined);
      this.emit('initialized', { success: false, error });
    }
  }

  private ensureStore(): void {
    const existingStore = this.db.getStore(EPISODIC_STORE_ID);
    if (!existingStore) {
      this.db.createStore({
        id: EPISODIC_STORE_ID,
        instanceId: EPISODIC_INSTANCE_ID,
        config: { type: 'episodic', version: '1.0.0' }
      });
    }
  }

  private loadFromPersistence(): void {
    try {
      const sections = this.db.getSections(EPISODIC_STORE_ID);
      let sessionsLoaded = 0;
      let patternsLoaded = 0;

      for (const section of sections) {
        if (section.type === SESSION_TYPE) {
          const session = this.sectionToSession(section);
          if (session) {
            this.sessionCache.set(session.sessionId, session);
            sessionsLoaded++;
          }
        } else if (section.type === PATTERN_TYPE) {
          const pattern = this.sectionToPattern(section);
          if (pattern) {
            this.patternCache.set(pattern.id, pattern);
            patternsLoaded++;
          }
        }
      }
      this.trimSessionCache();
      this.emit('loaded', {
        sessions: sessionsLoaded,
        patterns: patternsLoaded
      });
    } catch (error) {
      logger.error('Load failed', error instanceof Error ? error : undefined);
    }
  }

  async addSession(session: SessionMemory): Promise<void> {
    const content = this.sessionToContent(session);
    const sectionId = `session-${session.sessionId}`;

    try {
      this.db.addSection({
        id: sectionId,
        storeId: EPISODIC_STORE_ID,
        name: `Session: ${session.sessionId}`,
        type: SESSION_TYPE,
        content,
        tokens: Math.ceil(content.length / 4),
        startOffset: 0,
        endOffset: content.length,
        depth: 0
      });
    } catch (error) {
      logger.error('Failed to persist session', error instanceof Error ? error : undefined);
    }

    try {
      await this.vectorStore.addSection(EPISODIC_STORE_ID, sectionId, content, {
        type: SESSION_TYPE,
        outcome: session.outcome,
        timestamp: session.timestamp
      });
    } catch (error) {
      logger.error('Failed to index session', error instanceof Error ? error : undefined);
    }

    this.sessionCache.set(session.sessionId, session);
    this.trimSessionCache();

    if (this.config.enablePatternLearning && session.outcome === 'success') {
      await this.extractPatternsFromSession(session);
    }

    this.emit('session:added', session);
  }

  getSession(sessionId: string): SessionMemory | undefined {
    const cached = this.sessionCache.get(sessionId);
    if (cached) return cached;

    const sectionId = `session-${sessionId}`;
    const section = this.db.getSection(sectionId);
    if (section) {
      const session = this.sectionToSession(section);
      if (session) {
        this.sessionCache.set(sessionId, session);
        this.trimSessionCache();
        return session;
      }
    }
    return undefined;
  }

  querySessions(query: SessionQuery): SessionMemory[] {
    const sections = this.db.getSections(EPISODIC_STORE_ID, {
      type: SESSION_TYPE
    });
    let results: SessionMemory[] = [];

    for (const section of sections) {
      const session = this.sectionToSession(section);
      if (!session) continue;
      if (query.outcome && session.outcome !== query.outcome) continue;
      if (query.startDate && session.timestamp < query.startDate) continue;
      if (query.endDate && session.timestamp > query.endDate) continue;
      if (query.searchTerm) {
        const term = query.searchTerm.toLowerCase();
        const matches =
          session.summary.toLowerCase().includes(term) ||
          session.keyEvents.some((e) => e.toLowerCase().includes(term)) ||
          session.lessonsLearned.some((l) => l.toLowerCase().includes(term));
        if (!matches) continue;
      }
      results.push(session);
    }

    results.sort((a, b) => b.timestamp - a.timestamp);
    if (query.limit) results = results.slice(0, query.limit);
    return results;
  }

  getRecentSessions(limit: number): SessionMemory[] {
    return this.querySessions({ limit });
  }

  async findSimilarSessions(
    query: string,
    options?: { limit?: number; minSimilarity?: number }
  ): Promise<SemanticSearchResult[]> {
    const limit = options?.limit ?? 5;
    const minSimilarity =
      options?.minSimilarity ?? this.config.minSessionSimilarity;

    try {
      const searchResults = await this.vectorStore.search(
        EPISODIC_STORE_ID,
        query,
        {
          topK: limit,
          minSimilarity
        }
      );

      const results: SemanticSearchResult[] = [];
      for (const result of searchResults) {
        const section = this.db.getSection(result.entry.sectionId);
        if (section?.type !== SESSION_TYPE) continue;
        const session = this.sectionToSession(section);
        if (session) {
          results.push({ session, similarity: result.similarity });
        }
      }
      return results;
    } catch (error) {
      logger.error('Session search failed', error instanceof Error ? error : undefined);
      return [];
    }
  }

  async getSimilarSessions(
    session: SessionMemory,
    limit = 5
  ): Promise<SemanticSearchResult[]> {
    const results = await this.findSimilarSessions(session.summary, {
      limit: limit + 1
    });
    return results
      .filter((r) => r.session.sessionId !== session.sessionId)
      .slice(0, limit);
  }

  async addPattern(pattern: LearnedPattern): Promise<void> {
    const existing = await this.findSimilarPattern(pattern.pattern);
    if (existing) {
      existing.usageCount += pattern.usageCount;
      existing.successRate =
        (existing.successRate * (existing.usageCount - pattern.usageCount) +
          pattern.successRate * pattern.usageCount) /
        existing.usageCount;
      existing.contexts = [
        ...new Set([...existing.contexts, ...pattern.contexts])
      ];
      await this.updatePattern(existing);
      this.emit('pattern:merged', existing);
      return;
    }

    const content = this.patternToContent(pattern);
    const sectionId = `pattern-${pattern.id}`;

    try {
      this.db.addSection({
        id: sectionId,
        storeId: EPISODIC_STORE_ID,
        name: `Pattern: ${pattern.id}`,
        type: PATTERN_TYPE,
        content,
        tokens: Math.ceil(content.length / 4),
        startOffset: 0,
        endOffset: content.length,
        depth: 0
      });
    } catch (error) {
      logger.error('Failed to persist pattern', error instanceof Error ? error : undefined);
    }

    try {
      await this.vectorStore.addSection(EPISODIC_STORE_ID, sectionId, content, {
        type: PATTERN_TYPE,
        successRate: pattern.successRate,
        usageCount: pattern.usageCount
      });
    } catch (error) {
      logger.error('Failed to index pattern', error instanceof Error ? error : undefined);
    }

    this.patternCache.set(pattern.id, pattern);
    await this.trimPatterns();
    this.emit('pattern:added', pattern);
  }

  private async updatePattern(pattern: LearnedPattern): Promise<void> {
    const content = this.patternToContent(pattern);
    const sectionId = `pattern-${pattern.id}`;

    try {
      this.db.removeSection(sectionId);
      this.db.addSection({
        id: sectionId,
        storeId: EPISODIC_STORE_ID,
        name: `Pattern: ${pattern.id}`,
        type: PATTERN_TYPE,
        content,
        tokens: Math.ceil(content.length / 4),
        startOffset: 0,
        endOffset: content.length,
        depth: 0
      });
    } catch (error) {
      logger.error('Failed to update pattern', error instanceof Error ? error : undefined);
    }

    try {
      this.vectorStore.removeSection(sectionId);
      await this.vectorStore.addSection(EPISODIC_STORE_ID, sectionId, content, {
        type: PATTERN_TYPE,
        successRate: pattern.successRate,
        usageCount: pattern.usageCount
      });
    } catch (error) {
      logger.error('Failed to re-index pattern', error instanceof Error ? error : undefined);
    }

    this.patternCache.set(pattern.id, pattern);
  }

  getPattern(patternId: string): LearnedPattern | undefined {
    const cached = this.patternCache.get(patternId);
    if (cached) return cached;

    const sectionId = `pattern-${patternId}`;
    const section = this.db.getSection(sectionId);
    if (section) {
      const pattern = this.sectionToPattern(section);
      if (pattern) {
        this.patternCache.set(patternId, pattern);
        return pattern;
      }
    }
    return undefined;
  }

  queryPatterns(query: PatternQuery): LearnedPattern[] {
    const sections = this.db.getSections(EPISODIC_STORE_ID, {
      type: PATTERN_TYPE
    });
    let results: LearnedPattern[] = [];

    for (const section of sections) {
      const pattern = this.sectionToPattern(section);
      if (!pattern) continue;
      if (
        query.minSuccessRate !== undefined &&
        pattern.successRate < query.minSuccessRate
      )
        continue;
      if (
        query.minUsageCount !== undefined &&
        pattern.usageCount < query.minUsageCount
      )
        continue;
      if (query.contextMatch) {
        const match = query.contextMatch.toLowerCase();
        if (!pattern.contexts.some((c) => c.toLowerCase().includes(match)))
          continue;
      }
      results.push(pattern);
    }

    results.sort(
      (a, b) => b.successRate * b.usageCount - a.successRate * a.usageCount
    );
    if (query.limit) results = results.slice(0, query.limit);
    return results;
  }

  async searchPatterns(
    query: string,
    options?: { limit?: number; minSimilarity?: number }
  ): Promise<PatternSearchResult[]> {
    const limit = options?.limit ?? 5;
    const minSimilarity =
      options?.minSimilarity ?? this.config.minPatternSimilarity;

    try {
      const searchResults = await this.vectorStore.search(
        EPISODIC_STORE_ID,
        query,
        {
          topK: limit,
          minSimilarity
        }
      );

      const results: PatternSearchResult[] = [];
      for (const result of searchResults) {
        const section = this.db.getSection(result.entry.sectionId);
        if (section?.type !== PATTERN_TYPE) continue;
        const pattern = this.sectionToPattern(section);
        if (pattern) {
          results.push({ pattern, similarity: result.similarity });
        }
      }
      return results;
    } catch (error) {
      logger.error('Pattern search failed', error instanceof Error ? error : undefined);
      return [];
    }
  }

  async findMatchingPatterns(input: string): Promise<LearnedPattern[]> {
    const results = await this.searchPatterns(input, { limit: 5 });
    return results.map((r) => r.pattern);
  }

  async recordPatternUsage(
    patternId: string,
    success: boolean,
    contextId: string
  ): Promise<void> {
    const pattern = this.getPattern(patternId);
    if (!pattern) return;

    pattern.usageCount++;
    pattern.successRate =
      (pattern.successRate * (pattern.usageCount - 1) + (success ? 1 : 0)) /
      pattern.usageCount;
    if (!pattern.contexts.includes(contextId)) {
      pattern.contexts.push(contextId);
    }
    await this.updatePattern(pattern);
    this.emit('pattern:used', { patternId, success, contextId });
  }

  private async findSimilarPattern(
    text: string
  ): Promise<LearnedPattern | undefined> {
    const results = await this.searchPatterns(text, {
      limit: 1,
      minSimilarity: 0.7
    });
    return results[0]?.pattern;
  }

  private async extractPatternsFromSession(
    session: SessionMemory
  ): Promise<void> {
    for (const lesson of session.lessonsLearned) {
      if (lesson.length > 20) {
        const existing = await this.findSimilarPattern(lesson);
        if (existing) {
          existing.usageCount++;
          existing.successRate =
            (existing.successRate * (existing.usageCount - 1) + 1) /
            existing.usageCount;
          if (!existing.contexts.includes(session.sessionId)) {
            existing.contexts.push(session.sessionId);
          }
          await this.updatePattern(existing);
        } else {
          await this.addPattern({
            id: `pattern-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            pattern: lesson,
            successRate: 1.0,
            usageCount: 1,
            contexts: [session.sessionId]
          });
        }
      }
    }
  }

  private trimSessionCache(): void {
    if (this.sessionCache.size <= this.config.memoryCacheSize) return;
    const sessions = Array.from(this.sessionCache.values());
    sessions.sort((a, b) => b.timestamp - a.timestamp);
    this.sessionCache.clear();
    for (const session of sessions.slice(0, this.config.memoryCacheSize)) {
      this.sessionCache.set(session.sessionId, session);
    }
  }

  private async trimPatterns(): Promise<void> {
    const patterns = this.queryPatterns({});
    if (patterns.length <= this.config.maxPatterns) return;

    const toRemove = patterns.slice(this.config.maxPatterns);
    for (const pattern of toRemove) {
      const sectionId = `pattern-${pattern.id}`;
      try {
        this.db.removeSection(sectionId);
        this.vectorStore.removeSection(sectionId);
        this.patternCache.delete(pattern.id);
      } catch (error) {
        logger.error('Failed to remove pattern', error instanceof Error ? error : undefined);
      }
    }
  }

  async applyDecay(): Promise<void> {
    const now = Date.now();
    const weekMs = 7 * 24 * 60 * 60 * 1000;
    const patterns = this.queryPatterns({});

    for (const pattern of patterns) {
      let lastUsed = 0;
      for (const contextId of pattern.contexts) {
        const session = this.getSession(contextId);
        if (session && session.timestamp > lastUsed) {
          lastUsed = session.timestamp;
        }
      }
      if (lastUsed === 0) lastUsed = now - 4 * weekMs;

      const weeksSinceUse = Math.floor((now - lastUsed) / weekMs);
      if (weeksSinceUse > 1) {
        const decay = Math.pow(1 - this.config.patternDecayRate, weeksSinceUse);
        pattern.successRate *= decay;
        pattern.successRate = Math.max(0, pattern.successRate);

        if (pattern.successRate < 0.1 && pattern.usageCount < 10) {
          const sectionId = `pattern-${pattern.id}`;
          try {
            this.db.removeSection(sectionId);
            this.vectorStore.removeSection(sectionId);
            this.patternCache.delete(pattern.id);
          } catch (error) {
            logger.error('Failed to remove decayed pattern', error instanceof Error ? error : undefined);
          }
        } else {
          await this.updatePattern(pattern);
        }
      }
    }

    const retentionMs = this.config.sessionRetentionDays * 24 * 60 * 60 * 1000;
    const sections = this.db.getSections(EPISODIC_STORE_ID, {
      type: SESSION_TYPE
    });

    for (const section of sections) {
      const session = this.sectionToSession(section);
      if (session && now - session.timestamp > retentionMs) {
        try {
          this.db.removeSection(section.id);
          this.vectorStore.removeSection(section.id);
          this.sessionCache.delete(session.sessionId);
        } catch (error) {
          logger.error('Failed to archive old session', error instanceof Error ? error : undefined);
        }
      }
    }
    this.emit('decay:applied');
  }

  private sessionToContent(session: SessionMemory): string {
    return JSON.stringify({
      sessionId: session.sessionId,
      summary: session.summary,
      keyEvents: session.keyEvents,
      outcome: session.outcome,
      lessonsLearned: session.lessonsLearned,
      timestamp: session.timestamp
    });
  }

  private sectionToSession(
    section: ContextSectionRow
  ): SessionMemory | undefined {
    try {
      const content = this.db.getSectionContent(section);
      const data = JSON.parse(content);
      return {
        sessionId: data.sessionId,
        summary: data.summary,
        keyEvents: data.keyEvents || [],
        outcome: data.outcome,
        lessonsLearned: data.lessonsLearned || [],
        timestamp: data.timestamp
      };
    } catch {
      return undefined;
    }
  }

  private patternToContent(pattern: LearnedPattern): string {
    return JSON.stringify({
      id: pattern.id,
      pattern: pattern.pattern,
      successRate: pattern.successRate,
      usageCount: pattern.usageCount,
      contexts: pattern.contexts
    });
  }

  private sectionToPattern(
    section: ContextSectionRow
  ): LearnedPattern | undefined {
    try {
      const content = this.db.getSectionContent(section);
      const data = JSON.parse(content);
      return {
        id: data.id,
        pattern: data.pattern,
        successRate: data.successRate,
        usageCount: data.usageCount,
        contexts: data.contexts || []
      };
    } catch {
      return undefined;
    }
  }

  getStats(): EpisodicRLMStats {
    const sessions = this.querySessions({});
    const patterns = this.queryPatterns({});

    const sessionsByOutcome: Record<SessionOutcome, number> = {
      success: 0,
      partial: 0,
      failure: 0
    };
    for (const session of sessions) {
      sessionsByOutcome[session.outcome]++;
    }

    const avgPatternSuccessRate =
      patterns.length > 0
        ? patterns.reduce((sum, p) => sum + p.successRate, 0) / patterns.length
        : 0;

    const vectorStats = this.vectorStore.getStats();
    const storeVectors = vectorStats.storeStats.find(
      (s) => s.storeId === EPISODIC_STORE_ID
    );

    return {
      totalSessions: sessions.length,
      cachedSessions: this.sessionCache.size,
      sessionsByOutcome,
      totalPatterns: patterns.length,
      avgPatternSuccessRate,
      mostUsedPatterns: patterns.slice(0, 5),
      vectorsIndexed: storeVectors?.vectorCount ?? 0
    };
  }

  exportState(): { sessions: SessionMemory[]; patterns: LearnedPattern[] } {
    return {
      sessions: this.querySessions({}),
      patterns: this.queryPatterns({})
    };
  }

  async importState(state: {
    sessions?: SessionMemory[];
    patterns?: LearnedPattern[];
  }): Promise<void> {
    if (state.sessions) {
      for (const session of state.sessions) {
        await this.addSession(session);
      }
    }
    if (state.patterns) {
      for (const pattern of state.patterns) {
        await this.addPattern(pattern);
      }
    }
    this.emit('state:imported');
  }

  async clear(): Promise<void> {
    const sections = this.db.getSections(EPISODIC_STORE_ID);
    for (const section of sections) {
      try {
        this.db.removeSection(section.id);
        this.vectorStore.removeSection(section.id);
      } catch (error) {
        logger.error('Failed to clear section', error instanceof Error ? error : undefined);
      }
    }
    this.sessionCache.clear();
    this.patternCache.clear();
    this.emit('store:cleared');
  }
}

export function getEpisodicRLMStore(
  config?: Partial<EpisodicRLMStoreConfig>
): EpisodicRLMStore {
  return EpisodicRLMStore.getInstance(config);
}
