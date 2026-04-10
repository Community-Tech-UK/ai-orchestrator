import { EventEmitter } from 'events';
import { getLogger } from '../logging/logger';
import { getRLMDatabase } from '../persistence/rlm-database';
import * as kgStore from '../persistence/rlm/rlm-knowledge-graph';
import type { KGQueryResult, KGStats, KGDirection, KnowledgeGraphConfig } from '../../shared/types/knowledge-graph.types';
import { DEFAULT_KG_CONFIG } from '../../shared/types/knowledge-graph.types';

const logger = getLogger('KnowledgeGraphService');

interface AddFactOptions {
  validFrom?: string;
  validTo?: string;
  confidence?: number;
  sourceCloset?: string;
  sourceFile?: string;
}

interface QueryEntityOptions {
  direction?: KGDirection;
  asOf?: string;
}

export class KnowledgeGraphService extends EventEmitter {
  private static instance: KnowledgeGraphService | null = null;
  private config: KnowledgeGraphConfig;

  static getInstance(): KnowledgeGraphService {
    if (!this.instance) {
      this.instance = new KnowledgeGraphService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance) {
      this.instance.removeAllListeners();
      this.instance = null;
    }
  }

  private constructor() {
    super();
    this.config = { ...DEFAULT_KG_CONFIG };
    logger.info('KnowledgeGraphService initialized');
  }

  configure(config: Partial<KnowledgeGraphConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private get db() {
    return getRLMDatabase().getRawDb();
  }

  addFact(subject: string, predicate: string, object: string, options: AddFactOptions = {}): string {
    const tripleId = kgStore.addTriple(this.db, {
      subject,
      predicate,
      object,
      validFrom: options.validFrom,
      validTo: options.validTo,
      confidence: options.confidence,
      sourceCloset: options.sourceCloset,
      sourceFile: options.sourceFile,
    });
    this.emit('graph:fact-added', { tripleId, subject, predicate, object });
    logger.debug('Fact added', { tripleId, subject, predicate, object });
    return tripleId;
  }

  invalidateFact(subject: string, predicate: string, object: string, ended?: string): number {
    const count = kgStore.invalidateTriple(this.db, subject, predicate, object, ended);
    if (count > 0) {
      this.emit('graph:fact-invalidated', { subject, predicate, object, ended });
      logger.debug('Fact invalidated', { subject, predicate, object, ended });
    }
    return count;
  }

  addEntity(name: string, type?: string, properties?: Record<string, unknown>): string {
    return kgStore.upsertEntity(this.db, name, type, properties);
  }

  queryEntity(name: string, options: QueryEntityOptions = {}): KGQueryResult[] {
    return kgStore.queryEntity(this.db, name, options);
  }

  queryRelationship(predicate: string, asOf?: string): KGQueryResult[] {
    return kgStore.queryRelationship(this.db, predicate, asOf);
  }

  getTimeline(entityName?: string, limit?: number): KGQueryResult[] {
    return kgStore.timeline(this.db, entityName, limit);
  }

  getStats(): KGStats {
    return kgStore.getStats(this.db);
  }

  getEntity(name: string) {
    return kgStore.getEntity(this.db, kgStore.normalizeEntityId(name));
  }

  listEntities(type?: string) {
    return kgStore.listEntities(this.db, type);
  }
}

export function getKnowledgeGraphService(): KnowledgeGraphService {
  return KnowledgeGraphService.getInstance();
}
