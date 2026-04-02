/**
 * Migration Manager - Versioned config migration system.
 * Inspired by Claude Code's CURRENT_MIGRATION_VERSION + runMigrations().
 */

import { getLogger } from '../logging/logger';

const logger = getLogger('MigrationManager');

export interface Migration {
  version: number;
  name: string;
  up: (config: Record<string, unknown>) => Promise<Record<string, unknown>>;
}

export interface MigrationResult {
  config: Record<string, unknown>;
  fromVersion: number;
  toVersion: number;
  migrationsRun: number;
  migrationNames: string[];
  error?: string;
}

export class MigrationManager {
  private migrations: Migration[];

  constructor(migrations: Migration[]) {
    this.migrations = [...migrations].sort((a, b) => a.version - b.version);
  }

  getCurrentVersion(): number {
    if (this.migrations.length === 0) return 0;
    return this.migrations[this.migrations.length - 1].version;
  }

  async migrate(config: Record<string, unknown>, currentVersion: number): Promise<MigrationResult> {
    const pending = this.migrations.filter(m => m.version > currentVersion);

    if (pending.length === 0) {
      return { config, fromVersion: currentVersion, toVersion: currentVersion, migrationsRun: 0, migrationNames: [] };
    }

    logger.info('Running migrations', { from: currentVersion, pending: pending.length });

    let current = { ...config };
    let lastSuccessVersion = currentVersion;
    const runNames: string[] = [];

    for (const migration of pending) {
      try {
        logger.info('Running migration', { version: migration.version, name: migration.name });
        current = await migration.up(current);
        lastSuccessVersion = migration.version;
        runNames.push(migration.name);
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        logger.error('Migration failed', undefined, { version: migration.version, name: migration.name, error });
        return { config: current, fromVersion: currentVersion, toVersion: lastSuccessVersion, migrationsRun: runNames.length, migrationNames: runNames, error };
      }
    }

    return { config: current, fromVersion: currentVersion, toVersion: lastSuccessVersion, migrationsRun: runNames.length, migrationNames: runNames };
  }
}
