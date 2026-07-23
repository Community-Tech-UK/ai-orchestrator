import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createOrchestrationDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {
    // ============================================
    // Command Operations
    // ============================================

    /**
     * List all commands (built-in + custom)
     */
    listCommands: (payload?: {
      workingDirectory?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.COMMAND_LIST, payload);
    },

    /**
     * Resolve a slash command string into exact, alias, fuzzy, ambiguous, or none.
     */
    resolveCommand: (payload: {
      input: string;
      workingDirectory?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.COMMAND_RESOLVE, payload);
    },

    /**
     * Execute a command
     */
    executeCommand: (payload: {
      commandId: string;
      instanceId: string;
      args?: string[];
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.COMMAND_EXECUTE, payload);
    },

    /**
     * Create a custom command
     */
    createCommand: (payload: {
      name: string;
      description: string;
      template: string;
      hint?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.COMMAND_CREATE, payload);
    },

    /**
     * Update a custom command
     */
    updateCommand: (payload: {
      commandId: string;
      updates: Partial<{
        name: string;
        description: string;
        template: string;
        hint: string;
      }>;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.COMMAND_UPDATE, payload);
    },

    /**
     * Delete a custom command
     */
    deleteCommand: (commandId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.COMMAND_DELETE, { commandId });
    },

    recordUsage: (payload: {
      kind: 'command' | 'session' | 'model' | 'prompt' | 'resume';
      id: string;
      context?: string;
      timestamp?: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.USAGE_RECORD, payload);
    },

    getUsageSnapshot: (payload?: {
      kind?: 'command' | 'session' | 'model' | 'prompt' | 'resume';
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.USAGE_SNAPSHOT, payload);
    },

    isWorkspaceGitRepo: (payload: {
      workingDirectory: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKSPACE_IS_GIT_REPO, payload);
    },

    orchestrationGetChildDiagnosticBundle: (payload: {
      childInstanceId: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.ORCHESTRATION_GET_CHILD_DIAGNOSTIC_BUNDLE, payload);
    },

    orchestrationSummarizeChildren: (payload: {
      parentInstanceId: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.ORCHESTRATION_SUMMARIZE_CHILDREN, payload);
    },

    // ============================================
    // Configuration (Hierarchical)
    // ============================================

    /**
     * Resolve configuration for a working directory
     * Returns merged config with source tracking (project > user > default)
     */
    resolveConfig: (workingDirectory?: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CONFIG_RESOLVE, {
        workingDirectory
      });
    },

    /**
     * Get project config from a specific path
     */
    getProjectConfig: (configPath: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CONFIG_GET_PROJECT, { configPath });
    },

    /**
     * Save project config to a specific path
     */
    saveProjectConfig: (
      configPath: string,
      config: Record<string, unknown>
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CONFIG_SAVE_PROJECT, {
        configPath,
        config
      });
    },

    /**
     * Create a new project config file
     */
    createProjectConfig: (
      projectDir: string,
      config?: Record<string, unknown>
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CONFIG_CREATE_PROJECT, {
        projectDir,
        config
      });
    },

    /**
     * Find project config path by searching up the directory tree
     */
    findProjectConfig: (startDir: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CONFIG_FIND_PROJECT, { startDir });
    },

    /**
     * Resolve the active instruction stack for a working directory and optional context files.
     */
    instructionsResolve: (
      workingDirectory: string,
      contextPaths?: string[],
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTRUCTIONS_RESOLVE, {
        workingDirectory,
        contextPaths,
      });
    },

    /** WS12: pin (approve) instruction files at their current hashes — batch-capable. */
    instructionTrustApprove: (
      files: Array<{ path: string; sha256: string }>,
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTRUCTION_TRUST_APPROVE, { files });
    },

    /** WS12: revoke an instruction-file trust pin. */
    instructionTrustRevoke: (path: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTRUCTION_TRUST_REVOKE, { path });
    },

    /** WS12: list all instruction-file trust pins. */
    instructionTrustList: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTRUCTION_TRUST_LIST, {});
    },

    /**
     * Generate a migration draft for `.orchestrator/INSTRUCTIONS.md`.
     */
    instructionsCreateDraft: (
      workingDirectory: string,
      contextPaths?: string[],
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.INSTRUCTIONS_CREATE_DRAFT, {
        workingDirectory,
        contextPaths,
      });
    },

    // ============================================
    // Plan Mode
    // ============================================

    /**
     * Enter plan mode (read-only exploration)
     */
    enterPlanMode: (instanceId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PLAN_MODE_ENTER, { instanceId });
    },

    /**
     * Exit plan mode
     */
    exitPlanMode: (instanceId: string, force?: boolean): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PLAN_MODE_EXIT, {
        instanceId,
        force
      });
    },

    /**
     * Approve a plan (allows transition to implementation)
     */
    approvePlan: (
      instanceId: string,
      planContent?: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PLAN_MODE_APPROVE, {
        instanceId,
        planContent
      });
    },

    /**
     * Update plan content
     */
    updatePlanContent: (
      instanceId: string,
      planContent: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PLAN_MODE_UPDATE, {
        instanceId,
        planContent
      });
    },

    /**
     * Get plan mode state
     */
    getPlanModeState: (instanceId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.PLAN_MODE_GET_STATE, { instanceId });
    },

    // ============================================
    // Phase 6: Workflows (6.1)
    // ============================================

    /**
     * List available workflow templates
     */
    workflowListTemplates: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKFLOW_LIST_TEMPLATES);
    },

    /**
     * Get a specific workflow template
     */
    workflowGetTemplate: (templateId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKFLOW_GET_TEMPLATE, {
        templateId
      });
    },

    /**
     * Start a workflow
     */
    workflowStart: (payload: {
      instanceId: string;
      templateId: string;
      config?: Record<string, unknown>;
      source?: 'slash-command' | 'nl-suggestion' | 'automation' | 'manual-ui' | 'restore';
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKFLOW_START, payload);
    },

    /**
     * Get workflow execution status
     */
    workflowGetExecution: (executionId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKFLOW_GET_EXECUTION, {
        executionId
      });
    },

    /**
     * Get workflow execution for instance
     */
    workflowGetByInstance: (instanceId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKFLOW_GET_BY_INSTANCE, {
        instanceId
      });
    },

    /**
     * Complete a workflow phase
     */
    workflowCompletePhase: (
      executionId: string,
      phaseId: string,
      result?: unknown
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKFLOW_COMPLETE_PHASE, {
        executionId,
        phaseId,
        result
      });
    },

    /**
     * Satisfy a workflow gate
     */
    workflowSatisfyGate: (
      executionId: string,
      gateId: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKFLOW_SATISFY_GATE, {
        executionId,
        gateId
      });
    },

    /**
     * Skip a workflow phase
     */
    workflowSkipPhase: (
      executionId: string,
      phaseId: string,
      reason?: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKFLOW_SKIP_PHASE, {
        executionId,
        phaseId,
        reason
      });
    },

    /**
     * Cancel a workflow
     */
    workflowCancel: (executionId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKFLOW_CANCEL, { executionId });
    },

    /**
     * Get workflow prompt addition
     */
    workflowGetPromptAddition: (executionId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKFLOW_GET_PROMPT_ADDITION, {
        executionId
      });
    },

    // ============================================
    // Phase 6: Review Agents (6.2)
    // ============================================

    /**
     * List available review agents
     */
    reviewListAgents: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REVIEW_LIST_AGENTS);
    },

    /**
     * Get a specific review agent
     */
    reviewGetAgent: (agentId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REVIEW_GET_AGENT, { agentId });
    },

    /**
     * Start a review session
     */
    reviewStartSession: (payload: {
      agentId: string;
      instanceId: string;
      workingDirectory: string;
      files?: string[];
      options?: Record<string, unknown>;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REVIEW_START_SESSION, payload);
    },

    /**
     * Get a review session
     */
    reviewGetSession: (sessionId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REVIEW_GET_SESSION, { sessionId });
    },

    /**
     * Get issues for a review session
     */
    reviewGetIssues: (sessionId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REVIEW_GET_ISSUES, { sessionId });
    },

    /**
     * Acknowledge a review issue
     */
    reviewAcknowledgeIssue: (payload: {
      sessionId: string;
      issueId: string;
      action: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REVIEW_ACKNOWLEDGE_ISSUE, payload);
    },

    // ============================================
    // Phase 6: Hooks (6.3)
    // ============================================

    /**
     * List hooks
     */
    hooksList: (filter?: {
      event?: string;
      scope?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.HOOKS_LIST, { filter });
    },

    /**
     * Get a hook by ID
     */
    hooksGet: (hookId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.HOOKS_GET, { hookId });
    },

    /**
     * Create a new hook
     */
    hooksCreate: (payload: {
      name: string;
      event: string;
      command: string;
      conditions?: Record<string, unknown>;
      scope?: 'global' | 'project';
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.HOOKS_CREATE, payload);
    },

    /**
     * Update a hook
     */
    hooksUpdate: (
      hookId: string,
      updates: Record<string, unknown>
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.HOOKS_UPDATE, { hookId, updates });
    },

    /**
     * Delete a hook
     */
    hooksDelete: (hookId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.HOOKS_DELETE, { hookId });
    },

    /**
     * Evaluate hooks for an event
     */
    hooksEvaluate: (
      event: string,
      context: Record<string, unknown>
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.HOOKS_EVALUATE, { event, context });
    },

    /**
     * Import hooks from file
     */
    hooksImport: (filePath: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.HOOKS_IMPORT, { filePath });
    },

    /**
     * Export hooks to file
     */
    hooksExport: (filePath: string, hookIds?: string[]): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.HOOKS_EXPORT, { filePath, hookIds });
    },

    /**
     * List hook approvals
     */
    hooksApprovalsList: (payload?: {
      pendingOnly?: boolean;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.HOOK_APPROVALS_LIST, payload);
    },

    /**
     * Update hook approval
     */
    hooksApprovalsUpdate: (payload: {
      hookId: string;
      approved: boolean;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.HOOK_APPROVALS_UPDATE, payload);
    },

    /**
     * Clear hook approvals
     */
    hooksApprovalsClear: (payload?: {
      hookIds?: string[];
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.HOOK_APPROVALS_CLEAR, payload);
    },

    // ============================================
    // Phase 6: Skills (6.4)
    // ============================================

    /**
     * Discover skills in a directory
     */
    skillsDiscover: (directory?: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SKILLS_DISCOVER, { directory });
    },

    /**
     * List available skills
     */
    skillsList: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SKILLS_LIST);
    },

    /**
     * Get a skill by ID
     */
    skillsGet: (skillId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SKILLS_GET, { skillId });
    },

    /**
     * Load a skill
     */
    skillsLoad: (skillId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SKILLS_LOAD, { skillId });
    },

    /**
     * Unload a skill
     */
    skillsUnload: (skillId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SKILLS_UNLOAD, { skillId });
    },

    /**
     * Load reference documentation for a skill
     */
    skillsLoadReference: (skillId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SKILLS_LOAD_REFERENCE, { skillId });
    },

    /**
     * Load example for a skill
     */
    skillsLoadExample: (
      skillId: string,
      exampleId: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SKILLS_LOAD_EXAMPLE, {
        skillId,
        exampleId
      });
    },

    /**
     * Match skills to a query
     */
    skillsMatch: (query: string, maxResults?: number): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SKILLS_MATCH, { query, maxResults });
    },

    /**
     * Get skill memory
     */
    skillsGetMemory: (skillId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SKILLS_GET_MEMORY, { skillId });
    },

    /**
     * Recent skill activations (skill observability)
     */
    skillsActivationsRecent: (query?: {
      skillName?: string;
      instanceId?: string;
      since?: number;
      limit?: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SKILLS_ACTIVATIONS_RECENT, query);
    },

    /**
     * Per-skill health summary plus current controls
     */
    skillsHealthSummary: (since?: number): Promise<IpcResponse> => {
      return ipcRenderer.invoke(
        ch.SKILLS_HEALTH_SUMMARY,
        since === undefined ? undefined : { since }
      );
    },

    /**
     * List per-skill controls (kill-switch state)
     */
    skillsListControls: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SKILLS_LIST_CONTROLS);
    },

    /**
     * Set a per-skill control mode (enabled | suggest-only | disabled)
     */
    skillsSetControl: (
      skillName: string,
      mode: 'enabled' | 'suggest-only' | 'disabled',
      reason?: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SKILLS_SET_CONTROL, { skillName, mode, reason });
    },

    /**
     * Listen for live skill-activation deltas
     */
    onSkillActivationDelta: (callback: (activation: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, activation: unknown) => callback(activation);
      ipcRenderer.on(ch.SKILLS_ACTIVATION_DELTA, handler);
      return () => ipcRenderer.removeListener(ch.SKILLS_ACTIVATION_DELTA, handler);
    },

    // ============================================
    // Phase 7: Supervision (7.3)
    // ============================================

    /**
     * Get supervision tree
     */
    supervisionGetTree: (rootInstanceId?: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SUPERVISION_GET_TREE, {
        rootInstanceId
      });
    },

    /**
     * Get supervision health status
     */
    supervisionGetHealth: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SUPERVISION_GET_HEALTH);
    },

    /**
     * Listen for supervision tree-updated events
     */
    onSupervisionTreeUpdated: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.SUPERVISION_TREE_UPDATED, handler);
      return () => ipcRenderer.removeListener(ch.SUPERVISION_TREE_UPDATED, handler);
    },

    /**
     * Listen for supervision worker-failed events
     */
    onSupervisionWorkerFailed: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.SUPERVISION_WORKER_FAILED, handler);
      return () => ipcRenderer.removeListener(ch.SUPERVISION_WORKER_FAILED, handler);
    },

    /**
     * Listen for supervision worker-restarted events
     */
    onSupervisionWorkerRestarted: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.SUPERVISION_WORKER_RESTARTED, handler);
      return () => ipcRenderer.removeListener(ch.SUPERVISION_WORKER_RESTARTED, handler);
    },

    /**
     * Listen for supervision circuit-breaker-changed events
     */
    onSupervisionCircuitBreakerChanged: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.SUPERVISION_CIRCUIT_BREAKER_CHANGED, handler);
      return () => ipcRenderer.removeListener(ch.SUPERVISION_CIRCUIT_BREAKER_CHANGED, handler);
    },

    /**
     * Listen for supervision health-changed events
     */
    onSupervisionHealthChanged: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.SUPERVISION_HEALTH_CHANGED, handler);
      return () => ipcRenderer.removeListener(ch.SUPERVISION_HEALTH_CHANGED, handler);
    },

    /**
     * Listen for supervision health-global events
     */
    onSupervisionHealthGlobal: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.SUPERVISION_HEALTH_GLOBAL, handler);
      return () => ipcRenderer.removeListener(ch.SUPERVISION_HEALTH_GLOBAL, handler);
    },

    /**
     * Listen for supervision exhausted events
     */
    onSupervisionExhausted: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.SUPERVISION_EXHAUSTED, handler);
      return () => ipcRenderer.removeListener(ch.SUPERVISION_EXHAUSTED, handler);
    },

    // ============================================
    // Phase 8: Verification (8.3)
    // ============================================

    /**
     * Start CLI-based verification
     */
    verificationStartCli: (payload: {
      id: string;
      prompt: string;
      context?: string;
      config: {
        cliAgents?: string[];
        agentCount?: number;
        synthesisStrategy?: string;
        personalities?: string[];
        confidenceThreshold?: number;
        timeout?: number;
        maxDebateRounds?: number;
        fallbackToApi?: boolean;
        mixedMode?: boolean;
      };
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VERIFICATION_START_CLI, payload);
    },

    /**
     * Cancel an ongoing verification
     */
    verificationCancel: (payload: { id: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VERIFICATION_CANCEL, payload);
    },

    /**
     * Listen for verification agent-start events
     */
    onVerificationAgentStart: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.VERIFICATION_AGENT_START, handler);
      return () => ipcRenderer.removeListener(ch.VERIFICATION_AGENT_START, handler);
    },

    /**
     * Listen for verification agent-stream events
     */
    onVerificationAgentStream: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.VERIFICATION_AGENT_STREAM, handler);
      return () => ipcRenderer.removeListener(ch.VERIFICATION_AGENT_STREAM, handler);
    },

    /**
     * Listen for verification agent-complete events
     */
    onVerificationAgentComplete: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.VERIFICATION_AGENT_COMPLETE, handler);
      return () => ipcRenderer.removeListener(ch.VERIFICATION_AGENT_COMPLETE, handler);
    },

    /**
     * Listen for verification agent-error events
     */
    onVerificationAgentError: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.VERIFICATION_AGENT_ERROR, handler);
      return () => ipcRenderer.removeListener(ch.VERIFICATION_AGENT_ERROR, handler);
    },

    /**
     * Listen for verification round-progress events
     */
    onVerificationRoundProgress: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.VERIFICATION_ROUND_PROGRESS, handler);
      return () => ipcRenderer.removeListener(ch.VERIFICATION_ROUND_PROGRESS, handler);
    },

    /**
     * Listen for verification consensus-update events
     */
    onVerificationConsensusUpdate: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.VERIFICATION_CONSENSUS_UPDATE, handler);
      return () => ipcRenderer.removeListener(ch.VERIFICATION_CONSENSUS_UPDATE, handler);
    },

    /**
     * Listen for verification complete events
     */
    onVerificationComplete: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.VERIFICATION_COMPLETE, handler);
      return () => ipcRenderer.removeListener(ch.VERIFICATION_COMPLETE, handler);
    },

    /**
     * Listen for verification verdict-ready events
     */
    onVerificationVerdictReady: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.VERIFICATION_VERDICT_READY, handler);
      return () => ipcRenderer.removeListener(ch.VERIFICATION_VERDICT_READY, handler);
    },

    /**
     * Listen for verification error events
     */
    onVerificationError: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.VERIFICATION_ERROR, handler);
      return () => ipcRenderer.removeListener(ch.VERIFICATION_ERROR, handler);
    },

    // ============================================
    // Phase 9: Debate (9.3)
    // ============================================

    /**
     * Start a debate
     */
    debateStart: (payload: {
      query: string;
      context?: string;
      config?: Record<string, unknown>;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DEBATE_START, payload);
    },

    /**
     * Get debate result
     */
    debateGetResult: (debateId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DEBATE_GET_RESULT, debateId);
    },

    /**
     * Get active debates
     */
    debateGetActive: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DEBATE_GET_ACTIVE);
    },

    /**
     * Cancel debate
     */
    debateCancel: (debateId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DEBATE_CANCEL, debateId);
    },

    /**
     * Get debate stats
     */
    debateGetStats: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DEBATE_GET_STATS);
    },

    /**
     * Pause a running debate
     */
    debatePause: (payload: { sessionId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DEBATE_PAUSE, payload);
    },

    /**
     * Resume a paused debate
     */
    debateResume: (payload: { sessionId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DEBATE_RESUME, payload);
    },

    /**
     * Stop a running debate
     */
    debateStop: (payload: { sessionId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DEBATE_STOP, payload);
    },

    /**
     * Request human intervention in a debate
     */
    debateIntervene: (payload: {
      sessionId: string;
      message: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DEBATE_INTERVENE, payload);
    },

    // ============================================
    // LLM Service
    // ============================================

    llmCountTokens: (payload: { text: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.LLM_COUNT_TOKENS, payload),

    onLlmStreamChunk: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.LLM_STREAM_CHUNK, handler);
      return () => ipcRenderer.removeListener(ch.LLM_STREAM_CHUNK, handler);
    },

    // ============================================
    // Consensus
    // ============================================

    consensusQuery: (payload: Record<string, unknown>): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CONSENSUS_QUERY, payload),

    consensusAbort: (payload: { queryId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CONSENSUS_ABORT, payload),

    consensusGetActive: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CONSENSUS_GET_ACTIVE),

    // ============================================
    // Cross-Model Review
    // ============================================

    crossModelReviewOnResult: (callback: (data: unknown) => void) =>
      ipcRenderer.on('cross-model-review:result', (_e, data) => callback(data)),

    crossModelReviewOnStarted: (callback: (data: unknown) => void) =>
      ipcRenderer.on('cross-model-review:started', (_e, data) => callback(data)),

    crossModelReviewOnDiscarded: (callback: (data: unknown) => void) =>
      ipcRenderer.on(ch.CROSS_MODEL_REVIEW_DISCARDED, (_e, data) => callback(data)),

    crossModelReviewOnAllUnavailable: (callback: (data: unknown) => void) =>
      ipcRenderer.on('cross-model-review:all-unavailable', (_e, data) => callback(data)),

    crossModelReviewOnReviewerUnavailable: (callback: (data: unknown) => void) =>
      ipcRenderer.on('cross-model-review:reviewer-unavailable', (_e, data) => callback(data)),

    crossModelReviewOnReviewerRateLimited: (callback: (data: unknown) => void) =>
      ipcRenderer.on('cross-model-review:reviewer-rate-limited', (_e, data) => callback(data)),

    crossModelReviewOnReviewerRateLimitCleared: (callback: (data: unknown) => void) =>
      ipcRenderer.on('cross-model-review:reviewer-rate-limit-cleared', (_e, data) => callback(data)),

    crossModelReviewStatus: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CROSS_MODEL_REVIEW_STATUS),

    crossModelReviewDismiss: (payload: Record<string, unknown>): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CROSS_MODEL_REVIEW_DISMISS, payload),

    crossModelReviewAction: (payload: Record<string, unknown>): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.CROSS_MODEL_REVIEW_ACTION, payload),
  };
}
