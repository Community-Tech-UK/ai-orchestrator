import { app } from 'electron';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { getSettingsManager } from '../core/config/settings-manager';
import { McpServer } from '../mcp/mcp-server';
import { registerCleanup } from '../util/cleanup-registry';
import { defaultDriverFactory } from '../db/better-sqlite3-driver';
import type { SqliteDriver } from '../db/sqlite-driver';
import { migrate } from './cas-schema';
import { CasStore } from './cas-store';
import { CodeIndexManager } from './code-index-manager';
import { PeriodicScan } from './periodic-scan';
import { AgentLspFacade, type WorkspaceLspState } from './agent-lsp-facade';
import { workspaceHashForPath } from './symbol-id';
import { LspWorkerGateway } from '../lsp-worker/gateway-rpc';
import { IndexWorkerGateway, type IndexWorkerCodeIndexChangedEvent } from './index-worker-gateway';
import { createCodememMcpTools } from './mcp-tools';

export class CodememService extends EventEmitter {
  private db: SqliteDriver | null = null;
  private storeInstance: CasStore | null = null;
  private indexManagerInstance: CodeIndexManager | null = null;
  private periodicScanInstance: PeriodicScan | null = null;
  private facadeInstance: AgentLspFacade | null = null;
  private readonly gatewayInstance = new LspWorkerGateway();
  private readonly indexWorkerGatewayInstance = new IndexWorkerGateway();
  private readonly workspaceLspState = new Map<string, WorkspaceLspState>();
  private readonly workspaceLspReadyFiles = new Map<string, string | null>();
  private mcpToolsRegistered = false;

  constructor() {
    super();
    this.indexWorkerGateway.on('code-index:changed', (event: IndexWorkerCodeIndexChangedEvent) => {
      this.emit('code-index:changed', event);
    });
  }

  get store(): CasStore {
    if (!this.storeInstance) {
      this.storeInstance = new CasStore(this.getDb());
    }
    return this.storeInstance;
  }

  get indexManager(): CodeIndexManager {
    if (!this.indexManagerInstance) {
      this.indexManagerInstance = new CodeIndexManager({ store: this.store });
    }
    return this.indexManagerInstance;
  }

  get periodicScan(): PeriodicScan {
    if (!this.periodicScanInstance) {
      this.periodicScanInstance = new PeriodicScan({
        store: this.store,
        mgr: this.indexManager,
      });
    }
    return this.periodicScanInstance;
  }

  get gateway(): LspWorkerGateway {
    return this.gatewayInstance;
  }

  get indexWorkerGateway(): IndexWorkerGateway {
    return this.indexWorkerGatewayInstance;
  }

  get facade(): AgentLspFacade {
    if (!this.facadeInstance) {
      this.facadeInstance = new AgentLspFacade({
        store: this.store,
        gateway: this.gateway,
        getWorkspaceLspState: (workspaceHash) => this.workspaceLspState.get(workspaceHash) ?? 'idle',
      });
    }
    return this.facadeInstance;
  }

  async initialize(): Promise<void> {
    // The codemem feature flags should disable this subsystem cleanly without affecting app boot.
    if (!this.isEnabled()) {
      return;
    }

    this.registerMcpTools();

    if (this.isLspEnabled()) {
      await this.gateway.start();
    }

    if (this.isIndexingEnabled()) {
      await this.indexWorkerGateway.start();
    }
  }

  async shutdown(): Promise<void> {
    await this.indexWorkerGateway.stop();
    await this.gateway.stop();
    if (McpServer.getInstance().isStarted()) {
      McpServer.getInstance().stop();
    }
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this.storeInstance = null;
    this.indexManagerInstance = null;
    this.periodicScanInstance = null;
    this.facadeInstance = null;
  }

  isEnabled(): boolean {
    const settings = getSettingsManager().getAll();
    return settings.codememEnabled;
  }

  isIndexingEnabled(): boolean {
    const settings = getSettingsManager().getAll();
    return settings.codememEnabled && settings.codememIndexingEnabled;
  }

  isLspEnabled(): boolean {
    const settings = getSettingsManager().getAll();
    return settings.codememEnabled && settings.codememLspWorkerEnabled;
  }

  async ensureWorkspace(workspacePath: string, timeoutMs = 15_000) {
    if (!this.isEnabled() || !this.isIndexingEnabled()) {
      throw new Error('Codemem indexing is disabled.');
    }

    const normalizedPath = path.resolve(workspacePath);
    await this.indexWorkerGateway.warmWorkspace(normalizedPath, timeoutMs);
    const workspaceRoot = this.store.getWorkspaceRootByPath(normalizedPath);

    if (!workspaceRoot) {
      throw new Error(`Failed to index workspace: ${normalizedPath}`);
    }

    return workspaceRoot;
  }

  async warmWorkspace(workspacePath: string, timeoutMs = 15_000): Promise<{ ready: boolean; filePath: string | null }> {
    if (!this.isEnabled() || !this.isIndexingEnabled()) {
      return { ready: false, filePath: null };
    }

    const normalizedPath = path.resolve(workspacePath);
    const workspaceHash = workspaceHashForPath(normalizedPath);
    if (this.workspaceLspState.get(workspaceHash) === 'ready' && this.isLspEnabled()) {
      return {
        ready: true,
        filePath: this.workspaceLspReadyFiles.get(workspaceHash) ?? null,
      };
    }

    // Indexing runs in the index worker so the main event loop is not blocked.
    // If the gateway is unavailable or times out, return degraded gracefully.
    const indexResult = await this.indexWorkerGateway.warmWorkspace(workspacePath, timeoutMs);

    if (!indexResult.indexed) {
      this.cancelStaleWarmWorkspace(normalizedPath, workspaceHash, timeoutMs);
      this.workspaceLspState.set(workspaceHash, 'lsp_unavailable');
      this.workspaceLspReadyFiles.delete(workspaceHash);
      return { ready: false, filePath: null };
    }

    if (!this.isLspEnabled()) {
      this.workspaceLspState.set(workspaceHash, 'lsp_unavailable');
      this.workspaceLspReadyFiles.delete(workspaceHash);
      return { ready: false, filePath: null };
    }

    this.workspaceLspState.set(workspaceHash, 'warming');
    try {
      const result = await this.gateway.ready(
        indexResult.absPath,
        indexResult.primaryLanguage,
        timeoutMs,
      );
      this.workspaceLspState.set(workspaceHash, result.ready ? 'ready' : 'lsp_unavailable');
      if (result.ready) {
        this.workspaceLspReadyFiles.set(workspaceHash, result.filePath);
      } else {
        this.workspaceLspReadyFiles.delete(workspaceHash);
      }
      return result;
    } catch {
      this.workspaceLspState.set(workspaceHash, 'lsp_unavailable');
      this.workspaceLspReadyFiles.delete(workspaceHash);
      return { ready: false, filePath: null };
    }
  }

  getWorkspaceLspState(workspacePath: string): WorkspaceLspState {
    return this.workspaceLspState.get(workspaceHashForPath(path.resolve(workspacePath))) ?? 'idle';
  }

  private cancelStaleWarmWorkspace(
    normalizedPath: string,
    workspaceHash: string,
    timeoutMs: number,
  ): void {
    const existingStatus = this.store.getIndexStatus(workspaceHash);
    if (!existingStatus || existingStatus.state !== 'running') {
      return;
    }

    const completedAt = Date.now();
    this.store.requestCancel(workspaceHash);
    this.store.upsertIndexStatus({
      ...existingStatus,
      state: 'cancelled',
      phase: 'none',
      currentPath: null,
      updatedAt: completedAt,
      completedAt,
      errorMessage: `Codemem warm did not complete within ${timeoutMs}ms; cancellation requested.`,
      cancelRequested: true,
      absPath: normalizedPath,
    });
  }

  private registerMcpTools(): void {
    if (this.mcpToolsRegistered) {
      return;
    }

    const server = McpServer.getInstance();
    server.registerTools(createCodememMcpTools(() => this.facade));
    if (!server.isStarted()) {
      server.start();
    }

    this.mcpToolsRegistered = true;
  }

  private getDb(): SqliteDriver {
    if (!this.db) {
      this.db = defaultDriverFactory(
        path.join(app.getPath('userData'), 'codemem.sqlite'),
      );
      migrate(this.db);
    }
    return this.db;
  }
}

let codememService: CodememService | null = null;

export async function initializeCodemem(): Promise<CodememService> {
  if (!codememService) {
    codememService = new CodememService();
    registerCleanup(() => codememService?.shutdown() ?? Promise.resolve());
  }

  await codememService.initialize();
  return codememService;
}

export function getCodemem(): CodememService {
  if (!codememService) {
    codememService = new CodememService();
    registerCleanup(() => codememService?.shutdown() ?? Promise.resolve());
  }

  return codememService;
}

export async function shutdownCodemem(): Promise<void> {
  if (!codememService) {
    return;
  }

  await codememService.shutdown();
  codememService = null;
}

export function resetCodememForTesting(): void {
  if (!codememService) {
    return;
  }

  void codememService.shutdown();
  codememService = null;
}

// Re-export the prewarm coordinator so callers can `import { ... } from '../codemem'`
// rather than reaching into a nested module path.
export {
  getCodememPrewarmCoordinator,
  resetCodememPrewarmCoordinatorForTesting,
  CodememPrewarmCoordinator,
} from './codemem-prewarm-coordinator';
export type {
  CodememPrewarmCoordinatorOptions,
  PrewarmCodememTarget,
  PrewarmSettingsTarget,
} from './codemem-prewarm-coordinator';

export {
  CodeRetrievalService,
  getCodeRetrievalService,
  resetCodeRetrievalServiceForTesting,
} from './code-retrieval-service';
export type {
  CodeRetrievalResult,
  CodeRetrievalSearchOptions,
} from './code-retrieval-service';
