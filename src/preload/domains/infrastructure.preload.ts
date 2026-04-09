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
    // ============================================
    // App
    // ============================================

    /**
     * Signal app ready
     */
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

    /**
     * Get app version
     */
    getVersion: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.APP_GET_VERSION);
    },

    // ============================================
    // Settings
    // ============================================

    /**
     * Get all settings
     */
    getSettings: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SETTINGS_GET_ALL);
    },

    /**
     * Get a single setting
     */
    getSetting: (key: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SETTINGS_GET, key);
    },

    /**
     * Set a single setting
     */
    setSetting: (key: string, value: unknown): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SETTINGS_SET, { key, value });
    },

    /**
     * Update multiple settings
     */
    updateSettings: (settings: Record<string, unknown>): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SETTINGS_UPDATE, { settings });
    },

    /**
     * Reset all settings to defaults
     */
    resetSettings: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SETTINGS_RESET);
    },

    /**
     * Reset a single setting to default
     */
    resetSetting: (key: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SETTINGS_RESET_ONE, { key });
    },

    /**
     * Listen for settings changes
     */
    onSettingsChanged: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on(ch.SETTINGS_CHANGED, handler);
      return () =>
        ipcRenderer.removeListener(ch.SETTINGS_CHANGED, handler);
    },

    /**
     * Export all settings to a JSON file (shows save dialog)
     */
    exportSettings: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SETTINGS_EXPORT);
    },

    /**
     * Import settings from a JSON file (shows open dialog)
     */
    importSettings: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SETTINGS_IMPORT);
    },

    // ============================================
    // Security - Secret Detection & Redaction
    // ============================================

    /**
     * Detect secrets in content
     */
    securityDetectSecrets: (
      content: string,
      contentType?: 'env' | 'text' | 'auto'
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SECURITY_DETECT_SECRETS, {
        content,
        contentType
      });
    },

    /**
     * Redact secrets in content
     */
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

    /**
     * Check if a file path is sensitive
     */
    securityCheckFile: (filePath: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SECURITY_CHECK_FILE, { filePath });
    },

    /**
     * Get secret access audit log
     */
    securityGetAuditLog: (
      instanceId?: string,
      limit?: number
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SECURITY_GET_AUDIT_LOG, {
        instanceId,
        limit
      });
    },

    /**
     * Clear audit log
     */
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

    /**
     * Get safe environment variables
     */
    securityGetSafeEnv: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SECURITY_GET_SAFE_ENV);
    },

    /**
     * Check if a single env var should be allowed
     */
    securityCheckEnvVar: (name: string, value: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SECURITY_CHECK_ENV_VAR, {
        name,
        value
      });
    },

    /**
     * Get env filter config
     */
    securityGetEnvFilterConfig: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SECURITY_GET_ENV_FILTER_CONFIG);
    },

    // ============================================
    // Cost Tracking (5.3)
    // ============================================

    /**
     * Record token usage and cost
     */
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

    /**
     * Get cost summary
     */
    costGetSummary: (instanceId?: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(
        ch.COST_GET_SUMMARY,
        _withAuth({ instanceId })
      );
    },

    /**
     * Get cost history
     */
    costGetHistory: (
      instanceId?: string,
      limit?: number
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.COST_GET_HISTORY, {
        instanceId,
        limit
      });
    },

    /**
     * Set budget limits
     */
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

    /**
     * Get current budget status
     */
    costGetBudgetStatus: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(
        ch.COST_GET_BUDGET_STATUS,
        _withAuth({})
      );
    },

    /**
     * Listen for cost usage events
     */
    onCostUsageRecorded: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('cost:usage-recorded', handler);
      return () => ipcRenderer.removeListener('cost:usage-recorded', handler);
    },

    /**
     * Listen for budget warning events
     */
    onCostBudgetWarning: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('cost:budget-warning', handler);
      return () => ipcRenderer.removeListener('cost:budget-warning', handler);
    },

    /**
     * Listen for budget exceeded events
     */
    onCostBudgetExceeded: (callback: (data: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, data: unknown) => callback(data);
      ipcRenderer.on('cost:budget-exceeded', handler);
      return () => ipcRenderer.removeListener('cost:budget-exceeded', handler);
    },

    // ============================================
    // Remote Config (6.2)
    // ============================================

    /**
     * Fetch remote config
     */
    remoteConfigFetch: (force?: boolean): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REMOTE_CONFIG_FETCH, { force });
    },

    /**
     * Get config value
     */
    remoteConfigGet: (
      key: string,
      defaultValue?: unknown
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REMOTE_CONFIG_GET, {
        key,
        defaultValue
      });
    },

    /**
     * Set config source
     */
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

    /**
     * Get config status
     */
    remoteConfigStatus: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.REMOTE_CONFIG_STATUS);
    },

    /**
     * Listen for remote config updates
     */
    onRemoteConfigUpdated: (
      callback: (config: unknown) => void
    ): (() => void) => {
      const handler = (_event: IpcRendererEvent, config: unknown) =>
        callback(config);
      ipcRenderer.on('remote-config:updated', handler);
      return () => ipcRenderer.removeListener('remote-config:updated', handler);
    },

    /**
     * Listen for remote config errors
     */
    onRemoteConfigError: (callback: (error: unknown) => void): (() => void) => {
      const handler = (_event: IpcRendererEvent, error: unknown) =>
        callback(error);
      ipcRenderer.on('remote-config:error', handler);
      return () => ipcRenderer.removeListener('remote-config:error', handler);
    },

    // ============================================
    // Logging (13.1)
    // ============================================

    /**
     * Log a message
     */
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

    /**
     * Get logs
     */
    logGetLogs: (options?: {
      level?: 'debug' | 'info' | 'warn' | 'error';
      context?: string;
      startTime?: number;
      endTime?: number;
      limit?: number;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LOG_GET_LOGS, { options });
    },

    /**
     * Set log level
     */
    logSetLevel: (
      level: 'debug' | 'info' | 'warn' | 'error'
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LOG_SET_LEVEL, { level });
    },

    /**
     * Export logs
     */
    logExport: (
      filePath: string,
      options?: { format?: 'json' | 'csv'; compress?: boolean }
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LOG_EXPORT, { filePath, options });
    },

    /**
     * Clear logs
     */
    logClear: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.LOG_CLEAR);
    },

    // ============================================
    // Debug Commands (13.2)
    // ============================================

    /**
     * Execute debug command
     */
    debugExecute: (
      command: string,
      args?: Record<string, unknown>
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DEBUG_EXECUTE, { command, args });
    },

    /**
     * Get available debug commands
     */
    debugGetCommands: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DEBUG_GET_COMMANDS);
    },

    /**
     * Get debug info
     */
    debugGetInfo: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DEBUG_GET_INFO);
    },

    /**
     * Run diagnostics
     */
    debugRunDiagnostics: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.DEBUG_RUN_DIAGNOSTICS);
    },

    // ============================================
    // Usage Stats (14.1)
    // ============================================

    /**
     * Record session start
     */
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

    /**
     * Record session end
     */
    statsRecordSessionEnd: (sessionId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.STATS_RECORD_SESSION_END, {
        sessionId
      });
    },

    /**
     * Record message stats
     */
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

    /**
     * Record tool usage
     */
    statsRecordToolUsage: (
      sessionId: string,
      tool: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.STATS_RECORD_TOOL_USAGE, {
        sessionId,
        tool
      });
    },

    /**
     * Get stats for a period
     */
    statsGetStats: (
      period: 'day' | 'week' | 'month' | 'year' | 'all'
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.STATS_GET_STATS, { period });
    },

    /**
     * Export stats
     */
    statsExport: (
      filePath: string,
      period?: 'day' | 'week' | 'month' | 'year' | 'all'
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.STATS_EXPORT, { filePath, period });
    },

    // ============================================
    // Semantic Search (4.7)
    // ============================================

    /**
     * Perform semantic search
     */
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

    /**
     * Build search index
     */
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

    /**
     * Configure Exa API for enhanced search
     */
    searchConfigureExa: (config: {
      apiKey: string;
      baseUrl?: string;
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SEARCH_CONFIGURE_EXA, { config });
    },

    /**
     * Get search index stats
     */
    searchGetIndexStats: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.SEARCH_GET_INDEX_STATS);
    },

    // ============================================
    // Codebase Indexing
    // ============================================

    /**
     * Index a codebase (full or incremental)
     */
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

    /**
     * Index a single file
     */
    codebaseIndexFile: (storeId: string, filePath: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CODEBASE_INDEX_FILE, {
        storeId,
        filePath
      });
    },

    /**
     * Cancel ongoing indexing
     */
    codebaseIndexCancel: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CODEBASE_INDEX_CANCEL);
    },

    /**
     * Get current indexing status
     */
    codebaseIndexStatus: (): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CODEBASE_INDEX_STATUS);
    },

    /**
     * Get index stats for a store
     */
    codebaseIndexStats: (storeId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CODEBASE_INDEX_STATS, { storeId });
    },

    /**
     * Perform hybrid search (BM25 + vector + reranking)
     */
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
    }): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CODEBASE_SEARCH, { options });
    },

    /**
     * Search for symbols
     */
    codebaseSearchSymbols: (
      storeId: string,
      query: string
    ): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CODEBASE_SEARCH_SYMBOLS, {
        storeId,
        query
      });
    },

    /**
     * Start file watcher for a store
     */
    codebaseWatcherStart: (storeId: string, rootPath: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CODEBASE_WATCHER_START, {
        storeId,
        rootPath
      });
    },

    /**
     * Stop file watcher for a store
     */
    codebaseWatcherStop: (storeId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CODEBASE_WATCHER_STOP, { storeId });
    },

    /**
     * Get watcher status
     */
    codebaseWatcherStatus: (storeId: string): Promise<IpcResponse> => {
      return ipcRenderer.invoke(ch.CODEBASE_WATCHER_STATUS, { storeId });
    },

    /**
     * Listen for indexing progress updates
     */
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

    /**
     * Listen for watcher change events
     */
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
  };
}
