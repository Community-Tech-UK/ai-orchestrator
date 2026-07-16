import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SecurityFilter } from './security-filter';
import { ProjectDiscovery } from './project-discovery';
import { getLogger } from '../logging/logger';
import { readFilesystemDirectoryTree } from '../services/filesystem-directory-reader';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type {
  FsReadDirectoryParams,
  FsReadDirectoryResult,
  FsStatParams,
  FsStatResult,
  FsSearchParams,
  FsSearchResult,
  FsWatchParams,
  FsWatchResult,
  FsUnwatchParams,
  FsReadFileParams,
  FsReadFileResult,
  FsReadFileChunkParams,
  FsReadFileChunkResult,
  FsWriteFileParams,
  FsWriteFileChunkParams,
  FsWriteFileChunkResult,
  FsErrorCode,
  FsChangeEvent,
  FsEventNotification
} from '../../shared/types/remote-fs.types';
import type { NodePlatform, WorkerNodeFileTransferRoot } from '../../shared/types/worker-node.types';

const logger = getLogger('NodeFilesystemHandler');

const DEFAULT_LIMIT = 500;
const DEFAULT_DEPTH = 1;
const MAX_READ_FILE_SIZE = 50 * 1024 * 1024; // 50 MB (single-RPC whole-file reads)
/** Per-chunk cap for streamed transfers; stays well under the WS payload cap after base64. */
const MAX_CHUNK_BYTES = 16 * 1024 * 1024;
/** Total-size cap for streamed transfers. */
const MAX_STREAM_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GiB
/** Suffix for in-progress streamed writes; renamed into place on commit. */
const PARTIAL_SUFFIX = '.aio-partial';

/** Simple extension → MIME type mapping for common file types */
const MIME_TYPES: Record<string, string> = {
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.js': 'text/javascript',
  '.ts': 'text/typescript',
  '.html': 'text/html',
  '.css': 'text/css',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.csv': 'text/csv',
  '.sh': 'text/x-shellscript',
  '.py': 'text/x-python',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.java': 'text/x-java',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip'
};

// ---------------------------------------------------------------------------
// Custom RPC error
// ---------------------------------------------------------------------------

export class FsRpcError extends Error {
  readonly fsCode: FsErrorCode;
  readonly fsPath: string;
  readonly retryable: boolean;
  readonly suggestion?: string;

  constructor(
    fsCode: FsErrorCode,
    fsPath: string,
    message: string,
    retryable = false,
    suggestion?: string
  ) {
    super(message);
    this.name = 'FsRpcError';
    this.fsCode = fsCode;
    this.fsPath = fsPath;
    this.retryable = retryable;
    this.suggestion = suggestion;
  }
}

// ---------------------------------------------------------------------------
// Watcher state
// ---------------------------------------------------------------------------

interface WatcherEntry {
  watchId: string;
  targetPath: string;
  abort: AbortController;
}

interface NodeFilesystemHandlerOptions {
  onFsEvent?: (event: FsEventNotification) => void;
}

// ---------------------------------------------------------------------------
// NodeFilesystemHandler
// ---------------------------------------------------------------------------

export class NodeFilesystemHandler {
  private readonly roots: string[];
  private readonly transferRoots: WorkerNodeFileTransferRoot[];
  private readonly platform: NodePlatform;
  private readonly discovery: ProjectDiscovery;
  private readonly watchers = new Map<string, WatcherEntry>();
  private watchCounter = 0;

  constructor(
    browsableRoots: string[] = [],
    private readonly options: NodeFilesystemHandlerOptions = {},
    transferRoots: WorkerNodeFileTransferRoot[] = [],
  ) {
    this.roots = browsableRoots.length > 0 ? browsableRoots : [os.homedir()];
    this.transferRoots = transferRoots;
    this.platform = process.platform as NodePlatform;
    this.discovery = new ProjectDiscovery();
  }

  getDiscovery(): ProjectDiscovery {
    return this.discovery;
  }

  getRoots(): string[] {
    return this.roots;
  }

  getTransferRoots(): WorkerNodeFileTransferRoot[] {
    return [...this.transferRoots];
  }

  // -------------------------------------------------------------------------
  // Path validation
  // -------------------------------------------------------------------------

  private async validatePath(targetPath: string): Promise<string> {
    let resolved: string;
    try {
      resolved = await fs.realpath(targetPath);
    } catch {
      throw new FsRpcError(
        'ENOENT',
        targetPath,
        `ENOENT: no such file or directory, realpath '${targetPath}'`
      );
    }

    if (!SecurityFilter.isWithinRoot(resolved, this.readableRoots())) {
      throw new FsRpcError(
        'EOUTOFSCOPE',
        resolved,
        `EOUTOFSCOPE: path '${resolved}' is outside browsable roots`,
        false,
        'Only paths within the configured browsable roots are accessible.'
      );
    }

    return resolved;
  }

  private readableRoots(): string[] {
    return [
      ...this.roots,
      ...this.transferRoots
        .filter((root) => root.read)
        .map((root) => root.path),
    ];
  }

  /**
   * Decide writability by the MOST SPECIFIC (longest-path) scope that contains
   * `targetPath`, considering working directories (always writable) alongside
   * configured transfer roots (writable per their own `write` flag).
   *
   * This prevents a read-only transfer root that merely *contains* a working
   * directory — e.g. a read-only "Documents" transfer root sitting above a
   * "Documents/Work" working directory — from shadowing that working directory
   * and vetoing a legitimate write inside it. That shadowing broke remote
   * browser-upload staging (which writes into
   * `<workingDir>/_scratch/aio-browser-uploads`) on any node whose working
   * directory lives under a read-only transfer root. A read-only transfer root
   * nested *inside* a working directory still wins, because it is the more
   * specific scope. On an exact-length tie a working directory wins, since
   * agent writes inside their own working directory are a core invariant.
   */
  private isWritablePath(targetPath: string): boolean {
    const scopes: Array<{ path: string; writable: boolean }> = [
      ...this.roots.map((rootPath) => ({ path: rootPath, writable: true })),
      ...this.transferRoots.map((root) => ({ path: root.path, writable: root.write })),
    ];
    const mostSpecific = scopes
      .filter((scope) => SecurityFilter.isWithinRoot(targetPath, [scope.path]))
      .sort((left, right) => right.path.length - left.path.length)[0];
    return mostSpecific?.writable ?? false;
  }

  private writableRoots(): string[] {
    return [
      ...this.roots,
      ...this.transferRoots
        .filter((root) => root.write)
        .map((root) => root.path),
    ];
  }

  private async validateWritableParent(targetPath: string): Promise<void> {
    const parentPath = path.dirname(targetPath);
    const existingParent = await this.realpathClosestExisting(parentPath);
    if (!SecurityFilter.isWithinRoot(existingParent, this.writableRoots())) {
      throw new FsRpcError(
        'EOUTOFSCOPE',
        existingParent,
        `EOUTOFSCOPE: parent path '${existingParent}' is outside writable roots`,
        false,
        'Only paths within configured writable roots can be written.'
      );
    }
  }

  private async assertRealParentStillWritable(targetPath: string): Promise<void> {
    const parentPath = path.dirname(targetPath);
    const realParent = await fs.realpath(parentPath);
    if (!SecurityFilter.isWithinRoot(realParent, this.writableRoots())) {
      throw new FsRpcError(
        'EOUTOFSCOPE',
        realParent,
        `EOUTOFSCOPE: parent path '${realParent}' is outside writable roots`,
        false,
        'Only paths within configured writable roots can be written.'
      );
    }
  }

  private async realpathClosestExisting(targetPath: string): Promise<string> {
    let current = path.resolve(targetPath);
    while (true) {
      try {
        return await fs.realpath(current);
      } catch (error) {
        if (!isNotFoundError(error)) {
          throw error;
        }
        const parent = path.dirname(current);
        if (parent === current) {
          throw new FsRpcError(
            'ENOENT',
            targetPath,
            `ENOENT: no existing parent for '${targetPath}'`
          );
        }
        current = parent;
      }
    }
  }

  // -------------------------------------------------------------------------
  // readDirectory
  // -------------------------------------------------------------------------

  async readDirectory(
    params: FsReadDirectoryParams
  ): Promise<FsReadDirectoryResult> {
    const {
      depth = DEFAULT_DEPTH,
      includeHidden = false,
      limit = DEFAULT_LIMIT
    } = params;

    const resolvedPath = await this.validatePath(params.path);

    const allEntries = await readFilesystemDirectoryTree(
      resolvedPath,
      depth,
      includeHidden
    );

    // Pagination via cursor (cursor is a numeric string offset)
    const startIndex = params.cursor ? parseInt(params.cursor, 10) : 0;
    const page = allEntries.slice(startIndex, startIndex + limit);
    const truncated = startIndex + limit < allEntries.length;
    const nextCursor = truncated ? String(startIndex + limit) : undefined;

    logger.info('readDirectory', {
      path: resolvedPath,
      count: page.length,
      truncated
    });

    return { entries: page, cursor: nextCursor, truncated };
  }

  // -------------------------------------------------------------------------
  // stat
  // -------------------------------------------------------------------------

  async stat(params: FsStatParams): Promise<FsStatResult> {
    let resolved: string;
    try {
      resolved = await fs.realpath(params.path);
    } catch {
      return {
        exists: false,
        isDirectory: false,
        size: 0,
        modifiedAt: 0,
        platform: this.platform,
        withinBrowsableRoot: false
      };
    }

    const withinBrowsableRoot = SecurityFilter.isWithinRoot(
      resolved,
      this.readableRoots()
    );

    let statResult: import('node:fs').Stats;
    try {
      statResult = await fs.stat(resolved);
    } catch {
      return {
        exists: false,
        isDirectory: false,
        size: 0,
        modifiedAt: 0,
        platform: this.platform,
        withinBrowsableRoot
      };
    }

    return {
      exists: true,
      isDirectory: statResult.isDirectory(),
      size: statResult.size,
      modifiedAt: statResult.mtimeMs,
      platform: this.platform,
      withinBrowsableRoot
    };
  }

  // -------------------------------------------------------------------------
  // search
  // -------------------------------------------------------------------------

  async search(params: FsSearchParams): Promise<FsSearchResult> {
    const { query, maxResults = 20 } = params;
    const lower = query.toLowerCase();

    const projects = this.discovery.getCachedProjects();
    const results = projects
      .filter(
        (p) =>
          p.name.toLowerCase().includes(lower) ||
          p.path.toLowerCase().includes(lower)
      )
      .slice(0, maxResults)
      .map((p) => ({
        path: p.path,
        name: p.name,
        markers: p.markers,
        root: this.roots.find((r) => p.path.startsWith(r)) ?? ''
      }));

    return { results };
  }

  // -------------------------------------------------------------------------
  // watch / unwatch
  // -------------------------------------------------------------------------

  async watch(params: FsWatchParams): Promise<FsWatchResult> {
    const resolvedPath = await this.validatePath(params.path);

    this.watchCounter += 1;
    const watchId = `watch-${this.watchCounter}`;
    const abort = new AbortController();

    const entry: WatcherEntry = { watchId, targetPath: resolvedPath, abort };
    this.watchers.set(watchId, entry);

    // Start watching in background — errors are logged but do not surface
    (async () => {
      try {
        const watcher = fs.watch(resolvedPath, {
          recursive: params.recursive ?? false,
          signal: abort.signal
        });
        for await (const event of watcher) {
          const change = await this.toChangeEvent(resolvedPath, event);
          this.options.onFsEvent?.({ watchId, events: [change] });
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name !== 'AbortError') {
          logger.warn('Watcher error', { watchId, err: String(err) });
        }
      } finally {
        this.watchers.delete(watchId);
      }
    })();

    logger.info('Watching path', { watchId, path: resolvedPath });
    return { watchId };
  }

  private async toChangeEvent(
    rootPath: string,
    event: { eventType: string; filename: string | Buffer | null }
  ): Promise<FsChangeEvent> {
    const filename = event.filename?.toString();
    const targetPath = filename ? path.resolve(rootPath, filename) : rootPath;
    let exists = false;
    let isDirectory = false;

    try {
      const stat = await fs.stat(targetPath);
      exists = true;
      isDirectory = stat.isDirectory();
    } catch {
      exists = false;
    }

    return {
      type: event.eventType === 'change' ? 'change' : exists ? 'add' : 'delete',
      path: targetPath,
      isDirectory,
    };
  }

  async unwatch(params: FsUnwatchParams): Promise<void> {
    const entry = this.watchers.get(params.watchId);
    if (entry) {
      entry.abort.abort();
      this.watchers.delete(params.watchId);
      logger.info('Unwatched', { watchId: params.watchId });
    }
  }

  cleanupAllWatchers(): void {
    for (const entry of this.watchers.values()) {
      entry.abort.abort();
    }
    this.watchers.clear();
    logger.info('All watchers cleaned up');
  }

  // -------------------------------------------------------------------------
  // readFile
  // -------------------------------------------------------------------------

  async readFile(params: FsReadFileParams): Promise<FsReadFileResult> {
    const resolvedPath = await this.validatePath(params.path);

    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      throw new FsRpcError(
        'ENOTDIR',
        resolvedPath,
        `ENOTDIR: '${resolvedPath}' is a directory, not a file`
      );
    }
    if (stat.size > MAX_READ_FILE_SIZE) {
      throw new FsRpcError(
        'EACCES',
        resolvedPath,
        `File too large: ${stat.size} bytes exceeds ${MAX_READ_FILE_SIZE} byte limit`,
        false,
        'Use streaming transfer for files larger than 50 MB.'
      );
    }
    if (SecurityFilter.isRestrictedPath(resolvedPath)) {
      throw new FsRpcError(
        'EACCES',
        resolvedPath,
        `EACCES: '${path.basename(resolvedPath)}' is a restricted file`,
        false,
        'Restricted files (credentials, keys, secrets) cannot be read remotely.'
      );
    }

    const buffer = await fs.readFile(resolvedPath);
    const ext = path.extname(resolvedPath).toLowerCase();
    const mimeType = MIME_TYPES[ext] ?? 'application/octet-stream';

    logger.info('readFile', {
      path: resolvedPath,
      size: buffer.length,
      mimeType
    });

    return {
      data: buffer.toString('base64'),
      size: buffer.length,
      mimeType
    };
  }

  // -------------------------------------------------------------------------
  // writeFile
  // -------------------------------------------------------------------------

  async writeFile(
    params: FsWriteFileParams
  ): Promise<{ ok: true; size: number }> {
    const targetPath = path.resolve(params.path);

    // Validate target is within allowed roots (use resolve instead of realpath
    // since the file may not exist yet)
    if (!this.isWritablePath(targetPath)) {
      throw new FsRpcError(
        'EOUTOFSCOPE',
        targetPath,
        `EOUTOFSCOPE: path '${targetPath}' is outside browsable roots`,
        false,
        'Only paths within the configured working directories are writable.'
      );
    }

    if (SecurityFilter.isRestrictedPath(targetPath)) {
      throw new FsRpcError(
        'EACCES',
        targetPath,
        `EACCES: cannot write to restricted filename '${path.basename(targetPath)}'`,
        false,
        'Restricted files (credentials, keys, secrets) cannot be written remotely.'
      );
    }

    const buffer = Buffer.from(params.data, 'base64');
    await this.validateWritableParent(targetPath);

    // Create parent directories if needed
    if (params.mkdirp !== false) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
    }
    await this.assertRealParentStillWritable(targetPath);
    const existingStat = await lstatOrNull(targetPath);
    if (existingStat?.isSymbolicLink()) {
      throw new FsRpcError(
        'EACCES',
        targetPath,
        `EACCES: cannot write through symbolic link '${path.basename(targetPath)}'`,
        false,
        'Symbolic link destinations are refused for remote file writes.'
      );
    }

    await fs.writeFile(targetPath, buffer);

    logger.info('writeFile', { path: targetPath, size: buffer.length });

    return { ok: true, size: buffer.length };
  }

  // -------------------------------------------------------------------------
  // Streamed transfers (files above the single-RPC size cap)
  // -------------------------------------------------------------------------

  async readFileChunk(params: FsReadFileChunkParams): Promise<FsReadFileChunkResult> {
    const resolvedPath = await this.validatePath(params.path);
    if (SecurityFilter.isRestrictedPath(resolvedPath)) {
      throw new FsRpcError(
        'EACCES',
        resolvedPath,
        `EACCES: '${path.basename(resolvedPath)}' is a restricted file`,
        false,
        'Restricted files (credentials, keys, secrets) cannot be read remotely.'
      );
    }
    const stat = await fs.stat(resolvedPath);
    if (stat.isDirectory()) {
      throw new FsRpcError(
        'ENOTDIR',
        resolvedPath,
        `ENOTDIR: '${resolvedPath}' is a directory, not a file`
      );
    }
    if (stat.size > MAX_STREAM_FILE_SIZE) {
      throw new FsRpcError(
        'EACCES',
        resolvedPath,
        `File too large: ${stat.size} bytes exceeds the ${MAX_STREAM_FILE_SIZE} byte streaming limit`
      );
    }
    const length = Math.min(params.length, MAX_CHUNK_BYTES);
    const handle = await fs.open(resolvedPath, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, params.offset);
      return {
        data: buffer.subarray(0, bytesRead).toString('base64'),
        bytesRead,
        size: stat.size,
        eof: params.offset + bytesRead >= stat.size,
      };
    } finally {
      await handle.close();
    }
  }

  async writeFileChunk(params: FsWriteFileChunkParams): Promise<FsWriteFileChunkResult> {
    const targetPath = path.resolve(params.path);
    if (!this.isWritablePath(targetPath)) {
      throw new FsRpcError(
        'EOUTOFSCOPE',
        targetPath,
        `EOUTOFSCOPE: path '${targetPath}' is outside browsable roots`,
        false,
        'Only paths within the configured working directories are writable.'
      );
    }
    if (SecurityFilter.isRestrictedPath(targetPath)) {
      throw new FsRpcError(
        'EACCES',
        targetPath,
        `EACCES: cannot write to restricted filename '${path.basename(targetPath)}'`,
        false,
        'Restricted files (credentials, keys, secrets) cannot be written remotely.'
      );
    }
    if (params.totalSize > MAX_STREAM_FILE_SIZE) {
      throw new FsRpcError(
        'EACCES',
        targetPath,
        `File too large: ${params.totalSize} bytes exceeds the ${MAX_STREAM_FILE_SIZE} byte streaming limit`
      );
    }

    const partialPath = `${targetPath}${PARTIAL_SUFFIX}`;
    const buffer = Buffer.from(params.data, 'base64');

    if (params.offset === 0) {
      await this.validateWritableParent(targetPath);
      if (params.mkdirp !== false) {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
      }
      await this.assertRealParentStillWritable(targetPath);
      const existingStat = await lstatOrNull(targetPath);
      if (existingStat?.isSymbolicLink()) {
        throw new FsRpcError(
          'EACCES',
          targetPath,
          `EACCES: cannot write through symbolic link '${path.basename(targetPath)}'`,
          false,
          'Symbolic link destinations are refused for remote file writes.'
        );
      }
      await fs.rm(partialPath, { force: true });
    }

    const partialStat = await lstatOrNull(partialPath);
    const currentSize = params.offset === 0 ? 0 : partialStat?.size ?? -1;
    if (currentSize !== params.offset) {
      await fs.rm(partialPath, { force: true });
      throw new FsRpcError(
        'EIO',
        targetPath,
        `EIO: chunk offset ${params.offset} does not continue the partial file (have ${currentSize} bytes)`,
        true,
        'Restart the streamed transfer from offset 0.'
      );
    }

    const handle = await fs.open(partialPath, params.offset === 0 ? 'w' : 'r+');
    try {
      await handle.write(buffer, 0, buffer.length, params.offset);
    } finally {
      await handle.close();
    }

    if (!params.done) {
      return { ok: true, bytesWritten: buffer.length, committed: false };
    }

    const finalStat = await fs.stat(partialPath);
    if (finalStat.size !== params.totalSize) {
      await fs.rm(partialPath, { force: true });
      throw new FsRpcError(
        'EIO',
        targetPath,
        `EIO: streamed file is ${finalStat.size} bytes, expected ${params.totalSize}`,
        true,
        'Restart the streamed transfer from offset 0.'
      );
    }
    const digest = await sha256File(partialPath);
    // Windows rename() refuses to replace an existing file, so clear the
    // destination first — writability was already validated above.
    await fs.rm(targetPath, { force: true });
    await fs.rename(partialPath, targetPath);
    logger.info('writeFileChunk committed', { path: targetPath, size: finalStat.size });
    return {
      ok: true,
      bytesWritten: buffer.length,
      committed: true,
      size: finalStat.size,
      sha256: digest,
    };
  }

}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve());
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

async function lstatOrNull(filePath: string): Promise<import('node:fs').Stats | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return null;
    }
    throw error;
  }
}

function isNotFoundError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
