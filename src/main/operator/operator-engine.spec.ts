import { describe, expect, it } from 'vitest';
import type {
  OperatorProjectRecord,
  OperatorRunGraph,
  OperatorRunStatus,
  OperatorVerificationSummary,
} from '../../shared/types/operator.types';
import type { Instance } from '../../shared/types/instance.types';
import type { RepoJobRecord, RepoJobSubmission } from '../../shared/types/repo-job.types';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import { createOperatorTables } from './operator-schema';
import { OperatorRunStore } from './operator-run-store';
import { OperatorEngine, type OperatorEngineConfig } from './operator-engine';

describe('OperatorEngine', () => {
  it('creates and completes a git-batch run for pull-all-repos requests', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const gitBatch = new FakeGitBatchService();
    const engine = new OperatorEngine({
      runStore,
      gitBatch,
      resolveWorkRoot: () => '/work',
    });

    const graph = await engine.handleUserMessage({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      text: 'Please pull all the repos in my work folder',
    });

    expect(graph?.run).toMatchObject({
      status: 'completed',
      goal: 'Please pull all the repos in my work folder',
      planJson: {
        intent: 'workspace_git_batch',
        executor: 'git-batch',
        rootPath: '/work',
      },
      resultJson: {
        total: 1,
        pulled: 1,
        skipped: 0,
        failed: 0,
      },
    });
    expect(graph?.nodes).toEqual([
      expect.objectContaining({
        type: 'git-batch',
        status: 'completed',
        targetPath: '/work',
      }),
    ]);
    expect(graph?.events.map((event) => event.kind)).toEqual([
      'state-change',
      'progress',
      'progress',
      'state-change',
    ]);
    expect(gitBatch.roots).toEqual(['/work']);
    db.close();
  });

  it('does not create a run for unsupported conversational messages', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const engine = new OperatorEngine({
      runStore,
      gitBatch: new FakeGitBatchService(),
      resolveWorkRoot: () => '/work',
    });

    await expect(engine.handleUserMessage({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      text: 'hello',
    })).resolves.toBeNull();
    expect(runStore.listRuns()).toEqual([]);
    db.close();
  });

  it('blocks before starting git work when the run would exceed maxNodes', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const gitBatch = new FakeGitBatchService();
    const engine = new OperatorEngine({
      runStore,
      gitBatch,
      resolveWorkRoot: () => '/work',
      defaultBudget: { maxNodes: 0 },
    });

    const graph = await engine.handleUserMessage({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      text: 'Please pull all the repos in my work folder',
    });

    expect(gitBatch.roots).toEqual([]);
    expect(graph?.run).toMatchObject({
      status: 'blocked',
      error: 'Budget exhausted: maxNodes would be exceeded',
      usageJson: {
        nodesStarted: 0,
      },
    });
    expect(graph?.nodes).toEqual([]);
    expect(graph?.events).toEqual([
      expect.objectContaining({
        kind: 'budget',
        payload: expect.objectContaining({
          limit: 'maxNodes',
          actual: 1,
          allowed: 0,
        }),
      }),
      expect.objectContaining({
        kind: 'state-change',
        payload: { status: 'blocked' },
      }),
    ]);
    db.close();
  });

  it('blocks completed git work when the run exceeds its wall-clock budget', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const gitBatch = new FakeGitBatchService();
    const engine = new OperatorEngine({
      runStore,
      gitBatch,
      resolveWorkRoot: () => '/work',
      now: (() => {
        const times = [1_000, 1_500];
        return () => times.shift() ?? 1_500;
      })(),
      defaultBudget: { maxWallClockMs: 100 },
    });

    const graph = await engine.handleUserMessage({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      text: 'Please pull all the repos in my work folder',
    });

    expect(gitBatch.roots).toEqual(['/work']);
    expect(graph?.run).toMatchObject({
      status: 'blocked',
      error: 'Budget exhausted: maxWallClockMs exceeded',
      usageJson: {
        nodesStarted: 1,
        nodesCompleted: 1,
        wallClockMs: 500,
      },
    });
    expect(graph?.nodes[0]).toMatchObject({
      status: 'blocked',
      error: 'Budget exhausted: maxWallClockMs exceeded',
    });
    expect(graph?.events).toContainEqual(expect.objectContaining({
      kind: 'budget',
      payload: expect.objectContaining({
        limit: 'maxWallClockMs',
        actual: 500,
        allowed: 100,
      }),
    }));
    db.close();
  });

  it('persists shell-command audit events emitted by git-batch execution', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const engine = new OperatorEngine({
      runStore,
      gitBatch: new AuditedFakeGitBatchService(),
      resolveWorkRoot: () => '/work',
    });

    const graph = await engine.handleUserMessage({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      text: 'Please pull all the repos in my work folder',
    });

    expect(graph?.events).toContainEqual(expect.objectContaining({
      kind: 'shell-command',
      nodeId: graph?.nodes[0]?.id,
      payload: {
        cmd: 'git',
        args: ['fetch', '--prune'],
        cwd: '/work/app',
        exitCode: 0,
        durationMs: 12,
        stdoutBytes: 0,
        stderrBytes: 0,
      },
    }));
    db.close();
  });

  it('routes in-project implementation requests to a project-agent executor', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const project = projectRecord();
    const projectAgent = new FakeProjectAgentExecutor();
    const verificationExecutor = new FakeVerificationExecutor([passedVerification()], runStore);
    const engine = new OperatorEngine({
      runStore,
      gitBatch: new FakeGitBatchService(),
      resolveWorkRoot: () => '/work',
      projectRegistry: {
        resolveProject: () => ({
          status: 'resolved',
          query: 'AI Orchestrator',
          project,
          candidates: [project],
        }),
      },
      projectAgent,
      verificationExecutor,
    });

    const graph = await engine.handleUserMessage({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      text: 'In AI Orchestrator, I want to allow voice conversations, please implement it',
    });

    expect(projectAgent.calls).toEqual([
      expect.objectContaining({
        goal: 'I want to allow voice conversations, please implement it',
        project,
        promptOverride: undefined,
      }),
    ]);
    expect(verificationExecutor.calls).toHaveLength(1);
    expect(graph?.run).toMatchObject({
      status: 'completed',
      planJson: {
        intent: 'project_feature',
        executor: 'project-agent',
        projectId: 'project-1',
        projectPath: '/work/ai-orchestrator',
      },
      resultJson: {
        projectAgent: expect.objectContaining({
          instanceId: 'instance-1',
          finalStatus: 'idle',
        }),
        verification: expect.objectContaining({
          status: 'passed',
          requiredFailed: 0,
        }),
      },
    });
    expect(graph?.nodes).toEqual([
      expect.objectContaining({
        type: 'project-agent',
        status: 'completed',
        targetProjectId: 'project-1',
        targetPath: '/work/ai-orchestrator',
        externalRefKind: 'instance',
        externalRefId: 'instance-1',
      }),
      expect.objectContaining({
        type: 'verification',
        status: 'completed',
        targetProjectId: 'project-1',
        targetPath: '/work/ai-orchestrator',
        parentNodeId: graph?.nodes[0]?.id,
        outputJson: expect.objectContaining({
          status: 'passed',
        }),
      }),
    ]);
    expect(graph?.events.map((event) => event.kind)).toContain('verification-result');
    db.close();
  });

  it('completes project runs when verification is skipped because no checks are available', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const project = projectRecord();
    const engine = new OperatorEngine({
      runStore,
      gitBatch: new FakeGitBatchService(),
      projectRegistry: resolvedRegistry(project),
      projectAgent: new FakeProjectAgentExecutor(),
      verificationExecutor: new FakeVerificationExecutor([skippedVerification()], runStore),
    });

    const graph = await engine.handleUserMessage({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      text: 'In AI Orchestrator, add a settings panel',
    });

    expect(graph?.run).toMatchObject({
      status: 'completed',
      resultJson: {
        verification: expect.objectContaining({
          status: 'skipped',
          fallbackReason: 'No recognized project manifest found',
        }),
      },
    });
    expect(graph?.nodes.at(-1)).toMatchObject({
      type: 'verification',
      status: 'completed',
    });
    db.close();
  });

  it('blocks project runs when required verification fails and retry budget is zero', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const project = projectRecord();
    const engine = new OperatorEngine({
      runStore,
      gitBatch: new FakeGitBatchService(),
      projectRegistry: resolvedRegistry(project),
      projectAgent: new FakeProjectAgentExecutor(),
      verificationExecutor: new FakeVerificationExecutor([failedVerification()], runStore),
      defaultBudget: { maxRetries: 0 },
    });

    const graph = await engine.handleUserMessage({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      text: 'In AI Orchestrator, add retry support',
    });

    expect(graph?.run).toMatchObject({
      status: 'blocked',
      error: 'Budget exhausted: maxRetries would be exceeded',
      usageJson: expect.objectContaining({
        retriesUsed: 0,
      }),
    });
    expect(graph?.nodes).toHaveLength(2);
    expect(graph?.nodes[1]).toMatchObject({
      type: 'verification',
      status: 'blocked',
      error: 'Budget exhausted: maxRetries would be exceeded',
    });
    db.close();
  });

  it('runs a fix worker and completes when follow-up verification passes', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const project = projectRecord();
    const projectAgent = new FakeProjectAgentExecutor([
      projectAgentResult('instance-1', 'First worker output.'),
      projectAgentResult('instance-2', 'Repair worker output.'),
    ]);
    const verificationExecutor = new FakeVerificationExecutor([
      failedVerification(),
      passedVerification(),
    ], runStore);
    const engine = new OperatorEngine({
      runStore,
      gitBatch: new FakeGitBatchService(),
      projectRegistry: resolvedRegistry(project),
      projectAgent,
      verificationExecutor,
      defaultBudget: { maxRetries: 1 },
    });

    const graph = await engine.handleUserMessage({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      text: 'In AI Orchestrator, add retry support',
    });

    expect(graph?.run).toMatchObject({
      status: 'completed',
      usageJson: expect.objectContaining({
        nodesStarted: 4,
        nodesCompleted: 4,
        retriesUsed: 1,
      }),
    });
    expect(graph?.nodes.map((node) => node.type)).toEqual([
      'project-agent',
      'verification',
      'project-agent',
      'verification',
    ]);
    expect(graph?.nodes[1]).toMatchObject({ status: 'failed' });
    expect(graph?.nodes[2]).toMatchObject({
      status: 'completed',
      parentNodeId: graph?.nodes[1]?.id,
      inputJson: expect.objectContaining({
        attempt: 1,
        repairForVerificationNodeId: graph?.nodes[1]?.id,
      }),
    });
    expect(graph?.nodes[3]).toMatchObject({
      status: 'completed',
      parentNodeId: graph?.nodes[2]?.id,
    });
    expect(projectAgent.calls).toHaveLength(2);
    expect(projectAgent.calls[1]?.promptOverride).toContain('Required verification failures:');
    expect(projectAgent.calls[1]?.promptOverride).toContain('npx tsc --noEmit');
    expect(projectAgent.calls[1]?.promptOverride).toContain('First worker output.');
    expect(verificationExecutor.calls).toHaveLength(2);
    db.close();
  });

  it('blocks when verification still fails after retry budget is exhausted', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const project = projectRecord();
    const engine = new OperatorEngine({
      runStore,
      gitBatch: new FakeGitBatchService(),
      projectRegistry: resolvedRegistry(project),
      projectAgent: new FakeProjectAgentExecutor([
        projectAgentResult('instance-1', 'First output.'),
        projectAgentResult('instance-2', 'Repair output.'),
      ]),
      verificationExecutor: new FakeVerificationExecutor([
        failedVerification(),
        failedVerification(),
      ], runStore),
      defaultBudget: { maxRetries: 1 },
    });

    const graph = await engine.handleUserMessage({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      text: 'In AI Orchestrator, add retry support',
    });

    expect(graph?.run).toMatchObject({
      status: 'blocked',
      error: 'Budget exhausted: maxRetries would be exceeded',
      usageJson: expect.objectContaining({ retriesUsed: 1 }),
    });
    expect(graph?.nodes.find((node) =>
      node.type === 'verification' && node.status === 'blocked'
    )).toMatchObject({
      type: 'verification',
      status: 'blocked',
    });
    db.close();
  });

  it('blocks and does not start a fix worker when maxNodes would be exceeded', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const project = projectRecord();
    const projectAgent = new FakeProjectAgentExecutor();
    const engine = new OperatorEngine({
      runStore,
      gitBatch: new FakeGitBatchService(),
      projectRegistry: resolvedRegistry(project),
      projectAgent,
      verificationExecutor: new FakeVerificationExecutor([failedVerification()], runStore),
      defaultBudget: { maxRetries: 1, maxNodes: 2 },
    });

    const graph = await engine.handleUserMessage({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      text: 'In AI Orchestrator, add retry support',
    });

    expect(projectAgent.calls).toHaveLength(1);
    expect(graph?.run).toMatchObject({
      status: 'blocked',
      error: 'Budget exhausted: maxNodes would be exceeded',
      usageJson: expect.objectContaining({
        nodesStarted: 2,
        nodesCompleted: 2,
        retriesUsed: 0,
      }),
    });
    expect(graph?.events).toContainEqual(expect.objectContaining({
      kind: 'budget',
      payload: expect.objectContaining({ limit: 'maxNodes' }),
    }));
    db.close();
  });

  it('blocks and does not start a fix worker when wall-clock budget is already exceeded', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const project = projectRecord();
    const projectAgent = new FakeProjectAgentExecutor();
    const engine = new OperatorEngine({
      runStore,
      gitBatch: new FakeGitBatchService(),
      projectRegistry: resolvedRegistry(project),
      projectAgent,
      verificationExecutor: new FakeVerificationExecutor([failedVerification()], runStore),
      now: (() => {
        const times = [1_000, 1_010, 1_020, 1_030, 1_040, 1_050, 1_200];
        return () => times.shift() ?? 1_200;
      })(),
      defaultBudget: { maxRetries: 1, maxWallClockMs: 150 },
    });

    const graph = await engine.handleUserMessage({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      text: 'In AI Orchestrator, add retry support',
    });

    expect(projectAgent.calls).toHaveLength(1);
    expect(graph?.run).toMatchObject({
      status: 'blocked',
      error: 'Budget exhausted: maxWallClockMs exceeded',
    });
    expect(graph?.events).toContainEqual(expect.objectContaining({
      kind: 'budget',
      payload: expect.objectContaining({ limit: 'maxWallClockMs' }),
    }));
    db.close();
  });

  it('fails the run without follow-up verification when the fix worker fails', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const project = projectRecord();
    const projectAgent = new FakeProjectAgentExecutor([
      projectAgentResult('instance-1', 'First output.'),
      projectAgentResult('instance-2', 'Repair failed.', 'failed', 'Project agent ended with status error'),
    ]);
    const verificationExecutor = new FakeVerificationExecutor([failedVerification()], runStore);
    const engine = new OperatorEngine({
      runStore,
      gitBatch: new FakeGitBatchService(),
      projectRegistry: resolvedRegistry(project),
      projectAgent,
      verificationExecutor,
      defaultBudget: { maxRetries: 1 },
    });

    const graph = await engine.handleUserMessage({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      text: 'In AI Orchestrator, add retry support',
    });

    expect(graph?.run).toMatchObject({
      status: 'failed',
      error: 'Project agent ended with status error',
    });
    expect(projectAgent.calls).toHaveLength(2);
    expect(verificationExecutor.calls).toHaveLength(1);
    expect(graph?.nodes.filter((node) => node.type === 'project-agent')).toHaveLength(2);
    expect(graph?.nodes.filter((node) => node.type === 'verification')).toHaveLength(1);
    db.close();
  });

  it('routes project audit requests with "in the project" wording to a repo-health audit job', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const project = projectRecord({
      id: 'project-dingley',
      canonicalPath: '/work/dingley',
      displayName: 'Dingley',
      aliases: ['dingley'],
    });
    const projectAgent = new FakeProjectAgentExecutor();
    const repoJob = new FakeRepoJobExecutor();
    const config = {
      runStore,
      gitBatch: new FakeGitBatchService(),
      projectRegistry: {
        resolveProject: (query: string) => ({
          status: 'resolved' as const,
          query,
          project,
          candidates: [project],
        }),
      },
      projectAgent,
      verificationExecutor: new FakeVerificationExecutor([passedVerification()], runStore),
      repoJob,
    } satisfies OperatorEngineConfig & { repoJob: FakeRepoJobExecutor };
    const engine = new OperatorEngine({
      ...config,
    });

    const graph = await engine.handleUserMessage({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      text: 'Please go through all the code in the dingley project and create a list of things we can improve',
    });

    expect(projectAgent.calls).toEqual([]);
    expect(repoJob.submissions).toEqual([
      expect.objectContaining({
        type: 'repo-health-audit',
        workingDirectory: '/work/dingley',
        useWorktree: false,
      }),
    ]);
    expect(graph?.run.planJson).toMatchObject({
      intent: 'project_audit',
      executor: 'repo-job',
      projectId: 'project-dingley',
      projectPath: '/work/dingley',
    });
    expect(graph?.nodes[0]).toMatchObject({
      type: 'repo-job',
      status: 'completed',
      targetProjectId: 'project-dingley',
      targetPath: '/work/dingley',
      externalRefKind: 'repo-job',
      externalRefId: 'repo-job-1',
    });
    expect(graph?.run.resultJson).toMatchObject({
      repoJob: expect.objectContaining({
        status: 'completed',
        result: expect.objectContaining({
          summary: 'Audit finished',
        }),
      }),
    });
    db.close();
  });

  it('cancels an active run and marks active external workers cancelled', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const instanceManager = new FakeRecoveryInstanceManager();
    const engine = new OperatorEngine({
      runStore,
      gitBatch: new FakeGitBatchService(),
      instanceManager,
    });
    const run = runStore.createRun({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      title: 'Active run',
      goal: 'In AI Orchestrator, add cancel support',
      planJson: { intent: 'project_feature' },
    });
    const node = runStore.createNode({
      runId: run.id,
      type: 'project-agent',
      title: 'Active worker',
      externalRefKind: 'instance',
      externalRefId: 'instance-1',
    });
    runStore.updateRun(run.id, { status: 'running', usageJson: { nodesStarted: 1 } });
    runStore.updateNode(node.id, { status: 'running' });

    const graph = await (engine as OperatorEngine & {
      cancelRun(runId: string): Promise<OperatorRunGraph>;
    }).cancelRun(run.id);

    expect(instanceManager.terminated).toEqual(['instance-1']);
    expect(graph.run).toMatchObject({
      status: 'cancelled',
      error: 'Cancelled by user',
    });
    expect(graph.nodes[0]).toMatchObject({
      status: 'cancelled',
      error: 'Cancelled by user',
    });
    expect(graph.events).toContainEqual(expect.objectContaining({
      kind: 'state-change',
      payload: expect.objectContaining({
        status: 'cancelled',
      }),
    }));
    db.close();
  });

  it('retries a terminal run by creating a new run linked to the previous run', async () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const engine = new OperatorEngine({
      runStore,
      gitBatch: new FakeGitBatchService(),
      resolveWorkRoot: () => '/work',
    });
    const failedRun = runStore.createRun({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      title: 'Pull repositories',
      goal: 'Please pull all the repos in my work folder',
      planJson: { intent: 'workspace_git_batch' },
    });
    runStore.updateRun(failedRun.id, {
      status: 'blocked',
      completedAt: 10,
      error: 'Previous failure',
    });

    const graph = await (engine as OperatorEngine & {
      retryRun(runId: string): Promise<OperatorRunGraph>;
    }).retryRun(failedRun.id);

    expect(graph.run.id).not.toBe(failedRun.id);
    expect(graph.run).toMatchObject({
      status: 'completed',
      threadId: 'thread-1',
      goal: 'Please pull all the repos in my work folder',
      planJson: expect.objectContaining({
        intent: 'workspace_git_batch',
        retryOfRunId: failedRun.id,
      }),
    });
    expect(runStore.getRun(failedRun.id)?.planJson).toMatchObject({
      retriedByRunId: graph.run.id,
    });
    expect(graph.events).toContainEqual(expect.objectContaining({
      kind: 'recovery',
      payload: expect.objectContaining({
        action: 'retry-created',
        retryOfRunId: failedRun.id,
      }),
    }));
    db.close();
  });

  it('blocks stale active runs during startup recovery when linked instances are gone', () => {
    const db = defaultDriverFactory(':memory:');
    createOperatorTables(db);
    const runStore = new OperatorRunStore(db);
    const instanceManager = new FakeRecoveryInstanceManager();
    const engine = new OperatorEngine({
      runStore,
      gitBatch: new FakeGitBatchService(),
      instanceManager,
    });
    const run = runStore.createRun({
      threadId: 'thread-1',
      sourceMessageId: 'message-1',
      title: 'Recovered run',
      goal: 'In AI Orchestrator, add recovery',
      planJson: { intent: 'project_feature' },
    });
    const node = runStore.createNode({
      runId: run.id,
      type: 'project-agent',
      title: 'Lost worker',
      externalRefKind: 'instance',
      externalRefId: 'missing-instance',
    });
    runStore.updateRun(run.id, { status: 'running', usageJson: { nodesStarted: 1 } });
    runStore.updateNode(node.id, { status: 'running' });
    runStore.upsertInstanceLink({
      instanceId: 'missing-instance',
      runId: run.id,
      nodeId: node.id,
    });

    const recovered = (engine as OperatorEngine & {
      recoverActiveRuns(): OperatorRunGraph[];
    }).recoverActiveRuns();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.run).toMatchObject({
      status: 'blocked',
      error: 'Operator run recovery blocked: linked instance missing-instance is no longer active',
    });
    expect(recovered[0]?.nodes[0]).toMatchObject({
      status: 'blocked',
      error: 'Operator run recovery blocked: linked instance missing-instance is no longer active',
    });
    expect(runStore.getInstanceLink('missing-instance')?.recoveryState).toBe('stale');
    expect(recovered[0]?.events).toContainEqual(expect.objectContaining({
      kind: 'recovery',
      payload: expect.objectContaining({
        reason: 'stale-instance-link',
        instanceId: 'missing-instance',
      }),
    }));
    db.close();
  });
});

class FakeGitBatchService {
  roots: string[] = [];

  async pullAll(rootPath: string) {
    this.roots.push(rootPath);
    return {
      rootPath,
      total: 1,
      pulled: 1,
      upToDate: 0,
      skipped: 0,
      failed: 0,
      results: [
        {
          repositoryPath: `${rootPath}/app`,
          status: 'pulled' as const,
          reason: null,
          branch: 'main',
          upstream: 'origin/main',
          ahead: 0,
          behind: 0,
          dirty: false,
          durationMs: 10,
          error: null,
        },
      ],
    };
  }
}

class AuditedFakeGitBatchService extends FakeGitBatchService {
  override async pullAll(
    rootPath: string,
    options?: { onShellCommand?: (payload: Record<string, unknown>) => void },
  ) {
    options?.onShellCommand?.({
      cmd: 'git',
      args: ['fetch', '--prune'],
      cwd: `${rootPath}/app`,
      exitCode: 0,
      durationMs: 12,
      stdoutBytes: 0,
      stderrBytes: 0,
    });
    return super.pullAll(rootPath);
  }
}

class FakeProjectAgentExecutor {
  calls: Array<{
    goal: string;
    project: OperatorProjectRecord;
    promptOverride?: string;
  }> = [];

  constructor(private readonly results: ProjectAgentResult[] = [projectAgentResult()]) {}

  async execute(input: { goal: string; project: OperatorProjectRecord; promptOverride?: string }) {
    this.calls.push({
      goal: input.goal,
      project: input.project,
      promptOverride: input.promptOverride,
    });
    return this.results.shift() ?? projectAgentResult();
  }
}

class FakeRepoJobExecutor {
  submissions: RepoJobSubmission[] = [];
  cancelled: string[] = [];
  private readonly jobs = new Map<string, RepoJobRecord>();

  submitJob(submission: RepoJobSubmission): RepoJobRecord {
    this.submissions.push(submission);
    const job = repoJobRecord({
      id: `repo-job-${this.submissions.length}`,
      status: 'running',
      workingDirectory: submission.workingDirectory,
      title: submission.title,
      description: submission.description,
      submission,
    });
    this.jobs.set(job.id, job);
    return job;
  }

  async waitForJob(jobId: string): Promise<RepoJobRecord> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Missing fake repo job: ${jobId}`);
    }
    const completed = {
      ...job,
      status: 'completed' as const,
      progress: 100,
      completedAt: 2,
      result: {
        instanceId: 'repo-job-instance-1',
        summary: 'Audit finished',
        repoContext: job.repoContext,
      },
    };
    this.jobs.set(jobId, completed);
    return completed;
  }

  cancelJob(jobId: string): boolean {
    this.cancelled.push(jobId);
    return true;
  }
}

class FakeRecoveryInstanceManager {
  terminated: string[] = [];
  private readonly instances = new Map<string, Instance>();

  constructor(instances: Instance[] = []) {
    for (const instance of instances) {
      this.instances.set(instance.id, instance);
    }
  }

  getInstance(instanceId: string): Instance | undefined {
    return this.instances.get(instanceId);
  }

  async createInstance(): Promise<Instance> {
    throw new Error('createInstance is not used by this test');
  }

  async waitForInstanceSettled(): Promise<Instance | undefined> {
    throw new Error('waitForInstanceSettled is not used by this test');
  }

  async terminateInstance(instanceId: string): Promise<void> {
    this.terminated.push(instanceId);
  }
}

class FakeVerificationExecutor {
  calls: Array<{ runId: string; nodeId: string; sourceNodeId: unknown; project: OperatorProjectRecord }> = [];

  constructor(
    private readonly summaries: OperatorVerificationSummary[],
    private readonly runStore?: OperatorRunStore,
  ) {}

  async execute(input: {
    run: { id: string };
    node: { id: string; inputJson: Record<string, unknown> };
    project: OperatorProjectRecord;
  }): Promise<OperatorVerificationSummary> {
    this.calls.push({
      runId: input.run.id,
      nodeId: input.node.id,
      sourceNodeId: input.node.inputJson['sourceNodeId'],
      project: input.project,
    });
    const summary = this.summaries.shift() ?? passedVerification();
    this.runStore?.appendEvent({
      runId: input.run.id,
      nodeId: input.node.id,
      kind: 'verification-result',
      payload: summary as unknown as Record<string, unknown>,
    });
    return summary;
  }
}

interface ProjectAgentResult {
  status: OperatorRunStatus;
  outputJson: Record<string, unknown>;
  externalRefKind: 'instance';
  externalRefId: string;
  error: string | null;
}

function projectAgentResult(
  instanceId = 'instance-1',
  outputPreview = 'Project agent output.',
  status: OperatorRunStatus = 'completed',
  error: string | null = null,
): ProjectAgentResult {
  return {
    status,
    outputJson: {
      instanceId,
      finalStatus: status === 'completed' ? 'idle' : 'error',
      outputPreview,
    },
    externalRefKind: 'instance',
    externalRefId: instanceId,
    error,
  };
}

function repoJobRecord(overrides: Partial<RepoJobRecord> = {}): RepoJobRecord {
  const submission: RepoJobSubmission = overrides.submission ?? {
    type: 'repo-health-audit',
    workingDirectory: overrides.workingDirectory ?? '/work/ai-orchestrator',
    title: overrides.title,
    description: overrides.description,
    useWorktree: false,
  };
  return {
    id: 'repo-job-1',
    taskId: 'repo-job-1',
    name: 'Repository health audit',
    type: submission.type,
    status: 'queued',
    workingDirectory: submission.workingDirectory,
    title: submission.title,
    description: submission.description,
    workflowTemplateId: 'repo-health-audit',
    useWorktree: submission.useWorktree ?? false,
    progress: 0,
    createdAt: 1,
    repoContext: {
      gitAvailable: true,
      isRepo: true,
      gitRoot: submission.workingDirectory,
      currentBranch: 'main',
      changedFiles: [],
    },
    submission,
    ...overrides,
  };
}

function resolvedRegistry(project: OperatorProjectRecord) {
  return {
    resolveProject: (query: string) => ({
      status: 'resolved' as const,
      query,
      project,
      candidates: [project],
    }),
  };
}

function passedVerification(): OperatorVerificationSummary {
  return {
    status: 'passed',
    projectPath: '/work/ai-orchestrator',
    kinds: ['node', 'typescript'],
    requiredFailed: 0,
    optionalFailed: 0,
    checks: [
      {
        label: 'typecheck',
        command: 'npx',
        args: ['tsc', '--noEmit'],
        cwd: '/work/ai-orchestrator',
        required: true,
        status: 'passed',
        exitCode: 0,
        durationMs: 100,
        timedOut: false,
        stdoutBytes: 0,
        stderrBytes: 0,
        stdoutExcerpt: '',
        stderrExcerpt: '',
        error: null,
      },
    ],
  };
}

function skippedVerification(): OperatorVerificationSummary {
  return {
    status: 'skipped',
    projectPath: '/work/ai-orchestrator',
    kinds: ['unknown'],
    requiredFailed: 0,
    optionalFailed: 0,
    checks: [],
    fallbackReason: 'No recognized project manifest found',
  };
}

function failedVerification(): OperatorVerificationSummary {
  return {
    status: 'failed',
    projectPath: '/work/ai-orchestrator',
    kinds: ['node', 'typescript'],
    requiredFailed: 1,
    optionalFailed: 0,
    checks: [
      {
        label: 'typecheck',
        command: 'npx',
        args: ['tsc', '--noEmit'],
        cwd: '/work/ai-orchestrator',
        required: true,
        status: 'failed',
        exitCode: 2,
        durationMs: 100,
        timedOut: false,
        stdoutBytes: 0,
        stderrBytes: 64,
        stdoutExcerpt: '',
        stderrExcerpt: 'src/main/operator/operator-engine.ts(10,1): error TS2322',
        error: 'Command failed',
      },
    ],
  };
}

function projectRecord(overrides: Partial<OperatorProjectRecord> = {}): OperatorProjectRecord {
  return {
    id: 'project-1',
    canonicalPath: '/work/ai-orchestrator',
    displayName: 'AI Orchestrator',
    aliases: ['AI Orchestrator', 'ai-orchestrator'],
    source: 'scan',
    gitRoot: '/work/ai-orchestrator',
    remotes: [],
    currentBranch: 'main',
    isPinned: false,
    lastSeenAt: 1,
    lastAccessedAt: 1,
    metadata: {},
    ...overrides,
  };
}
