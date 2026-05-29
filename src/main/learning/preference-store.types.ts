/**
 * Preference Store — Type Definitions
 * Extracted from preference-store.ts to reduce file size.
 * All types are re-exported from preference-store.ts for backward compatibility.
 */

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
