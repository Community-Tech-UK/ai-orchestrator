/**
 * Knowledge Graph Types
 * Temporal entity-relationship storage inspired by mempalace's knowledge_graph.py
 *
 * Core Concepts:
 * - Entities: named things (people, projects, concepts)
 * - Triples: (subject, predicate, object) relationships with temporal validity
 * - Temporal validity: facts have valid_from/valid_to windows, enabling "what was true at time T?"
 */

export type KGEntityType = 'person' | 'project' | 'concept' | 'place' | 'unknown';

export interface KGEntity {
  id: string;
  name: string;
  type: KGEntityType;
  properties: Record<string, unknown>;
  createdAt: number;
}

export interface KGTriple {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  validFrom: string | null;
  validTo: string | null;
  confidence: number;
  sourceCloset: string | null;
  sourceFile: string | null;
  extractedAt: number;
}

export type KGDirection = 'outgoing' | 'incoming' | 'both';

export interface KGEntityQuery {
  entityName: string;
  asOf?: string;
  direction?: KGDirection;
}

export interface KGRelationshipQuery {
  predicate: string;
  asOf?: string;
}

export interface KGTimelineQuery {
  entityName?: string;
  limit?: number;
}

export interface KGQueryResult {
  direction: KGDirection;
  subject: string;
  predicate: string;
  object: string;
  validFrom: string | null;
  validTo: string | null;
  confidence: number;
  sourceCloset: string | null;
  current: boolean;
}

export interface KGStats {
  entities: number;
  triples: number;
  currentFacts: number;
  expiredFacts: number;
  relationshipTypes: string[];
}

export interface KnowledgeGraphConfig {
  maxEntities: number;
  maxTriples: number;
  timelineLimit: number;
  enableAutoExtraction: boolean;
}

export const DEFAULT_KG_CONFIG: KnowledgeGraphConfig = {
  maxEntities: 10_000,
  maxTriples: 50_000,
  timelineLimit: 100,
  enableAutoExtraction: true,
};
