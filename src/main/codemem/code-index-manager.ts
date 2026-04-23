import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { watch, type FSWatcher } from 'chokidar';
import { getTreeSitterChunker, type TreeSitterChunker } from '../indexing/tree-sitter-chunker';
import { getMetadataExtractor } from '../indexing/metadata-extractor';
import { getLogger } from '../logging/logger';
import { normalizeAndHash } from './ast-normalize';
import type { CasStore } from './cas-store';
import { symbolId, workspaceHashForPath } from './symbol-id';
import type {
  Chunk,
  ChunkType,
  MerkleNodeHash,
  WorkspaceSymbolKind,
  WorkspaceSymbolRecord,
  WorkspaceHash,
} from './types';

const logger = getLogger('CodeIndexManager');

const DEFAULT_IGNORES = ['.git/', '.gitignore', 'node_modules/', 'dist/', 'build/', '.next/', 'coverage/'];
const EMPTY_ROOT_HASH = sha256('');

export interface CodeIndexManagerOptions {
  store: CasStore;
  debounceMs?: number;
  chunker?: TreeSitterChunker;
}

export interface ColdIndexResult {
  workspaceHash: WorkspaceHash;
  fileCount: number;
  chunkCount: number;
  merkleRootHash: MerkleNodeHash;
}

interface PendingWorkspaceChange {
  paths: Set<string>;
  timer: NodeJS.Timeout;
}

interface WorkspaceWatcherHandle {
  close(): Promise<void>;
}

export class CodeIndexManager extends EventEmitter {
  private readonly debounceMs: number;
  private readonly chunker: TreeSitterChunker;
  private readonly metadataExtractor = getMetadataExtractor();
  private readonly workspacePaths = new Map<WorkspaceHash, string>();
  private readonly watchers = new Map<WorkspaceHash, WorkspaceWatcherHandle>();
  private readonly pending = new Map<WorkspaceHash, PendingWorkspaceChange>();

  constructor(protected readonly opts: CodeIndexManagerOptions) {
    super();
    this.debounceMs = opts.debounceMs ?? 75;
    this.chunker = opts.chunker ?? getTreeSitterChunker();
  }

  async coldIndex(workspacePath: string): Promise<ColdIndexResult> {
    const absoluteWorkspacePath = path.resolve(workspacePath);
    const workspaceHash = workspaceHashForPath(absoluteWorkspacePath);
    this.workspacePaths.set(workspaceHash, absoluteWorkspacePath);

    const ig = await this.loadIgnoreRules(absoluteWorkspacePath);
    const files = await this.walkFiles(absoluteWorkspacePath, absoluteWorkspacePath, ig);

    for (const entry of this.opts.store.listManifestEntries(workspaceHash)) {
      this.opts.store.deleteManifestEntry(workspaceHash, entry.pathFromRoot);
      this.opts.store.deleteWorkspaceSymbolsForFile(workspaceHash, entry.pathFromRoot);
    }

    let chunkCount = 0;
    for (const absoluteFilePath of files) {
      chunkCount += await this.indexFile(absoluteWorkspacePath, workspaceHash, absoluteFilePath);
    }

    const merkleRootHash = this.recomputeRootHash(workspaceHash);
    this.opts.store.upsertWorkspaceRoot({
      workspaceHash,
      absPath: absoluteWorkspacePath,
      headCommit: null,
      primaryLanguage: this.detectPrimaryLanguage(files),
      lastIndexedAt: Date.now(),
      merkleRootHash,
      pagerankJson: null,
    });

    return {
      workspaceHash,
      fileCount: files.length,
      chunkCount,
      merkleRootHash,
    };
  }

  async start(
    workspacePath: string,
    workspaceHash = workspaceHashForPath(path.resolve(workspacePath)),
  ): Promise<void> {
    const absoluteWorkspacePath = path.resolve(workspacePath);
    this.workspacePaths.set(workspaceHash, absoluteWorkspacePath);

    await this.stop(workspaceHash);

    try {
      const watcher = await this.createChokidarWatcher(absoluteWorkspacePath, workspaceHash);
      this.watchers.set(workspaceHash, watcher);
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
      this.watchers.set(workspaceHash, watcher);
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

  async onFileChange(absoluteFilePath: string, workspaceHash: WorkspaceHash): Promise<void> {
    const changedPath = await this.applyFileChange(workspaceHash, absoluteFilePath);
    if (!changedPath) {
      return;
    }

    this.emit('code-index:changed', { workspaceHash, paths: [changedPath] });
  }

  protected async walkFiles(rootPath: string, dirPath: string, ig: Ignore): Promise<string[]> {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const absolutePath = path.join(dirPath, entry.name);
      const relativePath = this.toRelativePath(rootPath, absolutePath);
      const candidate = entry.isDirectory() ? `${relativePath}/` : relativePath;

      if (relativePath && ig.ignores(candidate)) {
        continue;
      }

      if (entry.isDirectory()) {
        files.push(...await this.walkFiles(rootPath, absolutePath, ig));
        continue;
      }

      if (entry.isFile()) {
        files.push(absolutePath);
      }
    }

    return files.sort();
  }

  protected detectPrimaryLanguage(files: string[]): string | null {
    const counts = new Map<string, number>();

    for (const absoluteFilePath of files) {
      const language = inferLanguage(absoluteFilePath);
      counts.set(language, (counts.get(language) ?? 0) + 1);
    }

    let winner: { language: string; count: number } | null = null;
    for (const [language, count] of counts) {
      if (!winner || count > winner.count) {
        winner = { language, count };
      }
    }

    return winner?.language ?? null;
  }

  protected recomputeRootHash(workspaceHash: WorkspaceHash): MerkleNodeHash {
    const manifestEntries = this.opts.store.listManifestEntries(workspaceHash);
    if (manifestEntries.length === 0) {
      const workspaceRoot = this.opts.store.getWorkspaceRoot(workspaceHash);
      if (workspaceRoot) {
        this.opts.store.upsertWorkspaceRoot({
          ...workspaceRoot,
          merkleRootHash: EMPTY_ROOT_HASH,
          lastIndexedAt: Date.now(),
        });
      }
      this.opts.store.upsertMerkleNode({
        nodeHash: EMPTY_ROOT_HASH,
        kind: 'root',
        childrenJson: '[]',
      });
      return EMPTY_ROOT_HASH;
    }

    const directoryContents = new Map<string, string[]>();
    const directories = new Set<string>(['']);

    for (const entry of manifestEntries) {
      const relativePath = this.normalizeRelative(entry.pathFromRoot);
      const parts = relativePath.split('/');
      const fileName = parts.at(-1) ?? relativePath;
      const directoryPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';

      directories.add(directoryPath);
      let currentPath = '';
      for (const part of parts.slice(0, -1)) {
        currentPath = currentPath ? `${currentPath}/${part}` : part;
        directories.add(currentPath);
      }

      const tokens = directoryContents.get(directoryPath) ?? [];
      tokens.push(`file:${fileName}:${entry.merkleLeafHash}`);
      directoryContents.set(directoryPath, tokens);
    }

    const sortedDirectories = [...directories].sort((left, right) => {
      const depthDifference = this.directoryDepth(right) - this.directoryDepth(left);
      return depthDifference !== 0 ? depthDifference : left.localeCompare(right);
    });

    const directoryHashes = new Map<string, MerkleNodeHash>();
    for (const directoryPath of sortedDirectories) {
      const childTokens = [...(directoryContents.get(directoryPath) ?? [])];

      for (const candidate of directories) {
        if (!candidate || candidate === directoryPath) {
          continue;
        }

        const parentPath = path.posix.dirname(candidate);
        const normalizedParent = parentPath === '.' ? '' : parentPath;
        if (normalizedParent !== directoryPath) {
          continue;
        }

        const childHash = directoryHashes.get(candidate);
        if (childHash) {
          childTokens.push(`dir:${path.posix.basename(candidate)}:${childHash}`);
        }
      }

      childTokens.sort();
      const nodeHash = sha256(
        directoryPath
          ? `${directoryPath}\n${childTokens.join('\n')}`
          : childTokens.join('\n'),
      );

      this.opts.store.upsertMerkleNode({
        nodeHash,
        kind: directoryPath ? 'dir' : 'root',
        childrenJson: JSON.stringify(childTokens),
      });
      directoryHashes.set(directoryPath, nodeHash);
    }

    const rootHash = directoryHashes.get('') ?? EMPTY_ROOT_HASH;
    const workspaceRoot = this.opts.store.getWorkspaceRoot(workspaceHash);
    if (workspaceRoot) {
      this.opts.store.upsertWorkspaceRoot({
        ...workspaceRoot,
        merkleRootHash: rootHash,
        lastIndexedAt: Date.now(),
      });
    }

    return rootHash;
  }

  private async loadIgnoreRules(workspacePath: string): Promise<Ignore> {
    const ig = ignore().add(DEFAULT_IGNORES);
    try {
      const gitignore = await fs.readFile(path.join(workspacePath, '.gitignore'), 'utf8');
      ig.add(gitignore);
    } catch {
      // Missing .gitignore is expected for some workspaces.
    }
    return ig;
  }

  private async indexFile(
    workspacePath: string,
    workspaceHash: WorkspaceHash,
    absoluteFilePath: string,
  ): Promise<number> {
    const sourceText = await fs.readFile(absoluteFilePath, 'utf8');
    const language = inferLanguage(absoluteFilePath);
    const chunks = this.chunker.chunk(sourceText, language, absoluteFilePath);
    const metadata = await this.metadataExtractor.extractFileMetadata(absoluteFilePath, sourceText);
    const leafTokens: string[] = [];

    for (const chunk of chunks) {
      const storedChunk = this.createStoredChunk(chunk, language);
      this.opts.store.upsertChunk(storedChunk);
      leafTokens.push(`${storedChunk.astNormalizedHash}|${storedChunk.chunkType}|${storedChunk.name}`);
    }

    leafTokens.sort();

    const leafHash = sha256(leafTokens.join('\n'));
    this.opts.store.upsertMerkleNode({
      nodeHash: leafHash,
      kind: 'file',
      childrenJson: JSON.stringify(leafTokens),
    });

    const stat = await fs.stat(absoluteFilePath);
    const pathFromRoot = this.toRelativePath(workspacePath, absoluteFilePath);
    this.opts.store.upsertManifestEntry({
      workspaceHash,
      pathFromRoot,
      contentHash: sha256(sourceText),
      merkleLeafHash: leafHash,
      mtime: Math.floor(stat.mtimeMs),
    });
    this.opts.store.replaceWorkspaceSymbolsForFile(
      workspaceHash,
      pathFromRoot,
      this.buildWorkspaceSymbols(
        workspacePath,
        workspaceHash,
        pathFromRoot,
        metadata.symbols,
        chunks,
      ),
    );

    return chunks.length;
  }

  private createStoredChunk(
    chunk: {
      content: string;
      type: string;
      name?: string;
      signature?: string;
      docComment?: string;
    },
    language: string,
  ): Chunk {
    const { contentHash, astNormalizedHash } = normalizeAndHash(chunk.content, language);
    return {
      contentHash,
      astNormalizedHash,
      language,
      chunkType: this.normalizeChunkType(chunk.type),
      name: chunk.name ?? '',
      signature: chunk.signature ?? null,
      docComment: chunk.docComment ?? null,
      symbolsJson: '[]',
      importsJson: '[]',
      exportsJson: '[]',
      rawText: chunk.content,
    };
  }

  private normalizeChunkType(type: string): ChunkType {
    const allowed: ChunkType[] = [
      'function',
      'class',
      'method',
      'interface',
      'type',
      'enum',
      'module',
    ];
    return allowed.includes(type as ChunkType) ? (type as ChunkType) : 'other';
  }

  private buildWorkspaceSymbols(
    workspacePath: string,
    workspaceHash: WorkspaceHash,
    pathFromRoot: string,
    symbols: {
      name: string;
      type: string;
      line: number;
      column: number;
      endLine?: number;
      endColumn?: number;
      signature?: string;
      docComment?: string;
    }[],
    chunks: {
      type: string;
      name?: string;
      startLine: number;
      endLine: number;
      signature?: string;
      docComment?: string;
    }[],
  ): WorkspaceSymbolRecord[] {
    const absoluteFilePath = path.resolve(workspacePath, pathFromRoot);

    return symbols
      .map((symbol) => {
        const kind = this.normalizeSymbolKind(symbol.type);
        if (!kind) {
          return null;
        }

        const matchingChunk = chunks.find((chunk) =>
          this.normalizeSymbolKind(chunk.type) === kind
          && (chunk.name ?? '') === symbol.name
          && chunk.startLine === symbol.line,
        );
        const containerName = kind === 'method'
          ? chunks
            .filter((chunk) =>
              ['class', 'interface', 'type', 'enum', 'module'].includes(chunk.type)
              && (chunk.name?.length ?? 0) > 0
              && chunk.startLine <= symbol.line
              && chunk.endLine >= symbol.line,
            )
            .sort((left, right) => right.startLine - left.startLine)[0]
            ?.name ?? null
          : null;

        return {
          workspaceHash,
          symbolId: symbolId({
            absPath: absoluteFilePath,
            kind,
            name: symbol.name,
            containerName,
          }),
          pathFromRoot,
          name: symbol.name,
          kind,
          containerName,
          startLine: symbol.line,
          startCharacter: symbol.column,
          endLine: symbol.endLine ?? matchingChunk?.endLine ?? null,
          endCharacter: symbol.endColumn ?? null,
          signature: symbol.signature ?? matchingChunk?.signature ?? null,
          docComment: symbol.docComment ?? matchingChunk?.docComment ?? null,
        } satisfies WorkspaceSymbolRecord;
      })
      .filter((symbol): symbol is WorkspaceSymbolRecord => symbol !== null);
  }

  private normalizeSymbolKind(type: string): WorkspaceSymbolKind | null {
    const normalizedKinds: Record<string, WorkspaceSymbolKind> = {
      function: 'function',
      class: 'class',
      method: 'method',
      interface: 'interface',
      type: 'type',
      enum: 'enum',
      variable: 'variable',
      constant: 'constant',
      property: 'property',
      namespace: 'namespace',
      struct: 'class',
      trait: 'interface',
      const: 'constant',
      module: 'namespace',
    };

    return normalizedKinds[type] ?? null;
  }

  private async applyFileChange(workspaceHash: WorkspaceHash, absoluteFilePath: string): Promise<string | null> {
    const workspacePath = this.resolveWorkspacePath(workspaceHash);
    if (!workspacePath) {
      return null;
    }

    const relativePath = this.toRelativePath(workspacePath, absoluteFilePath);
    const ig = await this.loadIgnoreRules(workspacePath);

    try {
      const stat = await fs.stat(absoluteFilePath);
      if (!stat.isFile()) {
        return null;
      }

      if (ig.ignores(relativePath)) {
        return null;
      }

      await this.indexFile(workspacePath, workspaceHash, absoluteFilePath);
    } catch (error) {
      this.opts.store.deleteManifestEntry(workspaceHash, relativePath);
      this.opts.store.deleteWorkspaceSymbolsForFile(workspaceHash, relativePath);
      logger.debug('Removed missing file from manifest during incremental update', {
        workspaceHash,
        relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.recomputeRootHash(workspaceHash);
    return relativePath;
  }

  private resolveWorkspacePath(workspaceHash: WorkspaceHash): string | null {
    const cached = this.workspacePaths.get(workspaceHash);
    if (cached) {
      return cached;
    }

    const workspaceRoot = this.opts.store.getWorkspaceRoot(workspaceHash);
    if (!workspaceRoot) {
      return null;
    }

    this.workspacePaths.set(workspaceHash, workspaceRoot.absPath);
    return workspaceRoot.absPath;
  }

  private queueWorkspacePath(workspaceHash: WorkspaceHash, absoluteFilePath: string): void {
    const pending = this.pending.get(workspaceHash);
    if (pending) {
      pending.paths.add(absoluteFilePath);
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        void this.flushWorkspaceChanges(workspaceHash);
      }, this.debounceMs);
      return;
    }

    const timer = setTimeout(() => {
      void this.flushWorkspaceChanges(workspaceHash);
    }, this.debounceMs);

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
      const changedPath = await this.applyFileChange(workspaceHash, absoluteFilePath);
      if (changedPath) {
        changedPaths.push(changedPath);
      }
    }

    if (changedPaths.length > 0) {
      this.emit('code-index:changed', { workspaceHash, paths: changedPaths });
    }
  }

  private isDefaultIgnored(workspacePath: string, candidatePath: string): boolean {
    const relativePath = this.toRelativePath(workspacePath, candidatePath);
    return DEFAULT_IGNORES.some((pattern) => {
      const normalizedPattern = pattern.endsWith('/') ? pattern.slice(0, -1) : pattern;
      return relativePath === normalizedPattern || relativePath.startsWith(`${normalizedPattern}/`);
    });
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
          stabilityThreshold: Math.max(this.debounceMs, 30),
          pollInterval: 25,
        },
        ignored: (candidatePath) => this.isDefaultIgnored(absoluteWorkspacePath, candidatePath),
      });

      const queuePath = (changedPath: string): void => {
        this.queueWorkspacePath(workspaceHash, changedPath);
      };
      const runtimeErrorHandler = (error: unknown): void => {
        logger.warn('Code index watcher reported a runtime error', {
          workspaceHash,
          workspacePath: absoluteWorkspacePath,
          error: error instanceof Error ? error.message : String(error),
        });
      };
      const cleanupStartupListeners = (): void => {
        watcher.off('ready', handleReady);
        watcher.off('error', handleStartupError);
      };
      const handleReady = (): void => {
        cleanupStartupListeners();
        watcher.on('error', runtimeErrorHandler);
        resolve({
          close: async () => {
            watcher.off('error', runtimeErrorHandler);
            await watcher.close();
          },
        });
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
    const intervalMs = Math.max(this.debounceMs, 50);

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
    const ig = await this.loadIgnoreRules(workspacePath);
    const files = await this.walkFiles(workspacePath, workspacePath, ig);
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
    return code === 'EMFILE' || code === 'ENOSPC' || code === 'EPERM';
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

  private toRelativePath(workspacePath: string, absolutePath: string): string {
    return this.normalizeRelative(path.relative(workspacePath, path.resolve(absolutePath)));
  }

  private normalizeRelative(candidatePath: string): string {
    return candidatePath.split(path.sep).join('/');
  }

  private directoryDepth(directoryPath: string): number {
    if (!directoryPath) {
      return 0;
    }

    return directoryPath.split('/').length;
  }
}

export function inferLanguage(absoluteFilePath: string): string {
  if (absoluteFilePath.endsWith('.ts') || absoluteFilePath.endsWith('.tsx')) {
    return 'typescript';
  }
  if (absoluteFilePath.endsWith('.js') || absoluteFilePath.endsWith('.jsx')) {
    return 'javascript';
  }
  if (absoluteFilePath.endsWith('.py')) {
    return 'python';
  }
  if (absoluteFilePath.endsWith('.go')) {
    return 'go';
  }
  if (absoluteFilePath.endsWith('.rs')) {
    return 'rust';
  }
  if (absoluteFilePath.endsWith('.java')) {
    return 'java';
  }
  return 'unknown';
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
