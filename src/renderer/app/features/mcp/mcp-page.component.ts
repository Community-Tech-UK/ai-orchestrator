/**
 * MCP Page
 * MCP Server Management — list servers, manage connections, browse tools,
 * resources, and prompts, and add new servers.
 */

import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router } from '@angular/router';
import { McpIpcService } from '../../core/services/ipc/mcp-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import { BrowserAutomationIpcService } from '../../core/services/ipc/browser-automation-ipc.service';

// ─── Local interfaces ────────────────────────────────────────────────────────

interface McpServer {
  id: string;
  name: string;
  description?: string;
  source?: string;
  sourceProvider?: string;
  sourceLabel?: string;
  sourcePath?: string;
  scope?: string;
  readOnly?: boolean;
  toggleable?: boolean;
  enabled?: boolean;
  sourceEntries?: {
    id: string;
    name: string;
    sourceProvider?: string;
    sourceLabel?: string;
    sourcePath?: string;
    scope?: string;
    enabled: boolean;
    readOnly?: boolean;
  }[];
  sourceCount?: number;
  enabledSourceCount?: number;
  sourceSummary?: string;
  transport: string;
  status: string;
  error?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  autoConnect?: boolean;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  serverId: string;
}

interface McpResource {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
  serverId: string;
}

interface McpPrompt {
  name: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
  serverId: string;
}

interface BrowserAutomationHealthSource {
  path: string;
  detected: boolean;
  serverNames: string[];
}

interface BrowserAutomationHealthReport {
  status: 'ready' | 'partial' | 'missing';
  checkedAt: number;
  lastSuccessfulCheckAt?: number;
  runtimeAvailable: boolean;
  runtimeCommand?: string;
  nodeAvailable: boolean;
  inAppConfigured: boolean;
  inAppConnected: boolean;
  inAppToolCount: number;
  configDetected: boolean;
  configSources: BrowserAutomationHealthSource[];
  browserToolNames: string[];
  warnings: string[];
  suggestions: string[];
}

type DetailTab = 'tools' | 'resources' | 'prompts' | 'config';

// ─── Component ───────────────────────────────────────────────────────────────

@Component({
  selector: 'app-mcp-page',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './mcp-page.component.html',
  styleUrl: './mcp-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class McpPageComponent implements OnInit, OnDestroy {
  private readonly router = inject(Router);
  private readonly mcpIpc = inject(McpIpcService);
  private readonly browserAutomationIpc = inject(BrowserAutomationIpcService);

  // ── Data signals ──────────────────────────────────────────────────────────

  readonly servers = signal<McpServer[]>([]);
  readonly tools = signal<McpTool[]>([]);
  readonly resources = signal<McpResource[]>([]);
  readonly prompts = signal<McpPrompt[]>([]);
  readonly browserHealth = signal<BrowserAutomationHealthReport | null>(null);

  // ── UI state ──────────────────────────────────────────────────────────────

  readonly selectedServerId = signal<string | null>(null);
  readonly activeTab = signal<DetailTab>('tools');
  readonly loading = signal(false);
  readonly working = signal(false);
  readonly errorMessage = signal<string | null>(null);
  readonly infoMessage = signal<string | null>(null);

  // Tool call state
  readonly toolCallTarget = signal<McpTool | null>(null);
  readonly toolCallArgsJson = signal('{}');
  readonly toolCallResult = signal<string | null>(null);

  // Resource read state
  readonly resourceReadTarget = signal<string | null>(null);
  readonly resourceReadResult = signal<string | null>(null);

  // Prompt state
  readonly promptTarget = signal<string | null>(null);
  readonly promptResult = signal<string | null>(null);

  // Add-server dialog state
  readonly showAddDialog = signal(false);
  readonly addDialogError = signal<string | null>(null);
  readonly addForm = {
    id: signal(''),
    name: signal(''),
    transport: signal<'stdio' | 'http' | 'sse'>('stdio'),
    command: signal(''),
    url: signal(''),
    autoConnect: signal(false),
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  readonly connectedCount = computed(
    () => this.servers().filter((s) => s.status === 'connected').length
  );

  readonly selectedServer = computed(
    () => this.servers().find((s) => s.id === this.selectedServerId()) ?? null
  );

  readonly selectedTools = computed(
    () => this.tools().filter((t) => t.serverId === this.selectedServerId())
  );

  readonly selectedResources = computed(
    () => this.resources().filter((r) => r.serverId === this.selectedServerId())
  );

  readonly selectedPrompts = computed(
    () => this.prompts().filter((p) => p.serverId === this.selectedServerId())
  );

  readonly selectedServerJson = computed(() => {
    const srv = this.selectedServer();
    if (!srv) return '';
    const {
      id,
      name,
      description,
      source,
      sourceProvider,
      sourceLabel,
      sourcePath,
      scope,
      readOnly,
      toggleable,
      enabled,
      sourceEntries,
      sourceCount,
      enabledSourceCount,
      sourceSummary,
      transport,
      command,
      args,
      env,
      url,
      autoConnect,
    } = srv;
    return JSON.stringify({
      id,
      name,
      description,
      source,
      sourceProvider,
      sourceLabel,
      sourcePath,
      scope,
      readOnly,
      toggleable,
      enabled,
      sourceEntries,
      sourceCount,
      enabledSourceCount,
      sourceSummary,
      transport,
      command,
      args,
      env,
      url,
      autoConnect,
    }, null, 2);
  });

  // ── Tab definitions ───────────────────────────────────────────────────────

  readonly tabs: { id: DetailTab; label: string }[] = [
    { id: 'tools', label: 'Tools' },
    { id: 'resources', label: 'Resources' },
    { id: 'prompts', label: 'Prompts' },
    { id: 'config', label: 'Config' },
  ];

  tabCount(tab: DetailTab): number {
    switch (tab) {
      case 'tools': return this.selectedTools().length;
      case 'resources': return this.selectedResources().length;
      case 'prompts': return this.selectedPrompts().length;
      default: return 0;
    }
  }

  serverStatusClass(server: McpServer): string {
    if (server.enabled === false) {
      return 'disabled';
    }
    return server.readOnly ? 'configured' : server.status;
  }

  serverStatusLabel(server: McpServer): string {
    if (server.enabled === false) {
      return 'disabled';
    }
    return server.readOnly ? 'configured' : server.status;
  }

  serverMeta(server: McpServer): string {
    return [server.transport, server.sourceSummary ?? server.sourceLabel].filter(Boolean).join(' - ');
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  private unsubStateChanged: (() => void) | null = null;
  private unsubStatusChanged: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  async ngOnInit(): Promise<void> {
    await this.loadAll();
    this.subscribeToEvents();
    this.startPolling();
  }

  ngOnDestroy(): void {
    this.unsubStateChanged?.();
    this.unsubStatusChanged?.();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  // ── Navigation ────────────────────────────────────────────────────────────

  goBack(): void {
    this.router.navigate(['/']);
  }

  // ── Refresh ───────────────────────────────────────────────────────────────

  async refresh(): Promise<void> {
    this.loading.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);
    try {
      await this.loadAll();
    } finally {
      this.loading.set(false);
    }
  }

  async runBrowserHealthCheck(): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);
    try {
      const response = await this.browserAutomationIpc.getHealth();
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to run browser automation health check.');
        return;
      }
      this.browserHealth.set((response.data as BrowserAutomationHealthReport) ?? null);
      this.infoMessage.set('Browser automation health check updated.');
    } finally {
      this.working.set(false);
    }
  }

  async installBrowserPreset(): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);

    try {
      const existing = this.servers().find((server) => server.id === 'chrome-devtools');
      if (!existing) {
        const response = await this.mcpIpc.mcpAddServer({
          id: 'chrome-devtools',
          name: 'Chrome DevTools',
          description: 'Browser automation through Chrome DevTools MCP',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', 'chrome-devtools-mcp@latest'],
          autoConnect: false,
        });

        if (!response.success) {
          this.errorMessage.set(response.error?.message ?? 'Failed to add Chrome DevTools preset.');
          return;
        }
      }

      this.infoMessage.set('Chrome DevTools preset is available in the server list.');
      await this.loadServers();
      this.selectedServerId.set('chrome-devtools');
      await this.runBrowserHealthCheck();
    } finally {
      this.working.set(false);
    }
  }

  // ── Server selection ──────────────────────────────────────────────────────

  selectServer(id: string): void {
    this.selectedServerId.set(id);
    // Reset sub-panel state when switching servers
    this.toolCallTarget.set(null);
    this.toolCallResult.set(null);
    this.resourceReadTarget.set(null);
    this.resourceReadResult.set(null);
    this.promptTarget.set(null);
    this.promptResult.set(null);
  }

  setTab(tab: DetailTab): void {
    this.activeTab.set(tab);
  }

  // ── Server operations ─────────────────────────────────────────────────────

  async connectServer(event: Event, serverId: string): Promise<void> {
    event.stopPropagation();
    await this.runServerOp(
      () => this.mcpIpc.mcpConnect(serverId),
      `Connected to server ${serverId}.`,
      'Failed to connect.'
    );
  }

  async disconnectServer(event: Event, serverId: string): Promise<void> {
    event.stopPropagation();
    await this.runServerOp(
      () => this.mcpIpc.mcpDisconnect(serverId),
      `Disconnected from server ${serverId}.`,
      'Failed to disconnect.'
    );
  }

  async restartServer(event: Event, serverId: string): Promise<void> {
    event.stopPropagation();
    await this.runServerOp(
      () => this.mcpIpc.mcpRestart(serverId),
      `Server ${serverId} restarted.`,
      'Failed to restart.'
    );
  }

  async removeServer(event: Event, serverId: string): Promise<void> {
    event.stopPropagation();
    await this.runServerOp(
      () => this.mcpIpc.mcpRemoveServer(serverId),
      `Server ${serverId} removed.`,
      'Failed to remove server.'
    );
    if (this.selectedServerId() === serverId) {
      this.selectedServerId.set(null);
    }
  }

  async toggleServerEnabled(event: Event, server: McpServer): Promise<void> {
    event.stopPropagation();
    const target = event.target as HTMLInputElement;
    const enabled = target.checked;
    await this.runServerOp(
      () => this.mcpIpc.mcpSetServerEnabled(server.id, enabled),
      `${server.name} ${enabled ? 'enabled' : 'disabled'}.`,
      'Failed to update server.'
    );
  }

  // ── Tool call ─────────────────────────────────────────────────────────────

  openToolCall(tool: McpTool): void {
    this.toolCallTarget.set(tool);
    this.toolCallArgsJson.set('{}');
    this.toolCallResult.set(null);
  }

  closeToolCall(): void {
    this.toolCallTarget.set(null);
    this.toolCallResult.set(null);
  }

  onToolArgsInput(event: Event): void {
    const target = event.target as HTMLTextAreaElement;
    this.toolCallArgsJson.set(target.value);
  }

  async executeTool(): Promise<void> {
    const tool = this.toolCallTarget();
    if (!tool) return;

    let args: Record<string, unknown>;
    try {
      args = JSON.parse(this.toolCallArgsJson()) as Record<string, unknown>;
    } catch {
      this.errorMessage.set('Tool arguments must be valid JSON.');
      return;
    }

    this.working.set(true);
    this.errorMessage.set(null);
    try {
      const response = await this.mcpIpc.mcpCallTool({
        serverId: tool.serverId,
        toolName: tool.name,
        arguments: args,
      });
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Tool call failed.');
        return;
      }
      this.toolCallResult.set(JSON.stringify(response.data, null, 2));
    } finally {
      this.working.set(false);
    }
  }

  // ── Resource read ─────────────────────────────────────────────────────────

  async readResource(resource: McpResource): Promise<void> {
    this.resourceReadTarget.set(resource.uri);
    this.resourceReadResult.set(null);
    this.working.set(true);
    this.errorMessage.set(null);
    try {
      const response = await this.mcpIpc.mcpReadResource({
        serverId: resource.serverId,
        uri: resource.uri,
      });
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to read resource.');
        return;
      }
      this.resourceReadResult.set(JSON.stringify(response.data, null, 2));
    } finally {
      this.working.set(false);
    }
  }

  // ── Prompt get ────────────────────────────────────────────────────────────

  async getPrompt(prompt: McpPrompt): Promise<void> {
    this.promptTarget.set(prompt.name);
    this.promptResult.set(null);
    this.working.set(true);
    this.errorMessage.set(null);
    try {
      const response = await this.mcpIpc.mcpGetPrompt({
        serverId: prompt.serverId,
        promptName: prompt.name,
      });
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? 'Failed to get prompt.');
        return;
      }
      this.promptResult.set(JSON.stringify(response.data, null, 2));
    } finally {
      this.working.set(false);
    }
  }

  // ── Add server dialog ─────────────────────────────────────────────────────

  openAddDialog(): void {
    this.addForm.id.set('');
    this.addForm.name.set('');
    this.addForm.transport.set('stdio');
    this.addForm.command.set('');
    this.addForm.url.set('');
    this.addForm.autoConnect.set(false);
    this.addDialogError.set(null);
    this.showAddDialog.set(true);
  }

  closeAddDialog(): void {
    this.showAddDialog.set(false);
    this.addDialogError.set(null);
  }

  onAddField(field: 'id' | 'name' | 'command' | 'url', event: Event): void {
    const target = event.target as HTMLInputElement;
    this.addForm[field].set(target.value);
  }

  onTransportChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.addForm.transport.set(target.value as 'stdio' | 'http' | 'sse');
  }

  onAutoConnectChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.addForm.autoConnect.set(target.checked);
  }

  async submitAddServer(): Promise<void> {
    const id = this.addForm.id().trim();
    const name = this.addForm.name().trim();
    const transport = this.addForm.transport();

    if (!id) {
      this.addDialogError.set('ID is required.');
      return;
    }
    if (!name) {
      this.addDialogError.set('Name is required.');
      return;
    }

    this.working.set(true);
    this.addDialogError.set(null);
    try {
      const payload = {
        id,
        name,
        transport,
        command: transport === 'stdio' ? this.addForm.command().trim() || undefined : undefined,
        url: transport !== 'stdio' ? this.addForm.url().trim() || undefined : undefined,
        autoConnect: this.addForm.autoConnect(),
      };

      const response = await this.mcpIpc.mcpAddServer(payload);
      if (!response.success) {
        this.addDialogError.set(response.error?.message ?? 'Failed to add server.');
        return;
      }

      this.closeAddDialog();
      this.infoMessage.set(`Server "${name}" added.`);
      await this.loadServers();
    } finally {
      this.working.set(false);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async loadAll(): Promise<void> {
    await Promise.all([
      this.loadServers(),
      this.loadTools(),
      this.loadResources(),
      this.loadPrompts(),
      this.loadBrowserHealth(),
    ]);
  }

  private async loadServers(): Promise<void> {
    const response = await this.mcpIpc.mcpGetServers({ includeExternal: true });
    if (!response.success) {
      this.errorMessage.set(response.error?.message ?? 'Failed to load servers.');
      return;
    }
    this.servers.set(this.extractArray<McpServer>(response));
  }

  private async loadTools(): Promise<void> {
    const response = await this.mcpIpc.mcpGetTools();
    if (!response.success) return;
    this.tools.set(this.extractArray<McpTool>(response));
  }

  private async loadResources(): Promise<void> {
    const response = await this.mcpIpc.mcpGetResources();
    if (!response.success) return;
    this.resources.set(this.extractArray<McpResource>(response));
  }

  private async loadPrompts(): Promise<void> {
    const response = await this.mcpIpc.mcpGetPrompts();
    if (!response.success) return;
    this.prompts.set(this.extractArray<McpPrompt>(response));
  }

  private subscribeToEvents(): void {
    this.unsubStateChanged = this.mcpIpc.onMcpStateChanged(() => {
      void this.loadAll();
    });

    this.unsubStatusChanged = this.mcpIpc.onMcpServerStatusChanged((data) => {
      this.servers.update((current) =>
        current.map((srv) =>
          srv.id === data.serverId
            ? { ...srv, status: data.status, error: data.error }
            : srv
        )
      );
    });
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      void this.loadAll();
    }, 10_000);
  }

  mapHealthStatus(status: BrowserAutomationHealthReport['status']): string {
    switch (status) {
      case 'ready':
        return 'connected';
      case 'partial':
        return 'connecting';
      default:
        return 'error';
    }
  }

  private async runServerOp(
    op: () => Promise<IpcResponse>,
    successMessage: string,
    fallbackError: string
  ): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);
    this.infoMessage.set(null);
    try {
      const response = await op();
      if (!response.success) {
        this.errorMessage.set(response.error?.message ?? fallbackError);
        return;
      }
      this.infoMessage.set(successMessage);
      await this.loadServers();
    } finally {
      this.working.set(false);
    }
  }

  private extractArray<T>(response: IpcResponse): T[] {
    if (!response.success) return [];
    if (Array.isArray(response.data)) return response.data as T[];
    return [];
  }

  private async loadBrowserHealth(): Promise<void> {
    const response = await this.browserAutomationIpc.getHealth();
    if (!response.success) {
      return;
    }
    this.browserHealth.set((response.data as BrowserAutomationHealthReport) ?? null);
  }
}
