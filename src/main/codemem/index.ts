import { app } from 'electron';
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
import { createCodememMcpTools } from './mcp-tools';

export class CodememService {
  private readonly db: SqliteDriver = defaultDriverFactory(
    path.join(app.getPath('userData'), 'codemem.sqlite'),
  );
  readonly store: CasStore;
  readonly indexManager: CodeIndexManager;
  readonly periodicScan: PeriodicScan;
  readonly gateway: LspWorkerGateway;
  readonly facade: AgentLspFacade;
  private readonly activeWatchers = new Set<string>();
  private readonly workspaceLspState = new Map<string, WorkspaceLspState>();
  private mcpToolsRegistered = false;

  constructor() {
    migrate(this.db);
    this.store = new CasStore(this.db);
    this.indexManager = new CodeIndexManager({ store: this.store });
    this.periodicScan = new PeriodicScan({ store: this.store, mgr: this.indexManager });
    this.gateway = new LspWorkerGateway();
    this.facade = new AgentLspFacade({
      store: this.store,
      gateway: this.gateway,
      getWorkspaceLspState: (workspaceHash) => this.workspaceLspState.get(workspaceHash) ?? 'idle',
    });
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
  }

  async shutdown(): Promise<void> {
    await this.indexManager.stop();
    await this.gateway.stop();
    if (McpServer.getInstance().isStarted()) {
      McpServer.getInstance().stop();
    }
    this.db.close();
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

  async ensureWorkspace(workspacePath: string) {
    if (!this.isEnabled() || !this.isIndexingEnabled()) {
      throw new Error('Codemem indexing is disabled.');
    }

    const normalizedPath = path.resolve(workspacePath);
    const workspaceHash = workspaceHashForPath(normalizedPath);
    let workspaceRoot = this.store.getWorkspaceRootByPath(normalizedPath);

    if (!workspaceRoot) {
      await this.indexManager.coldIndex(normalizedPath);
      workspaceRoot = this.store.getWorkspaceRootByPath(normalizedPath);
    }

    if (!workspaceRoot) {
      throw new Error(`Failed to index workspace: ${normalizedPath}`);
    }

    if (!this.activeWatchers.has(workspaceHash)) {
      await this.indexManager.start(normalizedPath, workspaceHash);
      this.activeWatchers.add(workspaceHash);
    }

    return workspaceRoot;
  }

  async warmWorkspace(workspacePath: string, timeoutMs = 15_000): Promise<{ ready: boolean; filePath: string | null }> {
    if (!this.isEnabled() || !this.isIndexingEnabled()) {
      return { ready: false, filePath: null };
    }

    const workspaceRoot = await this.ensureWorkspace(workspacePath);
    if (!this.isLspEnabled()) {
      this.workspaceLspState.set(workspaceRoot.workspaceHash, 'lsp_unavailable');
      return { ready: false, filePath: null };
    }

    this.workspaceLspState.set(workspaceRoot.workspaceHash, 'warming');
    try {
      const result = await this.gateway.ready(
        workspaceRoot.absPath,
        workspaceRoot.primaryLanguage ?? 'typescript',
        timeoutMs,
      );
      this.workspaceLspState.set(workspaceRoot.workspaceHash, result.ready ? 'ready' : 'lsp_unavailable');
      return result;
    } catch {
      this.workspaceLspState.set(workspaceRoot.workspaceHash, 'lsp_unavailable');
      return { ready: false, filePath: null };
    }
  }

  getWorkspaceLspState(workspacePath: string): WorkspaceLspState {
    return this.workspaceLspState.get(workspaceHashForPath(path.resolve(workspacePath))) ?? 'idle';
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
