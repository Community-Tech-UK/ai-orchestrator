import * as path from 'path';
import { getLogger } from '../logging/logger';
import { getRLMDatabase } from '../persistence/rlm-database';
import * as miningStore from '../persistence/rlm/rlm-codebase-mining';
import type {
  CodebaseMiningStatus,
  ProjectDiscoverySource,
} from '../../shared/types/knowledge-graph.types';
import { normalizeProjectMemoryKey } from './project-memory-key';

const logger = getLogger('ProjectRootRegistry');

export class ProjectRootRegistry {
  private static instance: ProjectRootRegistry | null = null;

  static getInstance(): ProjectRootRegistry {
    this.instance ??= new ProjectRootRegistry();
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  private constructor() {
    logger.info('ProjectRootRegistry initialized');
  }

  ensureRoot(rootPath: string, discoverySource: ProjectDiscoverySource): CodebaseMiningStatus {
    const normalizedPath = this.normalizeRootPath(rootPath);
    const now = Date.now();
    return miningStore.ensureProjectRoot(this.db, {
      normalizedPath,
      rootPath: normalizedPath,
      projectKey: normalizedPath,
      displayName: displayNameForPath(normalizedPath),
      discoverySource,
      lastActiveAt: now,
    });
  }

  getRoot(rootPath: string): CodebaseMiningStatus | undefined {
    const normalizedPath = this.normalizeRootPath(rootPath);
    return miningStore.getMiningStatus(this.db, normalizedPath);
  }

  listRoots(): CodebaseMiningStatus[] {
    return miningStore.listProjectRoots(this.db);
  }

  pauseRoot(rootPath: string): CodebaseMiningStatus | undefined {
    const root = this.ensureRoot(rootPath, 'manual');
    return miningStore.pauseProjectRoot(this.db, root.normalizedPath, Date.now());
  }

  resumeRoot(rootPath: string): CodebaseMiningStatus | undefined {
    const root = this.ensureRoot(rootPath, 'manual');
    return miningStore.resumeProjectRoot(this.db, root.normalizedPath, Date.now());
  }

  excludeRoot(rootPath: string): CodebaseMiningStatus | undefined {
    const root = this.ensureRoot(rootPath, 'manual');
    return miningStore.excludeProjectRoot(this.db, root.normalizedPath, Date.now());
  }

  canAutoMine(rootPath: string): boolean {
    const root = this.getRoot(rootPath);
    return !root?.isPaused && !root?.isExcluded && root?.autoMine !== false;
  }

  canManualMine(rootPath: string): boolean {
    return this.getRoot(rootPath)?.isExcluded !== true;
  }

  private normalizeRootPath(rootPath: string): string {
    const normalizedPath = normalizeProjectMemoryKey(rootPath);
    if (!normalizedPath) {
      throw new Error('Project path is required');
    }
    return normalizedPath;
  }

  private get db() {
    return getRLMDatabase().getRawDb();
  }
}

export function getProjectRootRegistry(): ProjectRootRegistry {
  return ProjectRootRegistry.getInstance();
}

function displayNameForPath(rootPath: string): string {
  return path.basename(rootPath) || rootPath;
}
