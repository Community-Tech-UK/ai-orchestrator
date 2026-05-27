import type { EventEmitter } from 'node:events';
import type { AppSettings } from '../../shared/types/settings.types';
import type {
  CodebaseAutoIndexState,
  CodebaseAutoIndexStatus,
  IndexingProgress,
  IndexingStats,
} from '../../shared/types/codebase.types';
import type { ContextStore } from '../../shared/types/rlm.types';

export interface AutoIndexingTarget {
  indexCodebase(
    storeId: string,
    rootPath: string,
    options?: { force?: boolean },
  ): Promise<IndexingStats>;
  on(
    event: 'progress',
    listener: (progress: IndexingProgress) => void,
  ): unknown;
  off(
    event: 'progress',
    listener: (progress: IndexingProgress) => void,
  ): unknown;
}

export interface AutoIndexFileWatcherTarget {
  startWatching(storeId: string, rootPath: string): Promise<void>;
}

export interface AutoIndexContextManagerTarget {
  createStore(instanceId: string, config?: Record<string, unknown>): { id: string };
  listStores?(): ContextStore[];
}

export interface AutoIndexProjectRegistryTarget {
  canAutoMine(rootPath: string): boolean;
}

export interface AutoIndexSettingsTarget {
  get<K extends keyof AppSettings>(key: K): AppSettings[K];
}

export interface PreflightResult {
  fileCount: number;
  totalBytes: number;
  exceeded?: 'files' | 'bytes';
}

export interface CodebaseIndexingAutoCoordinatorOptions {
  recentDirectoriesManager?: EventEmitter;
  indexingService?: AutoIndexingTarget;
  fileWatcher?: AutoIndexFileWatcherTarget;
  contextManager?: AutoIndexContextManagerTarget;
  registry?: AutoIndexProjectRegistryTarget;
  settings?: AutoIndexSettingsTarget;
  storeIdResolver?: (rootPath: string) => string;
  preflight?: (rootPath: string, limits: { maxFiles: number; maxBytes: number }) => Promise<PreflightResult>;
  now?: () => number;
}

export type CodebaseAutoStatusEvent = CodebaseAutoIndexStatus;

export type CodebaseAutoStatusPartial =
  Partial<CodebaseAutoIndexStatus> & { state: CodebaseAutoIndexState };
