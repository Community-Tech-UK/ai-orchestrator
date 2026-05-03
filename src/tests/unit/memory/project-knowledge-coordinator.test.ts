import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  CodebaseMiningResult,
  CodebaseMiningStatus,
  ProjectDiscoverySource,
} from '../../../shared/types/knowledge-graph.types';
import { ProjectKnowledgeCoordinator } from '../../../main/memory/project-knowledge-coordinator';

function status(overrides: Partial<CodebaseMiningStatus> = {}): CodebaseMiningStatus {
  return {
    normalizedPath: '/fake/project',
    rootPath: '/fake/project',
    projectKey: '/fake/project',
    displayName: 'project',
    discoverySource: 'manual-browse',
    autoMine: true,
    isPaused: false,
    isExcluded: false,
    mined: false,
    status: 'never',
    ...overrides,
  };
}

function result(overrides: Partial<CodebaseMiningResult> = {}): CodebaseMiningResult {
  return {
    normalizedPath: '/fake/project',
    rootPath: '/fake/project',
    projectKey: '/fake/project',
    displayName: 'project',
    discoverySource: 'manual-browse',
    autoMine: true,
    isPaused: false,
    isExcluded: false,
    status: 'completed',
    factsExtracted: 1,
    hintsCreated: 1,
    filesRead: 1,
    errors: [],
    ...overrides,
  };
}

function createDeps(root: CodebaseMiningStatus = status()) {
  const registry = {
    ensureRoot: vi.fn((_rootPath: string, _source: ProjectDiscoverySource) => root),
    getRoot: vi.fn(() => root),
    pauseRoot: vi.fn(() => ({ ...root, isPaused: true })),
    resumeRoot: vi.fn(() => ({ ...root, isPaused: false })),
    excludeRoot: vi.fn(() => ({ ...root, isExcluded: true })),
    canAutoMine: vi.fn(() => !root.isPaused && !root.isExcluded),
    canManualMine: vi.fn(() => !root.isExcluded),
  };
  const miner = {
    mineDirectory: vi.fn(async () => result(root)),
    getStatus: vi.fn(() => root),
  };
  const codeIndexBridge = {
    refreshProject: vi.fn(async () => ({
      projectKey: root.projectKey ?? root.normalizedPath,
      status: 'ready' as const,
      fileCount: 1,
      symbolCount: 1,
      updatedAt: 1,
      metadata: { snapshotVersion: 1 },
    })),
  };

  return { registry, miner, codeIndexBridge };
}

describe('ProjectKnowledgeCoordinator', () => {
  beforeEach(() => {
    ProjectKnowledgeCoordinator._resetForTesting();
    vi.clearAllMocks();
  });

  it('auto-refreshes known projects when auto mining is allowed', async () => {
    const deps = createDeps();
    const coordinator = new ProjectKnowledgeCoordinator(deps);

    await coordinator.ensureProjectKnown('/fake/project', 'instance-working-directory', { autoRefresh: true });

    expect(deps.registry.ensureRoot).toHaveBeenCalledWith('/fake/project', 'instance-working-directory');
    expect(deps.registry.canAutoMine).toHaveBeenCalledWith('/fake/project');
    expect(deps.miner.mineDirectory).toHaveBeenCalledWith('/fake/project');
    expect(deps.codeIndexBridge.refreshProject).toHaveBeenCalledWith('/fake/project', { automatic: true });
  });

  it('skips auto-refresh when a project is paused', async () => {
    const root = status({ isPaused: true });
    const deps = createDeps(root);
    const coordinator = new ProjectKnowledgeCoordinator(deps);

    const refresh = await coordinator.ensureProjectKnown('/fake/project', 'instance-working-directory', { autoRefresh: true });

    expect(deps.miner.mineDirectory).not.toHaveBeenCalled();
    expect(deps.codeIndexBridge.refreshProject).not.toHaveBeenCalled();
    expect(refresh).toMatchObject({
      skipped: true,
      skipReason: 'paused',
    });
  });

  it('allows manual refresh while paused', async () => {
    const root = status({ isPaused: true });
    const deps = createDeps(root);
    const coordinator = new ProjectKnowledgeCoordinator(deps);

    await coordinator.refreshProject('/fake/project', 'manual-browse');

    expect(deps.registry.canManualMine).toHaveBeenCalledWith('/fake/project');
    expect(deps.miner.mineDirectory).toHaveBeenCalledWith('/fake/project');
    expect(deps.codeIndexBridge.refreshProject).not.toHaveBeenCalled();
  });

  it('skips manual refresh when a project is excluded', async () => {
    const root = status({ isExcluded: true });
    const deps = createDeps(root);
    const coordinator = new ProjectKnowledgeCoordinator(deps);

    const refresh = await coordinator.refreshProject('/fake/project', 'manual-browse');

    expect(deps.miner.mineDirectory).not.toHaveBeenCalled();
    expect(deps.codeIndexBridge.refreshProject).not.toHaveBeenCalled();
    expect(refresh).toMatchObject({
      skipped: true,
      skipReason: 'excluded',
    });
  });

  it('deduplicates concurrent refreshes for the same normalized path', async () => {
    const deps = createDeps();
    let resolveMine!: (value: CodebaseMiningResult) => void;
    deps.miner.mineDirectory.mockReturnValue(new Promise<CodebaseMiningResult>((resolve) => {
      resolveMine = resolve;
    }));
    const coordinator = new ProjectKnowledgeCoordinator(deps);

    const first = coordinator.refreshProject('/fake/project', 'manual-browse');
    const second = coordinator.refreshProject('/fake/project/', 'manual-browse');
    resolveMine(result());

    await Promise.all([first, second]);
    expect(deps.miner.mineDirectory).toHaveBeenCalledTimes(1);
    expect(deps.codeIndexBridge.refreshProject).toHaveBeenCalledTimes(2);
  });

  it('delegates explicit code-index refresh to the bridge', async () => {
    const deps = createDeps();
    const coordinator = new ProjectKnowledgeCoordinator(deps);

    const status = await coordinator.refreshProjectCodeIndex('/fake/project');

    expect(deps.registry.ensureRoot).toHaveBeenCalledWith('/fake/project', 'manual');
    expect(deps.codeIndexBridge.refreshProject).toHaveBeenCalledWith('/fake/project', { automatic: false });
    expect(status).toMatchObject({ status: 'ready', symbolCount: 1 });
  });

  it('does not create a registry row when checking unknown project status', () => {
    const root = status({ status: 'never' });
    const deps = createDeps(root);
    deps.registry.getRoot.mockReturnValue(undefined);
    const coordinator = new ProjectKnowledgeCoordinator(deps);

    const projectStatus = coordinator.getProjectStatus('/fake/project');

    expect(projectStatus).toEqual(root);
    expect(deps.registry.ensureRoot).not.toHaveBeenCalled();
    expect(deps.miner.getStatus).toHaveBeenCalledWith('/fake/project');
  });
});
