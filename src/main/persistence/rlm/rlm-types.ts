/**
 * RLM Database Types Module
 *
 * Configuration and internal types for the RLM database.
 */

import type { SqliteDriver } from '../../db/sqlite-driver';

export interface RLMDatabaseConfig {
  dbPath?: string;
  contentDir?: string;
  enableWAL?: boolean;
  cacheSize?: number; // MB
}

export interface Migration {
  name: string;
  up: string;
  down: string;
}

export interface RLMDatabaseContext {
  db: SqliteDriver;
  contentDir: string;
  config: RLMDatabaseConfig;
}

/**
 * Threshold for inline vs file storage (in bytes)
 */
export const INLINE_THRESHOLD = 4096; // 4KB

/**
 * Current schema version
 */
export const SCHEMA_VERSION = 1;
