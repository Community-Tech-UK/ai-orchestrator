import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import ignore from 'ignore';
import { getSettingsManager } from '../core/config/settings-manager';
import { workspaceHashForPath } from '../codemem/symbol-id';
import { getProjectRootRegistry } from '../memory/project-root-registry';
import { RLMContextManager } from '../rlm/context-manager';
import {
  getCodebaseIndexingService,
  type CodebaseIndexingService,
} from './indexing-service';
import { getCodebaseFileWatcher, type CodebaseFileWatcher } from './file-watcher';
import { DEFAULT_INDEXING_CONFIG, shouldIncludeFile } from './config';
import type { AppSettings } from '../../shared/types/settings.types';
import type {
  AutoIndexContextManagerTarget,
  AutoIndexFileWatcherTarget,
  AutoIndexingTarget,
  AutoIndexProjectRegistryTarget,
  AutoIndexSettingsTarget,
  PreflightResult,
} from './codebase-indexing-auto.types';

const DEFAULT_IGNORES = [
  '.git/',
  '.gitignore',
  '.gradle/',
  '.venv/',
  'cache/',
  'node_modules/',
  'dist/',
  'build/',
  'libraries/',
  '.next/',
  'coverage/',
  'out/',
  'target/',
  'venv/',
  'vendor/',
];

export function createDefaultIndexingTarget(): AutoIndexingTarget {
  const service = getCodebaseIndexingService();
  return wrapIndexingService(service);
}

export function wrapIndexingService(service: CodebaseIndexingService): AutoIndexingTarget {
  return {
    indexCodebase: (storeId, rootPath, options) =>
      service.indexCodebase(storeId, rootPath, options),
    on: (event, listener) => service.on(event, listener),
    off: (event, listener) => service.off(event, listener),
  };
}

export function createDefaultFileWatcherTarget(): AutoIndexFileWatcherTarget {
  return {
    startWatching: (storeId, rootPath) =>
      (getCodebaseFileWatcher() as CodebaseFileWatcher).startWatching(storeId, rootPath),
  };
}

export function createDefaultContextManagerTarget(): AutoIndexContextManagerTarget {
  const manager = RLMContextManager.getInstance();
  return {
    createStore: (instanceId: string, config?: Record<string, unknown>) =>
      manager.createStore(instanceId, config),
    listStores: () => manager.listStores(),
  };
}

export function createDefaultRegistryTarget(): AutoIndexProjectRegistryTarget {
  return {
    canAutoMine: (rootPath: string): boolean => {
      try {
        return getProjectRootRegistry().canAutoMine(rootPath);
      } catch {
        return true;
      }
    },
  };
}

export function createDefaultSettingsTarget(): AutoIndexSettingsTarget {
  return {
    get<K extends keyof AppSettings>(key: K): AppSettings[K] {
      try {
        return getSettingsManager().get(key);
      } catch {
        return undefined as unknown as AppSettings[K];
      }
    },
  };
}

export function defaultStoreIdResolver(rootPath: string): string {
  return `codebase:${workspaceHashForPath(rootPath)}`;
}

export async function defaultPreflight(
  rootPath: string,
  limits: { maxFiles: number; maxBytes: number },
): Promise<PreflightResult> {
  const ig = ignore().add(DEFAULT_IGNORES);
  try {
    const gitignore = await fsp.readFile(path.join(rootPath, '.gitignore'), 'utf8');
    ig.add(gitignore);
  } catch {
    // Missing .gitignore is expected.
  }

  const result: PreflightResult = { fileCount: 0, totalBytes: 0 };
  const stack: string[] = [rootPath];

  while (stack.length > 0) {
    const dirPath = stack.pop();
    if (!dirPath) break;
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dirPath, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const absolutePath = path.join(dirPath, entry.name);
      const relativePath = toRelativePath(rootPath, absolutePath);
      const candidate = entry.isDirectory() ? `${relativePath}/` : relativePath;
      if (relativePath && ig.ignores(candidate)) {
        continue;
      }

      if (entry.isDirectory()) {
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = await fsp.stat(absolutePath);
      } catch {
        continue;
      }
      if (!shouldIncludeFile(absolutePath, DEFAULT_INDEXING_CONFIG, stat.size)) {
        continue;
      }

      result.fileCount += 1;
      result.totalBytes += stat.size;

      if (result.fileCount > limits.maxFiles) {
        result.exceeded = 'files';
        return result;
      }
      if (result.totalBytes > limits.maxBytes) {
        result.exceeded = 'bytes';
        return result;
      }
    }
  }

  return result;
}

function toRelativePath(rootPath: string, absolutePath: string): string {
  return path.relative(rootPath, absolutePath).split(path.sep).join('/');
}
