import { IpcRenderer, IpcRendererEvent } from 'electron';
import { IPC_CHANNELS } from '../generated/channels';
import type { IpcResponse } from './types';

export function createInfrastructureDomain(
  ipcRenderer: IpcRenderer,
  ch: typeof IPC_CHANNELS,
  withAuth: (payload?: Record<string, unknown>) => Record<string, unknown> & { ipcAuthToken?: string } = (p = {}) => p
) {
  // ipcAuthToken is set by appReady and consumed by authenticated IPC calls
  let ipcAuthToken: string | null = null;

  const _withAuth = (payload: Record<string, unknown> = {}): Record<string, unknown> & { ipcAuthToken?: string } =>
    withAuth({ ...payload, ipcAuthToken: ipcAuthToken || undefined });

  return {

    appReady: (): Promise<IpcResponse> => {
      return ipcRenderer
        .invoke(ch.APP_READY)
        .then((response: IpcResponse) => {
          const data = response?.data as { ipcAuthToken?: string } | undefined;
          if (data?.ipcAuthToken) {
            ipcAuthToken = data.ipcAuthToken;
          }
          return response;
        });
    },
    getVersion: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.APP_GET_VERSION);
    },
    getStartupCapabilities: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.APP_GET_STARTUP_CAPABILITIES);
    },
    getScratchDirectory: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.APP_GET_SCRATCH_DIRECTORY);
    },
    onStartupCapabilities: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.APP_STARTUP_CAPABILITIES, handler);
      return () =>
        ipcRenderer.removeListener(ch.APP_STARTUP_CAPABILITIES, handler);
    },

    getSettings: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SETTINGS_GET_ALL);
    },
    getSetting: (key: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SETTINGS_GET, key);
    },
    setSetting: (key: string, value: unknown): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SETTINGS_SET, { key, value });
    },
    updateSettings: (settings: Record<string, unknown>): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SETTINGS_UPDATE, { settings });
    },
    resetSettings: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SETTINGS_RESET);
    },
    resetSetting: (key: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SETTINGS_RESET_ONE, { key });
    },
    onSettingsChanged: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.SETTINGS_CHANGED, handler);
      return () =>
        ipcRenderer.removeListener(ch.SETTINGS_CHANGED, handler);
    },
    exportSettings: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SETTINGS_EXPORT);
    },
    importSettings: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SETTINGS_IMPORT);
    },

    securityDetectSecrets: (
      content: string,
      contentType?: 'env' | 'text' | 'auto'
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SECURITY_DETECT_SECRETS, {
        content,
        contentType
      });
    },
    securityRedactContent: (
      content: string,
      contentType?: 'env' | 'text' | 'auto',
      options?: {
        maskChar?: string;
        showStart?: number;
        showEnd?: number;
        fullMask?: boolean;
        label?: string;
      }
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SECURITY_REDACT_CONTENT, {
        content,
        contentType,
        options
      });
    },
    securityCheckFile: (filePath: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SECURITY_CHECK_FILE, { filePath });
    },
    securityGetAuditLog: (
      instanceId?: string,
      limit?: number
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SECURITY_GET_AUDIT_LOG, {
        instanceId,
        limit
      });
    },
    securityClearAuditLog: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SECURITY_CLEAR_AUDIT_LOG);
    },

    securityGetPermissionConfig: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SECURITY_GET_PERMISSION_CONFIG);
    },

    securitySetPermissionPreset: (
      preset: 'allow' | 'ask' | 'deny'
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SECURITY_SET_PERMISSION_PRESET, { preset });
    },
    securityGetSafeEnv: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SECURITY_GET_SAFE_ENV);
    },
    securityCheckEnvVar: (name: string, value: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SECURITY_CHECK_ENV_VAR, {
        name,
        value
      });
    },
    securityGetEnvFilterConfig: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SECURITY_GET_ENV_FILTER_CONFIG);
    },

    costRecordUsage: (
      instanceId: string,
      provider: string,
      model: string,
      inputTokens: number,
      outputTokens: number
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(
        ch.COST_RECORD_USAGE,
        _withAuth({
          instanceId,
          provider,
          model,
          inputTokens,
          outputTokens
        })
      );
    },
    costGetSummary: (instanceId?: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(
        ch.COST_GET_SUMMARY,
        _withAuth({ instanceId })
      );
    },
    costGetHistory: (
      instanceId?: string,
      limit?: number
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.COST_GET_HISTORY, {
        instanceId,
        limit
      });
    },
    costSetBudget: (budget: {
      daily?: number;
      weekly?: number;
      monthly?: number;
      warningThreshold?: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(
        ch.COST_SET_BUDGET,
        _withAuth({ budget })
      );
    },
    costGetBudgetStatus: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(
        ch.COST_GET_BUDGET_STATUS,
        _withAuth({})
      );
    },
    onCostUsageRecorded: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('cost:usage-recorded', handler);
      return () => ipcRenderer.removeListener('cost:usage-recorded', handler);
    },
    onCostBudgetWarning: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('cost:budget-warning', handler);
      return () => ipcRenderer.removeListener('cost:budget-warning', handler);
    },
    onCostBudgetExceeded: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('cost:budget-exceeded', handler);
      return () => ipcRenderer.removeListener('cost:budget-exceeded', handler);
    },

    quotaGetAll: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.QUOTA_GET_ALL, _withAuth({}));
    },
    quotaGetProvider: (provider: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.QUOTA_GET_PROVIDER, _withAuth({ provider }));
    },
    quotaRefresh: (provider: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.QUOTA_REFRESH, _withAuth({ provider }));
    },
    quotaRefreshAll: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.QUOTA_REFRESH_ALL, _withAuth({}));
    },
    quotaSetPollInterval: (
      provider: string,
      intervalMs: number,
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(
        ch.QUOTA_SET_POLL_INTERVAL,
        _withAuth({ provider, intervalMs }),
      );
    },
    onQuotaUpdated: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.QUOTA_UPDATED, handler);
      return () => ipcRenderer.removeListener(ch.QUOTA_UPDATED, handler);
    },
    onQuotaWarning: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.QUOTA_WARNING, handler);
      return () => ipcRenderer.removeListener(ch.QUOTA_WARNING, handler);
    },
    onQuotaExhausted: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.QUOTA_EXHAUSTED, handler);
      return () => ipcRenderer.removeListener(ch.QUOTA_EXHAUSTED, handler);
    },

    remoteConfigFetch: (force?: boolean): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REMOTE_CONFIG_FETCH, { force });
    },
    remoteConfigGet: (
      key: string,
      defaultValue?: unknown
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REMOTE_CONFIG_GET, {
        key,
        defaultValue
      });
    },
    remoteConfigSetSource: (source: {
      type: 'url' | 'file' | 'git';
      location: string;
      refreshInterval?: number;
      branch?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REMOTE_CONFIG_SET_SOURCE, {
        source
      });
    },
    remoteConfigStatus: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REMOTE_CONFIG_STATUS);
    },
    onRemoteConfigUpdated: (
      callback: (config: unknown) => void
    ): (() => void) => {
      const handler = (_event: IpcRendererEvent, config: unknown) =>
        callback(config);
      ipcRenderer.on('remote-config:updated', handler);
      return () => ipcRenderer.removeListener('remote-config:updated', handler);
    },
    onRemoteConfigError: (callback: (error: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, error: unknown) =>
        callback(error);
      ipcRenderer.on('remote-config:error', handler);
      return () => ipcRenderer.removeListener('remote-config:error', handler);
    },

    logMessage: (
      level: 'debug' | 'info' | 'warn' | 'error',
      message: string,
      context?: string,
      metadata?: Record<string, unknown>
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LOG_MESSAGE, {
        level,
        message,
        context,
        metadata
      });
    },
    logGetLogs: (options?: {
      level?: 'debug' | 'info' | 'warn' | 'error';
      context?: string;
      startTime?: number;
      endTime?: number;
      limit?: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LOG_GET_LOGS, { options });
    },
    logSetLevel: (
      level: 'debug' | 'info' | 'warn' | 'error'
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LOG_SET_LEVEL, { level });
    },
    logExport: (
      filePath: string,
      options?: { format?: 'json' | 'csv'; compress?: boolean }
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LOG_EXPORT, { filePath, options });
    },
    logClear: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LOG_CLEAR);
    },

    debugExecute: (
      command: string,
      args?: Record<string, unknown>
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DEBUG_EXECUTE, { command, args });
    },
    debugGetCommands: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DEBUG_GET_COMMANDS);
    },
    debugGetInfo: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DEBUG_GET_INFO);
    },
    debugRunDiagnostics: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DEBUG_RUN_DIAGNOSTICS);
    },

    statsRecordSessionStart: (
      sessionId: string,
      instanceId: string,
      agentId: string,
      workingDirectory: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.STATS_RECORD_SESSION_START, {
        sessionId,
        instanceId,
        agentId,
        workingDirectory
      });
    },
    statsRecordSessionEnd: (sessionId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.STATS_RECORD_SESSION_END, {
        sessionId
      });
    },
    statsRecordMessage: (
      sessionId: string,
      inputTokens: number,
      outputTokens: number,
      cost: number
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.STATS_RECORD_MESSAGE, {
        sessionId,
        inputTokens,
        outputTokens,
        cost
      });
    },
    statsRecordToolUsage: (
      sessionId: string,
      tool: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.STATS_RECORD_TOOL_USAGE, {
        sessionId,
        tool
      });
    },
    statsGetStats: (
      period: 'day' | 'week' | 'month' | 'year' | 'all'
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.STATS_GET_STATS, { period });
    },
    statsExport: (
      filePath: string,
      period?: 'day' | 'week' | 'month' | 'year' | 'all'
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.STATS_EXPORT, { filePath, period });
    },

    searchSemantic: (options: {
      query: string;
      directory: string;
      maxResults?: number;
      includePatterns?: string[];
      excludePatterns?: string[];
      searchType?: 'semantic' | 'hybrid' | 'keyword';
      minScore?: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SEARCH_SEMANTIC, { options });
    },
    searchBuildIndex: (
      directory: string,
      includePatterns?: string[],
      excludePatterns?: string[]
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SEARCH_BUILD_INDEX, {
        directory,
        includePatterns,
        excludePatterns
      });
    },
    searchConfigureExa: (config: {
      apiKey: string;
      baseUrl?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SEARCH_CONFIGURE_EXA, { config });
    },
    searchGetIndexStats: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SEARCH_GET_INDEX_STATS);
    },

    // Session recall — cross-session search + @T-<id> reference resolution
    sessionRecallSearch: (payload: {
      query?: string;
      intent?: string;
      parentId?: string;
      automationId?: string;
      provider?: string;
      model?: string;
      repositoryPath?: string;
      sources?: string[];
      limit?: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SESSION_RECALL_SEARCH, payload);
    },
    sessionRecallResolveRef: (payload: { text: string }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SESSION_RECALL_RESOLVE_REF, payload);
    },

    // Multi-provider compare — ask N providers the same prompt
    compareListProviders: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.COMPARE_LIST_PROVIDERS);
    },
    compareRun: (payload: {
      prompt: string;
      providers: string[];
      workingDirectory?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.COMPARE_RUN, payload);
    },

    // LSP post-edit feedback loop (opt-in)
    lspFeedbackGet: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_FEEDBACK_GET);
    },
    lspFeedbackSet: (enabled: boolean): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LSP_FEEDBACK_SET, { enabled });
    },

    // Action/cost circuit breaker config
    circuitBreakerGet: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CIRCUIT_BREAKER_GET);
    },
    circuitBreakerSet: (config: { maxActions?: number; maxCostUsd?: number }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CIRCUIT_BREAKER_SET, config);
    },

    // Auto-update (electron-updater)
    updateCheck: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.UPDATE_CHECK);
    },
    updateDownload: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.UPDATE_DOWNLOAD);
    },
    updateInstall: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.UPDATE_INSTALL);
    },
    updateGetStatus: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.UPDATE_GET_STATUS);
    },
    onUpdateStatusChanged: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.UPDATE_STATUS_CHANGED, handler);
      return () => ipcRenderer.removeListener(ch.UPDATE_STATUS_CHANGED, handler);
    },

    // Magic prompts — schema-backed one-shot structured commands
    magicPromptList: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MAGIC_PROMPT_LIST);
    },
    magicPromptRun: (payload: {
      id: string;
      text: string;
      context?: string;
      provider?: string;
      workingDirectory?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.MAGIC_PROMPT_RUN, payload);
    },

    codebaseIndexStore: (
      storeId: string,
      rootPath: string,
      options?: { force?: boolean; filePatterns?: string[] }
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CODEBASE_INDEX_STORE, {
        storeId,
        rootPath,
        options
      });
    },
    codebaseIndexFile: (storeId: string, filePath: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CODEBASE_INDEX_FILE, {
        storeId,
        filePath
      });
    },
    codebaseIndexCancel: (
      workspacePath?: string,
      target?: 'codemem' | 'legacy',
    ): Promise<IpcResponse> => {
      const trimmedPath = workspacePath?.trim();
      return ipcRenderer.invoke(
        ch.CODEBASE_INDEX_CANCEL,
        trimmedPath || target ? { workspacePath: trimmedPath || undefined, target } : undefined,
      );
    },
    codebaseIndexStatus: (
      workspacePath?: string,
      target?: 'codemem' | 'legacy',
    ): Promise<IpcResponse> => {
      const trimmedPath = workspacePath?.trim();
      return ipcRenderer.invoke(
        ch.CODEBASE_INDEX_STATUS,
        trimmedPath || target ? { workspacePath: trimmedPath || undefined, target } : undefined,
      );
    },
    codebaseIndexStats: (storeId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CODEBASE_INDEX_STATS, { storeId });
    },
    codebaseLegacyClear: (storeId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CODEBASE_LEGACY_CLEAR, { storeId });
    },
    codebaseSearch: (options: {
      query: string;
      storeId: string;
      topK?: number;
      useHyDE?: boolean;
      bm25Weight?: number;
      vectorWeight?: number;
      minScore?: number;
      rerank?: boolean;
      filePatterns?: string[];
      workspacePath?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CODEBASE_SEARCH, { options });
    },
    codebaseSearchSymbols: (
      storeId: string,
      query: string,
      workspacePath?: string,
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CODEBASE_SEARCH_SYMBOLS, {
        storeId,
        query,
        workspacePath: workspacePath?.trim() || undefined,
      });
    },
    codebaseWatcherStart: (storeId: string, rootPath: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CODEBASE_WATCHER_START, {
        storeId,
        rootPath
      });
    },
    codebaseWatcherStop: (storeId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CODEBASE_WATCHER_STOP, { storeId });
    },
    codebaseWatcherStatus: (storeId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CODEBASE_WATCHER_STATUS, { storeId });
    },
    onCodebaseIndexProgress: (
      callback: (progress: unknown) => void
    ): (() => void) => {
      const listener = (_event: IpcRendererEvent, progress: unknown): void => {
        callback(progress);
      };
      ipcRenderer.on(ch.CODEBASE_INDEX_PROGRESS, listener);
      return () => {
        ipcRenderer.removeListener(ch.CODEBASE_INDEX_PROGRESS, listener);
      };
    },
    onCodebaseWatcherChanges: (
      callback: (data: unknown) => void
    ): (() => void) => {
      const listener = (_event: IpcRendererEvent, data: unknown): void => {
        callback(data);
      };
      ipcRenderer.on(ch.CODEBASE_WATCHER_CHANGES, listener);
      return () => {
        ipcRenderer.removeListener(ch.CODEBASE_WATCHER_CHANGES, listener);
      };
    },
    codebaseAutoStatusGet: (rootPath?: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(
        ch.CODEBASE_AUTO_STATUS_GET,
        rootPath ? { rootPath } : undefined,
      );
    },

    // Note: `codebaseAutoHint` was consolidated into the unified
    // `workspace.workspaceHintActive(...)` exposed by the workspace preload
    // domain. The main-process handler fans the hint out to this
    // coordinator alongside its siblings.
    onCodebaseAutoStatusChanged: (
      callback: (status: unknown) => void
    ): (() => void) => {
      const listener = (_event: IpcRendererEvent, status: unknown): void => {
        callback(status);
      };
      ipcRenderer.on(ch.CODEBASE_AUTO_STATUS_CHANGED, listener);
      return () => {
        ipcRenderer.removeListener(ch.CODEBASE_AUTO_STATUS_CHANGED, listener);
      };
    },
  };
}
