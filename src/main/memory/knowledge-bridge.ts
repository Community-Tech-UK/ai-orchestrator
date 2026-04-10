/**
 * Knowledge Bridge
 *
 * Listens to observation pipeline events (reflections, promotions) and
 * automatically creates KG facts and wake hints from them.
 *
 * This is the glue between the observation pipeline and the knowledge layer.
 */

import { getLogger } from '../logging/logger';
import { getKnowledgeGraphService } from './knowledge-graph-service';
import { getWakeContextBuilder } from './wake-context-builder';
import type { Reflection } from '../observation/observation.types';

const logger = getLogger('KnowledgeBridge');

/** Minimum confidence for a reflection to generate KG facts */
const MIN_CONFIDENCE_FOR_FACTS = 0.5;

/** Minimum pattern strength to generate a KG fact */
const MIN_PATTERN_STRENGTH = 0.5;

export class KnowledgeBridge {
  private static instance: KnowledgeBridge | null = null;

  static getInstance(): KnowledgeBridge {
    if (!this.instance) {
      this.instance = new KnowledgeBridge();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private constructor() {
    logger.info('KnowledgeBridge initialized');
  }

  /**
   * Called when a reflection is created by the ReflectorAgent.
   * Extracts KG facts from patterns with sufficient confidence + strength.
   */
  onReflectionCreated(reflection: Reflection): void {
    if (reflection.confidence < MIN_CONFIDENCE_FOR_FACTS) {
      logger.debug('Skipping low-confidence reflection for KG extraction', {
        reflectionId: reflection.id,
        confidence: reflection.confidence,
      });
      return;
    }

    const kg = getKnowledgeGraphService();

    for (const pattern of reflection.patterns) {
      if (pattern.strength < MIN_PATTERN_STRENGTH) continue;

      try {
        // Create a fact: reflection_title → has_pattern → pattern_description
        const subject = reflection.title.toLowerCase().replace(/\s+/g, '_').slice(0, 60);
        const predicate = pattern.type;
        const object = pattern.description.slice(0, 120);

        kg.addFact(subject, predicate, object, {
          confidence: Math.min(reflection.confidence, pattern.strength),
          sourceFile: `reflection://${reflection.id}`,
        });

        logger.debug('KG fact extracted from reflection', {
          reflectionId: reflection.id,
          pattern: pattern.type,
          subject,
        });
      } catch (error) {
        logger.warn('Failed to extract KG fact from reflection', {
          reflectionId: reflection.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Also create entity for each applicability tag
    for (const tag of reflection.applicability) {
      try {
        kg.addEntity(tag, 'topic');
      } catch {
        // Entity may already exist — that's fine
      }
    }
  }

  /**
   * Called when a reflection is promoted to procedural memory.
   * Creates a wake hint so this knowledge appears in cold-start context.
   */
  onPromotedToProcedural(reflection: Reflection): void {
    try {
      const wake = getWakeContextBuilder();
      const importance = Math.round(reflection.confidence * 10);
      const room = reflection.applicability[0] || 'general';
      const content = `${reflection.title}: ${reflection.insight}`.slice(0, 300);

      wake.addHint(content, {
        importance: Math.max(1, Math.min(10, importance)),
        room,
        sourceReflectionId: reflection.id,
      });

      logger.info('Wake hint created from promoted reflection', {
        reflectionId: reflection.id,
        importance,
        room,
      });
    } catch (error) {
      logger.warn('Failed to create wake hint from promoted reflection', {
        reflectionId: reflection.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function getKnowledgeBridge(): KnowledgeBridge {
  return KnowledgeBridge.getInstance();
}
