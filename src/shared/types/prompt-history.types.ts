/**
 * Prompt history types for per-instance and per-project prompt recall.
 */

export const PROMPT_HISTORY_MAX = 100;
export const PROMPT_HISTORY_STASH_KEY_PREFIX = '__recall_stash__:';

export interface PromptHistoryEntry {
  id: string;
  text: string;
  createdAt: number;
  projectPath?: string;
  provider?: string;
  model?: string;
  wasSlashCommand?: boolean;
}

export interface PromptHistoryRecord {
  instanceId: string;
  entries: PromptHistoryEntry[];
  updatedAt: number;
}

export interface PromptHistoryProjectAlias {
  projectPath: string;
  entries: PromptHistoryEntry[];
  updatedAt: number;
}

export interface PromptHistoryStoreV1 {
  schemaVersion: 1;
  byInstance: Record<string, PromptHistoryRecord>;
  byProject: Record<string, PromptHistoryProjectAlias>;
  lastPrunedAt?: number;
}

export interface PromptHistoryDelta {
  instanceId: string;
  record: PromptHistoryRecord;
}

export interface PromptHistorySnapshot {
  byInstance: Record<string, PromptHistoryRecord>;
  byProject: Record<string, PromptHistoryProjectAlias>;
}

export interface VisibleInstanceOrder {
  computedAt: number;
  instanceIds: string[];
  projectKeys?: string[];
}

export interface SessionPickerItem {
  id: string;
  title: string;
  subtitle?: string;
  projectPath?: string;
  provider?: string;
  kind: 'live' | 'history' | 'archived';
  lastActivity?: number;
  frecencyScore: number;
}

export interface ModelPickerItem {
  id: string;
  label: string;
  group: string;
  kind: 'model' | 'agent';
  available: boolean;
  disabledReason?: string;
  tags?: string[];
}

export function createPromptHistoryEntryId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }

  return `ph_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
