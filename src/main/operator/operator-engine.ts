import * as os from 'os';
import * as path from 'path';
import type {
  OperatorGitBatchSummary,
  OperatorProjectRecord,
  OperatorProjectResolution,
  OperatorRunBudget,
  OperatorRunNodeRecord,
  OperatorRunRecord,
  OperatorRunGraph,
  OperatorShellCommandEventPayload,
  OperatorRunUsage,
  OperatorVerificationSummary,
} from '../../shared/types/operator.types';
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

export interface OperatorEngineMessageInput {
  threadId: string;
  sourceMessageId: string;
  text: string;
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
}

interface ProjectAgentExecutorLike {
  execute(input: ProjectAgentExecutionInput): Promise<ProjectAgentExecutionResult>;
}

interface OperatorVerificationExecutorLike {
  execute(input: OperatorVerificationExecutionInput): Promise<OperatorVerificationSummary>;
}

export interface OperatorEngineConfig {
  runStore?: OperatorRunStore;
  gitBatch?: GitBatchExecutor;
  projectRegistry?: ProjectRegistryResolver;
  projectAgent?: ProjectAgentExecutorLike;
  verificationExecutor?: OperatorVerificationExecutorLike;
  instanceManager?: ProjectAgentInstanceManager;
  resolveWorkRoot?: (text: string) => string;
  defaultBudget?: Partial<OperatorRunBudget>;
  now?: () => number;
}

export class OperatorEngine {
  private static instance: OperatorEngine | null = null;
  private readonly runStore: OperatorRunStore;
  private readonly gitBatch: GitBatchExecutor;
  private readonly projectRegistry: ProjectRegistryResolver | null;
  private readonly projectAgent: ProjectAgentExecutorLike | null;
  private readonly verificationExecutor: OperatorVerificationExecutorLike;
  private readonly resolveWorkRoot: (text: string) => string;
  private readonly defaultBudget?: Partial<OperatorRunBudget>;
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
    this.projectAgent = config.projectAgent
      ?? (config.instanceManager
        ? new ProjectAgentExecutor({ instanceManager: config.instanceManager, runStore: this.runStore })
        : null);
    this.verificationExecutor = config.verificationExecutor
      ?? new OperatorVerificationExecutor({ runStore: this.runStore });
    this.resolveWorkRoot = config.resolveWorkRoot ?? defaultWorkRoot;
    this.defaultBudget = config.defaultBudget;
    this.now = config.now ?? Date.now;
  }

  async handleUserMessage(input: OperatorEngineMessageInput): Promise<OperatorRunGraph | null> {
    if (isPullAllReposRequest(input.text)) {
      return this.handleGitBatchRequest(input);
    }

    const projectTask = parseProjectTaskRequest(input.text);
    if (projectTask) {
      return this.handleProjectTaskRequest(input, projectTask);
    }

    return null;
  }

  private async handleGitBatchRequest(input: OperatorEngineMessageInput): Promise<OperatorRunGraph> {
    const rootPath = this.resolveWorkRoot(input.text);
    const startedAt = this.now();
    const run = this.runStore.createRun({
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
      title: 'Pull repositories',
      goal: input.text,
      budget: this.defaultBudget,
      planJson: {
        intent: 'workspace_git_batch',
        executor: 'git-batch',
        rootPath,
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
    this.runStore.updateRun(run.id, {
      status: terminalStatus,
      resultJson: summary as unknown as Record<string, unknown>,
      completedAt,
      usageJson: finalUsage,
      error: summary.failed > 0 ? 'One or more repositories failed' : null,
    });
    this.runStore.appendEvent({
      runId: run.id,
      nodeId: node.id,
      kind: 'state-change',
      payload: { status: terminalStatus },
    });

    return this.runStore.getRunGraph(run.id)!;
  }

  private async handleProjectTaskRequest(
    input: OperatorEngineMessageInput,
    request: { projectQuery: string; goal: string; intent: 'project_feature' | 'project_audit' },
  ): Promise<OperatorRunGraph> {
    const runStartedAt = this.now();
    const resolution = (this.projectRegistry ?? getProjectRegistry()).resolveProject(request.projectQuery);
    const project = resolution.project;
    const run = this.runStore.createRun({
      threadId: input.threadId,
      sourceMessageId: input.sourceMessageId,
      title: project ? `Implement in ${project.displayName}` : `Implement in ${request.projectQuery}`,
      goal: input.text,
      budget: this.defaultBudget,
      planJson: {
        intent: request.intent,
        executor: 'project-agent',
        projectQuery: request.projectQuery,
        resolvedStatus: resolution.status,
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
      this.runStore.updateRun(run.id, {
        status: 'blocked',
        completedAt: this.now(),
        error,
      });
      this.runStore.appendEvent({
        runId: run.id,
        kind: 'state-change',
        payload: { status: 'blocked', reason: 'project-resolution', error },
      });
      return this.runStore.getRunGraph(run.id)!;
    }

    const initialAgent = await this.runProjectAgentNode({
      run,
      project,
      goal: request.goal,
      projectQuery: request.projectQuery,
      runStartedAt,
      title: `Implement in ${project.displayName}`,
      progressLabel: 'Starting project agent',
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
      inputJson: input.inputJson ?? {
        goal: input.goal,
        projectQuery: input.projectQuery,
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

  private completeRunAfterVerification(input: {
    runId: string;
    verificationNode: OperatorRunNodeRecord;
    verificationSummary: OperatorVerificationSummary;
    latestProjectAgentOutput: Record<string, unknown>;
    runStartedAt: number;
  }): OperatorRunGraph {
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
    this.runStore.updateRun(input.runId, {
      status: 'completed',
      resultJson,
      completedAt,
      usageJson: { wallClockMs: completedAt - input.runStartedAt },
      error: null,
    });
    this.runStore.appendEvent({
      runId: input.runId,
      nodeId: input.verificationNode.id,
      kind: 'state-change',
      payload: { status: 'completed' },
    });
    return this.runStore.getRunGraph(input.runId)!;
  }

  private finishRunAfterProjectAgentNonCompletion(
    node: OperatorRunNodeRecord,
    result: ProjectAgentExecutionResult,
    runStartedAt: number,
  ): OperatorRunGraph {
    const completedAt = this.now();
    this.runStore.updateRun(node.runId, {
      status: result.status,
      resultJson: result.outputJson,
      completedAt,
      usageJson: { wallClockMs: completedAt - runStartedAt },
      error: result.error ?? null,
    });
    this.runStore.appendEvent({
      runId: node.runId,
      nodeId: node.id,
      kind: 'state-change',
      payload: { status: result.status },
    });
    return this.runStore.getRunGraph(node.runId)!;
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
}

export function getOperatorEngine(config?: OperatorEngineConfig): OperatorEngine {
  return OperatorEngine.getInstance(config);
}

function isPullAllReposRequest(text: string): boolean {
  const normalized = text.toLowerCase();
  return /\bpull\b/.test(normalized)
    && /\brepos?\b|\brepositories\b/.test(normalized);
}

function parseProjectTaskRequest(
  text: string,
): { projectQuery: string; goal: string; intent: 'project_feature' | 'project_audit' } | null {
  const explicitPrefix = text.match(/^\s*in\s+([^,]+),\s*(.+)$/i);
  if (explicitPrefix) {
    const projectQuery = explicitPrefix[1].trim();
    const goal = explicitPrefix[2].trim();
    if (
      projectQuery
      && goal
      && /\b(implement|build|add|allow|create|fix|change|update)\b/i.test(goal)
    ) {
      return { projectQuery, goal, intent: 'project_feature' };
    }
  }

  const projectMention = text.match(/\b(?:in|for)\s+(?:the\s+)?(.+?)\s+project\b/i);
  if (!projectMention) {
    return null;
  }
  const projectQuery = projectMention[1].trim();
  if (!projectQuery) {
    return null;
  }

  if (/\b(audit|improve|improvements|go through|review|list)\b/i.test(text)) {
    return { projectQuery, goal: text.trim(), intent: 'project_audit' };
  }

  if (/\b(implement|build|add|allow|create|fix|change|update)\b/i.test(text)) {
    return { projectQuery, goal: text.trim(), intent: 'project_feature' };
  }

  return null;
}

function defaultWorkRoot(text: string): string {
  if (/\bwork folder\b|\bwork directory\b|\bwork dir\b/.test(text.toLowerCase())) {
    return path.join(os.homedir(), 'work');
  }
  return process.cwd();
}

function readProjectAgentOutputPreview(node: OperatorRunNodeRecord): string | null {
  const preview = node.outputJson?.['outputPreview'];
  return typeof preview === 'string' ? preview : null;
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
