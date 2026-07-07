import fs from 'node:fs/promises';
import { getLogger } from '../logging/logger';
import { readFilesystemDirectoryTree } from './filesystem-directory-reader';
import type {
  FsReadDirectoryParams,
  FsReadDirectoryResult,
  FsStatResult,
  FsSearchResult,
  FsWatchResult,
  FsReadFileResult,
} from '../../shared/types/remote-fs.types';

const logger = getLogger('FilesystemService');

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30_000;
const CACHE_MAX_ENTRIES = 200;

interface CacheEntry {
  result: FsReadDirectoryResult;
  timestamp: number;
}

// ---------------------------------------------------------------------------
// FilesystemService
// ---------------------------------------------------------------------------

export class FilesystemService {
  private static instance: FilesystemService;

  private readonly cache = new Map<string, CacheEntry>();

  static getInstance(): FilesystemService {
    if (!this.instance) {
      this.instance = new FilesystemService();
    }
    return this.instance;
  }

  static _resetForTesting(): void {
    (this.instance as unknown) = undefined;
  }

  private constructor() {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  async readDirectory(
    nodeId: string,
    dirPath: string,
    options?: Omit<FsReadDirectoryParams, 'path'>
  ): Promise<FsReadDirectoryResult> {
    const depth = options?.depth ?? 1;
    const includeHidden = options?.includeHidden ?? false;
    const cacheKey = `${nodeId}:${dirPath}:${depth}:${includeHidden}`;

    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
      logger.info('readDirectory cache hit', { nodeId, dirPath });
      return cached.result;
    }

    let result: FsReadDirectoryResult;

    if (nodeId === 'local') {
      result = await this.localReadDirectory({ path: dirPath, ...options });
    } else {
      const { getWorkerNodeConnectionServer } = await import('../remote-node');
      const params: FsReadDirectoryParams = {
        path: dirPath,
        depth,
        includeHidden,
        ...options
      };
      result =
        await getWorkerNodeConnectionServer().sendRpc<FsReadDirectoryResult>(
          nodeId,
          'fs.readDirectory',
          params
        );
    }

    this.setCache(cacheKey, result);
    return result;
  }

  async stat(nodeId: string, targetPath: string): Promise<FsStatResult> {
    if (nodeId === 'local') {
      return this.localStat(targetPath);
    }

    const { getWorkerNodeConnectionServer } = await import('../remote-node');
    return getWorkerNodeConnectionServer().sendRpc<FsStatResult>(
      nodeId,
      'fs.stat',
      {
        path: targetPath
      }
    );
  }

  async search(
    nodeId: string,
    query: string,
    maxResults?: number
  ): Promise<FsSearchResult> {
    if (nodeId === 'local') {
      // Local search uses native dialog; return empty results here
      return { results: [] };
    }

    const { getWorkerNodeConnectionServer } = await import('../remote-node');
    return getWorkerNodeConnectionServer().sendRpc<FsSearchResult>(
      nodeId,
      'fs.search',
      {
        query,
        maxResults
      }
    );
  }

  async watch(
    nodeId: string,
    watchPath: string,
    recursive?: boolean
  ): Promise<FsWatchResult> {
    if (nodeId === 'local') {
      // Local watching is handled by file-explorer; return a noop watchId
      return { watchId: 'local-noop' };
    }

    const { getWorkerNodeConnectionServer } = await import('../remote-node');
    return getWorkerNodeConnectionServer().sendRpc<FsWatchResult>(
      nodeId,
      'fs.watch',
      {
        path: watchPath,
        recursive
      }
    );
  }

  async unwatch(nodeId: string, watchId: string): Promise<void> {
    if (nodeId === 'local') {
      // Noop for local
      return;
    }

    const { getWorkerNodeConnectionServer } = await import('../remote-node');
    await getWorkerNodeConnectionServer().sendRpc<void>(nodeId, 'fs.unwatch', {
      watchId
    });
  }

  async readFile(nodeId: string, filePath: string): Promise<FsReadFileResult> {
    const { getWorkerNodeConnectionServer } = await import('../remote-node');
    return getWorkerNodeConnectionServer().sendRpc<FsReadFileResult>(
      nodeId,
      'fs.readFile',
      { path: filePath }
    );
  }

  async writeFile(
    nodeId: string,
    filePath: string,
    data: string,
    mkdirp?: boolean
  ): Promise<{ ok: true; size: number }> {
    const { getWorkerNodeConnectionServer } = await import('../remote-node');
    return getWorkerNodeConnectionServer().sendRpc<{ ok: true; size: number }>(
      nodeId,
      'fs.writeFile',
      { path: filePath, data, mkdirp }
    );
  }

  invalidateCache(nodeId: string, dirPath?: string): void {
    if (dirPath) {
      const prefix = `${nodeId}:${dirPath}`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(prefix)) {
          this.cache.delete(key);
        }
      }
    } else {
      const nodePrefix = `${nodeId}:`;
      for (const key of this.cache.keys()) {
        if (key.startsWith(nodePrefix)) {
          this.cache.delete(key);
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private — cache helpers
  // ---------------------------------------------------------------------------

  private setCache(key: string, result: FsReadDirectoryResult): void {
    if (this.cache.size >= CACHE_MAX_ENTRIES) {
      // Evict oldest entry
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, { result, timestamp: Date.now() });
  }

  // ---------------------------------------------------------------------------
  // Private — local implementations
  // ---------------------------------------------------------------------------

  private async localReadDirectory(
    params: FsReadDirectoryParams
  ): Promise<FsReadDirectoryResult> {
    const { depth = 1, includeHidden = false, limit = 500, cursor } = params;
    const allEntries = await readFilesystemDirectoryTree(
      params.path,
      depth,
      includeHidden
    );

    const startIndex = cursor ? parseInt(cursor, 10) : 0;
    const page = allEntries.slice(startIndex, startIndex + limit);
    const truncated = startIndex + limit < allEntries.length;
    const nextCursor = truncated ? String(startIndex + limit) : undefined;

    logger.info('localReadDirectory', {
      path: params.path,
      count: page.length,
      truncated
    });

    return { entries: page, cursor: nextCursor, truncated };
  }

  private async localStat(targetPath: string): Promise<FsStatResult> {
    try {
      const statResult = await fs.stat(targetPath);
      return {
        exists: true,
        isDirectory: statResult.isDirectory(),
        size: statResult.size,
        modifiedAt: statResult.mtimeMs,
        platform: process.platform as 'darwin' | 'win32' | 'linux',
        withinBrowsableRoot: true
      };
    } catch {
      return {
        exists: false,
        isDirectory: false,
        size: 0,
        modifiedAt: 0,
        platform: process.platform as 'darwin' | 'win32' | 'linux',
        withinBrowsableRoot: false
      };
    }
  }

}

export function getFilesystemService(): FilesystemService {
  return FilesystemService.getInstance();
}
