import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { watch } from 'chokidar';
import type { Ignore } from 'ignore';
import { getLogger } from '../logging/logger';
import { buildWatchIgnoredMatchers } from '../workspace/watcher/watch-ignore';
import type { WorkspaceHash } from './types';

const logger = getLogger('CodeIndexWatcher');

interface PendingWorkspaceChange {
  paths: Set<string>;
  timer: NodeJS.Timeout;
}

interface WorkspaceWatcherHandle {
  close(): Promise<void>;
}

export interface CodeIndexWatcherOptions {
  debounceMs: number;
  maxNativeWatchFiles: number;
  maxWatchedWorkspaces: number;
  pollingIntervalMs: number;
  loadIgnoreRules(workspacePath: string): Promise<Ignore>;
  walkFiles(rootPath: string, dirPath: string, ig: Ignore): Promise<string[]>;
  toRelativePath(workspacePath: string, absolutePath: string): string;
  applyFileChange(workspaceHash: WorkspaceHash, absoluteFilePath: string): Promise<string | null>;
  emitChanged(event: { workspaceHash: WorkspaceHash; paths: string[] }): void;
}

export class CodeIndexWatcher {
  private readonly watchers = new Map<WorkspaceHash, WorkspaceWatcherHandle>();
  private readonly pending = new Map<WorkspaceHash, PendingWorkspaceChange>();

  constructor(private readonly options: CodeIndexWatcherOptions) {}

  async start(
    absoluteWorkspacePath: string,
    workspaceHash: WorkspaceHash,
  ): Promise<void> {
    await this.stop(workspaceHash);

    if (await this.shouldUsePollingWatcher(absoluteWorkspacePath)) {
      logger.warn('Using polling code index watcher for broad workspace', {
        workspaceHash,
        workspacePath: absoluteWorkspacePath,
        maxNativeWatchFiles: this.options.maxNativeWatchFiles,
      });
      const watcher = await this.createPollingWatcher(absoluteWorkspacePath, workspaceHash);
      await this.setWorkspaceWatcher(workspaceHash, watcher);
      return;
    }

    try {
      const watcher = await this.createChokidarWatcher(absoluteWorkspacePath, workspaceHash);
      await this.setWorkspaceWatcher(workspaceHash, watcher);
    } catch (error) {
      if (!this.isRecoverableWatchError(error)) {
        throw error;
      }

      logger.warn('Falling back to polling code index watcher after native watcher failure', {
        workspaceHash,
        workspacePath: absoluteWorkspacePath,
        error: error instanceof Error ? error.message : String(error),
      });

      const watcher = await this.createPollingWatcher(absoluteWorkspacePath, workspaceHash);
      await this.setWorkspaceWatcher(workspaceHash, watcher);
    }
  }

  async stop(workspaceHash?: WorkspaceHash): Promise<void> {
    if (workspaceHash) {
      await this.stopWorkspace(workspaceHash);
      return;
    }

    for (const hash of [...this.watchers.keys()]) {
      await this.stopWorkspace(hash);
    }
  }

  getWatcherForTesting(workspaceHash: WorkspaceHash): unknown {
    return this.watchers.get(workspaceHash);
  }

  private queueWorkspacePath(workspaceHash: WorkspaceHash, absoluteFilePath: string): void {
    const pending = this.pending.get(workspaceHash);
    if (pending) {
      pending.paths.add(absoluteFilePath);
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        void this.flushWorkspaceChanges(workspaceHash);
      }, this.options.debounceMs);
      return;
    }

    const timer = setTimeout(() => {
      void this.flushWorkspaceChanges(workspaceHash);
    }, this.options.debounceMs);

    this.pending.set(workspaceHash, {
      paths: new Set([absoluteFilePath]),
      timer,
    });
  }

  private async flushWorkspaceChanges(workspaceHash: WorkspaceHash): Promise<void> {
    const pending = this.pending.get(workspaceHash);
    if (!pending) {
      return;
    }

    this.pending.delete(workspaceHash);
    clearTimeout(pending.timer);

    const changedPaths: string[] = [];
    for (const absoluteFilePath of [...pending.paths].sort()) {
      const changedPath = await this.options.applyFileChange(workspaceHash, absoluteFilePath);
      if (changedPath) {
        changedPaths.push(changedPath);
      }
    }

    if (changedPaths.length > 0) {
      this.options.emitChanged({ workspaceHash, paths: changedPaths });
    }
  }

  private async shouldUsePollingWatcher(workspacePath: string): Promise<boolean> {
    if (this.options.maxNativeWatchFiles === 0) {
      return true;
    }
    const fileCount = await this.countWatchableFilesUpTo(
      workspacePath,
      this.options.maxNativeWatchFiles + 1,
    );
    return fileCount > this.options.maxNativeWatchFiles;
  }

  private async countWatchableFilesUpTo(workspacePath: string, limit: number): Promise<number> {
    const ig = await this.options.loadIgnoreRules(workspacePath);
    const stack = [workspacePath];
    let count = 0;

    while (stack.length > 0) {
      const dirPath = stack.pop();
      if (!dirPath) break;

      let entries: {
        name: string;
        isDirectory(): boolean;
        isFile(): boolean;
      }[];
      try {
        entries = await fs.readdir(dirPath, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        const absolutePath = path.join(dirPath, entry.name);
        const relativePath = this.options.toRelativePath(workspacePath, absolutePath);
        const candidate = entry.isDirectory() ? `${relativePath}/` : relativePath;
        if (relativePath && ig.ignores(candidate)) {
          continue;
        }

        if (entry.isDirectory()) {
          stack.push(absolutePath);
          continue;
        }

        if (entry.isFile()) {
          count += 1;
          if (count >= limit) {
            return count;
          }
        }
      }
    }

    return count;
  }

  private async createChokidarWatcher(
    absoluteWorkspacePath: string,
    workspaceHash: WorkspaceHash,
  ): Promise<WorkspaceWatcherHandle> {
    return await new Promise<WorkspaceWatcherHandle>((resolve, reject) => {
      const watcher = watch(absoluteWorkspacePath, {
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: {
          stabilityThreshold: Math.max(this.options.debounceMs, 30),
          pollInterval: 25,
        },
        ignored: buildWatchIgnoredMatchers(absoluteWorkspacePath, DEFAULT_CODE_INDEX_IGNORES),
        followSymlinks: false,
      });

      const queuePath = (changedPath: string): void => {
        this.queueWorkspacePath(workspaceHash, changedPath);
      };
      let fallbackInProgress = false;
      let resolvedHandle: WorkspaceWatcherHandle | null = null;

      const fallbackToPolling = async (error: unknown): Promise<void> => {
        if (fallbackInProgress || !this.isRecoverableWatchError(error)) {
          return;
        }
        fallbackInProgress = true;

        const currentHandle = resolvedHandle;
        if (!currentHandle || this.watchers.get(workspaceHash) !== currentHandle) {
          return;
        }

        logger.warn('Falling back to polling code index watcher after native watcher runtime failure', {
          workspaceHash,
          workspacePath: absoluteWorkspacePath,
          error: error instanceof Error ? error.message : String(error),
        });

        try {
          await currentHandle.close();
          const pollingWatcher = await this.createPollingWatcher(absoluteWorkspacePath, workspaceHash);
          if (this.watchers.get(workspaceHash) === currentHandle) {
            await this.setWorkspaceWatcher(workspaceHash, pollingWatcher);
          } else {
            await pollingWatcher.close();
          }
        } catch (fallbackError) {
          logger.warn('Failed to fall back to polling code index watcher', {
            workspaceHash,
            workspacePath: absoluteWorkspacePath,
            error: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
          });
        }
      };

      const runtimeErrorHandler = (error: unknown): void => {
        logger.warn('Code index watcher reported a runtime error', {
          workspaceHash,
          workspacePath: absoluteWorkspacePath,
          error: error instanceof Error ? error.message : String(error),
        });
        void fallbackToPolling(error);
      };
      const cleanupStartupListeners = (): void => {
        watcher.off('ready', handleReady);
        watcher.off('error', handleStartupError);
      };
      const handleReady = (): void => {
        cleanupStartupListeners();
        watcher.on('error', runtimeErrorHandler);
        resolvedHandle = {
          close: async () => {
            watcher.off('error', runtimeErrorHandler);
            await watcher.close();
          },
        };
        resolve(resolvedHandle);
      };
      const handleStartupError = (error: unknown): void => {
        cleanupStartupListeners();
        void watcher.close().catch(() => undefined);
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      watcher.on('add', queuePath);
      watcher.on('change', queuePath);
      watcher.on('unlink', queuePath);
      watcher.on('ready', handleReady);
      watcher.on('error', handleStartupError);
    });
  }

  private async createPollingWatcher(
    absoluteWorkspacePath: string,
    workspaceHash: WorkspaceHash,
  ): Promise<WorkspaceWatcherHandle> {
    let closed = false;
    let scanning = false;
    let snapshot = await this.captureWorkspaceSnapshot(absoluteWorkspacePath);
    const intervalMs = Math.max(this.options.debounceMs, this.options.pollingIntervalMs);

    const timer = setInterval(() => {
      if (closed || scanning) {
        return;
      }

      scanning = true;
      void this.scanWorkspaceSnapshot(absoluteWorkspacePath, workspaceHash, snapshot)
        .then((nextSnapshot) => {
          snapshot = nextSnapshot;
        })
        .catch((error) => {
          logger.warn('Polling code index watcher scan failed', {
            workspaceHash,
            workspacePath: absoluteWorkspacePath,
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          scanning = false;
        });
    }, intervalMs);

    if (timer.unref) {
      timer.unref();
    }

    return {
      close: async () => {
        closed = true;
        clearInterval(timer);
      },
    };
  }

  private async captureWorkspaceSnapshot(workspacePath: string): Promise<Map<string, string>> {
    const ig = await this.options.loadIgnoreRules(workspacePath);
    const files = await this.options.walkFiles(workspacePath, workspacePath, ig);
    const snapshot = new Map<string, string>();

    for (const absoluteFilePath of files) {
      try {
        const stat = await fs.stat(absoluteFilePath);
        snapshot.set(absoluteFilePath, `${Math.floor(stat.mtimeMs)}:${stat.size}`);
      } catch {
        // Ignore files that disappear while the snapshot is being collected.
      }
    }

    return snapshot;
  }

  private async scanWorkspaceSnapshot(
    workspacePath: string,
    workspaceHash: WorkspaceHash,
    previousSnapshot: Map<string, string>,
  ): Promise<Map<string, string>> {
    const nextSnapshot = await this.captureWorkspaceSnapshot(workspacePath);
    const changedPaths = new Set<string>();

    for (const [absoluteFilePath, signature] of nextSnapshot) {
      if (previousSnapshot.get(absoluteFilePath) !== signature) {
        changedPaths.add(absoluteFilePath);
      }
    }

    for (const absoluteFilePath of previousSnapshot.keys()) {
      if (!nextSnapshot.has(absoluteFilePath)) {
        changedPaths.add(absoluteFilePath);
      }
    }

    for (const absoluteFilePath of [...changedPaths].sort()) {
      this.queueWorkspacePath(workspaceHash, absoluteFilePath);
    }

    return nextSnapshot;
  }

  private isRecoverableWatchError(error: unknown): boolean {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
    return code === 'EMFILE' || code === 'ENFILE' || code === 'ENOSPC' || code === 'EPERM';
  }

  private async setWorkspaceWatcher(
    workspaceHash: WorkspaceHash,
    watcher: WorkspaceWatcherHandle,
  ): Promise<void> {
    this.watchers.delete(workspaceHash);
    this.watchers.set(workspaceHash, watcher);
    await this.enforceWatcherLimit(workspaceHash);
  }

  private async enforceWatcherLimit(preserveHash: WorkspaceHash): Promise<void> {
    while (this.watchers.size > this.options.maxWatchedWorkspaces) {
      const oldestHash = [...this.watchers.keys()].find((hash) => hash !== preserveHash);
      if (!oldestHash) {
        return;
      }
      logger.warn('Stopping older code index watcher to stay within watcher cap', {
        workspaceHash: oldestHash,
        maxWatchedWorkspaces: this.options.maxWatchedWorkspaces,
      });
      await this.stopWorkspace(oldestHash);
    }
  }

  private async stopWorkspace(workspaceHash: WorkspaceHash): Promise<void> {
    const watcher = this.watchers.get(workspaceHash);
    if (watcher) {
      await watcher.close();
      this.watchers.delete(workspaceHash);
    }

    const pending = this.pending.get(workspaceHash);
    if (pending) {
      clearTimeout(pending.timer);
      this.pending.delete(workspaceHash);
    }
  }
}

export const DEFAULT_CODE_INDEX_IGNORES = [
  '.git/',
  '.angular/',
  '.cache/',
  '.gradle/',
  '.next/',
  '.nuxt/',
  '.output/',
  '.parcel-cache/',
  '.pytest_cache/',
  '.ruff_cache/',
  '.svelte-kit/',
  '.turbo/',
  '.venv/',
  'build/',
  'cache/',
  'coverage/',
  'dist/',
  'external-benchmarks/',
  'libraries/',
  'node_modules/',
  'out/',
  'release/',
  'target/',
  'venv/',
  'vendor/',
  '**/*.class',
  '**/*.7z',
  '**/*.bz2',
  '**/*.dmg',
  '**/*.gz',
  '**/*.jar',
  '**/*.lock',
  '**/*.log',
  '**/*.map',
  '**/*.min.css',
  '**/*.min.js',
  '**/*.rar',
  '**/*.tar',
  '**/*.tar.bz2',
  '**/*.tar.gz',
  '**/*.tar.xz',
  '**/*.tgz',
  '**/*.war',
  '**/*.xz',
  '**/*.zip',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
];
