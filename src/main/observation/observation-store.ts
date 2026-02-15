/**
 * Observation Store
 *
 * Persistence facade for the observation memory system.
 * Wraps RLMDatabase CRUD with in-memory caching and VectorStore for semantic search.
 */

import { EventEmitter } from 'events';
import { getRLMDatabase } from '../persistence/rlm-database';
import { getVectorStore } from '../rlm/vector-store';
import { getLogger } from '../logging/logger';
import { generateId } from '../../shared/utils/id-generator';
import {
  DEFAULT_OBSERVATION_CONFIG,
  type Observation,
  type Reflection,
  type ObservationStats,
  type ObservationConfig,
} from '../../shared/types/observation.types';
import type { ObservationRow, ReflectionRow } from '../persistence/rlm-database.types';

export class ObservationStore extends EventEmitter {
  private static instance: ObservationStore;
  private logger = getLogger('ObservationStore');
  private config: ObservationConfig = DEFAULT_OBSERVATION_CONFIG;
  private observationCache = new Map<string, Observation>();
  private reflectionCache = new Map<string, Reflection>();
  private readonly VECTOR_STORE_ID = 'observation-store';
  private stats = {
    totalInjections: 0,
    successfulInjections: 0,
  };

  private constructor() {
    super();
  }

  static getInstance(): ObservationStore {
    if (!this.instance) {
      this.instance = new ObservationStore();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.cleanup();
      this.instance.removeAllListeners();
      this.instance = undefined as unknown as ObservationStore;
    }
  }

  /**
   * Store an observation (generates ID, persists, caches, and indexes)
   */
  storeObservation(obs: Omit<Observation, 'id'>): Observation {
    const observation: Observation = {
      id: generateId(),
      ...obs,
    };

    // Store to database
    try {
      const db = getRLMDatabase();
      db.addObservation({
        id: observation.id,
        summary: observation.summary,
        sourceIds: observation.sourceIds,
        instanceIds: observation.instanceIds,
        themes: observation.themes,
        keyFindings: observation.keyFindings,
        successSignals: observation.successSignals,
        failureSignals: observation.failureSignals,
        timestamp: observation.timestamp,
        createdAt: observation.createdAt,
        ttl: observation.ttl,
        promoted: observation.promoted,
        tokenCount: observation.tokenCount,
      });
    } catch (error) {
      this.logger.warn('Failed to persist observation to database', { error, observationId: observation.id });
    }

    // Cache locally
    this.observationCache.set(observation.id, observation);

    // Generate embedding (async, fire-and-forget)
    this.generateObservationEmbedding(observation).catch((error) => {
      this.logger.warn('Failed to generate observation embedding', { error, observationId: observation.id });
    });

    this.emit('observation:stored', { id: observation.id });
    return observation;
  }

  /**
   * Store a reflection (generates ID, persists, caches, and indexes)
   */
  storeReflection(ref: Omit<Reflection, 'id'>): Reflection {
    const reflection: Reflection = {
      id: generateId(),
      ...ref,
    };

    // Store to database
    try {
      const db = getRLMDatabase();
      db.addReflection({
        id: reflection.id,
        title: reflection.title,
        insight: reflection.insight,
        observationIds: reflection.observationIds,
        patterns: reflection.patterns,
        confidence: reflection.confidence,
        applicability: reflection.applicability,
        createdAt: reflection.createdAt,
        ttl: reflection.ttl,
        usageCount: reflection.usageCount,
        effectivenessScore: reflection.effectivenessScore,
        promotedToProcedural: reflection.promotedToProcedural,
      });
    } catch (error) {
      this.logger.warn('Failed to persist reflection to database', { error, reflectionId: reflection.id });
    }

    // Cache locally
    this.reflectionCache.set(reflection.id, reflection);

    // Generate embedding (async, fire-and-forget)
    this.generateReflectionEmbedding(reflection).catch((error) => {
      this.logger.warn('Failed to generate reflection embedding', { error, reflectionId: reflection.id });
    });

    this.emit('reflection:stored', { id: reflection.id });
    return reflection;
  }

  /**
   * Query relevant reflections using semantic search
   */
  async queryRelevantReflections(
    context: string,
    options?: { topK?: number; minConfidence?: number }
  ): Promise<Reflection[]> {
    const topK = options?.topK || 5;
    const minConfidence = options?.minConfidence ?? 0.5;

    try {
      const vectorStore = getVectorStore();
      const searchResults = await vectorStore.search(this.VECTOR_STORE_ID, context, {
        topK,
        minSimilarity: 0.3, // Lower threshold for initial retrieval
      });

      const reflections: Reflection[] = [];

      for (const result of searchResults) {
        // Extract reflection ID from section ID (format: "reflection-{id}")
        const reflectionId = result.entry.sectionId.replace('reflection-', '');

        // Try cache first, then database
        let reflection = this.reflectionCache.get(reflectionId);

        if (!reflection) {
          const db = getRLMDatabase();
          const rows = db.getReflections({ limit: 1 });
          const row = rows.find((r) => r.id === reflectionId);

          if (row) {
            reflection = this.rowToReflection(row);
            this.reflectionCache.set(reflection.id, reflection);
          }
        }

        // Filter by confidence threshold
        if (reflection && reflection.confidence >= minConfidence) {
          reflections.push(reflection);
        }
      }

      this.logger.info('Queried relevant reflections', {
        contextLength: context.length,
        topK,
        minConfidence,
        resultsFound: reflections.length,
      });

      return reflections;
    } catch (error) {
      this.logger.warn('Failed to query reflections (VectorStore may not be initialized)', { error });
      return [];
    }
  }

  /**
   * Query relevant observations using semantic search
   */
  async queryRelevantObservations(
    context: string,
    options?: { topK?: number }
  ): Promise<Observation[]> {
    const topK = options?.topK || 10;

    try {
      const vectorStore = getVectorStore();
      const searchResults = await vectorStore.search(this.VECTOR_STORE_ID, context, {
        topK,
        minSimilarity: 0.3,
      });

      const observations: Observation[] = [];

      for (const result of searchResults) {
        // Extract observation ID from section ID (format: "observation-{id}")
        const observationId = result.entry.sectionId.replace('observation-', '');

        // Try cache first, then database
        let observation = this.observationCache.get(observationId);

        if (!observation) {
          const db = getRLMDatabase();
          const rows = db.getObservations({ limit: 1 });
          const row = rows.find((r) => r.id === observationId);

          if (row) {
            observation = this.rowToObservation(row);
            this.observationCache.set(observation.id, observation);
          }
        }

        if (observation) {
          observations.push(observation);
        }
      }

      this.logger.info('Queried relevant observations', {
        contextLength: context.length,
        topK,
        resultsFound: observations.length,
      });

      return observations;
    } catch (error) {
      this.logger.warn('Failed to query observations (VectorStore may not be initialized)', { error });
      return [];
    }
  }

  /**
   * Record injection usage and update effectiveness
   */
  recordInjection(reflectionId: string, success: boolean): void {
    this.stats.totalInjections++;
    if (success) {
      this.stats.successfulInjections++;
    }

    // Update reflection usage and effectiveness
    const reflection = this.reflectionCache.get(reflectionId);
    if (!reflection) {
      this.logger.warn('Cannot record injection for unknown reflection', { reflectionId });
      return;
    }

    const newUsageCount = reflection.usageCount + 1;
    // Exponential moving average: new = old * 0.9 + current * 0.1
    const newEffectiveness = reflection.effectivenessScore * 0.9 + (success ? 1 : 0) * 0.1;

    reflection.usageCount = newUsageCount;
    reflection.effectivenessScore = newEffectiveness;

    // Update in cache
    this.reflectionCache.set(reflectionId, reflection);

    // Update in database
    try {
      const db = getRLMDatabase();
      db.updateReflection(reflectionId, {
        usageCount: newUsageCount,
        effectivenessScore: newEffectiveness,
      });
    } catch (error) {
      this.logger.warn('Failed to update reflection in database', { error, reflectionId });
    }

    this.emit('injection:recorded', { reflectionId, success, usageCount: newUsageCount, effectiveness: newEffectiveness });
  }

  /**
   * Apply decay by deleting expired observations and reflections
   */
  applyDecay(): { expiredObservations: number; expiredReflections: number } {
    let expiredObservations = 0;
    let expiredReflections = 0;

    try {
      const db = getRLMDatabase();

      // Delete expired observations from DB
      expiredObservations = db.deleteExpiredObservations();

      // Delete expired reflections from DB
      expiredReflections = db.deleteExpiredReflections();

      // Clear expired from cache
      const now = Date.now();

      for (const [id, obs] of this.observationCache) {
        if (now > obs.createdAt + obs.ttl) {
          this.observationCache.delete(id);
        }
      }

      for (const [id, ref] of this.reflectionCache) {
        if (now > ref.createdAt + ref.ttl) {
          this.reflectionCache.delete(id);
        }
      }

      this.logger.info('Applied decay', { expiredObservations, expiredReflections });
    } catch (error) {
      this.logger.warn('Failed to apply decay', { error });
    }

    return { expiredObservations, expiredReflections };
  }

  /**
   * Get aggregate statistics
   */
  getStats(): ObservationStats {
    let dbStats = {
      totalObservations: 0,
      totalReflections: 0,
      promotedReflections: 0,
      averageConfidence: 0,
      averageEffectiveness: 0,
    };

    try {
      const db = getRLMDatabase();
      dbStats = db.getObservationStats();
    } catch (error) {
      this.logger.warn('Failed to get database stats', { error });
    }

    return {
      totalRawCaptured: 0, // Tracked by ObservationBuffer
      totalObservations: dbStats.totalObservations,
      totalReflections: dbStats.totalReflections,
      promotedReflections: dbStats.promotedReflections,
      averageConfidence: dbStats.averageConfidence,
      averageEffectiveness: dbStats.averageEffectiveness,
      totalInjections: this.stats.totalInjections,
      successfulInjections: this.stats.successfulInjections,
      bufferSize: 0, // Tracked by ObservationBuffer
      lastFlushTimestamp: null, // Tracked by ObservationBuffer
      lastReflectionTimestamp: null, // Tracked by ObservationBuffer
    };
  }

  /**
   * Promote reflection to procedural memory
   */
  promoteReflection(reflectionId: string): boolean {
    const reflection = this.reflectionCache.get(reflectionId);

    if (!reflection) {
      this.logger.warn('Cannot promote unknown reflection', { reflectionId });
      return false;
    }

    // Check promotion gates
    const meetsConfidence = reflection.confidence >= this.config.promotionConfidenceThreshold;
    const meetsUsage = reflection.usageCount >= this.config.promotionUsageThreshold;
    const meetsEffectiveness = reflection.effectivenessScore >= this.config.promotionEffectivenessThreshold;

    if (!meetsConfidence || !meetsUsage || !meetsEffectiveness) {
      this.logger.info('Reflection does not meet promotion criteria', {
        reflectionId,
        confidence: reflection.confidence,
        required: this.config.promotionConfidenceThreshold,
        usageCount: reflection.usageCount,
        requiredUsage: this.config.promotionUsageThreshold,
        effectiveness: reflection.effectivenessScore,
        requiredEffectiveness: this.config.promotionEffectivenessThreshold,
      });
      return false;
    }

    // Mark as promoted
    reflection.promotedToProcedural = true;
    this.reflectionCache.set(reflectionId, reflection);

    // Update in database
    try {
      const db = getRLMDatabase();
      db.updateReflection(reflectionId, {
        promotedToProcedural: true,
      });
    } catch (error) {
      this.logger.warn('Failed to update reflection promotion in database', { error, reflectionId });
    }

    this.logger.info('Promoted reflection to procedural memory', { reflectionId });
    this.emit('reflection:promoted', { reflectionId });
    return true;
  }

  /**
   * Get reflections (direct database query, no semantic search)
   */
  getReflections(options?: { minConfidence?: number; limit?: number }): Reflection[] {
    try {
      const db = getRLMDatabase();
      const rows = db.getReflections({
        minConfidence: options?.minConfidence,
        limit: options?.limit,
      });
      return rows.map((row) => this.rowToReflection(row));
    } catch (error) {
      this.logger.warn('Failed to get reflections from database', { error });
      return [];
    }
  }

  /**
   * Get observations (direct database query, no semantic search)
   */
  getObservations(options?: { since?: number; limit?: number }): Observation[] {
    try {
      const db = getRLMDatabase();
      const rows = db.getObservations({
        since: options?.since,
        limit: options?.limit,
      });
      return rows.map((row) => this.rowToObservation(row));
    } catch (error) {
      this.logger.warn('Failed to get observations from database', { error });
      return [];
    }
  }

  /**
   * Get current configuration
   */
  getConfig(): ObservationConfig {
    return { ...this.config };
  }

  /**
   * Configure observation settings
   */
  configure(config: Partial<ObservationConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('Configuration updated', { config });
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    this.observationCache.clear();
    this.reflectionCache.clear();
    this.stats.totalInjections = 0;
    this.stats.successfulInjections = 0;
  }

  // ============================================
  // Private Helpers
  // ============================================

  /**
   * Generate embedding for observation
   */
  private async generateObservationEmbedding(observation: Observation): Promise<void> {
    try {
      const vectorStore = getVectorStore();
      const content = `${observation.summary}\n\nThemes: ${observation.themes.join(', ')}\nKey Findings: ${observation.keyFindings.join('; ')}`;

      await vectorStore.addSection(
        this.VECTOR_STORE_ID,
        `observation-${observation.id}`,
        content,
        {
          type: 'observation',
          sourceIds: observation.sourceIds,
          instanceIds: observation.instanceIds,
          timestamp: observation.timestamp,
        }
      );
    } catch {
      // Graceful degradation if VectorStore fails
      this.logger.warn('VectorStore not available for observation embedding', { observationId: observation.id });
    }
  }

  /**
   * Generate embedding for reflection
   */
  private async generateReflectionEmbedding(reflection: Reflection): Promise<void> {
    try {
      const vectorStore = getVectorStore();
      const patternDescriptions = reflection.patterns.map((p) => p.description).join('\n');
      const content = `${reflection.title}\n\n${reflection.insight}\n\nPatterns:\n${patternDescriptions}`;

      await vectorStore.addSection(
        this.VECTOR_STORE_ID,
        `reflection-${reflection.id}`,
        content,
        {
          type: 'reflection',
          observationIds: reflection.observationIds,
          confidence: reflection.confidence,
          applicability: reflection.applicability,
        }
      );
    } catch {
      // Graceful degradation if VectorStore fails
      this.logger.warn('VectorStore not available for reflection embedding', { reflectionId: reflection.id });
    }
  }

  /**
   * Convert database row to Observation
   */
  private rowToObservation(row: ObservationRow): Observation {
    return {
      id: row.id,
      summary: row.summary,
      sourceIds: JSON.parse(row.source_ids_json || '[]'),
      instanceIds: JSON.parse(row.instance_ids_json || '[]'),
      themes: JSON.parse(row.themes_json || '[]'),
      keyFindings: JSON.parse(row.key_findings_json || '[]'),
      successSignals: row.success_signals,
      failureSignals: row.failure_signals,
      timestamp: row.timestamp,
      createdAt: row.created_at,
      ttl: row.ttl,
      promoted: row.promoted === 1,
      tokenCount: row.token_count,
    };
  }

  /**
   * Convert database row to Reflection
   */
  private rowToReflection(row: ReflectionRow): Reflection {
    return {
      id: row.id,
      title: row.title,
      insight: row.insight,
      observationIds: JSON.parse(row.observation_ids_json || '[]'),
      patterns: JSON.parse(row.patterns_json || '[]'),
      confidence: row.confidence,
      applicability: JSON.parse(row.applicability_json || '[]'),
      createdAt: row.created_at,
      ttl: row.ttl,
      usageCount: row.usage_count,
      effectivenessScore: row.effectiveness_score,
      promotedToProcedural: row.promoted_to_procedural === 1,
    };
  }
}

/**
 * Convenience getter for singleton instance
 */
export function getObservationStore(): ObservationStore {
  return ObservationStore.getInstance();
}
