import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { getObserverAgent } from './observer-agent';
import { getObservationStore } from './observation-store';
import { getRLMDatabase } from '../persistence/rlm-database';
import type {
  Observation,
  Reflection,
  ReflectedPattern,
  ObservationConfig
} from '../../shared/types/observation.types';
import { DEFAULT_OBSERVATION_CONFIG } from '../../shared/types/observation.types';

/**
 * ReflectorAgent - Consolidates observations into reflection patterns
 *
 * Clusters observations by theme similarity and builds reflections with:
 * - Pattern extraction (success/failure/cross-instance/workflow)
 * - Confidence scoring based on cluster size and signal consistency
 * - Promotion gates to procedural memory
 */
export class ReflectorAgent extends EventEmitter {
  private static instance: ReflectorAgent;

  static getInstance(): ReflectorAgent {
    if (!this.instance) {
      this.instance = new ReflectorAgent();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.removeAllListeners();
      this.instance = undefined as unknown as ReflectorAgent;
    }
  }

  private logger = getLogger('ReflectorAgent');
  private config = DEFAULT_OBSERVATION_CONFIG;
  private pendingObservations: Observation[] = [];

  private constructor() {
    super();

    // Wire up event listeners
    const observer = getObserverAgent();

    observer.on('observer:observation-created', (obs: Observation) => {
      this.pendingObservations.push(obs);
    });

    observer.on('observer:reflect-ready', () => {
      this.processReflection();
    });

    this.logger.info('ReflectorAgent initialized');
  }

  /**
   * Configure reflection behavior
   */
  configure(config: Partial<ObservationConfig>): void {
    this.config = { ...this.config, ...config };
    this.logger.info('ReflectorAgent configured', { config: this.config });
  }

  /**
   * Force immediate reflection processing
   */
  forceReflect(): void {
    this.logger.info('Force reflecting pending observations', {
      count: this.pendingObservations.length
    });
    this.processReflection();
  }

  /**
   * Core consolidation: cluster observations and build reflections
   */
  private processReflection(): void {
    if (this.pendingObservations.length === 0) {
      return;
    }

    const observations = [...this.pendingObservations];
    this.pendingObservations = [];

    this.logger.info('Processing reflections', { observationCount: observations.length });

    try {
      const clusters = this.clusterByThemes(observations);
      const store = getObservationStore();
      let reflectionCount = 0;
      let promotionCount = 0;

      for (const cluster of clusters) {
        // Only create reflections from clusters with >= 2 observations
        if (cluster.length < 2) {
          continue;
        }

        const reflectionData = this.buildReflection(cluster);

        // Store the reflection (store generates the ID)
        const reflection = store.storeReflection(reflectionData);
        reflectionCount++;

        // Emit creation event
        this.emit('reflector:reflection-created', reflection);

        // Mark source observations as promoted
        const db = getRLMDatabase();
        for (const obs of cluster) {
          try {
            db.updateObservation(obs.id, { promoted: true });
          } catch (error) {
            this.logger.warn('Failed to mark observation as promoted', {
              observationId: obs.id,
              error
            });
          }
        }

        // Check promotion gates
        const shouldPromote =
          reflection.confidence >= this.config.promotionConfidenceThreshold &&
          reflection.usageCount >= this.config.promotionUsageThreshold &&
          reflection.effectivenessScore >= this.config.promotionEffectivenessThreshold;

        if (shouldPromote) {
          try {
            store.promoteReflection(reflection.id);
            promotionCount++;
            this.emit('reflector:promoted-to-procedural', reflection);
            this.logger.info('Reflection promoted to procedural memory', {
              reflectionId: reflection.id,
              title: reflection.title
            });
          } catch (error) {
            this.logger.warn('Failed to promote reflection', {
              reflectionId: reflection.id,
              error
            });
          }
        }
      }

      this.logger.info('Reflection processing complete', {
        clustersProcessed: clusters.length,
        reflectionsCreated: reflectionCount,
        promotions: promotionCount
      });
    } catch (error) {
      this.logger.error('Failed to process reflections', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Cluster observations by theme similarity using Jaccard index
   */
  private clusterByThemes(observations: Observation[]): Observation[][] {
    const clusters: Observation[][] = [];

    for (const obs of observations) {
      let addedToCluster = false;

      // Try to add to existing cluster based on theme similarity
      for (const cluster of clusters) {
        // Check similarity with any member of the cluster
        const hasSimilarMember = cluster.some(member =>
          this.jaccardSimilarity(obs.themes, member.themes) >= 0.3
        );

        if (hasSimilarMember) {
          cluster.push(obs);
          addedToCluster = true;
          break;
        }
      }

      // Create new cluster if no match found
      if (!addedToCluster) {
        clusters.push([obs]);
      }
    }

    return clusters;
  }

  /**
   * Calculate Jaccard similarity between two theme arrays
   */
  private jaccardSimilarity(a: string[], b: string[]): number {
    if (a.length === 0 && b.length === 0) {
      return 0;
    }

    const setA = new Set(a);
    const setB = new Set(b);

    const intersection = new Set([...setA].filter(x => setB.has(x)));
    const union = new Set([...setA, ...setB]);

    if (union.size === 0) {
      return 0;
    }

    return intersection.size / union.size;
  }

  /**
   * Build a reflection from a cluster of observations
   */
  private buildReflection(cluster: Observation[]): Omit<Reflection, 'id'> {
    // Generate title from top theme
    const topTheme = cluster[0]?.themes[0];
    const title = topTheme ? `${topTheme} pattern` : 'Observation cluster';

    // Combine key findings (deduplicate and limit)
    const allFindings = cluster.flatMap(obs => obs.keyFindings);
    const uniqueFindings = Array.from(new Set(allFindings));
    const insight = uniqueFindings.slice(0, 5).join('; ');

    // Extract observation IDs
    const observationIds = cluster.map(obs => obs.id);

    // Extract patterns
    const patterns = this.extractPatterns(cluster);

    // Calculate confidence based on cluster characteristics
    // Collect all unique instance IDs from all observations
    const allInstanceIds = cluster.flatMap(obs => obs.instanceIds);
    const uniqueInstances = new Set(allInstanceIds).size;

    // Base confidence from cluster size (more observations = higher confidence)
    let confidence = Math.min(cluster.length / 10, 0.5);

    // Check signal consistency - sum up success and failure signals across cluster
    const totalSuccessSignals = cluster.reduce((sum, obs) => sum + obs.successSignals, 0);
    const totalFailureSignals = cluster.reduce((sum, obs) => sum + obs.failureSignals, 0);
    const hasConsistentSignal = totalSuccessSignals === 0 || totalFailureSignals === 0;
    if (hasConsistentSignal) {
      confidence += 0.2;
    }

    // Bonus for cross-instance patterns (more reliable)
    const instanceBonus = Math.min(uniqueInstances / 10, 0.3);
    confidence += instanceBonus;

    // Clamp to [0, 1]
    confidence = Math.max(0, Math.min(1, confidence));

    // Collect all unique themes for applicability
    const applicability = Array.from(new Set(cluster.flatMap(obs => obs.themes)));

    return {
      title,
      insight,
      observationIds,
      patterns,
      confidence,
      applicability,
      createdAt: Date.now(),
      ttl: this.config.reflectionTtlMs,
      usageCount: 0,
      effectivenessScore: 0,
      promotedToProcedural: false
    };
  }

  /**
   * Extract patterns from observation cluster
   */
  private extractPatterns(cluster: Observation[]): ReflectedPattern[] {
    const patterns: ReflectedPattern[] = [];

    // Sum up success and failure signals across all observations
    const totalSuccessSignals = cluster.reduce((sum, obs) => sum + obs.successSignals, 0);
    const totalFailureSignals = cluster.reduce((sum, obs) => sum + obs.failureSignals, 0);
    const totalSignals = totalSuccessSignals + totalFailureSignals;

    // Count unique instances across all observations
    const allInstanceIds = cluster.flatMap(obs => obs.instanceIds);
    const uniqueInstances = new Set(allInstanceIds).size;

    // Extract evidence summaries (truncated) - use summary field
    const evidence = cluster.map(obs => {
      const summary = obs.summary + (obs.keyFindings[0] ? `: ${obs.keyFindings[0]}` : '');
      return summary.length > 100 ? summary.slice(0, 97) + '...' : summary;
    });

    // Success pattern
    if (totalSuccessSignals > totalFailureSignals * 2) {
      patterns.push({
        type: 'success_pattern',
        description: `Successful pattern observed across ${totalSuccessSignals} signals`,
        evidence: evidence.slice(0, 5),
        strength: totalSignals > 0 ? Math.max(0, Math.min(1, totalSuccessSignals / totalSignals)) : 0
      });
    }

    // Failure pattern
    if (totalFailureSignals > totalSuccessSignals * 2) {
      patterns.push({
        type: 'failure_pattern',
        description: `Failure pattern observed across ${totalFailureSignals} signals`,
        evidence: evidence.slice(0, 5),
        strength: totalSignals > 0 ? Math.max(0, Math.min(1, totalFailureSignals / totalSignals)) : 0
      });
    }

    // Cross-instance pattern
    if (uniqueInstances > 1) {
      patterns.push({
        type: 'cross_instance',
        description: `Pattern spans ${uniqueInstances} different instances`,
        evidence: evidence.slice(0, 5),
        strength: Math.max(0, Math.min(1, uniqueInstances / cluster.length))
      });
    }

    // Workflow optimization pattern (always create from themes)
    const topThemes = Array.from(new Set(cluster.flatMap(obs => obs.themes))).slice(0, 3);
    patterns.push({
      type: 'workflow_optimization',
      description: `Workflow optimization for: ${topThemes.join(', ')}`,
      evidence: evidence.slice(0, 5),
      strength: Math.max(0, Math.min(1, cluster.length / 10))
    });

    // Limit to 4 patterns max
    return patterns.slice(0, 4);
  }
}

/**
 * Convenience getter for ReflectorAgent singleton
 */
export function getReflectorAgent(): ReflectorAgent {
  return ReflectorAgent.getInstance();
}
