/**
 * Preference Store
 * Stores and manages user preferences across different scopes
 *
 * Handles:
 * - Global, project, workspace, and session preferences
 * - Preference merging with configurable strategies
 * - Learning from user behavior patterns
 * - Preference expiration and cleanup
 * - Import/export functionality
 *
 * Uses SQLite persistence for durability
 */

import { EventEmitter } from 'events';
import { getRLMDatabase, RLMDatabase } from '../persistence/rlm-database';
import { getLogger } from '../logging/logger';

const logger = getLogger('PreferenceStore');

// ============================================
// Type Definitions
// ============================================

export type PreferenceType = 'string' | 'number' | 'boolean' | 'array' | 'object';
export type PreferenceScope = 'global' | 'project' | 'workspace' | 'session';
export type PreferenceSource = 'user' | 'learned' | 'default' | 'inherited';

export interface PreferenceMetadata {
  description?: string;
  category?: string;
  validValues?: unknown[];
  minValue?: number;
  maxValue?: number;
  projectId?: string;
  workspaceId?: string;
  tags?: string[];
}

export interface Preference {
  id: string;
  key: string;
  value: unknown;
  type: PreferenceType;
  scope: PreferenceScope;
  metadata: PreferenceMetadata;
  createdAt: number;
  updatedAt: number;
  accessedAt: number;
  source: PreferenceSource;
}

export interface PreferenceQuery {
  key?: string;
  scope?: PreferenceScope;
  source?: PreferenceSource;
  category?: string;
  projectId?: string;
  tags?: string[];
}

export interface SetPreferenceOptions {
  scope?: PreferenceScope;
  source?: PreferenceSource;
  metadata?: Partial<PreferenceMetadata>;
  ttl?: number;
}

export interface PreferenceStoreConfig {
  maxPreferences: number;
  defaultTTL: number;
  allowOverride: boolean;
  persistImmediately: boolean;
  mergeStrategy: 'project_wins' | 'global_wins' | 'newest_wins';
}

export interface PreferenceStats {
  totalPreferences: number;
  byScope: Record<PreferenceScope, number>;
  bySource: Record<PreferenceSource, number>;
  byCategory: Record<string, number>;
  learnedCount: number;
  expiredCount: number;
  oldestPreference?: Preference;
  newestPreference?: Preference;
}

// ============================================
// PreferenceStore Class
// ============================================

export class PreferenceStore extends EventEmitter {
  private static instance: PreferenceStore;
  private preferences: Map<string, Preference> = new Map();
  private config: PreferenceStoreConfig;
  private db: RLMDatabase | null = null;
  private persistenceEnabled = true;

  private defaultConfig: PreferenceStoreConfig = {
    maxPreferences: 1000,
    defaultTTL: 90,
    allowOverride: true,
    persistImmediately: true,
    mergeStrategy: 'project_wins',
  };

  private defaultPreferences: Record<string, { value: unknown; type: PreferenceType; metadata: Partial<PreferenceMetadata> }> = {
    'model.default': {
      value: 'claude-3-sonnet',
      type: 'string',
      metadata: {
        description: 'Default Claude model to use',
        category: 'model',
        validValues: ['claude-3-opus', 'claude-3-sonnet', 'claude-3-haiku'],
      },
    },
    'agent.default': {
      value: 'general',
      type: 'string',
      metadata: {
        description: 'Default agent to use for tasks',
        category: 'agent',
      },
    },
    'permissions.yolo': {
      value: false,
      type: 'boolean',
      metadata: {
        description: 'Allow risky operations without confirmation',
        category: 'permissions',
      },
    },
    'ui.theme': {
      value: 'system',
      type: 'string',
      metadata: {
        description: 'UI theme preference',
        category: 'ui',
        validValues: ['light', 'dark', 'system'],
      },
    },
    'output.verbosity': {
      value: 'normal',
      type: 'string',
      metadata: {
        description: 'Output verbosity level',
        category: 'output',
        validValues: ['quiet', 'normal', 'verbose', 'debug'],
      },
    },
  };

  static getInstance(): PreferenceStore {
    if (!this.instance) {
      this.instance = new PreferenceStore();
    }
    return this.instance;
  }

  private constructor() {
    super();
    this.config = { ...this.defaultConfig };
    this.initializePersistence();
    this.loadDefaults();
  }

  private initializePersistence(): void {
    try {
      this.db = getRLMDatabase();
      this.createPreferencesTable();
      this.loadFromPersistence();
      this.emit('persistence:initialized', { success: true });
    } catch (error) {
      logger.error('Failed to initialize persistence', error instanceof Error ? error : undefined);
      this.persistenceEnabled = false;
      this.emit('persistence:initialized', { success: false, error });
    }
  }

  private createPreferencesTable(): void {
    if (!this.db) return;

    const dbInternal = (this.db as any).db;
    if (!dbInternal) return;

    dbInternal.exec(`
      CREATE TABLE IF NOT EXISTS preferences (
        id TEXT PRIMARY KEY,
        key TEXT NOT NULL,
        value_json TEXT NOT NULL,
        type TEXT NOT NULL,
        scope TEXT NOT NULL,
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL,
        expires_at INTEGER,
        metadata_json TEXT,
        UNIQUE(key, scope, metadata_json)
      );

      CREATE INDEX IF NOT EXISTS idx_preferences_key
        ON preferences(key);
      CREATE INDEX IF NOT EXISTS idx_preferences_scope
        ON preferences(scope);
      CREATE INDEX IF NOT EXISTS idx_preferences_source
        ON preferences(source);
      CREATE INDEX IF NOT EXISTS idx_preferences_expires
        ON preferences(expires_at);
    `);
  }

  private loadFromPersistence(): void {
    if (!this.db) return;

    const dbInternal = (this.db as any).db;
    if (!dbInternal) return;

    try {
      const stmt = dbInternal.prepare(`
        SELECT * FROM preferences
        WHERE expires_at IS NULL OR expires_at > ?
        ORDER BY updated_at DESC
      `);
      const rows = stmt.all(Date.now());

      for (const row of rows) {
        const preference: Preference = {
          id: row.id,
          key: row.key,
          value: JSON.parse(row.value_json),
          type: row.type as PreferenceType,
          scope: row.scope as PreferenceScope,
          source: row.source as PreferenceSource,
          metadata: row.metadata_json ? JSON.parse(row.metadata_json) : {},
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          accessedAt: row.accessed_at,
        };

        const mapKey = this.getMapKey(preference.key, preference.scope, preference.metadata);
        this.preferences.set(mapKey, preference);
      }

      this.emit('persistence:loaded', { count: rows.length });
    } catch (error) {
      logger.error('Failed to load from persistence', error instanceof Error ? error : undefined);
    }
  }

  private loadDefaults(): void {
    for (const [key, defaultPref] of Object.entries(this.defaultPreferences)) {
      if (!this.has(key)) {
        this.set(key, defaultPref.value, {
          source: 'default',
          scope: 'global',
          metadata: defaultPref.metadata,
        });
      }
    }
  }

  private persistPreference(preference: Preference): void {
    if (!this.db || !this.persistenceEnabled || !this.config.persistImmediately) return;

    const dbInternal = (this.db as any).db;
    if (!dbInternal) return;

    try {
      const expiresAt = this.config.defaultTTL > 0
        ? preference.accessedAt + this.config.defaultTTL * 24 * 60 * 60 * 1000
        : null;

      const stmt = dbInternal.prepare(`
        INSERT OR REPLACE INTO preferences (
          id, key, value_json, type, scope, source,
          created_at, updated_at, accessed_at, expires_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        preference.id,
        preference.key,
        JSON.stringify(preference.value),
        preference.type,
        preference.scope,
        preference.source,
        preference.createdAt,
        preference.updatedAt,
        preference.accessedAt,
        expiresAt,
        JSON.stringify(preference.metadata)
      );
    } catch (error) {
      logger.error('Failed to persist preference', error instanceof Error ? error : undefined);
    }
  }

  private deletePreferenceFromDB(key: string): void {
    if (!this.db || !this.persistenceEnabled) return;

    const dbInternal = (this.db as any).db;
    if (!dbInternal) return;

    try {
      const stmt = dbInternal.prepare(`DELETE FROM preferences WHERE key = ?`);
      stmt.run(key);
    } catch (error) {
      logger.error('Failed to delete preference from DB', error instanceof Error ? error : undefined);
    }
  }

  isPersistenceEnabled(): boolean {
    return this.persistenceEnabled && this.db !== null;
  }

  configure(config: Partial<PreferenceStoreConfig>): void {
    this.config = { ...this.config, ...config };
    this.emit('configured', this.config);
  }

  getConfig(): PreferenceStoreConfig {
    return { ...this.config };
  }

  private getMapKey(key: string, scope: PreferenceScope = 'global', metadata?: PreferenceMetadata): string {
    const projectId = metadata?.projectId || '';
    const workspaceId = metadata?.workspaceId || '';
    return `${scope}:${projectId}:${workspaceId}:${key}`;
  }

  private inferType(value: unknown): PreferenceType {
    if (Array.isArray(value)) return 'array';
    if (value === null || value === undefined) return 'string';
    const type = typeof value;
    if (type === 'string' || type === 'number' || type === 'boolean') {
      return type as PreferenceType;
    }
    return 'object';
  }

  set(key: string, value: unknown, options: SetPreferenceOptions = {}): Preference {
    const scope = options.scope || 'global';
    const source = options.source || 'user';
    const metadata = options.metadata || {};
    const type = this.inferType(value);

    const existing = this.getPreference(key);
    if (existing?.metadata.validValues) {
      const validValues = existing.metadata.validValues;
      if (!validValues.includes(value)) {
        throw new Error(
          `Invalid value "${value}" for preference "${key}". Valid values: ${validValues.join(', ')}`
        );
      }
    }

    if (existing?.metadata.minValue !== undefined && typeof value === 'number') {
      if (value < existing.metadata.minValue) {
        throw new Error(`Value ${value} is below minimum ${existing.metadata.minValue} for preference "${key}"`);
      }
    }

    if (existing?.metadata.maxValue !== undefined && typeof value === 'number') {
      if (value > existing.metadata.maxValue) {
        throw new Error(`Value ${value} exceeds maximum ${existing.metadata.maxValue} for preference "${key}"`);
      }
    }

    const now = Date.now();
    const mapKey = this.getMapKey(key, scope, metadata);
    const existingPref = this.preferences.get(mapKey);

    const preference: Preference = {
      id: existingPref?.id || `pref-${now}-${Math.random().toString(36).substr(2, 9)}`,
      key,
      value,
      type,
      scope,
      source,
      metadata,
      createdAt: existingPref?.createdAt || now,
      updatedAt: now,
      accessedAt: now,
    };

    this.preferences.set(mapKey, preference);
    this.persistPreference(preference);
    this.emit('preference:set', preference);

    if (this.preferences.size > this.config.maxPreferences) {
      this.pruneOldest();
    }

    return preference;
  }

  get<T>(key: string, defaultValue?: T): T | undefined {
    const preference = this.getPreference(key);

    if (preference) {
      preference.accessedAt = Date.now();
      this.persistPreference(preference);
      this.emit('preference:get', { key, value: preference.value });
      return preference.value as T;
    }

    return defaultValue;
  }

  getPreference(key: string): Preference | undefined {
    const scopes: PreferenceScope[] = this.config.mergeStrategy === 'global_wins'
      ? ['global', 'workspace', 'project', 'session']
      : ['session', 'project', 'workspace', 'global'];

    for (const scope of scopes) {
      for (const [mapKey, pref] of this.preferences) {
        if (pref.key === key && pref.scope === scope) {
          return pref;
        }
      }
    }

    return undefined;
  }

  has(key: string): boolean {
    return this.getPreference(key) !== undefined;
  }

  delete(key: string): boolean {
    let deleted = false;

    for (const [mapKey, pref] of this.preferences) {
      if (pref.key === key) {
        this.preferences.delete(mapKey);
        deleted = true;
      }
    }

    if (deleted) {
      this.deletePreferenceFromDB(key);
      this.emit('preference:deleted', { key });
    }

    return deleted;
  }

  getAll(query?: PreferenceQuery): Preference[] {
    let results = Array.from(this.preferences.values());

    if (query) {
      if (query.key) {
        results = results.filter(p => p.key === query.key);
      }
      if (query.scope) {
        results = results.filter(p => p.scope === query.scope);
      }
      if (query.source) {
        results = results.filter(p => p.source === query.source);
      }
      if (query.category) {
        results = results.filter(p => p.metadata.category === query.category);
      }
      if (query.projectId) {
        results = results.filter(p => p.metadata.projectId === query.projectId);
      }
      if (query.tags) {
        results = results.filter(p =>
          query.tags!.some(tag => p.metadata.tags?.includes(tag))
        );
      }
    }

    return results;
  }

  getByScope(scope: PreferenceScope): Preference[] {
    return this.getAll({ scope });
  }

  getByCategory(category: string): Preference[] {
    return this.getAll({ category });
  }

  setProjectPreference(projectId: string, key: string, value: unknown): Preference {
    return this.set(key, value, {
      scope: 'project',
      metadata: { projectId },
    });
  }

  getProjectPreference<T>(projectId: string, key: string, defaultValue?: T): T | undefined {
    const prefs = this.getAll({ key, scope: 'project', projectId });

    if (prefs.length > 0) {
      const pref = prefs[0];
      pref.accessedAt = Date.now();
      this.persistPreference(pref);
      this.emit('preference:get', { key, value: pref.value, projectId });
      return pref.value as T;
    }

    return this.get<T>(key, defaultValue);
  }

  mergePreferences(projectId?: string): Map<string, unknown> {
    const merged = new Map<string, unknown>();
    const allPrefs = Array.from(this.preferences.values());

    const byKey = new Map<string, Preference[]>();
    for (const pref of allPrefs) {
      if (!byKey.has(pref.key)) {
        byKey.set(pref.key, []);
      }
      byKey.get(pref.key)!.push(pref);
    }

    for (const [key, prefs] of byKey) {
      let selectedPref: Preference | undefined;

      switch (this.config.mergeStrategy) {
        case 'project_wins':
          selectedPref = this.selectProjectWins(prefs, projectId);
          break;
        case 'global_wins':
          selectedPref = this.selectGlobalWins(prefs);
          break;
        case 'newest_wins':
          selectedPref = this.selectNewestWins(prefs);
          break;
      }

      if (selectedPref) {
        merged.set(key, selectedPref.value);
      }
    }

    return merged;
  }

  private selectProjectWins(prefs: Preference[], projectId?: string): Preference | undefined {
    const session = prefs.find(p => p.scope === 'session');
    if (session) return session;

    if (projectId) {
      const project = prefs.find(p => p.scope === 'project' && p.metadata.projectId === projectId);
      if (project) return project;
    }

    const workspace = prefs.find(p => p.scope === 'workspace');
    if (workspace) return workspace;

    return prefs.find(p => p.scope === 'global');
  }

  private selectGlobalWins(prefs: Preference[]): Preference | undefined {
    const global = prefs.find(p => p.scope === 'global');
    if (global) return global;

    const workspace = prefs.find(p => p.scope === 'workspace');
    if (workspace) return workspace;

    const project = prefs.find(p => p.scope === 'project');
    if (project) return project;

    return prefs.find(p => p.scope === 'session');
  }

  private selectNewestWins(prefs: Preference[]): Preference | undefined {
    return prefs.sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  importPreferences(prefs: Array<{ key: string; value: unknown; scope?: PreferenceScope }>): number {
    let imported = 0;

    for (const pref of prefs) {
      try {
        this.set(pref.key, pref.value, {
          scope: pref.scope || 'global',
          source: 'user',
        });
        imported++;
      } catch (error) {
        logger.error('Failed to import preference', error instanceof Error ? error : undefined, { key: pref.key });
      }
    }

    this.emit('preferences:imported', { count: imported });
    return imported;
  }

  exportPreferences(scope?: PreferenceScope): Array<{ key: string; value: unknown; scope: PreferenceScope }> {
    const prefs = scope ? this.getByScope(scope) : Array.from(this.preferences.values());

    const exported = prefs.map(p => ({
      key: p.key,
      value: p.value,
      scope: p.scope,
    }));

    this.emit('preferences:exported', { count: exported.length, scope });
    return exported;
  }

  learnPreference(key: string, value: unknown, confidence: number): Preference {
    const preference = this.set(key, value, {
      source: 'learned',
      scope: 'global',
      metadata: {
        description: `Learned from user behavior (confidence: ${Math.round(confidence * 100)}%)`,
        category: 'learned',
      },
    });

    this.emit('preference:learned', { key, value, confidence });
    return preference;
  }

  getLearnedPreferences(): Preference[] {
    return this.getAll({ source: 'learned' });
  }

  pruneExpired(): number {
    if (this.config.defaultTTL <= 0) return 0;

    const cutoff = Date.now() - this.config.defaultTTL * 24 * 60 * 60 * 1000;
    let pruned = 0;

    for (const [mapKey, pref] of this.preferences) {
      if (pref.accessedAt < cutoff && pref.source !== 'default') {
        this.preferences.delete(mapKey);
        pruned++;
      }
    }

    if (pruned > 0) {
      this.emit('preference:expired', { count: pruned });
    }

    return pruned;
  }

  private pruneOldest(): void {
    const prefs = Array.from(this.preferences.entries())
      .filter(([_, p]) => p.source !== 'default')
      .sort(([_, a], [__, b]) => a.accessedAt - b.accessedAt);

    const toRemove = prefs.slice(0, Math.floor(this.config.maxPreferences * 0.1));

    for (const [mapKey, pref] of toRemove) {
      this.preferences.delete(mapKey);
      this.emit('preference:expired', { key: pref.key });
    }
  }

  getStats(): PreferenceStats {
    const all = Array.from(this.preferences.values());

    const byScope: Record<PreferenceScope, number> = {
      global: 0,
      project: 0,
      workspace: 0,
      session: 0,
    };

    const bySource: Record<PreferenceSource, number> = {
      user: 0,
      learned: 0,
      default: 0,
      inherited: 0,
    };

    const byCategory: Record<string, number> = {};
    let learnedCount = 0;
    let expiredCount = 0;

    const cutoff = Date.now() - this.config.defaultTTL * 24 * 60 * 60 * 1000;

    for (const pref of all) {
      byScope[pref.scope]++;
      bySource[pref.source]++;

      if (pref.metadata.category) {
        byCategory[pref.metadata.category] = (byCategory[pref.metadata.category] || 0) + 1;
      }

      if (pref.source === 'learned') learnedCount++;
      if (pref.accessedAt < cutoff) expiredCount++;
    }

    const sorted = all.sort((a, b) => a.createdAt - b.createdAt);

    return {
      totalPreferences: all.length,
      byScope,
      bySource,
      byCategory,
      learnedCount,
      expiredCount,
      oldestPreference: sorted[0],
      newestPreference: sorted[sorted.length - 1],
    };
  }

  destroy(): void {
    this.preferences.clear();
    this.removeAllListeners();
  }
}

export function getPreferenceStore(): PreferenceStore {
  return PreferenceStore.getInstance();
}
