import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Instance, InstanceCreateConfig, OutputMessage } from '../../../shared/types/instance.types';
import { RepoJobService, getRepoJobService } from '../repo-job-service';
import { BackgroundTaskManager } from '../../tasks/background-task-manager';

let messageCounter = 0;
let instanceCounter = 0;

function createAssistantMessage(content: string): OutputMessage {
  return {
    id: `msg-${++messageCounter}`,
    timestamp: Date.now(),
    type: 'assistant',
    content,
  };
}

function createMockInstance(config: InstanceCreateConfig): Instance {
  const now = Date.now();
  const sessionId = `session-${instanceCounter + 1}`;
  return {
    id: `instance-${++instanceCounter}`,
    displayName: config.displayName || `Instance ${instanceCounter}`,
    createdAt: now,
    historyThreadId: config.historyThreadId || sessionId,
    parentId: null,
    childrenIds: [],
    supervisorNodeId: '',
    workerNodeId: undefined,
    depth: 0,
    terminationPolicy: 'terminate-children',
    contextInheritance: {} as never,
    agentId: config.agentId || 'build',
    agentMode: 'build' as never,
    planMode: {
      enabled: false,
      state: 'off',
    },
    status: 'initializing',
    contextUsage: { used: 0, total: 200000, percentage: 0 },
    lastActivity: now,
    currentActivity: undefined,
    currentTool: undefined,
    processId: null,
    sessionId,
    workingDirectory: config.workingDirectory,
    yoloMode: config.yoloMode ?? false,
    provider: 'auto',
    currentModel: undefined,
    outputBuffer: [],
    outputBufferMaxSize: 1000,
    communicationTokens: new Map(),
    subscribedTo: [],
    totalTokensUsed: 0,
    requestCount: 0,
    errorCount: 0,
    restartCount: 0,
  };
}

function createTestRepo(): string {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-job-service-'));
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# test repo\n');
  execFileSync('git', ['init'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.email', 'repo-job@test.local'], { cwd: repoDir });
  execFileSync('git', ['config', 'user.name', 'Repo Job Test'], { cwd: repoDir });
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir });
  execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir });
  return repoDir;
}

type WaitForSettledTestOptions = {
  afterTimestamp?: number;
  timeoutMs?: number;
};

function buildService(options: {
  autoCompleteInstance?: boolean;
  sleep?: (ms: number) => Promise<void>;
  waitForInstanceSettled?: (
    instanceId: string,
    options: WaitForSettledTestOptions,
    instances: Map<string, Instance>,
  ) => Promise<Instance | undefined>;
} = {}) {
  const instances = new Map<string, Instance>();
  const terminateInstance = vi.fn(async () => undefined);
  const autoCompleteInstance = options.autoCompleteInstance ?? true;

  const createInstanceMock = vi.fn(async (config: InstanceCreateConfig) => {
    const instance = createMockInstance(config);
    instance.status = 'busy';
    instances.set(instance.id, instance);

    if (autoCompleteInstance) {
      setTimeout(() => {
      const current = instances.get(instance.id);
      if (!current) {
        return;
      }
      current.status = 'waiting_for_input';
      current.outputBuffer.push(createAssistantMessage('Background repo job complete'));
      }, 5);
    }

    return instance;
  });
  const waitForInstanceSettled = vi.fn(async (
    instanceId: string,
    waitOptions: WaitForSettledTestOptions,
  ) => {
    if (options.waitForInstanceSettled) {
      return options.waitForInstanceSettled(instanceId, waitOptions, instances);
    }

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const instance = instances.get(instanceId);
      if (
        instance
        && (instance.status === 'idle' || instance.status === 'waiting_for_input')
        && instance.outputBuffer.some((message) => message.type === 'assistant' || message.type === 'error')
      ) {
        return instance;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return instances.get(instanceId);
  });

  const worktreeManager = {
    createWorktree: vi.fn(async (instanceId: string, taskDescription: string, options?: Record<string, unknown>) => ({
      id: 'wt-test-1',
      instanceId,
      worktreePath: '/tmp/worktree-path',
      branchName: 'repo-job-test',
      baseBranch: String(options?.['baseBranch'] || 'main'),
      baseCommit: 'abc123',
      status: 'active' as const,
      lastActivity: Date.now(),
      commits: [],
      filesChanged: [],
      additions: 0,
      deletions: 0,
      createdAt: Date.now(),
      taskDescription,
      taskType: 'feature' as const,
    })),
    completeWorktree: vi.fn(async () => ({
      id: 'wt-test-1',
      instanceId: 'job-instance',
      worktreePath: '/tmp/worktree-path',
      branchName: 'repo-job-test',
      baseBranch: 'main',
      baseCommit: 'abc123',
      status: 'completed' as const,
      lastActivity: Date.now(),
      commits: [],
      filesChanged: ['README.md'],
      additions: 2,
      deletions: 0,
      createdAt: Date.now(),
      completedAt: Date.now(),
      taskDescription: 'Implement issue',
      taskType: 'feature' as const,
    })),
    previewMerge: vi.fn(async () => ({
      worktreeId: 'wt-test-1',
      targetBranch: 'main',
      strategy: 'auto' as const,
      canAutoMerge: true,
      conflictFiles: [],
      conflictDetails: [],
      commits: [],
      totalAdditions: 2,
      totalDeletions: 0,
      filesChanged: ['README.md'],
      previewDiff: 'diff --git a/README.md b/README.md',
    })),
  };

  const service = getRepoJobService();
  service.initialize({
    instanceManager: {
      createInstance: createInstanceMock,
      getInstance: (instanceId: string) => instances.get(instanceId),
      terminateInstance,
      waitForInstanceSettled,
    },
    worktreeManager,
    sleep: options.sleep ?? (async (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)))),
  });

  return {
    service,
    createInstanceMock,
    waitForInstanceSettled,
    worktreeManager,
    terminateInstance,
  };
}

describe('RepoJobService', () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    BackgroundTaskManager._resetForTesting();
    RepoJobService._resetForTesting();
    messageCounter = 0;
    instanceCounter = 0;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('submits and completes a PR review background job', async () => {
    const { service, createInstanceMock } = buildService();
    const repoDir = createTestRepo();
    tempDirs.push(repoDir);

    const job = service.submitJob({
      type: 'pr-review',
      workingDirectory: repoDir,
      title: 'Review README changes',
    });

    const completed = await service.waitForJob(job.id, 5000);

    expect(completed.status).toBe('completed');
    expect(completed.workflowTemplateId).toBe('pr-review');
    expect(createInstanceMock).toHaveBeenCalledTimes(1);
    expect(completed.result?.summary).toContain('Background repo job complete');
    expect(completed.repoContext.isRepo).toBe(true);
  });

  it('creates a worktree for issue implementation jobs', async () => {
    const { service, worktreeManager } = buildService();
    const repoDir = createTestRepo();
    tempDirs.push(repoDir);

    const job = service.submitJob({
      type: 'issue-implementation',
      workingDirectory: repoDir,
      title: 'Implement issue flow',
    });

    const completed = await service.waitForJob(job.id, 5000);

    expect(worktreeManager.createWorktree).toHaveBeenCalledTimes(1);
    expect(completed.status).toBe('completed');
    expect(completed.result?.worktree?.branchName).toBe('repo-job-test');
    expect(completed.result?.worktree?.filesChanged).toEqual(['README.md']);
  });

  it('includes browser evidence instructions when enabled', async () => {
    const { service, createInstanceMock } = buildService();
    const repoDir = createTestRepo();
    tempDirs.push(repoDir);

    const job = service.submitJob({
      type: 'pr-review',
      workingDirectory: repoDir,
      title: 'Review UI changes',
      browserEvidence: true,
    });

    await service.waitForJob(job.id, 5000);

    const firstCall = createInstanceMock.mock.calls[0]?.[0] as InstanceCreateConfig | undefined;
    expect(firstCall?.initialPrompt).toContain('Browser evidence: enabled.');
    expect(firstCall?.initialPrompt).toContain('Attach browser evidence summaries');
  });

  it('uses the event-based instance settled API instead of polling output buffers', async () => {
    const waitForInstanceSettled = vi.fn(async (
      instanceId: string,
      waitOptions: WaitForSettledTestOptions,
      instances: Map<string, Instance>,
    ) => {
      expect(waitOptions.afterTimestamp).toEqual(expect.any(Number));
      expect(waitOptions.timeoutMs).toBe(20 * 60 * 1000);

      const instance = instances.get(instanceId);
      expect(instance).toBeDefined();
      instance!.status = 'idle';
      instance!.outputBuffer.push(createAssistantMessage('Settled by event helper'));
      return instance;
    });

    const { service } = buildService({
      autoCompleteInstance: false,
      waitForInstanceSettled,
      sleep: async () => {
        throw new Error('legacy polling sleep should not run');
      },
    });
    const repoDir = createTestRepo();
    tempDirs.push(repoDir);

    const job = service.submitJob({
      type: 'pr-review',
      workingDirectory: repoDir,
      title: 'Review README changes',
    });

    const completed = await service.waitForJob(job.id, 5000);

    expect(completed.status).toBe('completed');
    expect(completed.result?.summary).toContain('Settled by event helper');
    expect(waitForInstanceSettled).toHaveBeenCalledTimes(1);
  });

  it('reruns a completed job as a fresh submission', async () => {
    const { service } = buildService();
    const repoDir = createTestRepo();
    tempDirs.push(repoDir);

    const original = service.submitJob({
      type: 'repo-health-audit',
      workingDirectory: repoDir,
      title: 'Audit repository',
    });
    await service.waitForJob(original.id, 5000);

    const rerun = service.rerunJob(original.id);
    const completed = await service.waitForJob(rerun.id, 5000);

    expect(rerun.id).not.toBe(original.id);
    expect(completed.status).toBe('completed');
    expect(completed.workflowTemplateId).toBe('repo-health-audit');
  }, 10000);
});
