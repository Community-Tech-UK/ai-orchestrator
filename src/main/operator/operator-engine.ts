import * as path from 'path';
import type {
  OperatorGitBatchSummary,
  OperatorProjectAgentRouting,
  OperatorProjectRecord,
  OperatorProjectRefreshOptions,
  OperatorProjectResolution,
  OperatorRunBudget,
  OperatorRunNodeRecord,
  OperatorRunRecord,
  OperatorRunGraph,
  OperatorRunStatus,
  OperatorShellCommandEventPayload,
  OperatorRunUsage,
  OperatorVerificationSummary,
} from '../../shared/types/operator.types';
import type { Instance, InstanceProvider } from '../../shared/types/instance.types';
import type { RepoJobRecord, RepoJobSubmission } from '../../shared/types/repo-job.types';
import { getModelRouter, type RoutingDecision } from '../routing';
import { getOperatorDatabase } from './operator-database';
import { getGitBatchService } from './git-batch-service';
import { OperatorRunStore } from './operator-run-store';
import { getProjectRegistry } from './project-registry';
import {
  budgetBreachPayload,
  evaluateOperatorBudget,
  type OperatorBudgetBreach,
} from './operator-budget';
import {
  ProjectAgentExecutor,
  type ProjectAgentExecutionInput,
  type ProjectAgentExecutionResult,
  type ProjectAgentInstanceManager,
} from './operator-project-agent-executor';
import {
  OperatorVerificationExecutor,
  type OperatorVerificationExecutionInput,
} from './operator-verification-executor';
import { buildOperatorFixWorkerPrompt } from './operator-fix-worker-prompt';
import {
  defaultOperatorWorkRoot,
  planOperatorRequest,
  type OperatorRequestPlan,
} from './operator-planner';
import {
  synthesizeOperatorRun,
  type OperatorSynthesisResult,
} from './operator-synthesis-executor';
import {
  getOperatorMemoryPromoter,
  type OperatorMemoryPromotionResult,
} from './operator-memory-promoter';
import {
  getOperatorFollowUpScheduler,
  type OperatorFollowUpScheduleResult,
} from './operator-follow-up-scheduler';

export interface OperatorEngineMessageInput {
  threadId: string;
  sourceMessageId: string;
  text: string;
  retryOfRunId?: string;
}

interface OperatorRunCompletionInput {
  runId: string;
  parentNodeId?: string | null;
  status: OperatorRunStatus;
  resultJson: Record<string, unknown> | null;
  error: string | null;
  usageJson?: Partial<OperatorRunUsage>;
  completedAt?: number;
  runStartedAt: number;
  memoryPromotion?: {
    eligible: boolean;
    projects: OperatorProjectRecord[];
  };
  followUp?: {
    eligible: boolean;
    projects: OperatorProjectRecord[];
  };
}

interface GitBatchExecutor {
  pullAll(
    rootPath: string,
    options?: {
      concurrency?: number;
      onShellCommand?: (payload: OperatorShellCommandEventPayload) => void;
    },
  ): Promise<OperatorGitBatchSummary>;
}

interface ProjectRegistryResolver {
  resolveProject(query: string): OperatorProjectResolution;
  listProjects?(query?: { limit?: number }): OperatorProjectRecord[];
  refreshProjects?(options?: OperatorProjectRefreshOptions): Promise<OperatorProjectRecord[]>;
}

interface ProjectAgentExecutorLike {
  execute(input: ProjectAgentExecutionInput): Promise<ProjectAgentExecutionResult>;
}

interface OperatorModelRouterLike {
  route(task: string, explicitModel?: string): RoutingDecision;
}

interface OperatorRemoteRoutingPolicy {
  enabled: boolean;
  preferRemoteForProject?: (input: {
    project: OperatorProjectRecord;
    plan: OperatorRequestPlan;
    goal: string;
  }) => boolean;
}

interface OperatorVerificationExecutorLike {
  execute(input: OperatorVerificationExecutionInput): Promise<OperatorVerificationSummary>;
}

interface OperatorMemoryPromoterLike {
  promote(input: {
    graph: OperatorRunGraph;
    projects: OperatorProjectRecord[];
  }): OperatorMemoryPromotionResult[];
}

interface OperatorFollowUpSchedulerLike {
  schedule(input: {
    graph: OperatorRunGraph;
    projects: OperatorProjectRecord[];
  }): Promise<OperatorFollowUpScheduleResult>;
}

interface RepoJobExecutorLike {
  submitJob(submission: RepoJobSubmission): RepoJobRecord;
  waitForJob(jobId: string, timeout?: number): Promise<RepoJobRecord>;
  cancelJob?(jobId: string): boolean;
  getJob?(jobId: string): RepoJobRecord | undefined;
}

interface OperatorEngineInstanceManager extends ProjectAgentInstanceManager {
  getInstance?(instanceId: string): Instance | undefined;
  terminateInstance?(instanceId: string, graceful?: boolean): Promise<void>;
}

export interface OperatorEngineConfig {
  runStore?: OperatorRunStore;
  gitBatch?: GitBatchExecutor;
  projectRegistry?: ProjectRegistryResolver;
  projectAgent?: ProjectAgentExecutorLike;
  verificationExecutor?: OperatorVerificationExecutorLike;
  memoryPromoter?: OperatorMemoryPromoterLike | null;
  followUpScheduler?: OperatorFollowUpSchedulerLike | null;
  repoJob?: RepoJobExecutorLike | null;
  instanceManager?: OperatorEngineInstanceManager;
  resolveWorkRoot?: (text: string) => string;
  defaultBudget?: Partial<OperatorRunBudget>;
  modelRouter?: OperatorModelRouterLike;
  remoteRouting?: OperatorRemoteRoutingPolicy;
  now?: () => number;
}

export class OperatorEngine {
  private static instance: OperatorEngine | null = null;
  private readonly runStore: OperatorRunStore;
  private readonly gitBatch: GitBatchExecutor;
  private readonly projectRegistry: ProjectRegistryResolver | null;
  private readonly projectAgent: ProjectAgentExecutorLike | null;
  private readonly verificationExecutor: OperatorVerificationExecutorLike;
  private readonly memoryPromoter: OperatorMemoryPromoterLike | null;
  private readonly followUpScheduler: OperatorFollowUpSchedulerLike | null;
  private readonly repoJob: RepoJobExecutorLike | null;
  private readonly instanceManager: OperatorEngineInstanceManager | null;
  private readonly resolveWorkRoot: (text: string) => string;
  private readonly defaultBudget?: Partial<OperatorRunBudget>;
  private readonly modelRouter: OperatorModelRouterLike;
  private readonly remoteRouting: OperatorRemoteRoutingPolicy;
  private readonly now: () => number;

  static getInstance(config?: OperatorEngineConfig): OperatorEngine {
    this.instance ??= new OperatorEngine(config);
    return this.instance;
  }

  static _resetForTesting(): void {
    this.instance = null;
  }

  constructor(config: OperatorEngineConfig = {}) {
    this.runStore = config.runStore ?? new OperatorRunStore(getOperatorDatabase().db);
    this.gitBatch = config.gitBatch ?? getGitBatchService();
    this.projectRegistry = config.projectRegistry ?? null;
    this.instanceManager = config.instanceManager ?? null;
    this.projectAgent = config.projectAgent
      ?? (config.instanceManager
        ? new ProjectAgentExecutor({ instanceManager: config.instanceManager, runStore: this.runStore })
        : null);
    this.verificationExecutor = config.verificationExecutor
      ?? new OperatorVerificationExecutor({ runStore: this.runStore });
    this.memoryPromoter = config.memoryPromoter === undefined
      ? getOperatorMemoryPromoter()
      : config.memoryPromoter;
    this.followUpScheduler = config.followUpScheduler === undefined
      ? getOperatorFollowUpScheduler()
      : config.followUpScheduler;
    this.repoJob = config.repoJob ?? null;
    this.resolveWorkRoot = config.resolveWorkRoot ?? defaultOperatorWorkRoot;
    this.defaultBudget = config.defaultBudget;
    this.modelRouter = config.modelRouter ?? getModelRouter();
    this.remoteRouting = config.remoteRouting ?? { enabled: false };
    this.now = config.now ?? Date.now;
  }

  async handleUserMessage(input: OperatorEngineMessageInput): Promise<OperatorRunGraph | null> {
    const plan = planOperatorRequest(input.text, { resolveWorkRoot: this.resolveWorkRoot });
    if (!plan.needsRun) {
      return null;
    }

    if (plan.intent === 'workspace_git_batch') {
      return this.handleGitBatchRequest(input, plan);
    }

    if (plan.intent === 'cross_project_research') {
      return this.handleCrossProjectResearchRequest(input, plan);
    }

    if ((plan.intent === 'project_feature' || plan.intent === 'project_audit') && plan.projectQuery) {
      return this.handleProjectTaskRequest(input, {
        intent: plan.intent,
        projectQuery: plan.projectQuery,
        goal: plan.projectGoal ?? input.text,
        plan,
      });
    }

    return null;
  }

  async cancelRun(runId: string): Promise<OperatorRunGraph> {
    const graph = this.requireRunGraph(runId);
    if (isTerminalRunStatus(graph.run.status)) {
      return graph;
    }

    const completedAt = this.now();
    const cancellableNodes = graph.nodes.filter((node) => !isTerminalRunStatus(node.status));
    await Promise.all(cancellableNodes.map(async (node) => {
      try {
        await this.cancelExternalNode(node);
      } catch (error) {
        this.runStore.appendEvent({
          runId,
          nodeId: node.id,
          kind: 'recovery',
          payload: {
            action: 'external-cancel-failed',
            externalRefKind: node.externalRefKind,
            externalRefId: node.externalRefId,
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }
    }));

    for (const node of cancellableNodes) {
      this.runStore.updateNode(node.id, {
        status: 'cancelled',
        completedAt,
        error: 'Cancelled by user',
      });
      this.runStore.appendEvent({
        runId,
        nodeId: node.id,
        kind: 'state-change',
        payload: {
          status: 'cancelled',
          reason: 'user-cancelled',
        },
      });
    }

    this.runStore.appendEvent({
      runId,
      kind: 'recovery',
      payload: {
        action: 'cancelled',
        reason: 'user-request',
        cancelledNodeIds: cancellableNodes.map((node) => node.id),
      },
    });
    this.runStore.updateRun(runId, {
      status: 'cancelled',
      completedAt,
      usageJson: {
        nodesCompleted: graph.run.usageJson.nodesCompleted + cancellableNodes.length,
        wallClockMs: completedAt - graph.run.createdAt,
      },
      error: 'Cancelled by user',
    });
    this.runStore.appendEvent({
      runId,
      kind: 'state-change',
      payload: {
        status: 'cancelled',
        reason: 'user-cancelled',
      },
    });

    return this.runStore.getRunGraph(runId)!;
  }

  async retryRun(runId: string): Promise<OperatorRunGraph> {
    const previousRun = this.runStore.getRun(runId);
    if (!previousRun) {
      throw new Error(`Operator run not found: ${runId}`);
    }
    if (!isTerminalRunStatus(previousRun.status)) {
      throw new Error(`Operator run is still active and cannot be retried: ${runId}`);
    }

    const graph = await this.handleUserMessage({
      threadId: previousRun.threadId,
      sourceMessageId: `${previousRun.sourceMessageId}:retry:${this.now()}`,
      text: previousRun.goal,
      retryOfRunId: previousRun.id,
    });
    if (!graph) {
      throw new Error(`Operator run cannot be retried because its goal is no longer routable: ${runId}`);
    }

    this.runStore.updateRun(previousRun.id, {
      planJson: {
        ...previousRun.planJson,
        retriedByRunId: graph.run.id,
      },
    });
    this.runStore.appendEvent({
      runId: graph.run.id,
      kind: 'recovery',
      payload: {
        action: 'retry-created',
        retryOfRunId: previousRun.id,
      },
    });

    return this.runStore.getRunGraph(graph.run.id)!;
  }

  recoverActiveRuns(): OperatorRunGraph[] {
    const activeRuns = this.runStore.listRuns({ limit: 500 })
      .filter((run) => run.status === 'queued' || run.status === 'running' || run.status === 'waiting');
    const recovered: OperatorRunGraph[] = [];

    for (const run of activeRuns) {
      const graph = this.runStore.getRunGraph(run.id);
      if (!graph) continue;

      let blocked = false;
      for (const node of graph.nodes.filter((candidate) => !isTerminalRunStatus(candidate.status))) {
        const completedGraph = this.completeRecoveredExternalNodeIfPossible(run, node);
        if (completedGraph) {
          recovered.push(completedGraph);
          blocked = false;
          break;
        }

        const staleReason = this.getStaleExternalNodeReason(node);
        if (!staleReason) {
          this.markExternalNodeRecovered(node);
          continue;
        }

        blocked = true;
        const error = `Operator run recovery blocked: ${staleReason}`;
        const completedAt = this.now();
        const recoveryReason = node.externalRefKind === 'repo-job'
          ? 'stale-repo-job-link'
          : node.externalRefKind === 'instance'
            ? 'stale-instance-link'
            : 'stale-node';
        this.runStore.appendEvent({
          runId: run.id,
          nodeId: node.id,
          kind: 'recovery',
          payload: {
            reason: recoveryReason,
            action: 'blocked',
            instanceId: node.externalRefKind === 'instance' ? node.externalRefId : undefined,
            externalRefKind: node.externalRefKind,
            externalRefId: node.externalRefId,
          },
        });
        this.runStore.updateNode(node.id, {
          status: 'blocked',
          completedAt,
          error,
        });
        if (node.externalRefKind === 'instance' && node.externalRefId) {
          this.runStore.touchInstanceLink(node.externalRefId, 'stale');
        }
      }

      if (!blocked && graph.nodes.some((node) => !isTerminalRunStatus(node.status))) {
        continue;
      }

      if (!blocked) {
        this.runStore.appendEvent({
          runId: run.id,
          kind: 'recovery',
          payload: {
            reason: 'no-active-nodes',
            action: 'blocked',
          },
        });
      }

      const completedAt = this.now();
      const currentGraph = this.runStore.getRunGraph(run.id)!;
      const error = blocked
        ? currentGraph.nodes.find((node) => node.status === 'blocked')?.error
          ?? 'Operator run recovery blocked'
        : 'Operator run recovery blocked: no active nodes remain';
      const newlyTerminalNodes = currentGraph.nodes
        .filter((node) => isTerminalRunStatus(node.status))
        .length;
      this.runStore.updateRun(run.id, {
        status: 'blocked',
        completedAt,
        usageJson: {
          nodesCompleted: Math.max(currentGraph.run.usageJson.nodesCompleted, newlyTerminalNodes),
          wallClockMs: completedAt - currentGraph.run.createdAt,
        },
        error,
      });
      this.runStore.appendEvent({
        runId: run.id,
        kind: 'state-change',
        payload: {
          status: 'blocked',
          reason: 'startup-recovery',
        },
      });
      recovered.push(this.runStore.getRunGraph(run.id)!);
    }

    return recovered;
  }

  private async handleGitBatchRequest(
    input: OperatorEngineMessageInput,
    plan: OperatorRequestPlan,
  ): Promise<OperatorRunGraph> {
    const rootPath = plan.rootPath ?? this.resolveWorkRoot(input.text);
    const startedAt = this.now();
    const run = this.runStore.createRun({
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
      title: plan.title,
      goal: input.text,
      budget: this.defaultBudget,
      planJson: {
        intent: plan.intent,
        executor: plan.executor,
        rootPath,
        confidence: plan.confidence,
        risk: plan.risk,
        successCriteria: plan.successCriteria,
        maxConcurrentNodes: plan.maxConcurrentNodes,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      },
    });
    const startBreach = evaluateOperatorBudget(run, { nodesToStart: 1 });
    if (startBreach) {
      return this.blockRunForBudget(run, null, startBreach, {
        wallClockMs: this.now() - startedAt,
      });
    }

    const node = this.runStore.createNode({
      runId: run.id,
      type: 'git-batch',
      title: 'Pull repositories',
      targetPath: rootPath,
      inputJson: { rootPath },
    });

    this.runStore.updateRun(run.id, {
      status: 'running',
      usageJson: { nodesStarted: 1 },
    });
    this.runStore.updateNode(node.id, { status: 'running' });
    this.runStore.appendEvent({
      runId: run.id,
      nodeId: node.id,
      kind: 'state-change',
      payload: { status: 'running' },
    });
    this.runStore.appendEvent({
      runId: run.id,
      nodeId: node.id,
      kind: 'progress',
      payload: { message: 'Starting Git batch pull', rootPath },
    });

    const summary = await this.gitBatch.pullAll(rootPath, {
      concurrency: 6,
      onShellCommand: (payload) => {
        this.runStore.appendEvent({
          runId: run.id,
          nodeId: node.id,
          kind: 'shell-command',
          payload,
        });
      },
    });
    const terminalStatus = summary.failed > 0 ? 'blocked' : 'completed';
    const completedAt = this.now();
    const finalUsage: Partial<OperatorRunUsage> = {
      nodesCompleted: 1,
      wallClockMs: completedAt - startedAt,
    };

    this.runStore.appendEvent({
      runId: run.id,
      nodeId: node.id,
      kind: 'progress',
      payload: {
        message: 'Git batch pull finished',
        total: summary.total,
        pulled: summary.pulled,
        skipped: summary.skipped,
        failed: summary.failed,
      },
    });

    const postRun = this.runStore.getRun(run.id)!;
    const budgetBreach = evaluateOperatorBudget(postRun, {
      usageJson: finalUsage,
    });
    if (budgetBreach) {
      return this.blockRunForBudget(
        postRun,
        node,
        budgetBreach,
        finalUsage,
        summary as unknown as Record<string, unknown>,
      );
    }

    this.runStore.updateNode(node.id, {
      status: terminalStatus,
      outputJson: summary as unknown as Record<string, unknown>,
      completedAt,
      error: summary.failed > 0 ? 'One or more repositories failed' : null,
    });
    this.runStore.appendEvent({
      runId: run.id,
      nodeId: node.id,
      kind: 'state-change',
      payload: { status: terminalStatus },
    });

    return this.completeRunWithSynthesis({
      runId: run.id,
      parentNodeId: node.id,
      status: terminalStatus,
      resultJson: summary as unknown as Record<string, unknown>,
      error: summary.failed > 0 ? 'One or more repositories failed' : null,
      usageJson: finalUsage,
      completedAt,
      runStartedAt: startedAt,
    });
  }

  private async handleProjectTaskRequest(
    input: OperatorEngineMessageInput,
    request: {
      projectQuery: string;
      goal: string;
      intent: 'project_feature' | 'project_audit';
      plan: OperatorRequestPlan;
    },
  ): Promise<OperatorRunGraph> {
    const runStartedAt = this.now();
    const projectRegistry = this.projectRegistry ?? getProjectRegistry();
    let resolution = projectRegistry.resolveProject(request.projectQuery);
    if (resolution.status === 'not_found' && projectRegistry.refreshProjects) {
      await projectRegistry.refreshProjects({
        includeRecent: true,
        includeActiveInstances: true,
        includeConversationLedger: true,
      });
      resolution = projectRegistry.resolveProject(request.projectQuery);
    }
    const project = resolution.project;
    const executor = request.intent === 'project_audit' && this.repoJob ? 'repo-job' : 'project-agent';
    const run = this.runStore.createRun({
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
      title: project
        ? request.intent === 'project_audit' ? `Audit ${project.displayName}` : `Implement in ${project.displayName}`
        : request.intent === 'project_audit' ? `Audit ${request.projectQuery}` : `Implement in ${request.projectQuery}`,
      goal: input.text,
      budget: this.defaultBudget,
      planJson: {
        intent: request.intent,
        executor,
        projectQuery: request.projectQuery,
        resolvedStatus: resolution.status,
        confidence: request.plan.confidence,
        risk: request.plan.risk,
        successCriteria: request.plan.successCriteria,
        maxConcurrentNodes: request.plan.maxConcurrentNodes,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
        ...(project ? {
          projectId: project.id,
          projectPath: project.canonicalPath,
        } : {}),
      },
    });

    if (!project) {
      const error = resolution.status === 'ambiguous'
        ? `Project reference is ambiguous: ${request.projectQuery}`
        : `Could not resolve project: ${request.projectQuery}`;
      const completedAt = this.now();
      const discoveryNode = this.runStore.createNode({
        runId: run.id,
        type: 'discover-projects',
        title: 'Resolve project',
        inputJson: {
          query: request.projectQuery,
          intent: request.intent,
        },
      });
      this.runStore.updateNode(discoveryNode.id, {
        status: 'blocked',
        outputJson: {
          status: resolution.status,
          query: resolution.query,
          candidates: resolution.candidates.map(projectSummary),
        },
        completedAt,
        error,
      });
      this.runStore.updateRun(run.id, {
        status: 'blocked',
        completedAt,
        usageJson: {
          nodesStarted: 1,
          nodesCompleted: 1,
          wallClockMs: completedAt - runStartedAt,
        },
        error,
      });
      this.runStore.appendEvent({
        runId: run.id,
        nodeId: discoveryNode.id,
        kind: 'state-change',
        payload: { status: 'blocked', reason: 'project-resolution', error },
      });
      return this.runStore.getRunGraph(run.id)!;
    }

    const routing = this.buildProjectAgentRouting({
      project,
      plan: request.plan,
      goal: request.goal,
    });
    this.runStore.updateRun(run.id, {
      planJson: {
        ...this.runStore.getRun(run.id)!.planJson,
        routing: routing.audit,
      },
    });

    if (request.intent === 'project_audit' && this.repoJob) {
      return this.runRepoJobAuditNode({
        run,
        project,
        goal: request.goal,
        runStartedAt,
      });
    }

    const initialAgent = await this.runProjectAgentNode({
      run,
      project,
      goal: request.goal,
      projectQuery: request.projectQuery,
      runStartedAt,
      title: `Implement in ${project.displayName}`,
      progressLabel: 'Starting project agent',
      routing,
    });
    if ('graph' in initialAgent) {
      return initialAgent.graph;
    }
    if (initialAgent.result.status !== 'completed') {
      return this.finishRunAfterProjectAgentNonCompletion(
        initialAgent.node,
        initialAgent.result,
        runStartedAt,
      );
    }

    let latestProjectAgentNode = initialAgent.node;
    let latestProjectAgentOutput = initialAgent.result.outputJson;
    let verificationAttempt = 0;

    while (true) {
      const verification = await this.runVerificationNode({
        run: this.runStore.getRun(run.id)!,
        project,
        sourceNode: latestProjectAgentNode,
        attempt: verificationAttempt,
        runStartedAt,
      });
      if ('graph' in verification) {
        return verification.graph;
      }

      if (verification.summary.status === 'passed' || verification.summary.status === 'skipped') {
        return this.completeRunAfterVerification({
          runId: run.id,
          project,
          verificationNode: verification.node,
          verificationSummary: verification.summary,
          latestProjectAgentOutput,
          runStartedAt,
        });
      }

      const retryDecision = this.canStartFixAttempt(this.runStore.getRun(run.id)!);
      if (!retryDecision.allowed) {
        return this.blockRunForBudget(
          this.runStore.getRun(run.id)!,
          verification.node,
          retryDecision.breach,
          { wallClockMs: this.now() - runStartedAt },
          verification.summary as unknown as Record<string, unknown>,
        );
      }

      this.runStore.updateNode(verification.node.id, {
        status: 'failed',
        outputJson: verification.summary as unknown as Record<string, unknown>,
        completedAt: this.now(),
        error: verificationFailureMessage(project, verification.summary),
      });
      this.runStore.appendEvent({
        runId: run.id,
        nodeId: verification.node.id,
        kind: 'state-change',
        payload: { status: 'failed', reason: 'fix-worker-retry' },
      });

      const currentRun = this.runStore.getRun(run.id)!;
      const repairAttempt = currentRun.usageJson.retriesUsed + 1;
      this.runStore.updateRun(run.id, {
        usageJson: {
          retriesUsed: repairAttempt,
          wallClockMs: this.now() - runStartedAt,
        },
      });
      const promptOverride = buildOperatorFixWorkerPrompt({
        originalGoal: request.goal,
        project,
        attempt: repairAttempt,
        previousWorkerOutputPreview: readProjectAgentOutputPreview(latestProjectAgentNode),
        verification: verification.summary,
      });
      const repairAgent = await this.runProjectAgentNode({
        run: this.runStore.getRun(run.id)!,
        project,
        goal: request.goal,
        projectQuery: request.projectQuery,
        runStartedAt,
        parentNodeId: verification.node.id,
        title: `Repair ${project.displayName}`,
        progressLabel: 'Starting verification fix worker',
        promptOverride,
        routing,
        inputJson: {
          attempt: repairAttempt,
          projectId: project.id,
          projectPath: project.canonicalPath,
          repairForVerificationNodeId: verification.node.id,
        },
      });
      if ('graph' in repairAgent) {
        return repairAgent.graph;
      }
      if (repairAgent.result.status !== 'completed') {
        return this.finishRunAfterProjectAgentNonCompletion(
          repairAgent.node,
          repairAgent.result,
          runStartedAt,
        );
      }

      latestProjectAgentNode = repairAgent.node;
      latestProjectAgentOutput = repairAgent.result.outputJson;
      verificationAttempt = repairAttempt;
    }
  }

  private async handleCrossProjectResearchRequest(
    input: OperatorEngineMessageInput,
    plan: OperatorRequestPlan,
  ): Promise<OperatorRunGraph> {
    const runStartedAt = this.now();
    const rootPath = plan.rootPath ?? this.resolveWorkRoot(input.text);
    const projectRegistry = this.projectRegistry ?? getProjectRegistry();
    const run = this.runStore.createRun({
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
      title: plan.title,
      goal: input.text,
      budget: this.defaultBudget,
      planJson: {
        intent: plan.intent,
        executor: plan.executor,
        rootPath,
        confidence: plan.confidence,
        risk: plan.risk,
        successCriteria: plan.successCriteria,
        maxConcurrentNodes: plan.maxConcurrentNodes,
        ...(input.retryOfRunId ? { retryOfRunId: input.retryOfRunId } : {}),
      },
    });
    const startBreach = evaluateOperatorBudget(run, { nodesToStart: 1 });
    if (startBreach) {
      return this.blockRunForBudget(run, null, startBreach, {
        wallClockMs: this.now() - runStartedAt,
      });
    }

    const discoveryNode = this.runStore.createNode({
      runId: run.id,
      type: 'discover-projects',
      title: 'Discover projects',
      targetPath: rootPath,
      inputJson: { rootPath },
    });
    this.runStore.updateRun(run.id, {
      status: 'running',
      usageJson: {
        nodesStarted: 1,
        wallClockMs: this.now() - runStartedAt,
      },
    });
    this.runStore.updateNode(discoveryNode.id, { status: 'running' });
    this.runStore.appendEvent({
      runId: run.id,
      nodeId: discoveryNode.id,
      kind: 'state-change',
      payload: { status: 'running' },
    });
    this.runStore.appendEvent({
      runId: run.id,
      nodeId: discoveryNode.id,
      kind: 'progress',
      payload: { message: 'Discovering projects', rootPath },
    });

    let projects: OperatorProjectRecord[];
    try {
      projects = projectRegistry.refreshProjects
        ? await projectRegistry.refreshProjects({
          roots: [rootPath],
          includeRecent: true,
          includeActiveInstances: true,
          includeConversationLedger: true,
        })
        : projectRegistry.listProjects?.({ limit: 500 }) ?? [];
      projects = projects.filter((project) => isProjectUnderRoot(project, rootPath));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Project discovery failed';
      const completedAt = this.now();
      const runningRun = this.runStore.getRun(run.id)!;
      this.runStore.updateNode(discoveryNode.id, {
        status: 'failed',
        completedAt,
        error: message,
      });
      return this.completeRunWithSynthesis({
        runId: run.id,
        parentNodeId: discoveryNode.id,
        status: 'failed',
        resultJson: { projectResults: [] },
        error: message,
        usageJson: {
          nodesCompleted: runningRun.usageJson.nodesCompleted + 1,
          wallClockMs: completedAt - runStartedAt,
        },
        completedAt,
        runStartedAt,
      });
    }

    const completedDiscoveryAt = this.now();
    const runningRun = this.runStore.getRun(run.id)!;
    this.runStore.updateNode(discoveryNode.id, {
      status: 'completed',
      outputJson: {
        rootPath,
        projects: projects.map(projectSummary),
      },
      completedAt: completedDiscoveryAt,
      error: null,
    });
    this.runStore.updateRun(run.id, {
      status: 'running',
      planJson: {
        ...runningRun.planJson,
        projectCount: projects.length,
      },
      usageJson: {
        nodesCompleted: runningRun.usageJson.nodesCompleted + 1,
        wallClockMs: completedDiscoveryAt - runStartedAt,
      },
    });
    this.runStore.appendEvent({
      runId: run.id,
      nodeId: discoveryNode.id,
      kind: 'state-change',
      payload: { status: 'completed', projectCount: projects.length },
    });

    if (projects.length === 0) {
      const error = `No projects found under ${rootPath}`;
      return this.completeRunWithSynthesis({
        runId: run.id,
        parentNodeId: discoveryNode.id,
        status: 'blocked',
        resultJson: { projectResults: [] },
        error,
        usageJson: { wallClockMs: this.now() - runStartedAt },
        runStartedAt,
      });
    }

    let lastNodeId = discoveryNode.id;
    const concurrency = Math.max(1, Math.min(
      plan.maxConcurrentNodes,
      this.runStore.getRun(run.id)!.budget.maxConcurrentNodes,
      projects.length,
    ));
    let projectResults: Record<string, unknown>[];
    try {
      projectResults = await mapWithConcurrency(projects, concurrency, async (project) => {
        const routing = this.buildProjectAgentRouting({
          project,
          plan,
          goal: plan.projectGoal ?? input.text,
        });
        const agent = await this.runProjectAgentNode({
          run: this.runStore.getRun(run.id)!,
          project,
          goal: plan.projectGoal ?? input.text,
          projectQuery: project.displayName,
          runStartedAt,
          parentNodeId: discoveryNode.id,
          title: `Research ${project.displayName}`,
          progressLabel: 'Starting project research agent',
          routing,
          inputJson: {
            goal: plan.projectGoal ?? input.text,
            projectId: project.id,
            projectPath: project.canonicalPath,
            rootPath,
          },
        });
        if ('graph' in agent) {
          throw new OperatorGraphCompletion(agent.graph);
        }
        return {
          nodeId: agent.node.id,
          projectId: project.id,
          displayName: project.displayName,
          projectPath: project.canonicalPath,
          status: agent.result.status,
          outputPreview: readProjectAgentOutputPreviewFromJson(agent.result.outputJson),
          error: agent.result.error,
        };
      });
    } catch (error) {
      if (error instanceof OperatorGraphCompletion) {
        return error.graph;
      }
      throw error;
    }
    lastNodeId = typeof projectResults.at(-1)?.['nodeId'] === 'string'
      ? projectResults.at(-1)!['nodeId'] as string
      : discoveryNode.id;
    projectResults = projectResults.map(({ nodeId: _nodeId, ...result }) => result);

    const blockedResult = projectResults.find((result) => result['status'] === 'blocked');
    const failedResult = projectResults.find((result) => result['status'] === 'failed');
    const terminalStatus: OperatorRunStatus = blockedResult
      ? 'blocked'
      : failedResult
        ? 'failed'
        : 'completed';
    const error = blockedResult
      ? `${blockedResult['displayName'] ?? 'Project'} was blocked`
      : failedResult
        ? `${failedResult['displayName'] ?? 'Project'} failed`
        : null;

    return this.completeRunWithSynthesisAndFollowUps({
      runId: run.id,
      parentNodeId: lastNodeId,
      status: terminalStatus,
      resultJson: { projectResults },
      error,
      usageJson: { wallClockMs: this.now() - runStartedAt },
      runStartedAt,
      memoryPromotion: {
        eligible: true,
        projects,
      },
      followUp: {
        eligible: hasAutomationFollowUpRequest(input.text),
        projects,
      },
    });
  }

  private async runRepoJobAuditNode(input: {
    run: OperatorRunRecord;
    project: OperatorProjectRecord;
    goal: string;
    runStartedAt: number;
  }): Promise<OperatorRunGraph> {
    const currentRun = this.runStore.getRun(input.run.id) ?? input.run;
    const startBreach = evaluateOperatorBudget(currentRun, {
      nodesToStart: 1,
      usageJson: { wallClockMs: this.now() - input.runStartedAt },
    });
    if (startBreach) {
      return this.blockRunForBudget(currentRun, null, startBreach, {
        wallClockMs: this.now() - input.runStartedAt,
      });
    }

    const node = this.runStore.createNode({
      runId: input.run.id,
      type: 'repo-job',
      title: `Audit ${input.project.displayName}`,
      targetProjectId: input.project.id,
      targetPath: input.project.canonicalPath,
      inputJson: {
        projectId: input.project.id,
        projectPath: input.project.canonicalPath,
        type: 'repo-health-audit',
      },
    });

    const afterCreateRun = this.runStore.getRun(input.run.id)!;
    this.runStore.updateRun(input.run.id, {
      status: 'running',
      usageJson: {
        nodesStarted: afterCreateRun.usageJson.nodesStarted + 1,
        wallClockMs: this.now() - input.runStartedAt,
      },
    });
    this.runStore.updateNode(node.id, { status: 'running' });
    this.runStore.appendEvent({
      runId: input.run.id,
      nodeId: node.id,
      kind: 'state-change',
      payload: { status: 'running' },
    });
    this.runStore.appendEvent({
      runId: input.run.id,
      nodeId: node.id,
      kind: 'progress',
      payload: {
        message: 'Starting repository health audit',
        projectPath: input.project.canonicalPath,
      },
    });

    if (!this.repoJob) {
      const error = 'Repo job executor unavailable';
      const completedAt = this.now();
      const runningRun = this.runStore.getRun(input.run.id)!;
      this.runStore.updateNode(node.id, {
        status: 'blocked',
        completedAt,
        error,
      });
      this.runStore.updateRun(input.run.id, {
        status: 'blocked',
        completedAt,
        usageJson: {
          nodesCompleted: runningRun.usageJson.nodesCompleted + 1,
          wallClockMs: completedAt - input.runStartedAt,
        },
        error,
      });
      this.runStore.appendEvent({
        runId: input.run.id,
        nodeId: node.id,
        kind: 'state-change',
        payload: { status: 'blocked', reason: 'executor-unavailable' },
      });
      return this.runStore.getRunGraph(input.run.id)!;
    }

    let finalJob: RepoJobRecord;
    try {
      const submitted = this.repoJob.submitJob({
        type: 'repo-health-audit',
        workingDirectory: input.project.canonicalPath,
        title: `Audit ${input.project.displayName}`,
        description: input.goal,
        useWorktree: false,
      });
      this.runStore.updateNode(node.id, {
        externalRefKind: 'repo-job',
        externalRefId: submitted.id,
      });
      this.runStore.appendEvent({
        runId: input.run.id,
        nodeId: node.id,
        kind: 'progress',
        payload: {
          message: 'Repository health audit submitted',
          repoJobId: submitted.id,
        },
      });
      finalJob = await this.repoJob.waitForJob(submitted.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Repo job failed';
      const completedAt = this.now();
      const runningRun = this.runStore.getRun(input.run.id)!;
      this.runStore.updateNode(node.id, {
        status: 'failed',
        completedAt,
        error: message,
      });
      this.runStore.updateRun(input.run.id, {
        status: 'failed',
        completedAt,
        usageJson: {
          nodesCompleted: runningRun.usageJson.nodesCompleted + 1,
          wallClockMs: completedAt - input.runStartedAt,
        },
        error: message,
      });
      this.runStore.appendEvent({
        runId: input.run.id,
        nodeId: node.id,
        kind: 'state-change',
        payload: { status: 'failed', reason: 'repo-job-error' },
      });
      return this.runStore.getRunGraph(input.run.id)!;
    }

    const completedAt = this.now();
    const runningRun = this.runStore.getRun(input.run.id)!;
    const finalUsage: Partial<OperatorRunUsage> = {
      nodesCompleted: runningRun.usageJson.nodesCompleted + 1,
      wallClockMs: completedAt - input.runStartedAt,
    };
    const outputJson = { repoJob: finalJob as unknown as Record<string, unknown> };
    const budgetBreach = evaluateOperatorBudget(runningRun, {
      usageJson: finalUsage,
    });
    if (budgetBreach) {
      return this.blockRunForBudget(runningRun, node, budgetBreach, finalUsage, outputJson);
    }

    const terminalStatus = repoJobStatusToOperatorStatus(finalJob.status);
    const error = terminalStatus === 'completed' ? null : finalJob.error ?? `Repo job ${finalJob.status}`;
    this.runStore.updateNode(node.id, {
      status: terminalStatus,
      outputJson,
      externalRefKind: 'repo-job',
      externalRefId: finalJob.id,
      completedAt,
      error,
    });
    this.runStore.appendEvent({
      runId: input.run.id,
      nodeId: node.id,
      kind: 'progress',
      payload: {
        message: 'Repository health audit finished',
        repoJobId: finalJob.id,
        status: finalJob.status,
      },
    });
    this.runStore.appendEvent({
      runId: input.run.id,
      nodeId: node.id,
      kind: 'state-change',
      payload: { status: terminalStatus },
    });

    if (terminalStatus === 'waiting') {
      this.runStore.updateRun(input.run.id, {
        status: terminalStatus,
        resultJson: outputJson,
        completedAt,
        usageJson: finalUsage,
        error,
      });
      return this.runStore.getRunGraph(input.run.id)!;
    }

    return this.completeRunWithSynthesisAndFollowUps({
      runId: input.run.id,
      parentNodeId: node.id,
      status: terminalStatus,
      resultJson: outputJson,
      error,
      usageJson: finalUsage,
      completedAt,
      runStartedAt: input.runStartedAt,
      memoryPromotion: {
        eligible: isRunMemoryPromotionEligible(this.runStore.getRun(input.run.id)!),
        projects: [input.project],
      },
      followUp: {
        eligible: isRunAutomationFollowUpEligible(this.runStore.getRun(input.run.id)!),
        projects: [input.project],
      },
    });
  }

  private async runProjectAgentNode(input: {
    run: OperatorRunRecord;
    project: OperatorProjectRecord;
    goal: string;
    projectQuery: string;
    runStartedAt: number;
    parentNodeId?: string | null;
    title: string;
    progressLabel: string;
    promptOverride?: string;
    routing?: OperatorProjectAgentRouting;
    inputJson?: Record<string, unknown>;
  }): Promise<{
    node: OperatorRunNodeRecord;
    result: ProjectAgentExecutionResult;
  } | { graph: OperatorRunGraph }> {
    const currentRun = this.runStore.getRun(input.run.id) ?? input.run;
    const startBreach = evaluateOperatorBudget(currentRun, {
      nodesToStart: 1,
      usageJson: { wallClockMs: this.now() - input.runStartedAt },
    });
    if (startBreach) {
      return {
        graph: this.blockRunForBudget(currentRun, null, startBreach, {
          wallClockMs: this.now() - input.runStartedAt,
        }),
      };
    }

    const node = this.runStore.createNode({
      runId: input.run.id,
      parentNodeId: input.parentNodeId ?? null,
      type: 'project-agent',
      title: input.title,
      targetProjectId: input.project.id,
      targetPath: input.project.canonicalPath,
      inputJson: withRoutingInputJson(input.inputJson ?? {
        goal: input.goal,
        projectQuery: input.projectQuery,
      }, input.routing),
    });
    const afterCreateRun = this.runStore.getRun(input.run.id)!;
    this.runStore.updateRun(input.run.id, {
      status: 'running',
      usageJson: {
        nodesStarted: afterCreateRun.usageJson.nodesStarted + 1,
        wallClockMs: this.now() - input.runStartedAt,
      },
    });
    this.runStore.updateNode(node.id, { status: 'running' });
    this.runStore.appendEvent({
      runId: input.run.id,
      nodeId: node.id,
      kind: 'state-change',
      payload: { status: 'running' },
    });
    this.runStore.appendEvent({
      runId: input.run.id,
      nodeId: node.id,
      kind: 'progress',
      payload: { message: input.progressLabel, projectPath: input.project.canonicalPath },
    });

    if (!this.projectAgent) {
      const error = 'Project agent executor unavailable';
      const completedAt = this.now();
      const runningRun = this.runStore.getRun(input.run.id)!;
      this.runStore.updateNode(node.id, {
        status: 'blocked',
        completedAt,
        error,
      });
      this.runStore.updateRun(input.run.id, {
        status: 'blocked',
        completedAt,
        usageJson: {
          nodesCompleted: runningRun.usageJson.nodesCompleted + 1,
          wallClockMs: completedAt - input.runStartedAt,
        },
        error,
      });
      this.runStore.appendEvent({
        runId: input.run.id,
        nodeId: node.id,
        kind: 'state-change',
        payload: { status: 'blocked', reason: 'executor-unavailable' },
      });
      return { graph: this.runStore.getRunGraph(input.run.id)! };
    }

    const result = await this.projectAgent.execute({
      run: this.runStore.getRun(input.run.id)!,
      node,
      project: input.project,
      goal: input.goal,
      promptOverride: input.promptOverride,
      routing: input.routing,
    });
    const completedAt = this.now();
    const runningRun = this.runStore.getRun(input.run.id)!;
    const finalUsage: Partial<OperatorRunUsage> = {
      nodesCompleted: runningRun.usageJson.nodesCompleted + 1,
      wallClockMs: completedAt - input.runStartedAt,
    };

    if (result.externalRefKind === 'instance' && result.externalRefId) {
      this.runStore.appendEvent({
        runId: input.run.id,
        nodeId: node.id,
        kind: 'instance-spawn',
        payload: {
          instanceId: result.externalRefId,
          projectId: input.project.id,
          projectPath: input.project.canonicalPath,
        },
      });
    }
    this.runStore.appendEvent({
      runId: input.run.id,
      nodeId: node.id,
      kind: 'progress',
      payload: { message: 'Project agent finished', status: result.status },
    });

    const budgetBreach = evaluateOperatorBudget(this.runStore.getRun(input.run.id)!, {
      usageJson: finalUsage,
    });
    if (budgetBreach) {
      return {
        graph: this.blockRunForBudget(
          this.runStore.getRun(input.run.id)!,
          node,
          budgetBreach,
          finalUsage,
          result.outputJson,
        ),
      };
    }

    this.runStore.updateNode(node.id, {
      status: result.status,
      outputJson: result.outputJson,
      externalRefKind: result.externalRefKind,
      externalRefId: result.externalRefId,
      completedAt,
      error: result.error ?? null,
    });
    this.runStore.updateRun(input.run.id, {
      status: 'running',
      usageJson: finalUsage,
    });
    this.runStore.appendEvent({
      runId: input.run.id,
      nodeId: node.id,
      kind: 'state-change',
      payload: { status: result.status },
    });

    return {
      node: this.runStore.getNode(node.id)!,
      result,
    };
  }

  private async runVerificationNode(input: {
    run: OperatorRunRecord;
    project: OperatorProjectRecord;
    sourceNode: OperatorRunNodeRecord;
    attempt: number;
    runStartedAt: number;
  }): Promise<{
    run: OperatorRunRecord;
    node: OperatorRunNodeRecord;
    summary: OperatorVerificationSummary;
  } | { graph: OperatorRunGraph }> {
    const currentRun = this.runStore.getRun(input.run.id) ?? input.run;
    const startBreach = evaluateOperatorBudget(currentRun, {
      nodesToStart: 1,
      usageJson: { wallClockMs: this.now() - input.runStartedAt },
    });
    if (startBreach) {
      return {
        graph: this.blockRunForBudget(currentRun, null, startBreach, {
          wallClockMs: this.now() - input.runStartedAt,
        }),
      };
    }

    const node = this.runStore.createNode({
      runId: input.run.id,
      parentNodeId: input.sourceNode.id,
      type: 'verification',
      title: `Verify ${input.project.displayName}`,
      targetProjectId: input.project.id,
      targetPath: input.project.canonicalPath,
      inputJson: {
        projectId: input.project.id,
        projectPath: input.project.canonicalPath,
        sourceNodeId: input.sourceNode.id,
        attempt: input.attempt,
      },
    });
    const afterCreateRun = this.runStore.getRun(input.run.id)!;
    this.runStore.updateRun(input.run.id, {
      status: 'running',
      usageJson: {
        nodesStarted: afterCreateRun.usageJson.nodesStarted + 1,
        wallClockMs: this.now() - input.runStartedAt,
      },
    });
    this.runStore.updateNode(node.id, { status: 'running' });
    this.runStore.appendEvent({
      runId: input.run.id,
      nodeId: node.id,
      kind: 'state-change',
      payload: { status: 'running' },
    });
    this.runStore.appendEvent({
      runId: input.run.id,
      nodeId: node.id,
      kind: 'progress',
      payload: {
        message: 'Starting project verification',
        projectPath: input.project.canonicalPath,
        sourceNodeId: input.sourceNode.id,
        attempt: input.attempt,
      },
    });

    const summary = await this.verificationExecutor.execute({
      run: this.runStore.getRun(input.run.id)!,
      node: this.runStore.getNode(node.id)!,
      project: input.project,
    });
    const completedAt = this.now();
    const runningRun = this.runStore.getRun(input.run.id)!;
    const finalUsage: Partial<OperatorRunUsage> = {
      nodesCompleted: runningRun.usageJson.nodesCompleted + 1,
      wallClockMs: completedAt - input.runStartedAt,
    };
    const budgetBreach = evaluateOperatorBudget(runningRun, {
      usageJson: finalUsage,
    });
    if (budgetBreach) {
      return {
        graph: this.blockRunForBudget(
          runningRun,
          node,
          budgetBreach,
          finalUsage,
          summary as unknown as Record<string, unknown>,
        ),
      };
    }

    this.runStore.updateRun(input.run.id, {
      status: 'running',
      usageJson: finalUsage,
    });

    return {
      run: this.runStore.getRun(input.run.id)!,
      node: this.runStore.getNode(node.id)!,
      summary,
    };
  }

  private async completeRunAfterVerification(input: {
    runId: string;
    project: OperatorProjectRecord;
    verificationNode: OperatorRunNodeRecord;
    verificationSummary: OperatorVerificationSummary;
    latestProjectAgentOutput: Record<string, unknown>;
    runStartedAt: number;
  }): Promise<OperatorRunGraph> {
    const completedAt = this.now();
    const resultJson = {
      projectAgent: input.latestProjectAgentOutput,
      verification: input.verificationSummary,
    };
    this.runStore.updateNode(input.verificationNode.id, {
      status: 'completed',
      outputJson: input.verificationSummary as unknown as Record<string, unknown>,
      completedAt,
      error: null,
    });
    this.runStore.appendEvent({
      runId: input.runId,
      nodeId: input.verificationNode.id,
      kind: 'state-change',
      payload: { status: 'completed' },
    });
    return this.completeRunWithSynthesisAndFollowUps({
      runId: input.runId,
      parentNodeId: input.verificationNode.id,
      status: 'completed',
      resultJson,
      error: null,
      usageJson: { wallClockMs: completedAt - input.runStartedAt },
      completedAt,
      runStartedAt: input.runStartedAt,
      memoryPromotion: {
        eligible: isRunMemoryPromotionEligible(this.runStore.getRun(input.runId)!),
        projects: [input.project],
      },
      followUp: {
        eligible: isRunAutomationFollowUpEligible(this.runStore.getRun(input.runId)!),
        projects: [input.project],
      },
    });
  }

  private finishRunAfterProjectAgentNonCompletion(
    node: OperatorRunNodeRecord,
    result: ProjectAgentExecutionResult,
    runStartedAt: number,
  ): OperatorRunGraph {
    const completedAt = this.now();
    this.runStore.appendEvent({
      runId: node.runId,
      nodeId: node.id,
      kind: 'state-change',
      payload: { status: result.status },
    });
    return this.completeRunWithSynthesis({
      runId: node.runId,
      parentNodeId: node.id,
      status: result.status,
      resultJson: { projectAgent: result.outputJson },
      error: result.error ?? null,
      usageJson: { wallClockMs: completedAt - runStartedAt },
      completedAt,
      runStartedAt,
    });
  }

  private canStartFixAttempt(
    run: OperatorRunRecord,
  ): { allowed: true } | { allowed: false; breach: OperatorBudgetBreach } {
    const breach = evaluateOperatorBudget(run, {
      nodesToStart: 2,
      retriesToUse: 1,
    });
    return breach ? { allowed: false, breach } : { allowed: true };
  }

  private blockRunForBudget(
    run: OperatorRunRecord,
    node: OperatorRunNodeRecord | null,
    breach: OperatorBudgetBreach,
    usageJson: Partial<OperatorRunUsage>,
    outputJson?: Record<string, unknown>,
  ): OperatorRunGraph {
    const completedAt = this.now();
    const currentRun = this.runStore.getRun(run.id) ?? run;
    const usage = {
      ...currentRun.usageJson,
      ...usageJson,
    };

    this.runStore.appendEvent({
      runId: run.id,
      nodeId: node?.id ?? null,
      kind: 'budget',
      payload: budgetBreachPayload(breach, currentRun.budget, usage),
    });

    if (node) {
      this.runStore.updateNode(node.id, {
        status: 'blocked',
        outputJson: outputJson ?? node.outputJson,
        completedAt,
        error: breach.message,
      });
    }

    this.runStore.updateRun(run.id, {
      status: 'blocked',
      resultJson: outputJson ?? currentRun.resultJson,
      completedAt,
      usageJson,
      error: breach.message,
    });
    this.runStore.appendEvent({
      runId: run.id,
      nodeId: node?.id ?? null,
      kind: 'state-change',
      payload: { status: 'blocked' },
    });

    return this.runStore.getRunGraph(run.id)!;
  }

  private completeRunWithSynthesis(input: OperatorRunCompletionInput): OperatorRunGraph {
    const completedAt = input.completedAt ?? this.now();
    const currentGraph = this.requireRunGraph(input.runId);
    const usageBeforeSynthesis = {
      ...currentGraph.run.usageJson,
      ...(input.usageJson ?? {}),
    };
    const draftGraph: OperatorRunGraph = {
      ...currentGraph,
      run: {
        ...currentGraph.run,
        status: input.status,
        completedAt,
        resultJson: input.resultJson,
        usageJson: usageBeforeSynthesis,
        error: input.error,
      },
    };
    const synthesis: OperatorSynthesisResult = synthesizeOperatorRun(draftGraph);
    const synthesisNode = this.runStore.createNode({
      runId: input.runId,
      parentNodeId: input.parentNodeId ?? null,
      type: 'synthesis',
      title: 'Synthesize result',
      inputJson: {
        status: input.status,
      },
    });
    this.runStore.updateNode(synthesisNode.id, {
      status: 'completed',
      outputJson: synthesis as unknown as Record<string, unknown>,
      completedAt,
      error: null,
    });
    this.runStore.appendEvent({
      runId: input.runId,
      nodeId: synthesisNode.id,
      kind: 'state-change',
      payload: { status: 'completed' },
    });

    this.runStore.updateRun(input.runId, {
      status: input.status,
      resultJson: {
        ...(input.resultJson ?? {}),
        synthesis: synthesis as unknown as Record<string, unknown>,
      },
      completedAt,
      usageJson: {
        ...usageBeforeSynthesis,
        nodesStarted: usageBeforeSynthesis.nodesStarted + 1,
        nodesCompleted: usageBeforeSynthesis.nodesCompleted + 1,
        wallClockMs: completedAt - input.runStartedAt,
      },
      error: input.error,
    });
    this.runStore.appendEvent({
      runId: input.runId,
      kind: 'state-change',
      payload: { status: input.status },
    });

    let completedGraph = this.runStore.getRunGraph(input.runId)!;
    if (input.memoryPromotion?.eligible) {
      completedGraph = this.promoteRunMemory(completedGraph, input.memoryPromotion.projects);
    }

    return completedGraph;
  }

  private async completeRunWithSynthesisAndFollowUps(
    input: OperatorRunCompletionInput,
  ): Promise<OperatorRunGraph> {
    const graph = this.completeRunWithSynthesis(input);
    if (!input.followUp?.eligible) {
      return graph;
    }
    return this.scheduleRunFollowUp(graph, input.followUp.projects);
  }

  private promoteRunMemory(
    graph: OperatorRunGraph,
    projects: OperatorProjectRecord[],
  ): OperatorRunGraph {
    if (!this.memoryPromoter || projects.length === 0) {
      return graph;
    }

    try {
      const results = this.memoryPromoter.promote({ graph, projects });
      if (results.length > 0) {
        this.runStore.appendEvent({
          runId: graph.run.id,
          kind: 'progress',
          payload: {
            action: 'memory-promoted',
            projectCount: results.length,
            projectKeys: results.map((result) => result.projectKey),
            sourceIds: results.map((result) => result.sourceId),
            hintIds: results.map((result) => result.hintId),
          },
        });
      }
    } catch (error) {
      this.runStore.appendEvent({
        runId: graph.run.id,
        kind: 'recovery',
        payload: {
          action: 'memory-promotion-failed',
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }

    return this.runStore.getRunGraph(graph.run.id)!;
  }

  private async scheduleRunFollowUp(
    graph: OperatorRunGraph,
    projects: OperatorProjectRecord[],
  ): Promise<OperatorRunGraph> {
    if (!this.followUpScheduler || projects.length === 0) {
      return graph;
    }

    try {
      const result = await this.followUpScheduler.schedule({ graph, projects });
      if (result.status === 'created') {
        this.runStore.appendEvent({
          runId: graph.run.id,
          kind: 'progress',
          payload: {
            action: 'automation-follow-up-created',
            automationId: result.automationId,
            name: result.name,
            schedule: result.schedule,
          },
        });
      } else {
        this.runStore.appendEvent({
          runId: graph.run.id,
          kind: 'progress',
          payload: {
            action: 'automation-follow-up-skipped',
            reason: result.reason,
          },
        });
      }
    } catch (error) {
      this.runStore.appendEvent({
        runId: graph.run.id,
        kind: 'recovery',
        payload: {
          action: 'automation-follow-up-failed',
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }

    return this.runStore.getRunGraph(graph.run.id)!;
  }

  private buildProjectAgentRouting(input: {
    project: OperatorProjectRecord;
    plan: OperatorRequestPlan;
    goal: string;
  }): OperatorProjectAgentRouting {
    const decision = this.modelRouter.route(input.goal);
    const provider = inferProviderFromModel(decision.model);
    const remoteEligible = this.remoteRouting.enabled
      && (this.remoteRouting.preferRemoteForProject?.(input) ?? false);
    const nodePlacement = remoteEligible
      ? {
        ...(provider && provider !== 'auto' ? { requiresCli: provider } : {}),
        requiresWorkingDirectory: input.project.canonicalPath,
      }
      : undefined;
    const memoryPromotionEligible = input.plan.intent === 'project_feature'
      || input.plan.intent === 'project_audit'
      || input.plan.intent === 'cross_project_research';
    const automationFollowUpEligible = hasAutomationFollowUpRequest(input.goal);

    return {
      ...(provider && provider !== 'auto' ? { provider } : {}),
      modelOverride: decision.model,
      nodePlacement,
      audit: {
        source: 'operator-routing',
        reason: decision.reason,
        model: decision.model,
        complexity: decision.complexity,
        tier: decision.tier,
        confidence: decision.confidence,
        ...(provider && provider !== 'auto' ? { provider } : {}),
        remoteEligible,
        memoryPromotionEligible,
        automationFollowUpEligible,
      },
    };
  }

  private requireRunGraph(runId: string): OperatorRunGraph {
    const graph = this.runStore.getRunGraph(runId);
    if (!graph) {
      throw new Error(`Operator run not found: ${runId}`);
    }
    return graph;
  }

  private async cancelExternalNode(node: OperatorRunNodeRecord): Promise<void> {
    if (node.externalRefKind === 'instance' && node.externalRefId) {
      await this.instanceManager?.terminateInstance?.(node.externalRefId, true);
      return;
    }
    if (node.externalRefKind === 'repo-job' && node.externalRefId) {
      this.repoJob?.cancelJob?.(node.externalRefId);
    }
  }

  private getStaleExternalNodeReason(node: OperatorRunNodeRecord): string | null {
    if (node.externalRefKind === 'instance' && node.externalRefId) {
      const instance = this.instanceManager?.getInstance?.(node.externalRefId);
      if (!instance || isTerminalInstanceStatus(instance.status)) {
        return `linked instance ${node.externalRefId} is no longer active`;
      }
      return null;
    }

    if (node.externalRefKind === 'repo-job' && node.externalRefId && this.repoJob?.getJob) {
      const job = this.repoJob.getJob(node.externalRefId);
      if (!job || job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
        return `linked repo job ${node.externalRefId} is no longer active`;
      }
    }

    if (!node.externalRefKind && node.status === 'queued') {
      return 'queued node was not started before restart';
    }

    return null;
  }

  private completeRecoveredExternalNodeIfPossible(
    run: OperatorRunRecord,
    node: OperatorRunNodeRecord,
  ): OperatorRunGraph | null {
    if (node.externalRefKind === 'repo-job' && node.externalRefId && this.repoJob?.getJob) {
      const job = this.repoJob.getJob(node.externalRefId);
      if (!job || !isTerminalRepoJobStatus(job.status)) {
        return null;
      }

      const completedAt = this.now();
      const status = repoJobStatusToOperatorStatus(job.status);
      const outputJson = { repoJob: job as unknown as Record<string, unknown> };
      const error = status === 'completed' ? null : job.error ?? `Repo job ${job.status}`;
      this.runStore.updateNode(node.id, {
        status,
        outputJson,
        completedAt,
        error,
      });
      this.runStore.appendEvent({
        runId: run.id,
        nodeId: node.id,
        kind: 'recovery',
        payload: {
          action: 'completed-from-recovered-repo-job',
          repoJobId: job.id,
          status: job.status,
        },
      });
      this.runStore.appendEvent({
        runId: run.id,
        nodeId: node.id,
        kind: 'state-change',
        payload: { status, reason: 'startup-recovery' },
      });
      return this.completeRunWithSynthesis({
        runId: run.id,
        parentNodeId: node.id,
        status,
        resultJson: outputJson,
        error,
        usageJson: {
          nodesCompleted: Math.max(run.usageJson.nodesCompleted, 1),
          wallClockMs: completedAt - run.createdAt,
        },
        completedAt,
        runStartedAt: run.createdAt,
      });
    }

    if (node.externalRefKind === 'instance' && node.externalRefId && this.instanceManager?.getInstance) {
      const instance = this.instanceManager.getInstance(node.externalRefId);
      if (!instance || !isSettledInstanceStatus(instance.status)) {
        return null;
      }

      const completedAt = this.now();
      const status = instanceStatusToOperatorStatus(instance.status);
      const finalMessage = [...(instance.outputBuffer ?? [])]
        .reverse()
        .find((message) => message.type === 'assistant' || message.type === 'error' || message.type === 'system');
      const outputJson = {
        instanceId: instance.id,
        finalStatus: instance.status,
        outputPreview: finalMessage?.content.slice(0, 2000) ?? null,
        changedFiles: changedFilesFromInstance(instance),
        ...(instance.diffStats ? { diffStats: instance.diffStats } : {}),
      };
      const error = status === 'completed' ? null : `Project agent ended with status ${instance.status}`;
      this.runStore.updateNode(node.id, {
        status,
        outputJson,
        completedAt,
        error,
      });
      this.runStore.touchInstanceLink(instance.id, 'recovered');
      this.runStore.appendEvent({
        runId: run.id,
        nodeId: node.id,
        kind: 'recovery',
        payload: {
          action: 'completed-from-recovered-instance',
          instanceId: instance.id,
          status: instance.status,
        },
      });
      this.runStore.appendEvent({
        runId: run.id,
        nodeId: node.id,
        kind: 'state-change',
        payload: { status, reason: 'startup-recovery' },
      });
      return this.completeRunWithSynthesis({
        runId: run.id,
        parentNodeId: node.id,
        status,
        resultJson: { projectAgent: outputJson },
        error,
        usageJson: {
          nodesCompleted: Math.max(run.usageJson.nodesCompleted, 1),
          wallClockMs: completedAt - run.createdAt,
        },
        completedAt,
        runStartedAt: run.createdAt,
      });
    }

    return null;
  }

  private markExternalNodeRecovered(node: OperatorRunNodeRecord): void {
    if (node.externalRefKind === 'instance' && node.externalRefId) {
      this.runStore.touchInstanceLink(node.externalRefId, 'recovered');
    }
  }
}

export function getOperatorEngine(config?: OperatorEngineConfig): OperatorEngine {
  return OperatorEngine.getInstance(config);
}

class OperatorGraphCompletion extends Error {
  constructor(readonly graph: OperatorRunGraph) {
    super('Operator graph completed');
  }
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), values.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < values.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(values[currentIndex]!, currentIndex);
    }
  }));
  return results;
}

function withRoutingInputJson(
  inputJson: Record<string, unknown>,
  routing?: OperatorProjectAgentRouting,
): Record<string, unknown> {
  return routing
    ? { ...inputJson, routing: routing.audit }
    : inputJson;
}

function isRunMemoryPromotionEligible(run: OperatorRunRecord): boolean {
  const routing = asRecord(run.planJson['routing']);
  return routing?.['memoryPromotionEligible'] === true;
}

function isRunAutomationFollowUpEligible(run: OperatorRunRecord): boolean {
  const routing = asRecord(run.planJson['routing']);
  return routing?.['automationFollowUpEligible'] === true;
}

function inferProviderFromModel(model: string): InstanceProvider | undefined {
  const normalized = model.toLowerCase();
  if (normalized.includes('gemini')) return 'gemini';
  if (normalized.includes('gpt') || normalized.includes('codex')) return 'codex';
  if (
    normalized.includes('claude')
    || normalized.includes('opus')
    || normalized.includes('sonnet')
    || normalized.includes('haiku')
  ) {
    return 'claude';
  }
  if (normalized.includes('copilot')) return 'copilot';
  if (normalized.includes('cursor')) return 'cursor';
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readProjectAgentOutputPreview(node: OperatorRunNodeRecord): string | null {
  const preview = node.outputJson?.['outputPreview'];
  return typeof preview === 'string' ? preview : null;
}

function readProjectAgentOutputPreviewFromJson(outputJson: Record<string, unknown>): string | null {
  const preview = outputJson['outputPreview'];
  return typeof preview === 'string' ? preview : null;
}

function hasAutomationFollowUpRequest(text: string): boolean {
  return /\b(remind|schedule|every|daily|weekly|follow[- ]?up|check back)\b/i.test(text);
}

function projectSummary(project: OperatorProjectRecord): Record<string, unknown> {
  return {
    id: project.id,
    displayName: project.displayName,
    canonicalPath: project.canonicalPath,
    source: project.source,
    isPinned: project.isPinned,
    currentBranch: project.currentBranch,
  };
}

function isProjectUnderRoot(project: OperatorProjectRecord, rootPath: string): boolean {
  const root = path.resolve(rootPath);
  const projectPath = path.resolve(project.canonicalPath);
  const relative = path.relative(root, projectPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function isTerminalRunStatus(status: OperatorRunStatus): boolean {
  return status === 'completed'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'blocked';
}

function isTerminalInstanceStatus(status: Instance['status']): boolean {
  return status === 'terminated'
    || status === 'error'
    || status === 'failed'
    || status === 'cancelled'
    || status === 'superseded'
    || status === 'hibernated';
}

function isSettledInstanceStatus(status: Instance['status']): boolean {
  return status === 'idle'
    || status === 'waiting_for_input'
    || isTerminalInstanceStatus(status);
}

function instanceStatusToOperatorStatus(status: Instance['status']): OperatorRunStatus {
  if (status === 'cancelled') return 'cancelled';
  if (status === 'idle' || status === 'waiting_for_input') return 'completed';
  return 'failed';
}

function changedFilesFromInstance(instance: Instance): string[] {
  return Object.values(instance.diffStats?.files ?? {})
    .map((entry) => entry.path)
    .sort((a, b) => a.localeCompare(b));
}

function isTerminalRepoJobStatus(status: RepoJobRecord['status']): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function repoJobStatusToOperatorStatus(status: RepoJobRecord['status']): OperatorRunStatus {
  if (status === 'completed') return 'completed';
  if (status === 'cancelled') return 'cancelled';
  if (status === 'failed') return 'failed';
  return 'waiting';
}

function verificationFailureMessage(
  project: OperatorProjectRecord,
  summary: OperatorVerificationSummary,
): string {
  const failedLabels = summary.checks
    .filter((check) => check.required && check.status === 'failed')
    .map((check) => check.label);
  const suffix = failedLabels.length > 0 ? `: ${failedLabels.join(', ')}` : '';
  return `Verification failed for ${project.displayName}${suffix}`;
}
