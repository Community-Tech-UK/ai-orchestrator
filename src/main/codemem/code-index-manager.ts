import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import ignore, { type Ignore } from 'ignore';
import { getTreeSitterChunker, type TreeSitterChunker } from '../indexing/tree-sitter-chunker';
import { getMetadataExtractor } from '../indexing/metadata-extractor';
import { getLogger } from '../logging/logger';
import { normalizeAndHash } from './ast-normalize';
import type { CasStore, CodeIndexStatusRecord, WorkspaceChunkRecord } from './cas-store';
import { reconcileWorkspaceIndex, type ReconcileResult } from './code-index-reconciler';
import { CodeIndexWatcher, DEFAULT_CODE_INDEX_IGNORES } from './code-index-watcher';
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

const EMPTY_ROOT_HASH = sha256('');
const MAX_INDEXED_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAX_NATIVE_WATCH_FILES = 1_500;
const DEFAULT_MAX_WATCHED_WORKSPACES = 3;
const DEFAULT_POLLING_INTERVAL_MS = 30_000;
const DEFAULT_MAX_INCREMENTAL_MERKLE_RECOMPUTE_MANIFEST_ENTRIES = 50_000;

export interface CodeIndexManagerOptions {
  store: CasStore;
  debounceMs?: number;
  chunker?: TreeSitterChunker;
  maxNativeWatchFiles?: number;
  maxWatchedWorkspaces?: number;
  pollingIntervalMs?: number;
  maxIncrementalMerkleRecomputeManifestEntries?: number;
}

export interface ColdIndexResult {
  workspaceHash: WorkspaceHash;
  fileCount: number;
  chunkCount: number;
  merkleRootHash: MerkleNodeHash;
}

export class CodeIndexManager extends EventEmitter {
  private readonly chunker: TreeSitterChunker;
  private readonly metadataExtractor = getMetadataExtractor();
  private readonly watcher: CodeIndexWatcher;
  private readonly workspacePaths = new Map<WorkspaceHash, string>();
  private readonly maxIncrementalMerkleRecomputeManifestEntries: number;
  private readonly loggedLargeIncrementalManifests = new Set<WorkspaceHash>();

  constructor(protected readonly opts: CodeIndexManagerOptions) {
    super();
    this.chunker = opts.chunker ?? getTreeSitterChunker();
    this.maxIncrementalMerkleRecomputeManifestEntries = Math.max(
      0,
      opts.maxIncrementalMerkleRecomputeManifestEntries
        ?? DEFAULT_MAX_INCREMENTAL_MERKLE_RECOMPUTE_MANIFEST_ENTRIES,
    );
    this.watcher = new CodeIndexWatcher({
      debounceMs: opts.debounceMs ?? 75,
      maxNativeWatchFiles: Math.max(0, opts.maxNativeWatchFiles ?? DEFAULT_MAX_NATIVE_WATCH_FILES),
      maxWatchedWorkspaces: Math.max(1, opts.maxWatchedWorkspaces ?? DEFAULT_MAX_WATCHED_WORKSPACES),
      pollingIntervalMs: Math.max(1_000, opts.pollingIntervalMs ?? DEFAULT_POLLING_INTERVAL_MS),
      loadIgnoreRules: (workspacePath) => this.loadIgnoreRules(workspacePath),
      walkFiles: (rootPath, dirPath, ig) => this.walkFiles(rootPath, dirPath, ig),
      toRelativePath: (workspacePath, absolutePath) => this.toRelativePath(workspacePath, absolutePath),
      applyFileChange: (workspaceHash, absoluteFilePath) =>
        this.applyFileChange(workspaceHash, absoluteFilePath),
      emitChanged: (event) => this.emit('code-index:changed', event),
    });
  }

  async coldIndex(workspacePath: string): Promise<ColdIndexResult> {
    const absoluteWorkspacePath = path.resolve(workspacePath);
    const workspaceHash = workspaceHashForPath(absoluteWorkspacePath);
    this.workspacePaths.set(workspaceHash, absoluteWorkspacePath);
    const startedAt = Date.now();
    this.opts.store.clearCancel(workspaceHash);
    this.writeIndexStatus({
      workspaceHash,
      absPath: absoluteWorkspacePath,
      state: 'running',
      phase: 'scanning',
      totalFiles: 0,
      processedFiles: 0,
      totalChunks: 0,
      processedChunks: 0,
      currentPath: null,
      startedAt,
      updatedAt: startedAt,
      completedAt: null,
      errorMessage: null,
      cancelRequested: false,
    });

    try {
      const ig = await this.loadIgnoreRules(absoluteWorkspacePath);
      const files = await this.walkFiles(
        absoluteWorkspacePath,
        absoluteWorkspacePath,
        ig,
        () => this.opts.store.isCancelRequested(workspaceHash),
      );

      if (this.opts.store.isCancelRequested(workspaceHash)) {
        const completedAt = Date.now();
        const merkleRootHash =
          this.opts.store.getWorkspaceRoot(workspaceHash)?.merkleRootHash ?? EMPTY_ROOT_HASH;
        this.writeIndexStatus({
          ...this.currentIndexStatus(workspaceHash, absoluteWorkspacePath, startedAt),
          state: 'cancelled',
          phase: 'none',
          totalFiles: files.length,
          processedFiles: 0,
          totalChunks: 0,
          processedChunks: 0,
          currentPath: null,
          updatedAt: completedAt,
          completedAt,
          cancelRequested: true,
        });
        return {
          workspaceHash,
          fileCount: 0,
          chunkCount: 0,
          merkleRootHash,
        };
      }

      for (const entry of this.opts.store.listManifestEntries(workspaceHash)) {
        this.opts.store.deleteManifestEntry(workspaceHash, entry.pathFromRoot);
        this.opts.store.deleteWorkspaceSymbolsForFile(workspaceHash, entry.pathFromRoot);
        this.opts.store.deleteWorkspaceChunksForFile(workspaceHash, entry.pathFromRoot);
      }

      let chunkCount = 0;
      let processedFiles = 0;
      this.writeIndexStatus({
        ...this.currentIndexStatus(workspaceHash, absoluteWorkspacePath, startedAt),
        phase: 'chunking',
        totalFiles: files.length,
        processedFiles,
      });
      for (const absoluteFilePath of files) {
        if (this.opts.store.isCancelRequested(workspaceHash)) {
          const merkleRootHash = this.recomputeRootHash(workspaceHash);
          const completedAt = Date.now();
          this.writeIndexStatus({
            ...this.currentIndexStatus(workspaceHash, absoluteWorkspacePath, startedAt),
            state: 'cancelled',
            phase: 'none',
            totalFiles: files.length,
            processedFiles,
            totalChunks: chunkCount,
            processedChunks: chunkCount,
            currentPath: null,
            updatedAt: completedAt,
            completedAt,
            cancelRequested: true,
          });
          return {
            workspaceHash,
            fileCount: processedFiles,
            chunkCount,
            merkleRootHash,
          };
        }

        this.writeIndexStatus({
          ...this.currentIndexStatus(workspaceHash, absoluteWorkspacePath, startedAt),
          totalFiles: files.length,
          processedFiles,
          totalChunks: chunkCount,
          processedChunks: chunkCount,
          currentPath: this.toRelativePath(absoluteWorkspacePath, absoluteFilePath),
          updatedAt: Date.now(),
        });
        chunkCount += await this.indexFile(absoluteWorkspacePath, workspaceHash, absoluteFilePath);
        processedFiles += 1;
        this.writeIndexStatus({
          ...this.currentIndexStatus(workspaceHash, absoluteWorkspacePath, startedAt),
          totalFiles: files.length,
          processedFiles,
          totalChunks: chunkCount,
          processedChunks: chunkCount,
          currentPath: this.toRelativePath(absoluteWorkspacePath, absoluteFilePath),
          updatedAt: Date.now(),
        });
      }

      const merkleRootHash = this.recomputeRootHash(workspaceHash);
      const completedAt = Date.now();
      this.opts.store.upsertWorkspaceRoot({
        workspaceHash,
        absPath: absoluteWorkspacePath,
        headCommit: null,
        primaryLanguage: this.detectPrimaryLanguage(files),
        lastIndexedAt: completedAt,
        merkleRootHash,
        pagerankJson: null,
      });
      this.writeIndexStatus({
        ...this.currentIndexStatus(workspaceHash, absoluteWorkspacePath, startedAt),
        state: 'complete',
        phase: 'watching',
        totalFiles: files.length,
        processedFiles: files.length,
        totalChunks: chunkCount,
        processedChunks: chunkCount,
        currentPath: null,
        updatedAt: completedAt,
        completedAt,
        cancelRequested: false,
      });

      return {
        workspaceHash,
        fileCount: files.length,
        chunkCount,
        merkleRootHash,
      };
    } catch (error) {
      const completedAt = Date.now();
      this.writeIndexStatus({
        ...this.currentIndexStatus(workspaceHash, absoluteWorkspacePath, startedAt),
        state: 'failed',
        phase: 'none',
        currentPath: null,
        updatedAt: completedAt,
        completedAt,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async start(
    workspacePath: string,
    workspaceHash = workspaceHashForPath(path.resolve(workspacePath)),
  ): Promise<void> {
    const absoluteWorkspacePath = path.resolve(workspacePath);
    this.workspacePaths.set(workspaceHash, absoluteWorkspacePath);
    await this.watcher.start(absoluteWorkspacePath, workspaceHash);
  }

  async stop(workspaceHash?: WorkspaceHash): Promise<void> {
    await this.watcher.stop(workspaceHash);
  }

  async onFileChange(absoluteFilePath: string, workspaceHash: WorkspaceHash): Promise<void> {
    const changedPath = await this.applyFileChange(workspaceHash, absoluteFilePath);
    if (!changedPath) {
      return;
    }

    this.emit('code-index:changed', { workspaceHash, paths: [changedPath] });
  }

  /** Repair manifest/filesystem drift accumulated while no watcher was running. */
  async reconcileIndex(workspacePath: string): Promise<ReconcileResult> {
    const absoluteWorkspacePath = path.resolve(workspacePath);
    const workspaceHash = workspaceHashForPath(absoluteWorkspacePath);
    this.workspacePaths.set(workspaceHash, absoluteWorkspacePath);
    return reconcileWorkspaceIndex({
      store: this.opts.store,
      loadIgnoreRules: (targetPath) => this.loadIgnoreRules(targetPath),
      walkFiles: (rootPath, dirPath, ig, shouldStop) => this.walkFiles(rootPath, dirPath, ig, shouldStop),
      toRelativePath: (targetPath, absolutePath) => this.toRelativePath(targetPath, absolutePath),
      indexFile: (targetPath, hash, absoluteFilePath) => this.indexFile(targetPath, hash, absoluteFilePath),
      removeFileFromIndex: (hash, pathFromRoot) => this.removeFileFromIndex(hash, pathFromRoot),
      refreshRootHashAfterIncrementalChange: (hash) => this.refreshRootHashAfterIncrementalChange(hash),
      emitChanged: (event) => this.emit('code-index:changed', event),
    }, absoluteWorkspacePath, workspaceHash);
  }
  protected async walkFiles(
    rootPath: string,
    dirPath: string,
    ig: Ignore,
    shouldStop?: () => boolean,
  ): Promise<string[]> {
    if (shouldStop?.()) {
      return [];
    }

    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      if (shouldStop?.()) {
        return files.sort();
      }

      const absolutePath = path.join(dirPath, entry.name);
      const relativePath = this.toRelativePath(rootPath, absolutePath);
      const candidate = entry.isDirectory() ? `${relativePath}/` : relativePath;

      if (relativePath && ig.ignores(candidate)) {
        continue;
      }

      if (entry.isDirectory()) {
        files.push(...await this.walkFiles(rootPath, absolutePath, ig, shouldStop));
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
      // Skip unknown so non-code files cannot outvote real source files.
      if (language === 'unknown') {
        continue;
      }
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
    const ig = ignore().add(['.gitignore', ...DEFAULT_CODE_INDEX_IGNORES]);
    try {
      const gitignore = await fs.readFile(path.join(workspacePath, '.gitignore'), 'utf8');
      ig.add(gitignore);
    } catch {
      // Missing .gitignore is expected for some workspaces.
    }
    return ig;
  }

  private currentIndexStatus(
    workspaceHash: WorkspaceHash,
    absPath: string,
    startedAt: number,
  ): CodeIndexStatusRecord {
    return this.opts.store.getIndexStatus(workspaceHash) ?? {
      workspaceHash,
      absPath,
      state: 'running',
      phase: 'none',
      totalFiles: 0,
      processedFiles: 0,
      totalChunks: 0,
      processedChunks: 0,
      currentPath: null,
      startedAt,
      updatedAt: Date.now(),
      completedAt: null,
      errorMessage: null,
      cancelRequested: false,
    };
  }

  private writeIndexStatus(status: CodeIndexStatusRecord): void {
    this.opts.store.upsertIndexStatus(status);
    this.emit('index:progress', { ...status });
  }

  private async indexFile(
    workspacePath: string,
    workspaceHash: WorkspaceHash,
    absoluteFilePath: string,
  ): Promise<number> {
    const pathFromRoot = this.toRelativePath(workspacePath, absoluteFilePath);
    const stat = await fs.stat(absoluteFilePath);
    if (stat.size > MAX_INDEXED_FILE_BYTES) {
      this.removeFileFromIndex(workspaceHash, pathFromRoot);
      logger.warn('Skipping oversized file during code index', {
        workspaceHash,
        pathFromRoot,
        size: stat.size,
        maxBytes: MAX_INDEXED_FILE_BYTES,
      });
      return 0;
    }

    const sourceText = await fs.readFile(absoluteFilePath, 'utf8');
    const language = inferLanguage(absoluteFilePath);
    const chunks = this.chunker.chunk(sourceText, language, absoluteFilePath);
    const metadata = await this.metadataExtractor.extractFileMetadata(absoluteFilePath, sourceText);
    const leafTokens: string[] = [];
    const workspaceChunks: WorkspaceChunkRecord[] = [];
    const updatedAt = Date.now();

    for (const [chunkIndex, chunk] of chunks.entries()) {
      const storedChunk = this.createStoredChunk(chunk, language);
      this.opts.store.upsertChunk(storedChunk);
      leafTokens.push(`${storedChunk.astNormalizedHash}|${storedChunk.chunkType}|${storedChunk.name}`);
      workspaceChunks.push({
        workspaceHash,
        pathFromRoot,
        chunkIndex,
        contentHash: storedChunk.contentHash,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        language,
        chunkType: storedChunk.chunkType,
        name: storedChunk.name,
        updatedAt,
      });
    }

    leafTokens.sort();

    const leafHash = sha256(leafTokens.join('\n'));
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
    this.opts.store.replaceWorkspaceChunksForFile(workspaceHash, pathFromRoot, workspaceChunks);

    return chunks.length;
  }

  private removeFileFromIndex(workspaceHash: WorkspaceHash, pathFromRoot: string): void {
    this.opts.store.deleteManifestEntry(workspaceHash, pathFromRoot);
    this.opts.store.deleteWorkspaceSymbolsForFile(workspaceHash, pathFromRoot);
    this.opts.store.deleteWorkspaceChunksForFile(workspaceHash, pathFromRoot);
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
      this.opts.store.deleteWorkspaceChunksForFile(workspaceHash, relativePath);
      logger.debug('Removed missing file from manifest during incremental update', {
        workspaceHash,
        relativePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    this.refreshRootHashAfterIncrementalChange(workspaceHash);
    return relativePath;
  }

  private refreshRootHashAfterIncrementalChange(workspaceHash: WorkspaceHash): void {
    const manifestEntries = this.opts.store.countManifestEntries(workspaceHash);
    if (manifestEntries <= this.maxIncrementalMerkleRecomputeManifestEntries) {
      this.recomputeRootHash(workspaceHash);
      return;
    }

    const workspaceRoot = this.opts.store.getWorkspaceRoot(workspaceHash);
    if (!workspaceRoot) {
      return;
    }

    this.opts.store.upsertWorkspaceRoot({
      ...workspaceRoot,
      merkleRootHash: null,
      lastIndexedAt: Date.now(),
    });

    if (!this.loggedLargeIncrementalManifests.has(workspaceHash)) {
      this.loggedLargeIncrementalManifests.add(workspaceHash);
      logger.warn('Skipped full Merkle recompute for large incremental code-index update', {
        workspaceHash,
        manifestEntries,
        maxEntries: this.maxIncrementalMerkleRecomputeManifestEntries,
      });
    }
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
