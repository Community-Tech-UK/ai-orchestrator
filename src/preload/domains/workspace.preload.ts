import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createWorkspaceDomain(ipcRenderer: IpcRenderer, ch: typeof IPC_CHANNELS) {
  return {

    vcsIsRepo: (workingDirectory: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_IS_REPO, { workingDirectory });
    },
    vcsGetStatus: (workingDirectory: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_GET_STATUS, {
        workingDirectory
      });
    },
    vcsGetBranches: (workingDirectory: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_GET_BRANCHES, {
        workingDirectory
      });
    },
    vcsGetCommits: (
      workingDirectory: string,
      limit?: number
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_GET_COMMITS, {
        workingDirectory,
        limit
      });
    },
    vcsGetDiff: (payload: {
      workingDirectory: string;
      type: 'staged' | 'unstaged' | 'between';
      fromRef?: string;
      toRef?: string;
      filePath?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_GET_DIFF, payload);
    },
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
    vcsGetBlame: (
      workingDirectory: string,
      filePath: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_GET_BLAME, {
        workingDirectory,
        filePath
      });
    },
    vcsFindRepos: (
      rootPath: string,
      ignorePatterns?: string[]
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_FIND_REPOS, {
        rootPath,
        ignorePatterns
      });
    },
    vcsWatchRepos: (repoPaths: string[]): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_WATCH_REPOS, { repoPaths });
    },
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
    vcsStageFiles: (payload: {
      workingDirectory: string;
      filePaths: string[];
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_STAGE_FILES, payload);
    },
    vcsUnstageFiles: (payload: {
      workingDirectory: string;
      filePaths: string[];
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_UNSTAGE_FILES, payload);
    },
    vcsDiscardFiles: (payload: {
      workingDirectory: string;
      filePaths: string[];
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_DISCARD_FILES, payload);
    },
    vcsCommit: (payload: {
      workingDirectory: string;
      message: string;
      signoff?: boolean;
      amend?: boolean;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_COMMIT, payload);
    },
    vcsFetch: (payload: {
      workingDirectory: string;
      remote?: string;
      prune?: boolean;
      opId: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_FETCH, payload);
    },
    vcsPull: (payload: {
      workingDirectory: string;
      remote?: string;
      branch?: string;
      opId: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_PULL, payload);
    },
    vcsPush: (payload: {
      workingDirectory: string;
      remote?: string;
      branch?: string;
      forceWithLease?: boolean;
      setUpstream?: boolean;
      opId: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_PUSH, payload);
    },
    vcsOperationCancel: (payload: { opId: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_OPERATION_CANCEL, payload);
    },
    onVcsOperationProgress: (
      callback: (event: {
        opId: string;
        kind: 'fetch' | 'pull' | 'push';
        phase: 'started' | 'running' | 'completed' | 'cancelled' | 'failed';
        repoPath: string;
        durationMs?: number;
        message?: string;
        stdout?: string;
        stderr?: string;
        exitCode?: number | null;
      }) => void,
    ): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: Parameters<typeof callback>[0]) => callback(data);
      ipcRenderer.on(ch.VCS_OPERATION_PROGRESS, handler);
      return () => ipcRenderer.removeListener(ch.VCS_OPERATION_PROGRESS, handler);
    },
    vcsCheckoutBranch: (payload: {
      workingDirectory: string;
      branchName: string;
      force?: boolean;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.VCS_CHECKOUT_BRANCH, payload);
    },

    worktreeCreate: (payload: {
      instanceId: string;
      baseBranch?: string;
      branchName?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKTREE_CREATE, payload);
    },
    worktreeList: (instanceId?: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKTREE_LIST, { instanceId });
    },
    worktreeGetStatus: (worktreeId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKTREE_GET_STATUS, { worktreeId });
    },

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

    todoGetList: (sessionId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TODO_GET_LIST, { sessionId });
    },
    todoCreate: (payload: {
      sessionId: string;
      content: string;
      activeForm?: string;
      priority?: 'low' | 'medium' | 'high' | 'critical';
      parentId?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TODO_CREATE, payload);
    },
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
    todoDelete: (sessionId: string, todoId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TODO_DELETE, { sessionId, todoId });
    },
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
    todoClear: (sessionId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TODO_CLEAR, { sessionId });
    },
    todoGetCurrent: (sessionId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TODO_GET_CURRENT, { sessionId });
    },
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

    mcpGetState: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_GET_STATE);
    },
    mcpGetServers: (payload?: { includeExternal?: boolean }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_GET_SERVERS, payload);
    },
    mcpSetServerEnabled: (payload: { serverId: string; enabled: boolean }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_SET_SERVER_ENABLED, payload);
    },
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
    mcpRemoveServer: (serverId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_REMOVE_SERVER, { serverId });
    },
    mcpConnect: (serverId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_CONNECT, { serverId });
    },
    mcpDisconnect: (serverId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_DISCONNECT, { serverId });
    },
    mcpRestart: (serverId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_RESTART, { serverId });
    },
    mcpGetTools: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_GET_TOOLS);
    },
    mcpGetResources: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_GET_RESOURCES);
    },
    mcpGetPrompts: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_GET_PROMPTS);
    },
    mcpCallTool: (payload: {
      serverId: string;
      toolName: string;
      arguments: Record<string, unknown>;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_CALL_TOOL, payload);
    },
    mcpReadResource: (payload: {
      serverId: string;
      uri: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_READ_RESOURCE, payload);
    },
    mcpGetPrompt: (payload: {
      serverId: string;
      promptName: string;
      arguments?: Record<string, string>;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_GET_PROMPT, payload);
    },
    mcpGetPresets: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MCP_GET_PRESETS);
    },
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

    lspGetAvailableServers: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_GET_AVAILABLE_SERVERS);
    },
    lspGetStatus: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_GET_STATUS);
    },
    lspGoToDefinition: (payload: {
      filePath: string;
      line: number;
      character: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_GO_TO_DEFINITION, payload);
    },
    lspFindReferences: (payload: {
      filePath: string;
      line: number;
      character: number;
      includeDeclaration?: boolean;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_FIND_REFERENCES, payload);
    },
    lspHover: (payload: {
      filePath: string;
      line: number;
      character: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_HOVER, payload);
    },
    lspDocumentSymbols: (filePath: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_DOCUMENT_SYMBOLS, { filePath });
    },
    lspWorkspaceSymbols: (
      query: string,
      rootPath: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_WORKSPACE_SYMBOLS, {
        query,
        rootPath
      });
    },
    lspDiagnostics: (filePath: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_DIAGNOSTICS, { filePath });
    },
    lspIsAvailable: (filePath: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_IS_AVAILABLE, { filePath });
    },
    lspShutdown: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_SHUTDOWN);
    },

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

    taskGetStatus: (taskId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TASK_GET_STATUS, { taskId });
    },
    taskGetHistory: (parentId?: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TASK_GET_HISTORY, { parentId });
    },
    taskGetByParent: (parentId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TASK_GET_BY_PARENT, { parentId });
    },
    taskGetByChild: (childId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TASK_GET_BY_CHILD, { childId });
    },
    taskCancel: (taskId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.TASK_CANCEL, { taskId });
    },
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

    workspaceHintActive: (payload: {
      path: string;
      nodeId?: string | null;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.WORKSPACE_HINT_ACTIVE, payload);
    },

  };
}
