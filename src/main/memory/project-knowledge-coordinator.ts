import { getLogger } from '../logging/logger';
import { getCodebaseMiner, type CodebaseMiner } from './codebase-miner';
import { getProjectCodeIndexBridge, type ProjectCodeIndexBridge } from './project-code-index-bridge';
import { getProjectRootRegistry, type ProjectRootRegistry } from './project-root-registry';
import { normalizeProjectMemoryKey } from './project-memory-key';
import type {
  CodebaseMiningResult,
  CodebaseMiningStatus,
  ProjectCodeIndexStatus,
  ProjectDiscoverySource,
} from '../../shared/types/knowledge-graph.types';

const logger = getLogger('ProjectKnowledgeCoordinator');

export interface EnsureProjectKnownOptions {
  autoRefresh?: boolean;
}

interface ProjectKnowledgeCoordinatorDeps {
  registry: Pick<
    ProjectRootRegistry,
    | 'ensureRoot'
    | 'getRoot'
    | 'pauseRoot'
    | 'resumeRoot'
    | 'excludeRoot'
    | 'canAutoMine'
    | 'canManualMine'
  >;
  miner: Pick<CodebaseMiner, 'mineDirectory' | 'getStatus'>;
  codeIndexBridge: Pick<ProjectCodeIndexBridge, 'refreshProject'>;
}

export class ProjectKnowledgeCoordinator {
  private static instance: ProjectKnowledgeCoordinator | null = null;
  private inflightRefreshes = new Map<string, Promise<CodebaseMiningResult>>();

  static getInstance(): ProjectKnowledgeCoordinator {
    this.instance ??= new ProjectKnowledgeCoordinator();
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  constructor(
    private readonly deps: ProjectKnowledgeCoordinatorDeps = {
      registry: getProjectRootRegistry(),
      miner: getCodebaseMiner(),
      codeIndexBridge: getProjectCodeIndexBridge(),
    },
  ) {
    logger.info('ProjectKnowledgeCoordinator initialized');
  }

  async ensureProjectKnown(
    rootPath: string,
    discoverySource: ProjectDiscoverySource,
    options: EnsureProjectKnownOptions = {},
  ): Promise<CodebaseMiningStatus | CodebaseMiningResult> {
    const root = this.deps.registry.ensureRoot(rootPath, discoverySource);
    if (!options.autoRefresh) {
      return root;
    }

    if (!this.deps.registry.canAutoMine(rootPath)) {
      return this.skippedResult(root);
    }

    this.refreshProjectCodeIndexInBackground(root, true);
    return this.refreshRegisteredProject(root);
  }

  async refreshProject(
    rootPath: string,
    discoverySource: ProjectDiscoverySource = 'manual',
  ): Promise<CodebaseMiningResult> {
    const root = this.deps.registry.ensureRoot(rootPath, discoverySource);
    if (!this.deps.registry.canManualMine(rootPath)) {
      return this.skippedResult(root);
    }

    this.refreshProjectCodeIndexInBackground(root, false);
    return this.refreshRegisteredProject(root);
  }

  refreshProjectCodeIndex(projectKey: string): Promise<ProjectCodeIndexStatus> {
    const root = this.deps.registry.ensureRoot(projectKey, 'manual');
    return this.deps.codeIndexBridge.refreshProject(root.projectKey ?? root.normalizedPath, { automatic: false });
  }

  getProjectStatus(rootPath: string): CodebaseMiningStatus {
    const root = this.deps.registry.getRoot(rootPath);
    if (root) {
      return root;
    }
    return this.deps.miner.getStatus(rootPath);
  }

  pauseProject(rootPath: string): CodebaseMiningStatus | undefined {
    return this.deps.registry.pauseRoot(rootPath);
  }

  resumeProject(rootPath: string): CodebaseMiningStatus | undefined {
    return this.deps.registry.resumeRoot(rootPath);
  }

  excludeProject(rootPath: string): CodebaseMiningStatus | undefined {
    return this.deps.registry.excludeRoot(rootPath);
  }

  private refreshRegisteredProject(root: CodebaseMiningStatus): Promise<CodebaseMiningResult> {
    if (root.isExcluded) {
      return Promise.resolve(this.skippedResult(root));
    }

    const key = normalizeProjectMemoryKey(root.normalizedPath) || root.normalizedPath;
    const existing = this.inflightRefreshes.get(key);
    if (existing) {
      return existing;
    }

    const refresh = this.deps.miner.mineDirectory(root.rootPath ?? root.normalizedPath);
    this.inflightRefreshes.set(key, refresh);
    refresh.finally(() => {
      this.inflightRefreshes.delete(key);
    }).catch(() => {
      // The caller observes the original refresh promise. This catch only
      // prevents unhandled rejection noise from the cleanup chain.
    });
    return refresh;
  }

  private refreshProjectCodeIndexInBackground(root: CodebaseMiningStatus, automatic: boolean): void {
    if (root.isExcluded || root.isPaused) {
      return;
    }

    const projectKey = root.projectKey ?? root.normalizedPath;
    this.deps.codeIndexBridge.refreshProject(projectKey, { automatic }).catch((error: unknown) => {
      logger.warn('Background project code-index refresh failed', {
        projectKey,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  private skippedResult(status: CodebaseMiningStatus): CodebaseMiningResult {
    return {
      normalizedPath: status.normalizedPath,
      rootPath: status.rootPath,
      projectKey: status.projectKey,
      displayName: status.displayName,
      discoverySource: status.discoverySource,
      autoMine: status.autoMine,
      isPaused: status.isPaused,
      isExcluded: status.isExcluded,
      status: status.status,
      factsExtracted: 0,
      hintsCreated: 0,
      filesRead: status.filesRead ?? 0,
      errors: status.errors ?? [],
      skipped: true,
      skipReason: status.isExcluded ? 'excluded' : 'paused',
      contentFingerprint: status.contentFingerprint,
      lastMinedAt: status.completedAt,
    };
  }
}

export function getProjectKnowledgeCoordinator(): ProjectKnowledgeCoordinator {
  return ProjectKnowledgeCoordinator.getInstance();
}
