import type { Instance } from '../../core/state/instance.store';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';

export const ORDER_STORAGE_KEY = 'instance-list-order';
export const SORT_MODE_STORAGE_KEY = 'instance-list-sort-mode';
export const HISTORY_VISIBILITY_STORAGE_KEY = 'instance-list-history-visibility';
export const HISTORY_TIME_WINDOW_STORAGE_KEY = 'instance-list-history-time-window';
export const SHOW_EMPTY_PROJECTS_STORAGE_KEY = 'instance-list-show-empty-projects';
export const STATUS_FILTER_STORAGE_KEY = 'instance-list-status-filter';
export const LOCATION_FILTER_STORAGE_KEY = 'instance-list-location-filter';
export const FILTER_TEXT_STORAGE_KEY = 'instance-list-filter-text';
export const NO_WORKSPACE_KEY = '__no_workspace__';
export const CHATS_KEY = '__chats__';
export const ORPHANED_CHILDREN_KEY = '__orphaned_children__';

export type HistorySortMode = 'last-interacted' | 'created';

export interface HierarchicalInstance {
  kind: 'live';
  instance: Instance;
  railTitle: string;
  hasChildren: boolean;
  childrenCount: number;
  isExpanded: boolean;
  children: HierarchicalRailItem[];
}

export interface HierarchicalHistoryItem {
  kind: 'history';
  entry: ConversationHistoryEntry;
  hasChildren: boolean;
  childrenCount: number;
  isExpanded: boolean;
  children: HierarchicalHistoryItem[];
}

export type HierarchicalRailItem = HierarchicalInstance | HierarchicalHistoryItem;

export interface ProjectGroup {
  key: string;
  path: string | null;
  title: string;
  subtitle: string;
  createdAt: number;
  sessionCount: number;
  busyCount: number;
  hasSelectedInstance: boolean;
  isExpanded: boolean;
  isPinned: boolean;
  hasDraft: boolean;
  draftUpdatedAt: number | null;
  projectStateLabel: string;
  projectStateTone: 'working' | 'attention' | 'connecting' | 'ready' | 'history';
  lastActivity: number;
  liveItems: HierarchicalInstance[];
  historyItems: HierarchicalHistoryItem[];
}

export interface ProjectPathGroupIndex {
  group: ProjectGroup;
  index: number;
}

export interface RailChangeSummary {
  additions: number;
  deletions: number;
}

export function getInstanceThreadId(
  instance: Pick<Instance, 'historyThreadId' | 'sessionId' | 'id'>,
): string {
  const historyThreadId = instance.historyThreadId.trim();
  if (historyThreadId) {
    return historyThreadId;
  }

  const sessionId = instance.sessionId.trim();
  if (sessionId) {
    return sessionId;
  }

  return instance.id;
}
