import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver, SqliteDriverFactory } from '../db/sqlite-driver';
import { createOperatorTables } from './operator-schema';

export interface OperatorDatabaseConfig {
  dbPath?: string;
  driverFactory?: SqliteDriverFactory;
  enableWAL?: boolean;
}

export class OperatorDatabase {
  private static instance: OperatorDatabase | null = null;
  readonly db: SqliteDriver;

  static getInstance(config?: OperatorDatabaseConfig): OperatorDatabase {
    this.instance ??= new OperatorDatabase(config);
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance?.close();
    this.instance = null;
  }

  constructor(config: OperatorDatabaseConfig = {}) {
    const dbPath = config.dbPath ?? defaultOperatorDbPath();
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    const driverFactory = config.driverFactory ?? defaultDriverFactory;
    this.db = driverFactory(dbPath);
    if (config.enableWAL !== false && dbPath !== ':memory:') {
      this.db.pragma('journal_mode = WAL');
    }
    createOperatorTables(this.db);
  }

  close(): void {
    this.db.close();
  }
}

export function defaultOperatorDbPath(): string {
  return path.join(app.getPath('userData'), 'operator', 'operator.db');
}

export function getOperatorDatabase(config?: OperatorDatabaseConfig): OperatorDatabase {
  return OperatorDatabase.getInstance(config);
}
