/**
 * Instance Orchestration Manager - Handles child instance spawning and fast-path retrieval
 */

import { spawn } from 'child_process';
import { getLogger } from '../logging/logger';
import { OrchestrationHandler } from '../orchestration/orchestration-handler';
import { OutcomeTracker } from '../learning/outcome-tracker';
import { StrategyLearner } from '../learning/strategy-learner';
import { getTaskManager } from '../orchestration/task-manager';
import { getChildResultStorage } from '../orchestration/child-result-storage';
import { getChildAnnouncer } from '../orchestration/child-announcer';
import { getModelRouter, type RoutingDecision, type ModelRouter } from '../routing';
import { getUnifiedMemory } from '../memory';
import { getHabitTracker } from '../learning/habit-tracker';
import { getPreferenceStore } from '../learning/preference-store';
import { getAgentById, getDefaultAgent } from '../../shared/types/agent.types';
import {
  isModelTier,
  normalizeModelAliasForProvider,
  resolveModelForTier,
} from '../../shared/types/provider.types';
import type {
  SpawnChildCommand,
  MessageChildCommand,
  TerminateChildCommand,
  GetChildOutputCommand
} from '../orchestration/orchestration-protocol';
import type { Instance, OutputMessage } from '../../shared/types/instance.types';
import type { TaskExecution, TaskProgress } from '../../shared/types/task.types';
import type { ToolUsageRecord } from '../../shared/types/self-improvement.types';
import type { FastPathResult } from './instance-types';
import { getChildErrorClassifier } from '../orchestration/child-error-classifier';
import type { ChildAnnouncement, ChildErrorClassification } from '../../shared/types/child-announce.types';
import type {
  ReportResultCommand,
  GetChildSummaryCommand,
  GetChildArtifactsCommand,
  GetChildSectionCommand,
  ChildSummaryResponse,
  ChildArtifactsResponse,
  ChildSectionResponse,
} from '../../shared/types/child-result.types';
import { SpawnChildPayloadSchema } from '@contracts/schemas/orchestration';
import { emitPluginHook } from '../plugins/hook-emitter';
import type { PluginRoutingAudit } from '../../shared/types/plugin.types';

/**
 * Dependencies required by the orchestration manager
 */
export interface OrchestrationDependencies {
  getInstance: (id: string) => Instance | undefined;
  getInstanceCount: () => number;
  createChildInstance: (parentId: string, command: SpawnChildCommand, routingDecision: RoutingDecision) => Promise<Instance>;
  sendInput: (instanceId: string, message: string) => Promise<void>;
  terminateInstance: (instanceId: string, graceful: boolean) => Promise<void>;
  getAdapter: (id: string) => any;
}

const logger = getLogger('InstanceOrchestration');

function getChildRoutingAudit(child: Instance): PluginRoutingAudit | undefined {
  const orchestration = child.metadata?.['orchestration'];
  if (!orchestration || typeof orchestration !== 'object') {
    return undefined;
  }
  const audit = (orchestration as Record<string, unknown>)['routingAudit'];
  if (!audit || typeof audit !== 'object') {
    return undefined;
  }
  return audit as PluginRoutingAudit;
}

export class InstanceOrchestrationManager {
  private orchestration: OrchestrationHandler;
  private outcomeTracker = OutcomeTracker.getInstance();
  private strategyLearner = StrategyLearner.getInstance();
  private unifiedMemory = getUnifiedMemory();
  private deps: OrchestrationDependencies;
  /** Per-instance write queues to prevent concurrent stdin writes */
  private writeQueues = new Map<string, Promise<void>>();
  /** Mutable settings ref — handlers read this, so they always see current values */
  private orchestrationSettings = { maxTotalInstances: 0, maxChildrenPerParent: 0, allowNestedOrchestration: false };
  /** Guard to prevent duplicate listener registration */
  private handlersRegistered = false;

  constructor(deps: OrchestrationDependencies) {
    this.deps = deps;
    this.orchestration = new OrchestrationHandler();
  }

  /**
   * Get the orchestration handler
   */
  getOrchestrationHandler(): OrchestrationHandler {
    return this.orchestration;
  }

  /**
   * Whether orchestration is currently doing work on behalf of an instance.
   */
  hasActiveWork(instanceId: string): boolean {
    return this.orchestration.hasActiveWork(instanceId);
  }

  /**
   * Register an instance with orchestration
   */
  registerInstance(instanceId: string, workingDirectory: string, parentId: string | null): void {
    this.orchestration.registerInstance(instanceId, workingDirectory, parentId);
  }

  /**
   * Unregister an instance from orchestration
   */
  unregisterInstance(instanceId: string): void {
    this.orchestration.unregisterInstance(instanceId);
  }

  /**
   * Process orchestration output
   */
  processOrchestrationOutput(instanceId: string, content: string): void {
    this.orchestration.processOutput(instanceId, content);
  }

  /**
   * Get orchestration prompt for first message
   */
  getOrchestrationPrompt(instanceId: string, currentModel?: string): string {
    return this.orchestration.getOrchestrationPrompt(instanceId, currentModel);
  }

  // ============================================
  // Orchestration Event Handlers Setup
  // ============================================

  /**
   * Set up orchestration event handlers.
   *
   * Separates settings update from listener registration to prevent
   * duplicate listener accumulation (each .on() call appends a new listener).
   * Handlers read from this.orchestrationSettings so they always see current values.
   */
  setupOrchestrationHandlers(
    settings: { maxTotalInstances: number; maxChildrenPerParent: number; allowNestedOrchestration: boolean },
    addToOutputBuffer: (instance: Instance, message: OutputMessage) => void,
    publishOutput: (instanceId: string, message: OutputMessage) => void,
  ): void {
    // Always update the mutable settings ref — handlers read from this field
    this.orchestrationSettings = { ...settings };

    // Only register listeners once — subsequent calls just update settings above
    if (this.handlersRegistered) {
      logger.debug('Orchestration settings updated (handlers already registered)', {
        maxTotalInstances: settings.maxTotalInstances,
        maxChildrenPerParent: settings.maxChildrenPerParent,
      });
      return;
    }
    this.handlersRegistered = true;

    // Handle spawn child requests
    this.orchestration.on(
      'spawn-child',
      async (parentId: string, command: SpawnChildCommand) => {
        const parent = this.deps.getInstance(parentId);
        if (!parent) return;

        const validation = SpawnChildPayloadSchema.safeParse({
          parentInstanceId: parentId,
          task: command.task,
          name: command.name,
          agentId: command.agentId,
          model: command.model,
          provider: command.provider,
        });
        if (!validation.success) {
          const issue = validation.error.issues[0];
          this.orchestration.notifyError(
            parentId,
            `Invalid spawn_child command: ${issue?.path.join('.') || 'payload'} ${issue?.message || 'failed validation'}`,
          );
          return;
        }

        // Check max total instances limit
        if (
          this.orchestrationSettings.maxTotalInstances > 0 &&
          this.deps.getInstanceCount() >= this.orchestrationSettings.maxTotalInstances
        ) {
          logger.info('Cannot spawn child: max total instances reached', { maxTotalInstances: this.orchestrationSettings.maxTotalInstances });
          this.orchestration.notifyError(
            parentId,
            `Cannot spawn child: maximum total instances (${this.orchestrationSettings.maxTotalInstances}) reached`
          );
          return;
        }

        // Check max children per parent limit (active + completed to prevent spawn loops)
        const completedChildCount = this.orchestration.getCompletedChildIds(parentId).length;
        const totalChildrenSpawned = parent.childrenIds.length + completedChildCount;
        if (
          this.orchestrationSettings.maxChildrenPerParent > 0 &&
          totalChildrenSpawned >= this.orchestrationSettings.maxChildrenPerParent
        ) {
          logger.info('Cannot spawn child: max children per parent reached', {
            maxChildrenPerParent: this.orchestrationSettings.maxChildrenPerParent,
            active: parent.childrenIds.length,
            completed: completedChildCount,
          });
          this.orchestration.notifyError(
            parentId,
            `Cannot spawn child: maximum children per parent (${this.orchestrationSettings.maxChildrenPerParent}) reached (${parent.childrenIds.length} active, ${completedChildCount} completed)`
          );
          return;
        }

        // Check if parent is already a child (nested orchestration)
        if (!this.orchestrationSettings.allowNestedOrchestration && parent.depth > 0) {
          logger.info('Cannot spawn child: nested orchestration is disabled');
          this.orchestration.notifyError(
            parentId,
            'Cannot spawn child: nested orchestration is not allowed'
          );
          return;
        }

        try {
          // Fast-path retrieval: skip spawning a child for simple lookup tasks
          if (await this.tryFastPathRetrieval(parent, command)) {
            return;
          }

          const childAgentId = this.resolveChildAgentId(command);

          // Use intelligent model routing if no explicit model specified
          const routingDecision = this.routeChildModel(
            command.task,
            command.model,
            childAgentId,
            command.provider
          );

          logger.info('Child task routed', { model: routingDecision.model, complexity: routingDecision.complexity, confidence: routingDecision.confidence, reason: routingDecision.reason });
          if (
            routingDecision.estimatedSavingsPercent &&
            routingDecision.estimatedSavingsPercent > 0
          ) {
            logger.info('Estimated cost savings from model routing', { savingsPercent: routingDecision.estimatedSavingsPercent });
          }

	          const child = await this.deps.createChildInstance(parentId, command, routingDecision);
	          emitPluginHook('orchestration.child.started', {
	            parentId,
	            childId: child.id,
	            task: command.task,
	            name: child.displayName,
	            routing: getChildRoutingAudit(child),
	            timestamp: Date.now(),
	          });

	          this.orchestration.notifyChildSpawned(
            parentId,
            child.id,
            child.displayName,
            routingDecision
          );
        } catch (error) {
          logger.error('Failed to spawn child', error instanceof Error ? error : undefined);
          this.orchestration.notifyError(
            parentId,
            `Failed to spawn child: ${error}`
          );
        }
      }
    );

    // Handle message child requests
    this.orchestration.on(
      'message-child',
      async (parentId: string, command: MessageChildCommand) => {
        try {
          await this.deps.sendInput(command.childId, command.message);
          this.orchestration.notifyMessageSent(parentId, command.childId);
        } catch (error) {
          logger.error('Failed to message child', error instanceof Error ? error : undefined);
        }
      }
    );

    // Handle get children requests
    this.orchestration.on(
      'get-children',
      (parentId: string, callback: (children: any[]) => void) => {
        const parent = this.deps.getInstance(parentId);
        if (!parent) {
          callback([]);
          return;
        }

        const children = parent.childrenIds
          .map((childId) => {
            const child = this.deps.getInstance(childId);
            return child
              ? {
                  id: child.id,
                  name: child.displayName,
                  status: child.status,
                  createdAt: child.createdAt
                }
              : null;
          })
          .filter(Boolean);

        callback(children);
      }
    );

    // Handle terminate child requests
    this.orchestration.on(
      'terminate-child',
      async (parentId: string, command: TerminateChildCommand) => {
        try {
          // Announce to parent before terminating — must await to capture child state before cleanup
          const child = this.deps.getInstance(command.childId);
          if (child) {
            await this.announceChildCompletion(child, parentId);
          }
          await this.deps.terminateInstance(command.childId, true);
          this.orchestration.notifyChildTerminated(parentId, command.childId);
        } catch (error) {
          logger.error('Failed to terminate child', error instanceof Error ? error : undefined);
        }
      }
    );

    // Handle get child output requests
    this.orchestration.on(
      'get-child-output',
      (
        parentId: string,
        command: GetChildOutputCommand,
        callback: (output: string[]) => void
      ) => {
        const child = this.deps.getInstance(command.childId);
        if (!child) {
          callback([]);
          return;
        }

        const lastN = command.lastN || 100;
        const messages = child.outputBuffer.slice(-lastN).map((msg) => {
          return `[${msg.type}] ${msg.content}`;
        });

        callback(messages);
      }
    );

    this.orchestration.on(
      'task-complete',
      (parentId: string, childId: string, task: TaskExecution) => {
        this.recordOrchestrationOutcome(parentId, childId, task, true);
      }
    );

    this.orchestration.on(
      'task-progress',
      (parentId: string, childId: string, progress: TaskProgress) => {
        emitPluginHook('orchestration.child.progress', {
          parentId,
          childId,
          percentage: progress.percentage,
          currentStep: progress.currentStep,
          timestamp: Date.now(),
        });
      }
    );

    this.orchestration.on(
      'task-error',
      (
        parentId: string,
        childId: string,
        error: { code: string; message: string }
      ) => {
        const task = this.findTaskForChild(parentId, childId);
        this.recordOrchestrationOutcome(parentId, childId, task, false, error);
      }
    );

    // Handle response injection with serialized writes per instance
    this.orchestration.on(
      'inject-response',
      (instanceId: string, response: string) => {
        // Guard against empty responses — sending empty user messages causes API 400 errors
        if (!response || !response.trim()) {
          logger.warn('Skipping inject-response with empty content', { instanceId });
          return;
        }

        const adapter = this.deps.getAdapter(instanceId);
        const instance = this.deps.getInstance(instanceId);

        if (adapter && instance) {
          const actionMatch = response.match(/Action:\s*(\w+)/);
          const statusMatch = response.match(/Status:\s*(\w+)/);
          const action = actionMatch ? actionMatch[1] : 'unknown';
          const status = statusMatch ? statusMatch[1] : 'unknown';

          let data: any = {};
          try {
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              data = JSON.parse(jsonMatch[0]);
            }
          } catch (e) {
            logger.warn('Failed to parse JSON data from orchestration response', { error: e instanceof Error ? e.message : String(e) });
          }

          const friendlyContent = this.buildFriendlyOrchestrationMessage(action, status, data);

          const orchestrationMessage = {
            id: `orch-${Date.now()}`,
            timestamp: Date.now(),
            type: 'system' as const,
            content: friendlyContent,
            metadata: { source: 'orchestration', action, status, rawData: data }
          };
          addToOutputBuffer(instance, orchestrationMessage);
          publishOutput(instanceId, orchestrationMessage);

          // Serialize writes per instance to prevent concurrent stdin corruption
          const prev = this.writeQueues.get(instanceId) ?? Promise.resolve();
          const next = prev.then(async () => {
            try {
              await adapter.sendInput(response);
            } catch (err) {
              logger.error('Failed to inject response to instance', err instanceof Error ? err : undefined, { instanceId });
            }
          });
          this.writeQueues.set(instanceId, next);
        }
      }
    );

    // ============================================
    // Structured Result Handlers
    // ============================================

    // Handle report_result from child
    this.orchestration.on(
      'report-result',
      async (
        childId: string,
        command: ReportResultCommand,
        callback: (response: ChildSummaryResponse | null) => void
      ) => {
        const child = this.deps.getInstance(childId);
        if (!child || !child.parentId) {
          callback(null);
          return;
        }

        const taskManager = getTaskManager();
        const task = taskManager.getTaskByChildId(childId);
        const storage = getChildResultStorage();

        try {
          const result = await storage.storeResult(
            childId,
            child.parentId,
            task?.task || 'Unknown task',
            command,
            child.outputBuffer,
            child.createdAt
          );

	          const summary = await storage.getChildSummary(childId);
	          callback(summary);
	          emitPluginHook('orchestration.child.result.reported', {
	            parentId: child.parentId,
	            childId,
	            name: child.displayName,
	            success: command.success !== false,
	            summary: command.summary,
	            resultId: result.id,
	            artifactCount: result.artifactCount,
	            timestamp: Date.now(),
	          });

	          // Also record task completion
          if (task) {
            taskManager.completeTask(task.taskId, {
              success: command.success !== false,
              summary: command.summary,
              data: { resultId: result.id },
            });
          }
        } catch (error) {
          logger.error('Failed to store child result', error instanceof Error ? error : undefined);
          callback(null);
        }
      }
    );

    // Handle get_child_summary from parent
    this.orchestration.on(
      'get-child-summary',
      async (
        _parentId: string,
        command: GetChildSummaryCommand,
        callback: (response: ChildSummaryResponse | null) => void
      ) => {
        const storage = getChildResultStorage();
        const summary = await storage.getChildSummary(command.childId);
        callback(summary);
      }
    );

    // Handle get_child_artifacts from parent
    this.orchestration.on(
      'get-child-artifacts',
      async (
        _parentId: string,
        command: GetChildArtifactsCommand,
        callback: (response: ChildArtifactsResponse | null) => void
      ) => {
        const storage = getChildResultStorage();
        const artifacts = await storage.getChildArtifacts(
          command.childId,
          command.types,
          command.severity,
          command.limit
        );
        callback(artifacts);
      }
    );

    // Handle get_child_section from parent
    this.orchestration.on(
      'get-child-section',
      async (
        _parentId: string,
        command: GetChildSectionCommand,
        callback: (response: ChildSectionResponse | null) => void
      ) => {
        const storage = getChildResultStorage();
        const section = await storage.getChildSection(
          command.childId,
          command.section,
          command.artifactId,
          command.includeContext
        );
        callback(section);
      }
    );
  }

  // ============================================
  // Child Announcements
  // ============================================

  /**
   * Build a ChildAnnouncement from a completed/failed child instance.
   * Fetches stored result summary if available, falls back to instance status.
   */
  async buildAnnouncement(child: Instance, parentId: string): Promise<ChildAnnouncement | null> {
    const resultStorage = getChildResultStorage();
    const storedResult = await resultStorage.getChildSummary(child.id);

    const isFailed = child.status === 'failed' || child.status === 'error';

    let errorClassification: ChildErrorClassification | undefined;
    if (isFailed) {
      // Find the last error message in the output buffer
      const lastError = child.outputBuffer
        .filter(m => m.type === 'error')
        .pop();
      const errorText = lastError?.content ?? `Instance ended with status: ${child.status}`;
      errorClassification = getChildErrorClassifier().classify(errorText, child.status);
    }

    return {
      childId: child.id,
      parentId,
      childName: child.displayName,
      success: storedResult?.success ?? (child.status !== 'failed' && child.status !== 'error'),
      summary: storedResult?.summary ?? `Child "${child.displayName}" finished with status: ${child.status}`,
      conclusions: storedResult?.conclusions ?? [],
      errorClassification,
      duration: Date.now() - child.createdAt,
      tokensUsed: child.totalTokensUsed,
      completedAt: Date.now(),
    };
  }

  /**
   * Announce a child's completion to its parent.
   * Must be awaited before terminating the child to avoid a race condition.
   */
  async announceChildCompletion(child: Instance, parentId: string): Promise<void> {
    try {
      const announcement = await this.buildAnnouncement(child, parentId);
      if (announcement) {
        getChildAnnouncer().announce(announcement);
      }
    } catch (err) {
      logger.warn('Failed to build child announcement', {
        childId: child.id,
        parentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ============================================
  // Model Routing
  // ============================================

  /**
   * Route a child task to the optimal model based on complexity.
   *
   * When a non-Claude provider is targeted, the routing result is automatically
   * resolved to that provider's equivalent model for the same tier, ensuring
   * children always get a valid model ID for their provider.
   */
  routeChildModel(
    task: string,
    explicitModel?: string,
    agentId?: string,
    provider?: string
  ): RoutingDecision {
    const router = getModelRouter();
    const providerForModel = provider && provider !== 'auto' ? provider : undefined;
    const normalizedExplicitModel = providerForModel
      ? normalizeModelAliasForProvider(providerForModel, explicitModel)
      : explicitModel;
    const decision = this.computeRoutingDecision(router, task, normalizedExplicitModel, agentId);
    const hasExplicitConcreteModel = Boolean(
      normalizedExplicitModel && !isModelTier(normalizedExplicitModel)
    );

    // If the target is a non-Claude provider, resolve the decision's tier
    // to that provider's concrete model ID. This handles:
    //   - Explicit tier names (e.g., model: "powerful", provider: "gemini")
    //   - Auto-routed Claude model IDs that need cross-provider mapping
    if (provider && provider !== 'auto' && provider !== 'claude') {
      if (hasExplicitConcreteModel) {
        return {
          ...decision,
          model: normalizedExplicitModel!,
          reason: `${decision.reason} for ${provider}`,
        };
      }

      const resolvedId = resolveModelForTier(decision.tier, provider);
      if (resolvedId) {
        logger.info('Resolved model for target provider', {
          originalModel: decision.model,
          tier: decision.tier,
          provider,
          resolvedModel: resolvedId
        });
        return {
          ...decision,
          model: resolvedId,
          reason: `${decision.reason} → resolved to "${resolvedId}" for ${provider}`
        };
      }
      // No model found for this tier+provider — let lifecycle validation handle it
      logger.warn('No model found for tier in target provider, passing through', {
        tier: decision.tier,
        provider,
        originalModel: decision.model
      });
    }

    return decision;
  }

  /**
   * Core routing logic — determines complexity tier and model without
   * considering the target provider. Returns Claude-centric model IDs
   * that get cross-mapped to other providers by routeChildModel().
   */
  private computeRoutingDecision(
    router: ModelRouter,
    task: string,
    explicitModel?: string,
    agentId?: string
  ): RoutingDecision {
    // Explicit model or tier name → pass to router
    if (explicitModel && !isModelTier(explicitModel)) {
      return router.route(task, explicitModel);
    }

    // Explicit tier name → route with complexity pre-determined
    if (explicitModel && isModelTier(explicitModel)) {
      return {
        model: explicitModel === 'powerful' ? 'opus' : explicitModel === 'fast' ? 'haiku' : 'sonnet',
        complexity: explicitModel === 'powerful' ? 'complex' : explicitModel === 'fast' ? 'simple' : 'moderate',
        tier: explicitModel,
        confidence: 1.0,
        reason: `Explicit tier "${explicitModel}" requested`
      };
    }

    // Agent override
    if (agentId) {
      const agent = getAgentById(agentId);
      if (agent?.modelOverride) {
        return {
          model: agent.modelOverride,
          complexity: 'simple',
          tier: router.getModelTier(agent.modelOverride),
          confidence: 1.0,
          reason: `Agent "${agent.name}" has model override configured`
        };
      }
    }

    // Outcome-driven recommendation
    const recommendation = this.getOutcomeRecommendation(task);
    if (
      recommendation &&
      recommendation.confidence >= 0.6 &&
      recommendation.recommendedModel
    ) {
      return {
        model: recommendation.recommendedModel,
        complexity: 'moderate',
        tier: router.getModelTier(recommendation.recommendedModel),
        confidence: recommendation.confidence,
        reason: `Outcome-driven routing for "${recommendation.taskType}"`
      };
    }

    // User preference store
    try {
      const preferredModel = getPreferenceStore().get<string>('model.default');
      if (preferredModel) {
        return {
          model: preferredModel,
          complexity: 'moderate',
          tier: router.getModelTier(preferredModel),
          confidence: 0.5,
          reason: 'User preference store default model'
        };
      }
    } catch {
      // Preference store is optional
    }

    // Auto-route based on task complexity analysis
    return router.route(task);
  }

  // ============================================
  // Task Classification
  // ============================================

  resolveChildAgentId(command: SpawnChildCommand): string | undefined {
    if (command.agentId) {
      // Allow custom agents (e.g. `custom:foo`) to pass through without validation.
      // Built-in agents are validated for better error messages.
      const resolved = getAgentById(command.agentId);
      if (resolved) return command.agentId;
      return command.agentId;
    }

    if (this.isRetrievalTask(command.task)) {
      const retriever = getAgentById('retriever');
      if (retriever) return retriever.id;
    }

    const recommendation = this.getOutcomeRecommendation(command.task);
    if (recommendation && recommendation.confidence >= 0.6) {
      const recommendedAgentId = this.normalizeRecommendedAgentId(
        recommendation.recommendedAgent
      );
      if (recommendedAgentId) {
        return recommendedAgentId;
      }
    }

    return undefined;
  }

  isRetrievalTask(task: string): boolean {
    const text = task.toLowerCase();
    const retrievalHints = [
      'find', 'search', 'locate', 'list files', 'enumerate', 'identify',
      'where is', 'grep', 'ripgrep', 'rg ', 'references', 'reference',
      'usages', 'usage', 'occurrences', 'occurrence', 'show me', 'look for',
      'scan', 'file path', 'files containing', 'open file', 'read file'
    ];
    const changeHints = [
      'implement', 'modify', 'edit', 'refactor', 'fix', 'add',
      'remove', 'create', 'write', 'build', 'update', 'delete', 'rename'
    ];

    if (changeHints.some((hint) => text.includes(hint))) {
      return false;
    }

    return retrievalHints.some((hint) => text.includes(hint));
  }

  private isListFilesTask(task: string): boolean {
    const text = task.toLowerCase();
    return (
      text.includes('list files') ||
      text.includes('file list') ||
      text.includes('show files') ||
      text.includes('files in') ||
      text.includes('list directories')
    );
  }

  classifyTaskType(task: string): string {
    const text = task.toLowerCase();

    if (this.isRetrievalTask(task)) return 'retrieval';
    if (text.includes('security') || text.includes('vulnerability'))
      return 'security-review';
    if (text.includes('review')) return 'review';
    if (text.includes('refactor')) return 'refactor';
    if (text.includes('test') || text.includes('testing')) return 'testing';
    if (text.includes('bug') || text.includes('fix')) return 'bug-fix';
    if (
      text.includes('feature') ||
      text.includes('implement') ||
      text.includes('add')
    )
      return 'feature-development';
    return 'general';
  }

  private getOutcomeRecommendation(task: string) {
    const taskType = this.classifyTaskType(task);
    const recommendation = this.strategyLearner.getRecommendation(
      taskType,
      task
    );
    return { ...recommendation, taskType };
  }

  private normalizeRecommendedAgentId(
    agentId: string | undefined
  ): string | undefined {
    if (!agentId) return undefined;
    if (agentId === 'default') return getDefaultAgent().id;
    const resolved = getAgentById(agentId);
    return resolved ? resolved.id : undefined;
  }

  // ============================================
  // Fast-Path Retrieval
  // ============================================

  private shouldUseFastPath(command: SpawnChildCommand): boolean {
    if (command.model || command.agentId) return false;
    if (!this.isRetrievalTask(command.task)) return false;
    return command.task.trim().length <= 220;
  }

  async tryFastPathRetrieval(
    parent: Instance,
    command: SpawnChildCommand
  ): Promise<boolean> {
    if (!this.shouldUseFastPath(command)) return false;

    const cwd = command.workingDirectory || parent.workingDirectory;
    try {
      const result = await this.runFastPathSearch(command.task, cwd);
      if (!result) return false;

      const summary = this.buildFastPathSummary(command.task, result);
      this.orchestration.notifyFastPathResult(parent.id, {
        summary,
        task: command.task,
        mode: result.mode,
        command: result.command,
        args: result.args,
        totalMatches: result.totalMatches,
        lines: result.lines,
        cwd: result.cwd
      });
      return true;
    } catch (error) {
      logger.warn('Fast-path retrieval failed, falling back to child instance', { error: String(error) });
      return false;
    }
  }

  private async runFastPathSearch(
    task: string,
    cwd: string
  ): Promise<FastPathResult | null> {
    const terms = this.extractQueryTerms(task);
    const pattern = terms.length > 0 ? this.buildLexicalPattern(terms) : '';
    const lineLimit = 40;

    if (this.isListFilesTask(task) || !pattern) {
      const fileList = await this.runFastPathFileList(cwd);
      if (!fileList) return null;
      const filtered =
        terms.length > 0
          ? fileList.files.filter((file) =>
              terms.some((term) => file.toLowerCase().includes(term))
            )
          : fileList.files;
      const lines = filtered.slice(0, lineLimit);
      return {
        mode: 'files',
        command: fileList.command,
        args: fileList.args,
        totalMatches: filtered.length,
        lines,
        rawOutput: filtered.join('\n'),
        cwd
      };
    }

    const result = await this.runFastPathGrep(pattern, cwd);
    if (!result) return null;

    const lines = result.rawOutput
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, lineLimit);

    return {
      mode: 'grep',
      command: result.command,
      args: result.args,
      totalMatches: result.totalMatches,
      lines,
      rawOutput: result.rawOutput,
      cwd
    };
  }

  private async runFastPathFileList(
    cwd: string
  ): Promise<{ files: string[]; command: string; args: string[] } | null> {
    const gitArgs = ['ls-files'];
    const gitResult = await this.runFastPathCommand('git', gitArgs, cwd, 4000);
    if (gitResult && gitResult.exitCode === 0) {
      const files = gitResult.stdout.split('\n').filter(Boolean);
      return { files, command: 'git', args: gitArgs };
    }

    const findArgs = [
      '.', '-maxdepth', '3', '-type', 'f',
      '-not', '-path', '*/node_modules/*',
      '-not', '-path', '*/.git/*'
    ];
    const findResult = await this.runFastPathCommand('find', findArgs, cwd, 5000);
    if (findResult && findResult.exitCode === 0) {
      const files = findResult.stdout.split('\n').filter(Boolean);
      return { files, command: 'find', args: findArgs };
    }

    return null;
  }

  private async runFastPathGrep(
    pattern: string,
    cwd: string
  ): Promise<{
    command: string;
    args: string[];
    rawOutput: string;
    totalMatches: number;
  } | null> {
    const rgArgs = ['-n', '--no-heading', '-S', pattern, '.'];
    const rgResult = await this.runFastPathCommand('rg', rgArgs, cwd, 5000);
    if (rgResult && (rgResult.exitCode === 0 || rgResult.exitCode === 1)) {
      const output = rgResult.stdout || '';
      const lines = output.split('\n').filter(Boolean);
      return {
        command: 'rg',
        args: rgArgs,
        rawOutput: output,
        totalMatches: lines.length
      };
    }

    const gitArgs = ['grep', '-n', '-e', pattern];
    const gitResult = await this.runFastPathCommand('git', gitArgs, cwd, 5000);
    if (gitResult && (gitResult.exitCode === 0 || gitResult.exitCode === 1)) {
      const output = gitResult.stdout || '';
      const lines = output.split('\n').filter(Boolean);
      return {
        command: 'git',
        args: gitArgs,
        rawOutput: output,
        totalMatches: lines.length
      };
    }

    const grepArgs = [
      '-RIn', '--exclude-dir=node_modules', '--exclude-dir=.git',
      '-e', pattern, '.'
    ];
    const grepResult = await this.runFastPathCommand('grep', grepArgs, cwd, 5000);
    if (grepResult && (grepResult.exitCode === 0 || grepResult.exitCode === 1)) {
      const output = grepResult.stdout || '';
      const lines = output.split('\n').filter(Boolean);
      return {
        command: 'grep',
        args: grepArgs,
        rawOutput: output,
        totalMatches: lines.length
      };
    }

    return null;
  }

  private async runFastPathCommand(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number
  ): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number | null;
  } | null> {
    return new Promise((resolve) => {
      const proc = spawn(command, args, { cwd });
      let stdout = '';
      let stderr = '';
      let settled = false;

      const finish = (exitCode: number | null) => {
        if (settled) return;
        settled = true;
        resolve({ stdout, stderr, exitCode });
      };

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
      proc.on('error', () => finish(null));
      proc.on('close', (code) => finish(code));

      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        finish(proc.exitCode ?? null);
      }, timeoutMs);

      proc.on('close', () => clearTimeout(timer));
    });
  }

  private buildFastPathSummary(task: string, result: FastPathResult): string {
    const matchLabel = result.mode === 'files' ? 'files' : 'matches';
    const shown = result.lines.length;
    const total = result.totalMatches;
    const header = `Fast-path retrieval complete (${matchLabel}: ${total}, showing ${shown}).`;
    const commandLine =
      `Command: ${result.command} ${result.args.join(' ')}`.trim();
    const lines =
      result.lines.length > 0 ? result.lines.join('\n') : 'No matches found.';

    return [
      '[Fast Retrieval]',
      header,
      `Task: ${task}`,
      commandLine,
      lines,
      '[End Fast Retrieval]'
    ].join('\n');
  }

  // ============================================
  // Outcome Recording
  // ============================================

  private recordOrchestrationOutcome(
    parentId: string,
    childId: string,
    task: TaskExecution | undefined,
    success: boolean,
    error?: { code: string; message: string }
  ): void {
    const child = this.deps.getInstance(childId);
    const duration =
      task?.startedAt && task?.completedAt
        ? task.completedAt - task.startedAt
        : 0;

    try {
      this.outcomeTracker.recordOutcome({
        instanceId: childId,
        taskType: 'orchestration-task',
        taskDescription: task?.task || error?.message || 'Orchestration task',
        prompt: task?.task || error?.message || 'Orchestration task',
        context: task?.result?.summary,
        agentUsed: child?.agentId || 'unknown',
        modelUsed: 'unknown',
        workflowUsed: task?.name,
        toolsUsed: this.buildToolUsage(child),
        tokensUsed: child?.totalTokensUsed || 0,
        duration,
        success,
        completionScore: success ? 1 : 0,
        errorType: success ? undefined : error?.code,
        errorMessage: success ? undefined : error?.message
      });
    } catch (recordError) {
      logger.error('Failed to record outcome for task', recordError instanceof Error ? recordError : undefined, { taskId: task?.taskId || 'unknown' });
    }

    this.unifiedMemory.recordTaskOutcome(
      task?.taskId || `${parentId}:${childId}`,
      success,
      success ? 1 : 0
    );

    // Record habit for agent/model selection learning
    try {
      getHabitTracker().recordAction({
        type: 'agent_selection',
        action: child?.agentId || 'unknown',
        context: {
          workspaceId: child?.workingDirectory || '',
          taskType: 'orchestration-task',
        },
      });
    } catch {
      // Habit tracking is optional
    }
  }

  private findTaskForChild(
    parentId: string,
    childId: string
  ): TaskExecution | undefined {
    const taskManager = getTaskManager();
    const history = taskManager.getTaskHistory(parentId);
    return history.recentTasks.find((task) => task.childId === childId);
  }

  private buildToolUsage(instance?: Instance): ToolUsageRecord[] {
    if (!instance) return [];

    const counts = new Map<string, { count: number }>();

    for (const message of instance.outputBuffer) {
      if (message.type !== 'tool_use') continue;

      const toolName =
        typeof message.metadata?.['name'] === 'string'
          ? (message.metadata?.['name'] as string)
          : 'unknown';
      const entry = counts.get(toolName) || { count: 0 };
      entry.count += 1;
      counts.set(toolName, entry);
    }

    return Array.from(counts.entries()).map(([tool, entry]) => ({
      tool,
      count: entry.count,
      avgDuration: 0,
      errorCount: 0
    }));
  }

  // ============================================
  // Helper Methods
  // ============================================

  private extractQueryTerms(message: string): string[] {
    const matches = message.toLowerCase().match(/[a-z0-9_]{3,}/g) || [];
    const unique = Array.from(
      new Set(matches.filter((term) => term.length >= 4))
    );
    return unique.slice(0, 12);
  }

  private buildLexicalPattern(terms: string[]): string {
    return terms
      .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|');
  }

  private buildFriendlyOrchestrationMessage(action: string, status: string, data: any): string {
    switch (action) {
      case 'spawn_child':
        if (status === 'SUCCESS') {
          return `**Child Spawned:** ${data.name || 'Child instance'}\n\nID: \`${data.childId}\``;
        } else {
          return `**Failed to spawn child:** ${data.error || 'Unknown error'}`;
        }
      case 'message_child':
        return status === 'SUCCESS'
          ? `**Message sent** to child \`${data.childId}\``
          : `**Failed to send message:** ${data.error || 'Unknown error'}`;
      case 'terminate_child':
        return status === 'SUCCESS'
          ? `**Child terminated:** \`${data.childId}\``
          : `**Failed to terminate child:** ${data.error || 'Unknown error'}`;
      case 'task_complete':
        return `**Task completed** by child \`${data.childId}\`\n\n${data.result?.summary || data.message || 'No summary'}`;
      case 'task_progress':
        return `**Progress update** from child \`${data.childId}\`: ${data.progress?.percentage || 0}% - ${data.progress?.currentStep || 'Working...'}`;
      case 'task_error':
        return `**Error** from child \`${data.childId}\`:\n\n${data.error?.message || data.message || 'Unknown error'}`;
      case 'get_children': {
        const activeConsensusQueries = typeof data.activeConsensusQueries === 'number'
          ? data.activeConsensusQueries
          : 0;
        const completedChildIds = Array.isArray(data.completedChildIds)
          ? data.completedChildIds as string[]
          : [];
        if (data.children && data.children.length > 0) {
          const childList = data.children
            .map((c: any) => `- **${c.name}** (\`${c.id}\`) - ${c.status}`)
            .join('\n');
          const consensusLine = activeConsensusQueries > 0
            ? `\n\n**Consensus queries running:** ${activeConsensusQueries}`
            : '';
          return `**Active children:**\n\n${childList}${consensusLine}`;
        }
        if (activeConsensusQueries > 0) {
          const queryLabel = activeConsensusQueries === 1 ? 'query is' : 'queries are';
          return `**Consensus query in progress**\n\nNo child instances are active. ${activeConsensusQueries} internal consensus ${queryLabel} still running.`;
        }
        if (completedChildIds.length > 0) {
          const shown = completedChildIds.slice(-5);
          const childList = shown.map((id) => `- \`${id}\``).join('\n');
          const extra = completedChildIds.length > shown.length
            ? `\n- ... and ${completedChildIds.length - shown.length} more`
            : '';
          return `**No active children**\n\n${completedChildIds.length} child instance${completedChildIds.length === 1 ? '' : 's'} completed recently:\n${childList}${extra}`;
        }
        return `**No active children**`;
      }
      case 'get_child_output':
        if (status !== 'SUCCESS') {
          const errChildId = data.childId ? ` \`${data.childId}\`` : '';
          return `**Failed to get child output**${errChildId}: ${data.error || 'Unknown error'}`;
        }
        if (data.output && data.output.length > 0) {
          return `**Output from child \`${data.childId}\`:**\n\n\`\`\`\n${data.output.join('\n')}\n\`\`\``;
        } else {
          return `**No output from child** \`${data.childId ?? '(unknown)'}\``;
        }
      case 'call_tool':
        if (status === 'SUCCESS') {
          const toolId = data.toolId || data.tool?.id || 'tool';
          const outputPreview =
            data.output !== undefined
              ? (typeof data.output === 'string'
                  ? data.output
                  : JSON.stringify(data.output, null, 2))
              : '';
          const trimmed =
            outputPreview.length > 1500
              ? outputPreview.slice(0, 1500) + '\n... (truncated)'
              : outputPreview;
          return `**Tool ran:** \`${toolId}\`\n\n\`\`\`\n${trimmed}\n\`\`\``;
        }
        return `**Tool failed:** \`${data.toolId || data.tool?.id || 'tool'}\`\n\n${data.error || 'Unknown error'}`;
      case 'consensus_query':
        return this.formatConsensusQueryMessage(status, data);
      // New structured result messages
      case 'child_result':
        return this.formatChildResultMessage(data);
      case 'child_completed':
        return this.formatChildCompletedMessage(data);
      case 'all_children_completed':
        return this.formatAllChildrenCompletedMessage(data);
      case 'get_child_summary':
        return this.formatChildSummaryMessage(status, data);
      case 'get_child_artifacts':
        return this.formatChildArtifactsMessage(status, data);
      case 'get_child_section':
        return this.formatChildSectionMessage(status, data);
      case 'request_user_action':
        return this.formatRequestUserActionMessage(data);
      case 'user_action_response':
        return status === 'SUCCESS'
          ? `**User responded** to "${data.requestType || 'request'}" — ${data.approved ? 'Approved' : 'Rejected'}${data.selectedOption ? `: ${data.selectedOption.slice(0, 200)}` : ''}`
          : `**User action response failed**`;
      default:
        return `**Orchestration:** ${action} - ${status}`;
    }
  }

  private formatConsensusQueryMessage(status: string, data: any): string {
    if (data.status === 'dispatching') {
      const requestedProviders = Array.isArray(data.providersRequested) && data.providersRequested.length > 0
        ? data.providersRequested.join(', ')
        : 'available providers';
      return `**Consensus query started**\n\nConsulting ${requestedProviders}.`;
    }

    if (status === 'SUCCESS') {
      const parts: string[] = [];
      parts.push('**Consensus complete**');

      if (typeof data.successCount === 'number' || typeof data.failureCount === 'number') {
        const successCount = typeof data.successCount === 'number' ? data.successCount : 0;
        const failureCount = typeof data.failureCount === 'number' ? data.failureCount : 0;
        parts.push(`${successCount} provider${successCount === 1 ? '' : 's'} responded, ${failureCount} failed.`);
      }

      if (typeof data.totalDurationMs === 'number') {
        parts.push(`Duration: ${Math.round(data.totalDurationMs / 1000)}s.`);
      }

      parts.push('');
      parts.push('_Result injected to parent CLI._');
      return parts.join('\n');
    }

    const parts = ['**Consensus query failed**'];
    if (data.message || data.error) {
      parts.push('');
      parts.push(String(data.message || data.error));
    }

    if (Array.isArray(data.errors) && data.errors.length > 0) {
      parts.push('');
      parts.push('**Provider errors:**');
      for (const err of data.errors.slice(0, 3)) {
        const provider = typeof err.provider === 'string' ? err.provider : 'provider';
        const message = typeof err.error === 'string' ? err.error : 'unknown error';
        parts.push(`- ${provider}: ${message}`);
      }
      if (data.errors.length > 3) {
        parts.push(`- ... and ${data.errors.length - 3} more`);
      }
    }

    return parts.join('\n');
  }

  private formatRequestUserActionMessage(data: any): string {
    const title = data.title || 'User Action Required';
    const message = data.message || '';
    const questions = data.questions as string[] | undefined;

    const parts: string[] = [];
    parts.push(`**Awaiting your response** — ${title}`);

    if (message) {
      parts.push('');
      parts.push(message);
    }

    if (questions && questions.length > 0) {
      parts.push('');
      questions.forEach((q: string, i: number) => {
        parts.push(`${i + 1}. ${q}`);
      });
    }

    parts.push('');
    parts.push('_See the prompt below to respond._');

    return parts.join('\n');
  }

  private formatChildResultMessage(data: any): string {
    const parts: string[] = [];
    parts.push(`**Child Result** from \`${data.childId}\``);
    parts.push('');
    parts.push(`**Summary:** ${data.summary}`);
    parts.push(`**Status:** ${data.success ? 'Success' : 'Failed'}`);

    if (data.artifactCount > 0) {
      parts.push(`**Artifacts:** ${data.artifactCount} (${data.artifactTypes?.join(', ') || 'various'})`);
    }

    if (data.conclusions && data.conclusions.length > 0) {
      parts.push('');
      parts.push('**Conclusions:**');
      data.conclusions.slice(0, 3).forEach((c: string) => parts.push(`- ${c}`));
      if (data.conclusions.length > 3) {
        parts.push(`- ... and ${data.conclusions.length - 3} more`);
      }
    }

    if (data.hasMoreDetails) {
      parts.push('');
      parts.push('_Use `get_child_artifacts` or `get_child_section` for more details._');
    }

    return parts.join('\n');
  }

  private formatChildSummaryMessage(status: string, data: any): string {
    if (status !== 'SUCCESS') {
      return `**Child Summary Error:** ${data.error || 'Unknown error'}\n\n${data.suggestion || ''}`;
    }

    const parts: string[] = [];
    parts.push(`**Summary for child \`${data.childId}\`:**`);
    parts.push('');
    parts.push(data.summary);
    parts.push('');
    parts.push(`**Status:** ${data.success ? 'Success' : 'Failed'}`);

    if (data.artifactCount > 0) {
      parts.push(`**Artifacts:** ${data.artifactCount} (${data.artifactTypes?.join(', ') || 'various'})`);
    }

    if (data.conclusions && data.conclusions.length > 0) {
      parts.push('');
      parts.push('**Conclusions:**');
      data.conclusions.forEach((c: string) => parts.push(`- ${c}`));
    }

    return parts.join('\n');
  }

  private formatChildArtifactsMessage(status: string, data: any): string {
    if (status !== 'SUCCESS') {
      return `**Artifacts Error:** ${data.error || 'Unknown error'}`;
    }

    const parts: string[] = [];
    parts.push(`**Artifacts from child \`${data.childId}\`** (${data.filtered}/${data.total})`);

    if (data.artifacts && data.artifacts.length > 0) {
      for (const artifact of data.artifacts) {
        parts.push('');
        const severity = artifact.severity ? `[${artifact.severity.toUpperCase()}]` : '';
        parts.push(`### ${severity} ${artifact.title || artifact.type}`);
        if (artifact.file) {
          const location = artifact.lines ? `${artifact.file}:${artifact.lines}` : artifact.file;
          parts.push(`**Location:** \`${location}\``);
        }
        parts.push(artifact.content);
      }
    } else {
      parts.push('_No artifacts found._');
    }

    if (data.hasMore) {
      parts.push('');
      parts.push(`_${data.total - data.filtered} more artifacts available. Use limit parameter to fetch more._`);
    }

    return parts.join('\n');
  }

  private formatChildSectionMessage(status: string, data: any): string {
    if (status !== 'SUCCESS') {
      return `**Section Error:** ${data.error || 'Unknown error'}`;
    }

    const parts: string[] = [];
    parts.push(`**${data.section}** from child \`${data.childId}\` (${data.tokenCount} tokens)`);

    if (data.warning) {
      parts.push('');
      parts.push(`⚠️ ${data.warning}`);
    }

    parts.push('');
    parts.push(data.content);

    return parts.join('\n');
  }

  private formatChildCompletedMessage(data: Record<string, unknown>): string {
    const parts: string[] = [];
    const name = (data['name'] as string) || (data['childId'] as string) || 'Unknown child';
    const statusLabel = data['success'] ? 'Success' : 'Failed';
    parts.push(`**Child Completed:** ${name} (\`${data['childId']}\`)`);
    parts.push(`**Status:** ${statusLabel}`);
    if (data['summary']) {
      parts.push('');
      parts.push(data['summary'] as string);
    }
    const conclusions = data['conclusions'] as string[] | undefined;
    if (conclusions && conclusions.length > 0) {
      parts.push('');
      parts.push('**Conclusions:**');
      for (const c of conclusions) {
        parts.push(`- ${c}`);
      }
    }
    return parts.join('\n');
  }

  private formatAllChildrenCompletedMessage(data: Record<string, unknown>): string {
    const parts: string[] = [];
    parts.push(`**All ${data['totalChildren']} children completed**`);
    parts.push('');
    const summaries = data['summaries'] as { success: boolean; name: string; summary: string }[] | undefined;
    if (summaries && summaries.length > 0) {
      for (const s of summaries) {
        const statusLabel = s.success ? 'SUCCESS' : 'FAILED';
        parts.push(`- **[${statusLabel}]** ${s.name}: ${s.summary}`);
      }
    }
    parts.push('');
    parts.push('_Synthesis prompt injected to parent CLI._');
    return parts.join('\n');
  }
}
