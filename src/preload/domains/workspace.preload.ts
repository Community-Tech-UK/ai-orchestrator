import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createWorkspaceDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {

    // ============================================
    // VCS (Git) Operations
    // ============================================

    /**
     * Check if working directory is a git repository
     */
    vcsIsRepo: (workingDirectory: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_IS_REPO, { workingDirectory });
    },

    /**
     * Get git status for working directory
     */
    vcsGetStatus: (workingDirectory: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_GET_STATUS, {
        workingDirectory
      });
    },

    /**
     * Get branches for working directory
     */
    vcsGetBranches: (workingDirectory: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_GET_BRANCHES, {
        workingDirectory
      });
    },

    /**
     * Get recent commits
     */
    vcsGetCommits: (
      workingDirectory: string,
      limit?: number
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_GET_COMMITS, {
        workingDirectory,
        limit
      });
    },

    /**
     * Get diff (staged, unstaged, or between refs)
     */
    vcsGetDiff: (payload: {
      workingDirectory: string;
      type: 'staged' | 'unstaged' | 'between';
      fromRef?: string;
      toRef?: string;
      filePath?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_GET_DIFF, payload);
    },

    /**
     * Get file history (commits that modified the file)
     */
    vcsGetFileHistory: (
      workingDirectory: string,
      filePath: string,
      limit?: number
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_GET_FILE_HISTORY, {
        workingDirectory,
        filePath,
        limit
      });
    },

    /**
     * Get file content at a specific commit
     */
    vcsGetFileAtCommit: (
      workingDirectory: string,
      filePath: string,
      commitHash: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_GET_FILE_AT_COMMIT, {
        workingDirectory,
        filePath,
        commitHash
      });
    },

    /**
     * Get blame information for a file
     */
    vcsGetBlame: (
      workingDirectory: string,
      filePath: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_GET_BLAME, {
        workingDirectory,
        filePath
      });
    },

    /**
     * Discover all nested git repositories under a directory.
     * Used by the Source Control panel to enumerate every repo the user has
     * inside their working folder (matches VS Code's multi-root SCM behavior).
     */
    vcsFindRepos: (
      rootPath: string,
      ignorePatterns?: string[]
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_FIND_REPOS, {
        rootPath,
        ignorePatterns
      });
    },

    /**
     * Replace the set of repos the main-process GitStatusWatcher tracks.
     * Passing `repoPaths: []` stops all watchers.
     */
    vcsWatchRepos: (repoPaths: string[]): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_WATCH_REPOS, { repoPaths });
    },

    /**
     * Subscribe to git-status-changed events from the main-process
     * watcher. Returns an unsubscribe function.
     */
    onVcsStatusChanged: (
      callback: (event: { repoPath: string; reason: string; timestamp: number }) => void
    ): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        data: { repoPath: string; reason: string; timestamp: number }
      ) => callback(data);
      ipcRenderer.on(ch.VCS_STATUS_CHANGED, handler);
      return () => ipcRenderer.removeListener(ch.VCS_STATUS_CHANGED, handler);
    },

    /**
     * Stage files (`git add -- <paths>`).
     * Phase 2d — item 7 of the source-control phase-2 plan.
     */
    vcsStageFiles: (payload: {
      workingDirectory: string;
      filePaths: string[];
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_STAGE_FILES, payload);
    },

    /**
     * Unstage files (`git restore --staged -- <paths>`).
     * Phase 2d — item 7. Only the index side is touched; the worktree
     * contents are preserved.
     */
    vcsUnstageFiles: (payload: {
      workingDirectory: string;
      filePaths: string[];
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_UNSTAGE_FILES, payload);
    },

    // ============================================
    // Phase 7: Worktrees (7.1)
    // ============================================

    /**
     * Create a worktree for isolated work
     */
    worktreeCreate: (payload: {
      instanceId: string;
      baseBranch?: string;
      branchName?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKTREE_CREATE, payload);
    },

    /**
     * List worktrees
     */
    worktreeList: (instanceId?: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKTREE_LIST, { instanceId });
    },

    /**
     * Delete a worktree
     */
    worktreeDelete: (worktreeId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKTREE_DELETE, { worktreeId });
    },

    /**
     * Get worktree status
     */
    worktreeGetStatus: (worktreeId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKTREE_GET_STATUS, { worktreeId });
    },

    // ============================================
    // Parallel Worktrees
    // ============================================

    parallelWorktreeStart: (payload: {
      tasks: unknown[];
      instanceId: string;
      repoPath: string;
    }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PARALLEL_WORKTREE_START, payload),

    parallelWorktreeGetStatus: (payload: { executionId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PARALLEL_WORKTREE_GET_STATUS, payload),

    parallelWorktreeCancel: (payload: { executionId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PARALLEL_WORKTREE_CANCEL, payload),

    parallelWorktreeGetResults: (payload: { executionId: string }): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PARALLEL_WORKTREE_GET_RESULTS, payload),

    parallelWorktreeList: (): Promise<IpcResponse> =>
      ipcRenderer.invoke(ch.PARALLEL_WORKTREE_LIST),

    // ============================================
    // TODO Operations
    // ============================================

    /**
     * Get TODO list for a session
     */
    todoGetList: (sessionId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TODO_GET_LIST, { sessionId });
    },

    /**
     * Create a new TODO
     */
    todoCreate: (payload: {
      sessionId: string;
      content: string;
      activeForm?: string;
      priority?: 'low' | 'medium' | 'high' | 'critical';
      parentId?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TODO_CREATE, payload);
    },

    /**
     * Update a TODO
     */
    todoUpdate: (payload: {
      sessionId: string;
      todoId: string;
      content?: string;
      activeForm?: string;
      status?: 'pending' | 'in_progress' | 'completed' | 'cancelled';
      priority?: 'low' | 'medium' | 'high' | 'critical';
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TODO_UPDATE, payload);
    },

    /**
     * Delete a TODO
     */
    todoDelete: (sessionId: string, todoId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TODO_DELETE, { sessionId, todoId });
    },

    /**
     * Write all TODOs at once (replaces existing)
     * This matches Claude's TodoWrite tool format
     */
    todoWriteAll: (payload: {
      sessionId: string;
      todos: {
        content: string;
        status: string;
        activeForm?: string;
      }[];
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TODO_WRITE_ALL, payload);
    },

    /**
     * Clear all TODOs for a session
     */
    todoClear: (sessionId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TODO_CLEAR, { sessionId });
    },

    /**
     * Get the current in-progress TODO
     */
    todoGetCurrent: (sessionId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TODO_GET_CURRENT, { sessionId });
    },

    /**
     * Listen for TODO list changes
     */
    onTodoListChanged: (
      callback: (data: { sessionId: string; list: unknown }) => void
    ): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        data: { sessionId: string; list: unknown }
      ) => callback(data);
      ipcRenderer.on(ch.TODO_LIST_CHANGED, handler);
      return () =>
        ipcRenderer.removeListener(ch.TODO_LIST_CHANGED, handler);
    },

    // ============================================
    // MCP Operations
    // ============================================

    /**
     * Get full MCP state (servers, tools, resources, prompts)
     */
    mcpGetState: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_GET_STATE);
    },

    /**
     * Get all MCP servers
     */
    mcpGetServers: (payload?: { includeExternal?: boolean }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_GET_SERVERS, payload);
    },

    /**
     * Enable or disable a provider-configured MCP server
     */
    mcpSetServerEnabled: (payload: { serverId: string; enabled: boolean }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_SET_SERVER_ENABLED, payload);
    },

    /**
     * Add an MCP server
     */
    mcpAddServer: (payload: {
      id: string;
      name: string;
      description?: string;
      transport: 'stdio' | 'http' | 'sse';
      command?: string;
      args?: string[];
      env?: Record<string, string>;
      url?: string;
      autoConnect?: boolean;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_ADD_SERVER, payload);
    },

    /**
     * Remove an MCP server
     */
    mcpRemoveServer: (serverId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_REMOVE_SERVER, { serverId });
    },

    /**
     * Connect to an MCP server
     */
    mcpConnect: (serverId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_CONNECT, { serverId });
    },

    /**
     * Disconnect from an MCP server
     */
    mcpDisconnect: (serverId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_DISCONNECT, { serverId });
    },

    /**
     * Restart an MCP server connection
     */
    mcpRestart: (serverId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_RESTART, { serverId });
    },

    /**
     * Get all MCP tools
     */
    mcpGetTools: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_GET_TOOLS);
    },

    /**
     * Get all MCP resources
     */
    mcpGetResources: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_GET_RESOURCES);
    },

    /**
     * Get all MCP prompts
     */
    mcpGetPrompts: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_GET_PROMPTS);
    },

    /**
     * Call an MCP tool
     */
    mcpCallTool: (payload: {
      serverId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_CALL_TOOL, payload);
    },

    /**
     * Read an MCP resource
     */
    mcpReadResource: (payload: {
      serverId: string;
      uri: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_READ_RESOURCE, payload);
    },

    /**
     * Get an MCP prompt
     */
    mcpGetPrompt: (payload: {
      serverId: string;
      promptName: string;
      arguments?: Record<string, string>;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_GET_PROMPT, payload);
    },

    /**
     * Get MCP server presets
     */
    mcpGetPresets: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_GET_PRESETS);
    },

    /**
     * Get browser automation readiness diagnostics
     */
    mcpGetBrowserAutomationHealth: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_GET_BROWSER_AUTOMATION_HEALTH);
    },

    mcpGetMultiProviderState: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_GET_MULTI_PROVIDER_STATE);
    },

    mcpRefreshMultiProviderState: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_REFRESH_MULTI_PROVIDER_STATE);
    },

    mcpOrchestratorUpsert: (payload: unknown): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_ORCHESTRATOR_UPSERT, payload);
    },

    mcpOrchestratorDelete: (payload: { serverId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_ORCHESTRATOR_DELETE, payload);
    },

    mcpOrchestratorSetInjectionTargets: (payload: {
      serverId: string;
      providers: string[];
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_ORCHESTRATOR_SET_INJECTION_TARGETS, payload);
    },

    mcpSharedUpsert: (payload: unknown): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_SHARED_UPSERT, payload);
    },

    mcpSharedDelete: (payload: { serverId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_SHARED_DELETE, payload);
    },

    mcpSharedFanOut: (payload: { serverId: string; providers?: string[] }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_SHARED_FAN_OUT, payload);
    },

    mcpSharedGetDrift: (payload: { serverId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_SHARED_GET_DRIFT, payload);
    },

    mcpSharedResolveDrift: (payload: {
      serverId: string;
      provider: string;
      action: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_SHARED_RESOLVE_DRIFT, payload);
    },

    mcpProviderUserUpsert: (payload: unknown): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_PROVIDER_USER_UPSERT, payload);
    },

    mcpProviderUserDelete: (payload: { provider: string; serverId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_PROVIDER_USER_DELETE, payload);
    },

    mcpProviderOpenScopeFile: (payload: { provider: string; scope: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_PROVIDER_OPEN_SCOPE_FILE, payload);
    },

    /**
     * Listen for MCP state changes (tools, resources, prompts updated)
     */
    onMcpStateChanged: (
      callback: (data: { type: string; serverId?: string }) => void
    ): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        data: { type: string; serverId?: string }
      ) => callback(data);
      ipcRenderer.on(ch.MCP_STATE_CHANGED, handler);
      return () =>
        ipcRenderer.removeListener(ch.MCP_STATE_CHANGED, handler);
    },

    /**
     * Listen for MCP server status changes
     */
    onMcpServerStatusChanged: (
      callback: (data: {
        serverId: string;
        status: string;
        error?: string;
      }) => void
    ): (() => void) => {
      const handler = (
        _event: IpcRendererEvent,
        data: { serverId: string; status: string; error?: string }
      ) => callback(data);
      ipcRenderer.on(ch.MCP_SERVER_STATUS_CHANGED, handler);
      return () =>
        ipcRenderer.removeListener(
          ch.MCP_SERVER_STATUS_CHANGED,
          handler
        );
    },

    onMcpMultiProviderStateChanged: (
      callback: (data: unknown) => void
    ): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.MCP_MULTI_PROVIDER_STATE_CHANGED, handler);
      return () =>
        ipcRenderer.removeListener(ch.MCP_MULTI_PROVIDER_STATE_CHANGED, handler);
    },

    // ============================================
    // LSP Operations
    // ============================================

    /**
     * Get available LSP servers (installed language servers)
     */
    lspGetAvailableServers: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_GET_AVAILABLE_SERVERS);
    },

    /**
     * Get status of all active LSP clients
     */
    lspGetStatus: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_GET_STATUS);
    },

    /**
     * Go to definition (navigate to where symbol is defined)
     */
    lspGoToDefinition: (payload: {
      filePath: string;
      line: number;
      character: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_GO_TO_DEFINITION, payload);
    },

    /**
     * Find all references to a symbol
     */
    lspFindReferences: (payload: {
      filePath: string;
      line: number;
      character: number;
      includeDeclaration?: boolean;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_FIND_REFERENCES, payload);
    },

    /**
     * Get hover information (type info, documentation)
     */
    lspHover: (payload: {
      filePath: string;
      line: number;
      character: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_HOVER, payload);
    },

    /**
     * Get document symbols (outline/structure)
     */
    lspDocumentSymbols: (filePath: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_DOCUMENT_SYMBOLS, { filePath });
    },

    /**
     * Search workspace symbols
     */
    lspWorkspaceSymbols: (
      query: string,
      rootPath: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_WORKSPACE_SYMBOLS, {
        query,
        rootPath
      });
    },

    /**
     * Get diagnostics (errors, warnings) for a file
     */
    lspDiagnostics: (filePath: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_DIAGNOSTICS, { filePath });
    },

    /**
     * Check if LSP is available for a file type
     */
    lspIsAvailable: (filePath: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_IS_AVAILABLE, { filePath });
    },

    /**
     * Shutdown all LSP clients
     */
    lspShutdown: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_SHUTDOWN);
    },

    // ============================================
    // Multi-Edit Operations
    // ============================================

    /**
     * Preview edits without applying them
     */
    multiEditPreview: (payload: {
      edits: {
        filePath: string;
        oldString: string;
        newString: string;
        replaceAll?: boolean;
      }[];
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MULTIEDIT_PREVIEW, payload);
    },

    /**
     * Apply edits atomically (all succeed or all fail)
     */
    multiEditApply: (payload: {
      edits: {
        filePath: string;
        oldString: string;
        newString: string;
        replaceAll?: boolean;
      }[];
      instanceId?: string;
      takeSnapshots?: boolean;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MULTIEDIT_APPLY, payload);
    },

    // ============================================
    // Bash Validation
    // ============================================

    /**
     * Validate a bash command for safety
     */
    bashValidate: (command: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BASH_VALIDATE, command);
    },

    /**
     * Get bash validator configuration
     */
    bashGetConfig: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BASH_GET_CONFIG);
    },

    /**
     * Add a command to the allowed list
     */
    bashAddAllowed: (command: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BASH_ADD_ALLOWED, command);
    },

    /**
     * Add a command to the blocked list
     */
    bashAddBlocked: (command: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.BASH_ADD_BLOCKED, command);
    },

    // ============================================
    // Task Management (Subagent Spawning)
    // ============================================

    /**
     * Get task status by ID
     */
    taskGetStatus: (taskId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TASK_GET_STATUS, { taskId });
    },

    /**
     * Get task history
     */
    taskGetHistory: (parentId?: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TASK_GET_HISTORY, { parentId });
    },

    /**
     * Get tasks by parent instance
     */
    taskGetByParent: (parentId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TASK_GET_BY_PARENT, { parentId });
    },

    /**
     * Get task by child instance
     */
    taskGetByChild: (childId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TASK_GET_BY_CHILD, { childId });
    },

    /**
     * Cancel a task
     */
    taskCancel: (taskId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TASK_CANCEL, { taskId });
    },

    /**
     * Get task queue stats
     */
    taskGetQueue: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TASK_GET_QUEUE);
    },

    taskGetPreflight: (payload: {
      workingDirectory: string;
      surface: 'repo-job' | 'workflow' | 'worktree' | 'verification';
      taskType?: string;
      requiresWrite?: boolean;
      requiresNetwork?: boolean;
      requiresBrowser?: boolean;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TASK_GET_PREFLIGHT, payload);
    },

    repoJobSubmit: (payload: {
      type: 'pr-review' | 'issue-implementation' | 'repo-health-audit';
      workingDirectory: string;
      issueOrPrUrl?: string;
      title?: string;
      description?: string;
      baseBranch?: string;
      branchRef?: string;
      workflowTemplateId?: string;
      useWorktree?: boolean;
      browserEvidence?: boolean;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REPO_JOB_SUBMIT, payload);
    },

    repoJobList: (payload?: {
      status?: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
      type?: 'pr-review' | 'issue-implementation' | 'repo-health-audit';
      limit?: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REPO_JOB_LIST, payload);
    },

    repoJobGet: (jobId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REPO_JOB_GET, { jobId });
    },

    repoJobCancel: (jobId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REPO_JOB_CANCEL, { jobId });
    },

    repoJobRerun: (jobId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REPO_JOB_RERUN, { jobId });
    },

    repoJobGetStats: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REPO_JOB_GET_STATS);
    },

  };
}
