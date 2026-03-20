/**
 * RLM Database - Thin Coordinator
 *
 * SQLite database for RLM metadata, indices, and learning data.
 * This is a facade that delegates to focused sub-modules.
 */

import Database from 'better-sqlite3';
import { app } from 'electron';
import * as path from 'path';
import { EventEmitter } from 'events';
import type {
  ContextStoreRow,
  ContextSectionRow,
  SearchResult,
  RLMSessionRow,
  OutcomeRow,
  PatternRow,
  ExperienceRow,
  InsightRow,
  VectorRow,
  MigrationRow,
  ObservationRow,
  ReflectionRow,
} from './rlm-database.types';

// Import from decomposed modules
import { SCHEMA_VERSION, type RLMDatabaseConfig } from './rlm/rlm-types';
import {
  createTables,
  createMigrationsTable,
  runMigrations,
  getSchemaInfo,
  MIGRATIONS
} from './rlm/rlm-schema';
import { ensureDirectories } from './rlm/rlm-content';
import * as stores from './rlm/rlm-stores';
import * as sections from './rlm/rlm-sections';
import * as search from './rlm/rlm-search';
import * as sessions from './rlm/rlm-sessions';
import * as learning from './rlm/rlm-learning';
import * as vectors from './rlm/rlm-vectors';
import * as observations from './rlm/rlm-observations';
import * as backup from './rlm/rlm-backup';

// Re-export config type
export type { RLMDatabaseConfig };

export class RLMDatabase extends EventEmitter {
  private static instance: RLMDatabase | null = null;
  private db: Database.Database;
  private contentDir: string;
  private config: RLMDatabaseConfig;
  private initialized = false;

  private constructor(config: RLMDatabaseConfig = {}) {
    super();
    const userDataPath = app?.getPath?.('userData') || path.join(process.cwd(), '.rlm-data');

    this.config = {
      dbPath: config.dbPath || path.join(userDataPath, 'rlm', 'rlm.db'),
      contentDir: config.contentDir || path.join(userDataPath, 'rlm', 'content'),
      enableWAL: config.enableWAL ?? true,
      cacheSize: config.cacheSize ?? 64,
    };

    this.contentDir = this.config.contentDir!;
    ensureDirectories(this.config.dbPath!, this.contentDir);
    this.db = this.initializeDatabase();
    this.initialized = true;
  }

  static getInstance(config?: RLMDatabaseConfig): RLMDatabase {
    if (!this.instance) {
      this.instance = new RLMDatabase(config);
    }
    return this.instance;
  }

  static resetInstance(): void {
    if (this.instance) {
      this.instance.close();
      this.instance = null;
    }
  }

  static _resetForTesting(): void {
    this.resetInstance();
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  private initializeDatabase(): Database.Database {
    const db = new Database(this.config.dbPath!);

    if (this.config.enableWAL) {
      db.pragma('journal_mode = WAL');
    }
    db.pragma(`cache_size = -${this.config.cacheSize! * 1024}`);
    db.pragma('foreign_keys = ON');

    createTables(db);
    createMigrationsTable(db);
    runMigrations(
      db,
      (name) => this.emit('migration:applied', { name }),
      (applied) => this.emit('migrations:complete', { applied })
    );
    this.emit('database:initialized', { path: this.config.dbPath });
    return db;
  }

  // ============================================
  // Schema Info
  // ============================================

  getSchemaInfo(): {
    version: number;
    appliedMigrations: MigrationRow[];
    pendingMigrations: string[];
  } {
    return getSchemaInfo(this.db, SCHEMA_VERSION);
  }

  // ============================================
  // Content File Management (delegated)
  // ============================================

  saveContent(sectionId: string, content: string): string {
    const { saveContent } = require('./rlm/rlm-content');
    return saveContent(this.contentDir, sectionId, content);
  }

  loadContent(sectionId: string): string | null {
    const { loadContent } = require('./rlm/rlm-content');
    return loadContent(this.contentDir, sectionId);
  }

  deleteContent(sectionId: string): void {
    const { deleteContent } = require('./rlm/rlm-content');
    deleteContent(this.contentDir, sectionId);
  }

  shouldStoreInline(content: string): boolean {
    const { shouldStoreInline } = require('./rlm/rlm-content');
    return shouldStoreInline(content);
  }

  // ============================================
  // Context Store CRUD (delegated)
  // ============================================

  createStore(store: { id: string; instanceId: string; config?: Record<string, unknown> }): void {
    stores.createStore(this.db, store);
    this.emit('store:created', { id: store.id, instanceId: store.instanceId });
  }

  /**
   * Idempotent store creation — INSERT OR IGNORE to avoid PK/UNIQUE collisions.
   * Used by VectorStore.ensureStoreExists for FK satisfaction.
   */
  ensureStore(store: { id: string; instanceId: string }): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO context_stores
        (id, instance_id, created_at, last_accessed, config_json)
      VALUES (?, ?, ?, ?, NULL)
    `).run(store.id, store.instanceId, Date.now(), Date.now());
  }

  /**
   * Idempotent section creation — INSERT OR IGNORE for FK satisfaction.
   * Used by VectorStore.ensureSectionExists.
   */
  ensureSection(section: { id: string; storeId: string; type: string; name: string; content: string }): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO context_sections
        (id, store_id, type, name, start_offset, end_offset, tokens, created_at, content_inline)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)
    `).run(
      section.id,
      section.storeId,
      section.type,
      section.name,
      section.content.length,
      Math.ceil(section.content.length / 4),
      Date.now(),
      section.content
    );
  }

  getStore(storeId: string): ContextStoreRow | null {
    return stores.getStore(this.db, storeId);
  }

  getStoreByInstance(instanceId: string): ContextStoreRow | null {
    return stores.getStoreByInstance(this.db, instanceId);
  }

  listStores(): ContextStoreRow[] {
    return stores.listStores(this.db);
  }

  updateStoreStats(storeId: string, stats: { totalTokens?: number; totalSize?: number; accessCount?: number }): void {
    stores.updateStoreStats(this.db, storeId, stats);
  }

  deleteStore(storeId: string): void {
    stores.deleteStore(this.db, this.contentDir, storeId, (id) => this.getSections(id));
    this.emit('store:deleted', { id: storeId });
  }

  // ============================================
  // Section CRUD (delegated)
  // ============================================

  addSection(section: {
    id: string;
    storeId: string;
    type: string;
    name: string;
    source?: string;
    startOffset: number;
    endOffset: number;
    tokens: number;
    checksum?: string;
    depth?: number;
    summarizes?: string[];
    parentSummaryId?: string;
    filePath?: string;
    language?: string;
    sourceUrl?: string;
    content: string;
  }): void {
    sections.addSection(this.db, this.contentDir, section);
    this.emit('section:added', { id: section.id, storeId: section.storeId });
  }

  getSection(sectionId: string): ContextSectionRow | null {
    return sections.getSection(this.db, sectionId);
  }

  getSectionContent(section: ContextSectionRow): string {
    return sections.getSectionContent(this.contentDir, section);
  }

  getSections(storeId: string, options?: {
    type?: string;
    minDepth?: number;
    maxDepth?: number;
    limit?: number;
    offset?: number;
  }): ContextSectionRow[] {
    return sections.getSections(this.db, storeId, options);
  }

  removeSection(sectionId: string): void {
    const section = this.getSection(sectionId);
    if (section) {
      sections.removeSection(this.db, this.contentDir, sectionId);
      this.emit('section:removed', { id: sectionId, storeId: section.store_id });
    }
  }

  // ============================================
  // Search Index Operations (delegated)
  // ============================================

  indexSection(storeId: string, sectionId: string, content: string): void {
    search.indexSection(this.db, storeId, sectionId, content);
  }

  searchIndex(storeId: string, pattern: string, options?: { limit?: number; caseSensitive?: boolean }): SearchResult[] {
    return search.searchIndex(this.db, storeId, pattern, options);
  }

  rebuildIndex(storeId: string): void {
    const count = search.rebuildIndex(this.db, this.contentDir, storeId);
    this.emit('index:rebuilt', { storeId, sectionCount: count });
  }

  // ============================================
  // Session Operations (delegated)
  // ============================================

  createSession(session: { id: string; storeId: string; instanceId: string; estimatedDirectTokens: number }): void {
    sessions.createSession(this.db, session);
  }

  getSession(sessionId: string): RLMSessionRow | null {
    return sessions.getSession(this.db, sessionId);
  }

  listSessions(storeId?: string): RLMSessionRow[] {
    return sessions.listSessions(this.db, storeId);
  }

  updateSession(sessionId: string, updates: {
    totalQueries?: number;
    totalRootTokens?: number;
    totalSubQueryTokens?: number;
    tokenSavingsPercent?: number;
    queriesJson?: string;
    recursiveCallsJson?: string;
  }): void {
    sessions.updateSession(this.db, sessionId, updates);
  }

  endSession(sessionId: string): void {
    sessions.endSession(this.db, sessionId);
  }

  // ============================================
  // Learning Operations (delegated)
  // ============================================

  addOutcome(outcome: {
    id: string;
    taskType: string;
    success: boolean;
    timestamp: number;
    durationMs?: number;
    tokenUsage?: number;
    agentId?: string;
    model?: string;
    errorType?: string;
    promptHash?: string;
    tools?: string[];
    metadata?: Record<string, unknown>;
  }): void {
    learning.addOutcome(this.db, outcome);
  }

  getOutcomes(options?: { taskType?: string; agentId?: string; since?: number; limit?: number }): OutcomeRow[] {
    return learning.getOutcomes(this.db, options);
  }

  upsertPattern(pattern: {
    id: string;
    type: string;
    key: string;
    effectiveness: number;
    sampleSize: number;
    metadata?: Record<string, unknown>;
  }): void {
    learning.upsertPattern(this.db, pattern);
  }

  getPatterns(type?: string): PatternRow[] {
    return learning.getPatterns(this.db, type);
  }

  upsertExperience(experience: {
    id: string;
    taskType: string;
    successCount: number;
    failureCount: number;
    successPatterns?: string[];
    failurePatterns?: string[];
    examplePrompts?: string[];
  }): void {
    learning.upsertExperience(this.db, experience);
  }

  getExperience(taskType: string): ExperienceRow | null {
    return learning.getExperience(this.db, taskType);
  }

  getAllExperiences(): ExperienceRow[] {
    return learning.getAllExperiences(this.db);
  }

  addInsight(insight: {
    id: string;
    type: string;
    title: string;
    description?: string;
    confidence: number;
    supportingPatterns?: string[];
    expiresAt?: number;
  }): void {
    learning.addInsight(this.db, insight);
  }

  getInsights(type?: string): InsightRow[] {
    return learning.getInsights(this.db, type);
  }

  // ============================================
  // Vector Operations (delegated)
  // ============================================

  addVector(vector: {
    id: string;
    storeId: string;
    sectionId: string;
    embedding: number[];
    contentPreview?: string;
    metadata?: Record<string, unknown>;
  }): void {
    vectors.addVector(this.db, vector);
  }

  getVectors(storeId: string): VectorRow[] {
    return vectors.getVectors(this.db, storeId);
  }

  getVectorBySectionId(sectionId: string): VectorRow | null {
    return vectors.getVectorBySectionId(this.db, sectionId);
  }

  deleteVector(sectionId: string): void {
    vectors.deleteVector(this.db, sectionId);
  }

  bufferToEmbedding(buffer: Buffer): number[] {
    return vectors.bufferToEmbedding(buffer);
  }

  // ============================================
  // Observation Operations (delegated)
  // ============================================

  addObservation(observation: {
    id: string;
    summary: string;
    sourceIds: string[];
    instanceIds: string[];
    themes: string[];
    keyFindings: string[];
    successSignals: number;
    failureSignals: number;
    timestamp: number;
    createdAt: number;
    ttl: number;
    promoted: boolean;
    tokenCount: number;
    embeddingId?: string;
  }): void {
    observations.addObservation(this.db, observation);
  }

  getObservations(options?: {
    promoted?: boolean;
    since?: number;
    limit?: number;
  }): ObservationRow[] {
    return observations.getObservations(this.db, options);
  }

  updateObservation(id: string, updates: {
    promoted?: boolean;
    embeddingId?: string;
  }): void {
    observations.updateObservation(this.db, id, updates);
  }

  deleteExpiredObservations(): number {
    return observations.deleteExpiredObservations(this.db);
  }

  addReflection(reflection: {
    id: string;
    title: string;
    insight: string;
    observationIds: string[];
    patterns: unknown[];
    confidence: number;
    applicability: string[];
    createdAt: number;
    ttl: number;
    usageCount: number;
    effectivenessScore: number;
    promotedToProcedural: boolean;
    embeddingId?: string;
  }): void {
    observations.addReflection(this.db, reflection);
  }

  getReflections(options?: {
    minConfidence?: number;
    promotedToProcedural?: boolean;
    since?: number;
    limit?: number;
  }): ReflectionRow[] {
    return observations.getReflections(this.db, options);
  }

  updateReflection(id: string, updates: {
    usageCount?: number;
    effectivenessScore?: number;
    promotedToProcedural?: boolean;
    embeddingId?: string;
  }): void {
    observations.updateReflection(this.db, id, updates);
  }

  deleteExpiredReflections(): number {
    return observations.deleteExpiredReflections(this.db);
  }

  getObservationStats(): {
    totalObservations: number;
    totalReflections: number;
    promotedReflections: number;
    averageConfidence: number;
    averageEffectiveness: number;
  } {
    return observations.getObservationStats(this.db);
  }

  // ============================================
  // Utility Methods (delegated)
  // ============================================

  getStats(): {
    stores: number;
    sections: number;
    sessions: number;
    outcomes: number;
    patterns: number;
    experiences: number;
    insights: number;
    vectors: number;
    dbSizeBytes: number;
  } {
    return backup.getStats(this.db, this.config.dbPath!);
  }

  vacuum(): void {
    backup.vacuum(this.db);
    this.emit('database:vacuumed');
  }

  // ============================================
  // Backup and Restore (delegated)
  // ============================================

  backupDatabase(targetPath: string, options?: { includeContent?: boolean }): {
    dbBackupPath: string;
    contentBackupPath?: string;
    dbSizeBytes: number;
    contentSizeBytes?: number;
  } {
    const result = backup.backupDatabase(this.db, this.contentDir, targetPath, options);
    this.emit('database:backed_up', {
      targetPath,
      dbSizeBytes: result.dbSizeBytes,
      contentSizeBytes: result.contentSizeBytes,
    });
    return result;
  }

  restoreDatabase(sourcePath: string, options?: { includeContent?: boolean }): void {
    this.db.close();
    backup.restoreDatabase(sourcePath, this.config.dbPath!, this.contentDir, options);
    this.db = this.initializeDatabase();
    this.emit('database:restored', { sourcePath });
  }

  checkpoint(): void {
    backup.checkpoint(this.db);
    this.emit('database:checkpoint');
  }

  close(): void {
    if (this.db) {
      this.db.close();
      this.emit('database:closed');
    }
  }

  getDatabasePath(): string {
    return this.config.dbPath!;
  }

  getContentDir(): string {
    return this.contentDir;
  }

  /**
   * Expose the raw better-sqlite3 Database instance for services that need
   * direct access (e.g., TokenStatsService for lightweight stat writes).
   */
  getRawDb(): Database.Database {
    return this.db;
  }
}

// Export singleton getter
export function getRLMDatabase(config?: RLMDatabaseConfig): RLMDatabase {
  return RLMDatabase.getInstance(config);
}
