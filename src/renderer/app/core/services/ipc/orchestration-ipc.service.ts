/**
 * Orchestration IPC Service - Orchestration, workflow, debate, and supervision operations
 */

import { Injectable, inject } from '@angular/core';
import { ElectronIpcService, IpcResponse } from './electron-ipc.service';
import type {
  NlWorkflowSuggestion,
  WorkflowStartSource,
  WorkflowTransitionPolicy,
} from '../../../../../shared/types/workflow.types';

const DEFAULT_SKILL_SEARCH_PATHS = ['.claude/skills', '.codex/skills', 'skills'];

@Injectable({ providedIn: 'root' })
export class OrchestrationIpcService {
  private base = inject(ElectronIpcService);

  private get api() {
    return this.base.getApi();
  }

  private notInElectron(): IpcResponse {
    return { success: false, error: { message: 'Not in Electron' } };
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  private isIpcResponse(value: unknown): value is IpcResponse {
    return this.isRecord(value) && typeof value['success'] === 'boolean';
  }

  private toIpcResponse<T>(value: unknown): IpcResponse<T> {
    if (this.isIpcResponse(value)) {
      return value as IpcResponse<T>;
    }
    return { success: true, data: value as T };
  }

  private async invokeChannel<T = unknown>(
    channel: string,
    payload?: unknown
  ): Promise<IpcResponse<T>> {
    if (!this.api) {
      return this.notInElectron() as IpcResponse<T>;
    }

    try {
      const raw = await this.base.invoke<T>(channel, payload);
      return this.toIpcResponse<T>(raw);
    } catch (error) {
      return { success: false, error: { message: (error as Error).message } };
    }
  }

  private toPhaseData(
    phaseOrData?: string | Record<string, unknown>,
    result?: unknown
  ): Record<string, unknown> | undefined {
    if (this.isRecord(phaseOrData)) {
      return phaseOrData;
    }

    if (typeof phaseOrData === 'string') {
      if (this.isRecord(result)) {
        return { phaseId: phaseOrData, ...result };
      }
      if (result !== undefined) {
        return { phaseId: phaseOrData, result };
      }
      return { phaseId: phaseOrData };
    }

    if (this.isRecord(result)) {
      return result;
    }

    return undefined;
  }

  private resolveSkillSearchPaths(
    searchPathsOrDirectory?: string[] | string
  ): string[] {
    if (Array.isArray(searchPathsOrDirectory)) {
      return searchPathsOrDirectory.filter((path) => path.trim().length > 0);
    }
    if (typeof searchPathsOrDirectory === 'string' && searchPathsOrDirectory.trim().length > 0) {
      return [searchPathsOrDirectory.trim()];
    }
    return [...DEFAULT_SKILL_SEARCH_PATHS];
  }

  // ============================================
  // Workflows
  // ============================================

  /**
   * List available workflow templates
   */
  async workflowListTemplates(): Promise<IpcResponse> {
    return this.invokeChannel('workflow:list-templates');
  }

  /**
   * Get a specific workflow template
   */
  async workflowGetTemplate(templateId: string): Promise<IpcResponse> {
    return this.invokeChannel('workflow:get-template', { templateId });
  }

  /**
   * Start a workflow
   */
  async workflowStart(payload: {
    instanceId: string;
    templateId: string;
    config?: Record<string, unknown>;
    source?: WorkflowStartSource;
  }): Promise<IpcResponse> {
    return this.invokeChannel('workflow:start', {
      instanceId: payload.instanceId,
      templateId: payload.templateId,
      source: payload.source,
    });
  }

  async workflowCanTransition(payload: {
    instanceId: string;
    templateId: string;
    source: WorkflowStartSource;
  }): Promise<IpcResponse<{ policy: WorkflowTransitionPolicy; activeExecutionId: string | null; requestedTemplateId: string }>> {
    return this.invokeChannel('workflow:can-transition', payload);
  }

  async workflowNlSuggest(payload: {
    promptText: string;
    provider?: string;
    workingDirectory?: string;
  }): Promise<IpcResponse<NlWorkflowSuggestion>> {
    return this.invokeChannel('workflow:nl-suggest', payload);
  }

  /**
   * Get workflow execution status
   */
  async workflowGetExecution(executionId: string): Promise<IpcResponse> {
    return this.invokeChannel('workflow:get-execution', { executionId });
  }

  /**
   * Get workflow execution for instance
   */
  async workflowGetByInstance(instanceId: string): Promise<IpcResponse> {
    return this.invokeChannel('workflow:get-by-instance', { instanceId });
  }

  /**
   * Complete a workflow phase
   */
  async workflowCompletePhase(
    executionId: string,
    phaseOrData?: string | Record<string, unknown>,
    result?: unknown
  ): Promise<IpcResponse> {
    const phaseData = this.toPhaseData(phaseOrData, result);
    return this.invokeChannel('workflow:complete-phase', {
      executionId,
      phaseData,
    });
  }

  /**
   * Satisfy a workflow gate
   */
  async workflowSatisfyGate(
    executionId: string,
    responseOrGateId: string | { approved?: boolean; selection?: string; answer?: string }
  ): Promise<IpcResponse> {
    const response = typeof responseOrGateId === 'string'
      ? { answer: responseOrGateId }
      : responseOrGateId;
    return this.invokeChannel('workflow:satisfy-gate', { executionId, response });
  }

  /**
   * Skip a workflow phase
   */
  async workflowSkipPhase(
    executionId: string,
    _phaseId?: string,
    _reason?: string
  ): Promise<IpcResponse> {
    void _phaseId;
    void _reason;
    return this.invokeChannel('workflow:skip-phase', { executionId });
  }

  /**
   * Cancel a workflow
   */
  async workflowCancel(executionId: string): Promise<IpcResponse> {
    return this.invokeChannel('workflow:cancel', { executionId });
  }

  /**
   * Get workflow prompt addition
   */
  async workflowGetPromptAddition(executionId: string): Promise<IpcResponse> {
    return this.invokeChannel('workflow:get-prompt-addition', { executionId });
  }

  // ============================================
  // Review Agents
  // ============================================

  /**
   * List available review agents
   */
  async reviewListAgents(): Promise<IpcResponse> {
    return this.invokeChannel('review:list-agents');
  }

  /**
   * Get a specific review agent
   */
  async reviewGetAgent(agentId: string): Promise<IpcResponse> {
    return this.invokeChannel('review:get-agent', { agentId });
  }

  /**
   * Start a review session
   */
  async reviewStartSession(payload: {
    instanceId: string;
    agentIds: string[];
    files: string[];
    diffOnly?: boolean;
  }): Promise<IpcResponse> {
    return this.invokeChannel('review:start-session', payload);
  }

  /**
   * Get a review session
   */
  async reviewGetSession(sessionId: string): Promise<IpcResponse> {
    return this.invokeChannel('review:get-session', { sessionId });
  }

  /**
   * Get issues for a review session
   */
  async reviewGetIssues(payload: {
    sessionId: string;
    severity?: string;
    agentId?: string;
  }): Promise<IpcResponse> {
    return this.invokeChannel('review:get-issues', payload);
  }

  /**
   * Acknowledge or unacknowledge a review issue
   */
  async reviewAcknowledgeIssue(
    sessionId: string,
    issueId: string,
    acknowledged: boolean
  ): Promise<IpcResponse> {
    return this.invokeChannel('review:acknowledge-issue', {
      sessionId,
      issueId,
      acknowledged,
    });
  }

  // ============================================
  // Worktrees
  // ============================================

  /**
   * Create a worktree for isolated work
   */
  async worktreeCreate(payload: {
    instanceId: string;
    taskDescription: string;
    baseBranch?: string;
    branchName?: string;
    config?: Record<string, unknown>;
  }): Promise<IpcResponse> {
    return this.invokeChannel('worktree:create', payload);
  }

  /**
   * List worktrees
   */
  async worktreeList(instanceId?: string): Promise<IpcResponse> {
    const response = await this.invokeChannel<unknown[]>('worktree:list-sessions');
    if (!instanceId || !response.success || !Array.isArray(response.data)) {
      return response as IpcResponse;
    }
    const filtered = response.data.filter(
      (session) => this.isRecord(session) && session['instanceId'] === instanceId
    );
    return { ...response, data: filtered };
  }

  /**
   * Get a specific worktree session
   */
  async worktreeGetSession(sessionId: string): Promise<IpcResponse> {
    return this.invokeChannel('worktree:get-session', { sessionId });
  }

  /**
   * Complete a worktree session (ready to merge)
   */
  async worktreeComplete(sessionId: string): Promise<IpcResponse> {
    return this.invokeChannel('worktree:complete', { sessionId });
  }

  /**
   * Preview worktree merge
   */
  async worktreePreviewMerge(sessionId: string): Promise<IpcResponse> {
    return this.invokeChannel('worktree:preview-merge', { sessionId });
  }

  /**
   * Merge a completed worktree
   */
  async worktreeMerge(payload: {
    sessionId: string;
    strategy?: string;
    commitMessage?: string;
  }): Promise<IpcResponse> {
    return this.invokeChannel('worktree:merge', payload);
  }

  /**
   * Detect conflicts across sessions
   */
  async worktreeDetectConflicts(sessionIds: string[]): Promise<IpcResponse> {
    return this.invokeChannel('worktree:detect-conflicts', { sessionIds });
  }

  /**
   * Sync a worktree session with remote/base branch
   */
  async worktreeSync(sessionId: string): Promise<IpcResponse> {
    return this.invokeChannel('worktree:sync', { sessionId });
  }

  /**
   * Abandon a worktree session
   */
  async worktreeAbandon(sessionId: string, reason?: string): Promise<IpcResponse> {
    return this.invokeChannel('worktree:abandon', { sessionId, reason });
  }

  /**
   * Cleanup a worktree session (local delete)
   */
  async worktreeCleanup(sessionId: string): Promise<IpcResponse> {
    return this.invokeChannel('worktree:cleanup', { sessionId });
  }

  /**
   * Legacy alias for delete
   */
  async worktreeDelete(worktreeId: string): Promise<IpcResponse> {
    return this.worktreeCleanup(worktreeId);
  }

  /**
   * Legacy alias for get status
   */
  async worktreeGetStatus(worktreeId: string): Promise<IpcResponse> {
    return this.worktreeGetSession(worktreeId);
  }

  // ============================================
  // Specialists
  // ============================================

  /**
   * List all specialist profiles
   */
  async specialistList(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistList();
  }

  /**
   * List built-in specialist profiles
   */
  async specialistListBuiltin(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistListBuiltin();
  }

  /**
   * List custom specialist profiles
   */
  async specialistListCustom(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistListCustom();
  }

  /**
   * Get a specialist profile
   */
  async specialistGet(profileId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistGet(profileId);
  }

  /**
   * Get specialist profiles by category
   */
  async specialistGetByCategory(category: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistGetByCategory(category);
  }

  /**
   * Add a custom specialist profile
   */
  async specialistAddCustom(profile: {
    id: string;
    name: string;
    description: string;
    category: string;
    icon: string;
    color: string;
    systemPromptAddition: string;
    restrictedTools: string[];
    constraints?: {
      readOnlyMode?: boolean;
      maxTokens?: number;
      allowedDirectories?: string[];
      blockedDirectories?: string[];
      requireApprovalFor?: string[];
    };
    tags?: string[];
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistAddCustom(profile);
  }

  /**
   * Update a custom specialist profile
   */
  async specialistUpdateCustom(profileId: string, updates: {
    name?: string;
    description?: string;
    category?: string;
    icon?: string;
    color?: string;
    systemPromptAddition?: string;
    restrictedTools?: string[];
    constraints?: {
      readOnlyMode?: boolean;
      maxTokens?: number;
      allowedDirectories?: string[];
      blockedDirectories?: string[];
      requireApprovalFor?: string[];
    };
    tags?: string[];
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistUpdateCustom(profileId, updates);
  }

  /**
   * Remove a custom specialist profile
   */
  async specialistRemoveCustom(profileId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistRemoveCustom(profileId);
  }

  /**
   * Get specialist recommendations based on context
   */
  async specialistRecommend(context: {
    taskDescription?: string;
    fileTypes?: string[];
    userPreferences?: string[];
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistRecommend(context);
  }

  /**
   * Create a specialist instance
   */
  async specialistCreateInstance(profileId: string, orchestratorInstanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistCreateInstance(profileId, orchestratorInstanceId);
  }

  /**
   * Get a specialist instance
   */
  async specialistGetInstance(instanceId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistGetInstance(instanceId);
  }

  /**
   * Get all active specialist instances
   */
  async specialistGetActiveInstances(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistGetActiveInstances();
  }

  /**
   * Update specialist instance status
   */
  async specialistUpdateStatus(instanceId: string, status: 'active' | 'paused' | 'completed' | 'failed'): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistUpdateStatus(instanceId, status);
  }

  /**
   * Add a finding to a specialist instance
   */
  async specialistAddFinding(instanceId: string, finding: {
    id: string;
    type: string;
    severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
    title: string;
    description: string;
    filePath?: string;
    lineRange?: { start: number; end: number };
    codeSnippet?: string;
    suggestion?: string;
    confidence: number;
    tags?: string[];
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistAddFinding(instanceId, finding);
  }

  /**
   * Update specialist instance metrics
   */
  async specialistUpdateMetrics(instanceId: string, updates: {
    filesAnalyzed?: number;
    linesAnalyzed?: number;
    findingsCount?: number;
    tokensUsed?: number;
    durationMs?: number;
  }): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistUpdateMetrics(instanceId, updates);
  }

  /**
   * Get system prompt addition for a specialist
   */
  async specialistGetPromptAddition(profileId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.specialistGetPromptAddition(profileId);
  }

  // ============================================
  // Supervision
  // ============================================

  /**
   * Get supervision tree
   */
  async supervisionGetTree(rootInstanceId?: string): Promise<IpcResponse> {
    return this.invokeChannel('supervision:get-tree', { instanceId: rootInstanceId });
  }

  /**
   * Get supervision health status
   */
  async supervisionGetHealth(): Promise<IpcResponse> {
    return this.invokeChannel('supervision:get-health');
  }

  /**
   * Get supervision hierarchy + stats
   */
  async supervisionGetHierarchy(): Promise<IpcResponse> {
    return this.invokeChannel('supervision:get-hierarchy');
  }

  /**
   * Get all supervision registrations
   */
  async supervisionGetAllRegistrations(): Promise<IpcResponse> {
    return this.invokeChannel('supervision:get-all-registrations');
  }

  /**
   * Signal a worker failure to supervision tree
   */
  async supervisionHandleFailure(
    childInstanceId: string,
    error: string
  ): Promise<IpcResponse> {
    return this.invokeChannel('supervision:handle-failure', {
      childInstanceId,
      error,
    });
  }

  // ============================================
  // Debate
  // ============================================

  /**
   * Start a debate
   */
  async debateStart(payload: {
    query: string;
    context?: string;
    config?: Record<string, unknown>;
  }): Promise<IpcResponse> {
    return this.invokeChannel('debate:start', payload);
  }

  /**
   * Get debate result
   */
  async debateGetResult(debateId: string): Promise<IpcResponse> {
    return this.invokeChannel('debate:get-result', debateId);
  }

  /**
   * Get active debates
   */
  async debateGetActive(): Promise<IpcResponse> {
    return this.invokeChannel('debate:get-active');
  }

  /**
   * Cancel debate
   */
  async debateCancel(debateId: string): Promise<IpcResponse> {
    return this.invokeChannel('debate:cancel', debateId);
  }

  /**
   * Get debate stats
   */
  async debateGetStats(): Promise<IpcResponse> {
    return this.invokeChannel('debate:get-stats');
  }

  // ============================================
  // Skills
  // ============================================

  /**
   * Discover skills in a directory
   */
  async skillsDiscover(searchPathsOrDirectory?: string[] | string): Promise<IpcResponse> {
    const searchPaths = this.resolveSkillSearchPaths(searchPathsOrDirectory);
    return this.invokeChannel('skills:discover', { searchPaths });
  }

  /**
   * List available skills
   */
  async skillsList(): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.skillsList();
  }

  /**
   * Get a skill by ID
   */
  async skillsGet(skillId: string): Promise<IpcResponse> {
    if (!this.api) return { success: false, error: { message: 'Not in Electron' } };
    return this.api.skillsGet(skillId);
  }

  /**
   * Load a skill
   */
  async skillsLoad(skillId: string): Promise<IpcResponse> {
    if (!this.api) return this.notInElectron();
    return this.api.skillsLoad(skillId);
  }

  /**
   * Unload a skill
   */
  async skillsUnload(skillId: string): Promise<IpcResponse> {
    if (!this.api) return this.notInElectron();
    return this.api.skillsUnload(skillId);
  }

  /**
   * Load reference documentation for a skill
   */
  async skillsLoadReference(skillId: string, referencePath: string): Promise<IpcResponse> {
    if (!referencePath) {
      return { success: false, error: { message: 'referencePath is required' } };
    }
    return this.invokeChannel('skills:load-reference', { skillId, referencePath });
  }

  /**
   * Load example for a skill
   */
  async skillsLoadExample(skillId: string, examplePath: string): Promise<IpcResponse> {
    if (!examplePath) {
      return { success: false, error: { message: 'examplePath is required' } };
    }
    return this.invokeChannel('skills:load-example', { skillId, examplePath });
  }

  /**
   * Match skills to a query
   */
  async skillsMatch(query: string, maxResults?: number): Promise<IpcResponse> {
    const response = await this.invokeChannel<unknown[]>('skills:match', { text: query });
    if (
      response.success &&
      Array.isArray(response.data) &&
      typeof maxResults === 'number' &&
      maxResults > 0
    ) {
      return { ...response, data: response.data.slice(0, maxResults) };
    }
    return response;
  }

  /**
   * Get skill memory
   */
  async skillsGetMemory(_skillId?: string): Promise<IpcResponse> {
    void _skillId;
    return this.invokeChannel('skills:get-memory');
  }
}
