import { mkdirSync } from 'fs';
import { app } from 'electron';
import { dirname, join } from 'path';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver, SqliteDriverFactory } from '../db/sqlite-driver';
import { getLogger } from '../logging/logger';
import { runLoopMigrations } from './loop-schema';
import { LoopStore } from './loop-store';

const logger = getLogger('LoopStore');

export interface LoopStoreServiceConfig {
  dbPath?: string;
  enableWAL?: boolean;
  cacheSize?: number;
  driverFactory?: SqliteDriverFactory;
  store?: LoopStore;
}

export class LoopStoreService {
  private static instance: LoopStoreService | null = null;
  private readonly db: SqliteDriver | null;
  private readonly _store: LoopStore;

  static getInstance(config?: LoopStoreServiceConfig): LoopStoreService {
    if (!this.instance) this.instance = new LoopStoreService(config);
    return this.instance;
  }

  static _resetForTesting(): void {
    if (this.instance?.db) {
      try { this.instance.db.close(); } catch { /* noop */ }
    }
    this.instance = null;
  }

  constructor(config: LoopStoreServiceConfig = {}) {
    if (config.store) {
      this._store = config.store;
      this.db = null;
    } else {
      const dbPath = config.dbPath ?? defaultLoopDbPath();
      mkdirSync(dirname(dbPath), { recursive: true });
      const factory = config.driverFactory ?? defaultDriverFactory;
      this.db = factory(dbPath);
      if (config.enableWAL ?? true) this.db.pragma('journal_mode = WAL');
      this.db.pragma(`cache_size = -${(config.cacheSize ?? 32) * 1024}`);
      this.db.pragma('foreign_keys = ON');
      runLoopMigrations(this.db);
      this._store = new LoopStore(this.db);
    }
    logger.info('LoopStoreService initialized');
  }

  get store(): LoopStore {
    return this._store;
  }

  /** Exposes the raw db driver for use by co-located stores (e.g. CampaignStore). */
  getDb(): SqliteDriver | null {
    return this.db;
  }

  close(): void {
    if (this.db) {
      try { this.db.close(); } catch { /* noop */ }
    }
  }
}

export function getLoopStoreService(config?: LoopStoreServiceConfig): LoopStoreService {
  return LoopStoreService.getInstance(config);
}

export function getLoopStore(): LoopStore {
  return LoopStoreService.getInstance().store;
}

function defaultLoopDbPath(): string {
  const userDataPath = app?.getPath?.('userData') || join(process.cwd(), '.loop-mode');
  return join(userDataPath, 'loop-mode', 'loop-mode.db');
}
