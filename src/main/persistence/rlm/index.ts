/**
 * RLM Persistence Module - Barrel Exports
 *
 * This module provides the decomposed RLM database functionality.
 */

// Types
export type { RLMDatabaseConfig, Migration, RLMDatabaseContext } from './rlm-types';
export { INLINE_THRESHOLD, SCHEMA_VERSION } from './rlm-types';

// Schema
export {
  MIGRATIONS,
  createTables,
  createMigrationsTable,
  computeMigrationChecksum,
  getAppliedMigrations,
  runMigrations,
  getSchemaInfo
} from './rlm-schema';

// Content management
export {
  getContentPath,
  saveContent,
  loadContent,
  deleteContent,
  shouldStoreInline,
  copyDirectoryRecursive,
  getDirectorySize,
  ensureDirectories
} from './rlm-content';

// Store operations
export {
  createStore,
  getStore,
  getStoreByInstance,
  listStores,
  updateStoreStats,
  deleteStore,
  updateStoreStatsForSection
} from './rlm-stores';

// Section operations
export {
  addSection,
  getSection,
  getSectionContent,
  getSections,
  removeSection
} from './rlm-sections';

// Search operations
export {
  indexSection,
  searchIndex,
  rebuildIndex
} from './rlm-search';

// Session operations
export {
  createSession,
  getSession,
  listSessions,
  updateSession,
  endSession
} from './rlm-sessions';

// Learning operations
export {
  addOutcome,
  getOutcomes,
  upsertPattern,
  getPatterns,
  upsertExperience,
  getExperience,
  getAllExperiences,
  addInsight,
  getInsights
} from './rlm-learning';

// Vector operations
export {
  addVector,
  getVectors,
  getVectorBySectionId,
  deleteVector,
  bufferToEmbedding
} from './rlm-vectors';

// Compaction marker operations
export {
  recordCompactionMarker,
  type RecordCompactionMarkerParams,
  type CompactionMarker
} from './rlm-compaction-markers';

// Backup operations
export {
  backupDatabase,
  restoreDatabase,
  checkpoint,
  vacuum,
  getStats
} from './rlm-backup';
