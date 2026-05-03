import * as fs from 'fs/promises';
import * as path from 'path';
import ignore from 'ignore';
import { getCodemem } from '../codemem';
import type {
  WorkspaceManifestRow,
  WorkspaceSymbolRecord,
} from '../codemem/types';
import type { WorkspaceRoot } from '../codemem/types';
import { getLogger } from '../logging/logger';
import { getRLMDatabase } from '../persistence/rlm-database';
import type { SqliteDriver } from '../db/sqlite-driver';
import * as projectKnowledgeStore from '../persistence/rlm/rlm-project-knowledge';
import {
  PROJECT_CODE_INDEX_SNAPSHOT_VERSION,
  PROJECT_CODE_INDEX_SYMBOL_PREVIEW_LIMIT,
  PROJECT_CODE_INDEX_TIMEOUT_MS,
  getProjectCodeIndexStatus,
  replaceProjectCodeSymbols,
  upsertProjectCodeIndexStatus,
  type ProjectCodeSymbolInput,
} from '../persistence/rlm/rlm-project-code-index';
import { getProjectRootRegistry, type ProjectRootRegistry } from './project-root-registry';
import { normalizeProjectMemoryKey } from './project-memory-key';
import type {
  CodebaseMiningStatus,
  ProjectCodeIndexStatus,
} from '../../shared/types/knowledge-graph.types';

const logger = getLogger('ProjectCodeIndexBridge');

export const PROJECT_CODE_INDEX_MAX_FILES = 5_000;
export const PROJECT_CODE_INDEX_MAX_BYTES = 250 * 1024 * 1024;
export const PROJECT_CODE_INDEX_MAX_SYMBOLS = 100_000;
export { PROJECT_CODE_INDEX_TIMEOUT_MS, PROJECT_CODE_INDEX_SYMBOL_PREVIEW_LIMIT };

const DEFAULT_IGNORES = ['.git/', '.gitignore', 'node_modules/', 'dist/', 'build/', '.next/', 'coverage/'];

export interface ProjectCodeIndexSource {
  isEnabled(): boolean;
  isIndexingEnabled(): boolean;
  ensureWorkspace(rootPath: string): Promise<{ workspaceHash: string; lastIndexedAt: number | null }>;
  listManifestEntries(workspaceHash: string): WorkspaceManifestRow[];
  listWorkspaceSymbols(workspaceHash: string): WorkspaceSymbolRecord[];
}

interface ProjectCodeIndexBridgeDeps {
  registry: Pick<ProjectRootRegistry, 'ensureRoot' | 'getRoot'>;
  source: ProjectCodeIndexSource;
  db?: SqliteDriver;
  limits?: Partial<ProjectCodeIndexLimits>;
}

interface ProjectCodeIndexLimits {
  maxFiles: number;
  maxBytes: number;
  maxSymbols: number;
  timeoutMs: number;
}

interface RefreshProjectOptions {
  automatic?: boolean;
}

interface PreflightResult {
  fileCount: number;
  totalBytes: number;
  exceeded?: 'files' | 'bytes';
}

export class CodememProjectCodeIndexSource implements ProjectCodeIndexSource {
  isEnabled(): boolean {
    return getCodemem().isEnabled();
  }

  isIndexingEnabled(): boolean {
    return getCodemem().isIndexingEnabled();
  }

  async ensureWorkspace(rootPath: string): Promise<{ workspaceHash: string; lastIndexedAt: number | null }> {
    const workspaceRoot = await getCodemem().ensureWorkspace(rootPath) as WorkspaceRoot;
    return {
      workspaceHash: workspaceRoot.workspaceHash,
      lastIndexedAt: workspaceRoot.lastIndexedAt ?? null,
    };
  }

  listManifestEntries(workspaceHash: string): WorkspaceManifestRow[] {
    return getCodemem().store.listManifestEntries(workspaceHash);
  }

  listWorkspaceSymbols(workspaceHash: string): WorkspaceSymbolRecord[] {
    return getCodemem().store.listWorkspaceSymbols(workspaceHash);
  }
}

export class ProjectCodeIndexBridge {
  private static instance: ProjectCodeIndexBridge | null = null;
  private inflight = new Map<string, Promise<ProjectCodeIndexStatus>>();

  static getInstance(): ProjectCodeIndexBridge {
    this.instance ??= new ProjectCodeIndexBridge();
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  constructor(
    private readonly deps: ProjectCodeIndexBridgeDeps = {
      registry: getProjectRootRegistry(),
      source: new CodememProjectCodeIndexSource(),
    },
  ) {
    logger.info('ProjectCodeIndexBridge initialized');
  }

  refreshProject(projectKeyOrPath: string, options: RefreshProjectOptions = {}): Promise<ProjectCodeIndexStatus> {
    const projectKey = this.normalizeProjectKey(projectKeyOrPath);
    const existing = this.inflight.get(projectKey);
    if (existing) {
      return existing;
    }

    const refresh = this.refreshProjectInternal(projectKey, options);
    this.inflight.set(projectKey, refresh);
    refresh.finally(() => {
      this.inflight.delete(projectKey);
    }).catch(() => {
      // The caller observes the original refresh promise. This catch only
      // prevents unhandled rejection noise from the cleanup chain.
    });
    return refresh;
  }

  getStatus(projectKey: string): ProjectCodeIndexStatus {
    return getProjectCodeIndexStatus(this.db, this.normalizeProjectKey(projectKey));
  }

  private async refreshProjectInternal(
    projectKey: string,
    options: RefreshProjectOptions,
  ): Promise<ProjectCodeIndexStatus> {
    const root = this.deps.registry.getRoot(projectKey) ?? this.deps.registry.ensureRoot(projectKey, 'manual');
    const rootPath = root.rootPath ?? root.normalizedPath;

    if (root.isExcluded) {
      return this.writeTerminalStatus(root, 'excluded', undefined, { reason: 'project_excluded' });
    }
    if (root.isPaused) {
      return this.writeTerminalStatus(root, 'paused', undefined, { reason: 'project_paused' });
    }
    if (!this.deps.source.isEnabled() || !this.deps.source.isIndexingEnabled()) {
      return this.writeTerminalStatus(root, 'disabled', undefined, { reason: 'codemem_disabled' });
    }

    let preflight: PreflightResult;
    try {
      preflight = await this.preflight(rootPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return this.writeTerminalStatus(root, 'failed', message, { reason: 'preflight_failed' });
    }
    if (preflight.exceeded) {
      return this.writeTerminalStatus(
        root,
        'failed',
        `Code index ${preflight.exceeded === 'files' ? 'file count' : 'byte size'} limit exceeded.`,
        {
          reason: 'limit_exceeded',
          limit: preflight.exceeded,
          observedFiles: preflight.fileCount,
          observedBytes: preflight.totalBytes,
          automatic: options.automatic === true,
        },
      );
    }

    const syncStartedAt = Date.now();
    upsertProjectCodeIndexStatus(this.db, {
      projectKey,
      status: 'indexing',
      syncStartedAt,
      updatedAt: syncStartedAt,
      error: null,
      metadata: {
        reason: 'refresh_started',
        automatic: options.automatic === true,
        preflightFiles: preflight.fileCount,
        preflightBytes: preflight.totalBytes,
      },
    });

    try {
      const workspace = await withTimeout(
        this.deps.source.ensureWorkspace(rootPath),
        this.limits.timeoutMs,
      );
      const manifestEntries = this.deps.source.listManifestEntries(workspace.workspaceHash);
      const workspaceSymbols = this.deps.source.listWorkspaceSymbols(workspace.workspaceHash);

      if (workspaceSymbols.length > this.limits.maxSymbols) {
        return this.writeTerminalStatus(
          root,
          'failed',
          'Code index symbol count limit exceeded.',
          {
            reason: 'limit_exceeded',
            limit: 'symbols',
            workspaceHash: workspace.workspaceHash,
            observedSymbols: workspaceSymbols.length,
          },
        );
      }

      return this.syncSnapshot(root, workspace, manifestEntries, workspaceSymbols);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const reason = message === 'Project code index timed out' ? 'timeout' : 'sync_failed';
      logger.warn('Project code-index refresh failed', { projectKey, rootPath, error: message });
      return this.writeTerminalStatus(root, 'failed', message, { reason });
    }
  }

  private syncSnapshot(
    root: CodebaseMiningStatus,
    workspace: { workspaceHash: string; lastIndexedAt: number | null },
    manifestEntries: WorkspaceManifestRow[],
    workspaceSymbols: WorkspaceSymbolRecord[],
  ): ProjectCodeIndexStatus {
    const projectKey = root.projectKey ?? root.normalizedPath;
    const rootPath = root.rootPath ?? root.normalizedPath;
    const manifestByPath = new Map(manifestEntries.map((entry) => [entry.pathFromRoot, entry]));
    const sourceIdsByPath = new Map<string, string>();
    const now = Date.now();

    // Manifest and symbols are read as the current codemem snapshot for one
    // workspace hash. Wave 3A repairs drift by replaying the full snapshot on
    // the next refresh instead of trying to coordinate two SQLite databases.
    const writeSnapshot = this.db.transaction(() => {
      for (const entry of manifestEntries) {
        const sourceUri = path.resolve(rootPath, entry.pathFromRoot);
        const upsert = projectKnowledgeStore.upsertProjectKnowledgeSource(this.db, {
          projectKey,
          sourceKind: 'code_file',
          sourceUri,
          sourceTitle: entry.pathFromRoot,
          contentFingerprint: entry.contentHash,
          metadata: {
            relativePath: entry.pathFromRoot,
            workspaceHash: workspace.workspaceHash,
            merkleLeafHash: entry.merkleLeafHash,
            mtime: entry.mtime,
            snapshotVersion: PROJECT_CODE_INDEX_SNAPSHOT_VERSION,
          },
        });
        sourceIdsByPath.set(entry.pathFromRoot, upsert.source.id);
      }

      projectKnowledgeStore.deleteProjectKnowledgeSourcesByKindNotSeen(
        this.db,
        projectKey,
        'code_file',
        manifestEntries.map((entry) => path.resolve(rootPath, entry.pathFromRoot)),
      );

      const symbolInputs: ProjectCodeSymbolInput[] = workspaceSymbols.flatMap((symbol) => {
        if (!manifestByPath.has(symbol.pathFromRoot)) {
          return [];
        }
        const sourceId = sourceIdsByPath.get(symbol.pathFromRoot);
        if (!sourceId) {
          return [];
        }
        return [{
          projectKey,
          sourceId,
          workspaceHash: workspace.workspaceHash,
          symbolId: symbol.symbolId,
          pathFromRoot: symbol.pathFromRoot,
          name: symbol.name,
          kind: symbol.kind,
          containerName: symbol.containerName,
          startLine: symbol.startLine,
          startCharacter: symbol.startCharacter,
          endLine: symbol.endLine,
          endCharacter: symbol.endCharacter,
          signature: symbol.signature,
          docComment: symbol.docComment,
          createdAt: now,
          updatedAt: now,
          metadata: {
            snapshotVersion: PROJECT_CODE_INDEX_SNAPSHOT_VERSION,
          },
        }];
      });

      replaceProjectCodeSymbols(this.db, projectKey, symbolInputs);

      return upsertProjectCodeIndexStatus(this.db, {
        projectKey,
        workspaceHash: workspace.workspaceHash,
        status: 'ready',
        fileCount: manifestEntries.length,
        symbolCount: symbolInputs.length,
        syncStartedAt: null,
        lastIndexedAt: workspace.lastIndexedAt,
        lastSyncedAt: now,
        updatedAt: now,
        error: null,
        metadata: {
          snapshotVersion: PROJECT_CODE_INDEX_SNAPSHOT_VERSION,
          skippedSymbols: workspaceSymbols.length - symbolInputs.length,
        },
      });
    });

    return writeSnapshot();
  }

  private writeTerminalStatus(
    root: CodebaseMiningStatus,
    status: ProjectCodeIndexStatus['status'],
    error: string | undefined,
    metadata: Record<string, unknown>,
  ): ProjectCodeIndexStatus {
    return upsertProjectCodeIndexStatus(this.db, {
      projectKey: root.projectKey ?? root.normalizedPath,
      status,
      updatedAt: Date.now(),
      error: error ?? null,
      syncStartedAt: null,
      metadata,
    });
  }

  private async preflight(rootPath: string): Promise<PreflightResult> {
    const ig = ignore().add(DEFAULT_IGNORES);
    try {
      const gitignore = await fs.readFile(path.join(rootPath, '.gitignore'), 'utf8');
      ig.add(gitignore);
    } catch {
      // Missing .gitignore is expected.
    }

    const result: PreflightResult = { fileCount: 0, totalBytes: 0 };
    const stack = [rootPath];

    while (stack.length > 0) {
      const dirPath = stack.pop()!;
      const entries = await fs.readdir(dirPath, { withFileTypes: true });

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

        const stat = await fs.stat(absolutePath);
        result.fileCount++;
        result.totalBytes += stat.size;

        if (result.fileCount > this.limits.maxFiles) {
          result.exceeded = 'files';
          return result;
        }
        if (result.totalBytes > this.limits.maxBytes) {
          result.exceeded = 'bytes';
          return result;
        }
      }
    }

    return result;
  }

  private normalizeProjectKey(projectKeyOrPath: string): string {
    const normalized = normalizeProjectMemoryKey(projectKeyOrPath);
    if (!normalized) {
      throw new Error('Project path is required');
    }
    return normalized;
  }

  private get db(): SqliteDriver {
    return this.deps.db ?? getRLMDatabase().getRawDb();
  }

  private get limits(): ProjectCodeIndexLimits {
    return {
      maxFiles: this.deps.limits?.maxFiles ?? PROJECT_CODE_INDEX_MAX_FILES,
      maxBytes: this.deps.limits?.maxBytes ?? PROJECT_CODE_INDEX_MAX_BYTES,
      maxSymbols: this.deps.limits?.maxSymbols ?? PROJECT_CODE_INDEX_MAX_SYMBOLS,
      timeoutMs: this.deps.limits?.timeoutMs ?? PROJECT_CODE_INDEX_TIMEOUT_MS,
    };
  }
}

export function getProjectCodeIndexBridge(): ProjectCodeIndexBridge {
  return ProjectCodeIndexBridge.getInstance();
}

function toRelativePath(rootPath: string, absolutePath: string): string {
  return path.relative(rootPath, absolutePath).split(path.sep).join('/');
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let settled = false;
  let timer: NodeJS.Timeout;

  return new Promise<T>((resolve, reject) => {
    timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      promise.catch(() => {});
      reject(new Error('Project code index timed out'));
    }, timeoutMs);

    promise.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
