import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { AppIconButtonDirective } from '../../shared/tooltip/icon-button.directive';
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
import { McpIpcService } from '../../core/services/ipc/mcp-ipc.service';
import type { IpcResponse } from '../../core/services/ipc/electron-ipc.service';
import { McpPresetCatalogComponent } from './mcp-preset-catalog.component';
import { WorkspaceMcpConnectorsPanelComponent } from './workspace-mcp-connectors-panel.component';
import { BrowserAutomationIpcService } from '../../core/services/ipc/browser-automation-ipc.service';
import { McpMultiProviderStore } from './state/mcp-multi-provider.store';
import {
  REDACTED_SENTINEL,
  type RedactedMcpServerDto,
} from '../../../../shared/types/mcp-dtos.types';
import {
  ORCHESTRATOR_INJECTION_PROVIDERS,
  SUPPORTED_PROVIDERS,
  type OrchestratorMcpScope,
  type SupportedProvider,
  type OrchestratorRuntimeInjectionProvider,
} from '../../../../shared/types/mcp-scopes.types';
import { GlossaryTermComponent } from '../../shared/glossary/glossary-term.component';
import { parseOptionalStringArray, parseOptionalStringRecord } from './mcp-management-form';
import type { McpTransport } from '../../../../shared/types/mcp-orchestrator.types';

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
type ManagementTab = 'orchestrator' | 'workspace' | SupportedProvider;
type ManagementMode = 'create' | 'edit';
type ManagementProviderField = 'injectInto';

// ─── Component ───────────────────────────────────────────────────────────────

@Component({
  selector: 'app-mcp-page',
  standalone: true,
  imports: [CommonModule, McpPresetCatalogComponent, WorkspaceMcpConnectorsPanelComponent, GlossaryTermComponent, AioTooltipDirective, AppIconButtonDirective],
  templateUrl: './mcp-page.component.html',
  styleUrl: './mcp-page.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class McpPageComponent implements OnInit, OnDestroy {
  private readonly mcpIpc = inject(McpIpcService);
  private readonly browserAutomationIpc = inject(BrowserAutomationIpcService);
  readonly multiProviderStore = inject(McpMultiProviderStore);

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
  readonly errorDetails = signal<string | null>(null);
  readonly infoMessage = signal<string | null>(null);

  readonly toolCallTarget = signal<McpTool | null>(null);
  readonly toolCallArgsJson = signal('{}');
  readonly toolCallResult = signal<string | null>(null);

  readonly resourceReadTarget = signal<string | null>(null);
  readonly resourceReadResult = signal<string | null>(null);

  readonly promptTarget = signal<string | null>(null);
  readonly promptResult = signal<string | null>(null);

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

  readonly managementTabs: { id: ManagementTab; label: string }[] = [
    { id: 'orchestrator', label: 'Connectors' },
    { id: 'workspace', label: 'Workspace' },
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' },
    { id: 'gemini', label: 'Gemini' },
    { id: 'copilot', label: 'Copilot' },
    { id: 'grok', label: 'Grok' },
    { id: 'opencode', label: 'OpenCode' },
  ];

  readonly activeManagementTab = signal<ManagementTab>('orchestrator');
  readonly orchestratorInjectionProviders = ORCHESTRATOR_INJECTION_PROVIDERS;

  readonly managementFormOpen = signal(false);
  readonly managementFormMode = signal<ManagementMode>('create');
  readonly managementFormServerId = signal<string | null>(null);
  readonly managementFormOriginalName = signal<string | null>(null);
  readonly managementFormError = signal<string | null>(null);
  readonly managementFormErrorDetails = signal<string | null>(null);
  readonly managementForm = {
    name: signal(''),
    description: signal(''),
    scope: signal<OrchestratorMcpScope>('orchestrator'),
    transport: signal<McpTransport>('stdio'),
    command: signal(''),
    argsJson: signal(''),
    url: signal(''),
    headersJson: signal(''),
    envJson: signal(''),
    autoConnect: signal(true),
    injectInto: signal<readonly OrchestratorRuntimeInjectionProvider[]>([...ORCHESTRATOR_INJECTION_PROVIDERS]),
    kind: signal<'local' | 'remote' | 'microsoft365'>('local'),
    authType: signal<'none' | 'bearer' | 'oauth'>('none'),
    clientMetadataUrl: signal(''),
    bearerToken: signal(''),
    accountId: signal(''),
    mailEnabled: signal(false),
  };

  // ── Derived ───────────────────────────────────────────────────────────────

  readonly connectedCount = computed(
    () => this.servers().filter((s) => s.status === 'connected').length
  );

  /** IDs of all currently configured servers — passed to the preset catalog to mark already-added entries. */
  readonly configuredServerIds = computed(() => this.servers().map((s) => s.id));

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

  readonly managementRows = computed<RedactedMcpServerDto[]>(() => {
    const tab = this.activeManagementTab();
    if (tab === 'orchestrator') {
      return this.multiProviderStore.orchestrator().map((entry) => entry.record);
    }
    if (tab === 'workspace') {
      return [];
    }
    return this.multiProviderStore.state().providers
      .find((provider) => provider.provider === tab)
      ?.servers.slice() ?? [];
  });

  readonly managementEmptyMessage = computed(() => {
    const tab = this.activeManagementTab();
    if (tab === 'orchestrator') return 'No connectors added.';
    if (tab === 'workspace') return '';
    return `No ${tab} MCP servers discovered.`;
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

  /** Called by the preset catalog when the user adds a preset server. */
  async onPresetAdded(presetId: string): Promise<void> {
    this.infoMessage.set(`Preset "${presetId}" added. Connect it from the server list.`);
    await this.loadServers();
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

  setManagementTab(tab: ManagementTab): void {
    this.activeManagementTab.set(tab);
    this.cancelManagementForm();
  }

  // ── Multi-provider management operations ────────────────────────────────

  isProviderManagementTab(tab: ManagementTab = this.activeManagementTab()): tab is SupportedProvider {
    return (SUPPORTED_PROVIDERS as readonly string[]).includes(tab);
  }

  managementFormTitle(): string {
    const action = this.managementFormMode() === 'create' ? 'Add' : 'Edit';
    const tab = this.activeManagementTab();
    if (tab === 'orchestrator') return `${action} connector`;
    if (tab === 'workspace') return `${action} Workspace MCP`;
    return `${action} ${tab} User MCP`;
  }

  beginCreateManagementServer(): void {
    if (this.activeManagementTab() === 'workspace') {
      return;
    }
    this.managementFormMode.set('create');
    this.managementFormServerId.set(null);
    this.managementFormOriginalName.set(null);
    this.managementFormError.set(null);
    this.hydrateManagementForm();
    this.managementFormOpen.set(true);
  }

  beginEditManagementServer(server: RedactedMcpServerDto): void {
    this.managementFormMode.set('edit');
    this.managementFormServerId.set(server.id);
    this.managementFormOriginalName.set(server.name);
    this.managementFormError.set(null);
    this.hydrateManagementForm(server);
    this.managementFormOpen.set(true);
  }

  cancelManagementForm(): void {
    this.managementFormOpen.set(false);
    this.managementForm.bearerToken.set('');
    this.managementFormError.set(null);
    this.managementFormErrorDetails.set(null);
  }

  canEditManagementServer(server: RedactedMcpServerDto): boolean {
    const tab = this.activeManagementTab();
    return tab === 'orchestrator' || (this.isProviderManagementTab(tab) && !server.readOnly);
  }

  onManagementTextField(
    field: 'name' | 'description' | 'command' | 'argsJson' | 'url' | 'headersJson' | 'envJson' | 'bearerToken' | 'clientMetadataUrl',
    event: Event,
  ): void {
    const target = event.target as HTMLInputElement | HTMLTextAreaElement;
    this.managementForm[field].set(target.value);
  }

  onManagementTransportChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    this.managementForm.transport.set(target.value as McpTransport);
  }

  onManagementAutoConnectChange(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.managementForm.autoConnect.set(target.checked);
  }

  isManagementProviderSelected(field: ManagementProviderField, provider: OrchestratorRuntimeInjectionProvider): boolean {
    return this.managementForm[field]().includes(provider);
  }

  toggleManagementProvider(
    field: ManagementProviderField,
    provider: OrchestratorRuntimeInjectionProvider,
    event: Event,
  ): void {
    const checked = (event.target as HTMLInputElement).checked;
    const current = this.managementForm[field]();
    const next = checked
      ? [...new Set([...current, provider])]
      : current.filter((entry) => entry !== provider);
    this.managementForm[field].set(next);
  }

  async submitManagementServer(): Promise<void> {
    this.working.set(true);
    this.managementFormError.set(null);
    this.managementFormErrorDetails.set(null);
    this.errorMessage.set(null);
    this.infoMessage.set(null);
    try {
      const tab = this.activeManagementTab();
      if (tab === 'workspace') {
        this.managementFormError.set('Use the workspace connector form. This does not write a global MCP scope.');
        return;
      }
      if (tab === 'orchestrator' && this.managementForm.kind() === 'microsoft365' && this.managementFormMode() === 'create') {
        const name = this.managementForm.name().trim();
        if (!name) throw new Error('Name is required.');
        const signedIn = await this.mcpIpc.connectorAddMicrosoft365({ name, mailEnabled: this.managementForm.mailEnabled(), injectInto: this.managementForm.injectInto() });
        if (!signedIn.success) { this.managementFormError.set('Microsoft 365 sign-in failed. Check the details and try again.'); this.managementFormErrorDetails.set(signedIn.error?.message ?? null); return; }
        this.cancelManagementForm();
        this.infoMessage.set('Microsoft 365 account added.');
        await this.loadAll();
        return;
      }
      const payload = this.buildManagementPayload(tab);
      let response: IpcResponse;

      if (tab === 'orchestrator') {
        response = await this.mcpIpc.orchestratorUpsert(payload);

      } else {
        response = await this.mcpIpc.providerUserUpsert({
          ...payload,
          provider: tab,
        });
        const originalName = this.managementFormOriginalName();
        if (
          response.success
          && this.managementFormMode() === 'edit'
          && this.managementFormServerId()
          && originalName
          && originalName !== this.managementForm.name().trim()
        ) {
          await this.mcpIpc.providerUserDelete({
            provider: tab,
            serverId: this.managementFormServerId()!,
          });
        }
      }

      if (!response.success) {
        this.managementFormError.set('Could not save these settings. Check the details and try again.');
        this.managementFormErrorDetails.set(response.error?.message ?? null);
        return;
      }

      if (tab === 'orchestrator' && this.managementForm.authType() === 'bearer' && this.managementForm.bearerToken().trim()) {
        const id = (response.data as { id?: string } | undefined)?.id ?? this.managementFormServerId();
        if (!id) throw new Error('The connector was saved, but its sign-in could not be stored. Edit it to try again.');
        const saved = await this.mcpIpc.connectorAuth({ serverId: id, action: 'set-bearer', bearerToken: this.managementForm.bearerToken().trim() });
        this.managementForm.bearerToken.set('');
        if (!saved.success) { this.managementFormServerId.set(id); this.managementFormMode.set('edit'); throw new Error(saved.error?.message ?? 'The connector was saved, but its sign-in could not be stored.'); }
      }
      this.cancelManagementForm();
      this.infoMessage.set(tab === 'orchestrator' ? 'Connector saved.' : 'Tool server saved.');
      await this.loadAll();
    } catch (error) {
      this.managementFormError.set('Could not save these settings. Check the details and try again.');
      this.managementFormErrorDetails.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.working.set(false);
    }
  }

  async deleteManagementServer(server: RedactedMcpServerDto): Promise<void> {
    const tab = this.activeManagementTab();
    await this.runManagementOp(async () => {
      if (tab === 'orchestrator') {
        return this.mcpIpc.orchestratorDelete(server.id);
      }
      return this.mcpIpc.providerUserDelete({ provider: tab, serverId: server.id });
    }, `${server.name} removed.`, 'Failed to remove MCP server.');
  }

  async connectorAction(server: RedactedMcpServerDto, action: 'sign-in' | 'sign-out' | 'test'): Promise<void> {
    await this.runManagementOp(() => this.mcpIpc.connectorAuth({ serverId: server.id, action }),
      action === 'test' ? `${server.name} is ready to use.` : action === 'sign-in' ? `${server.name} signed in.` : `${server.name} signed out.`,
      'The connector could not complete this action.');
  }

  connectorMayWrite(serverId: string): boolean {
    return this.multiProviderStore.orchestrator().find((entry) => entry.record.id === serverId)?.agentsMayWrite ?? false;
  }

  async setConnectorWritable(server: RedactedMcpServerDto, event: Event): Promise<void> {
    await this.runManagementOp(() => this.mcpIpc.connectorSetWritable({ serverId: server.id, allowed: (event.target as HTMLInputElement).checked }),
      'Account permissions updated.', 'Could not change account permissions.');
  }

  connectorSummary(serverId: string): string {
    const entry = this.multiProviderStore.orchestrator().find((item) => item.record.id === serverId);
    if (!entry) return '';
    const state = entry.authStatus?.state;
    const signIn = state === 'expired' ? 'Sign in again' : state === 'signed-out' ? 'Sign-in needed' : '';
    return [entry.record.autoConnect ? `Used by: ${entry.injectInto.join(', ') || 'No providers selected'}` : 'Turned off',
      entry.record.kind === 'microsoft365' ? `Agents may write: ${entry.agentsMayWrite ? 'yes' : 'no'}` : '', signIn].filter(Boolean).join(' · ');
  }

  onConnectorKindChange(event: Event): void {
    const kind = (event.target as HTMLSelectElement).value as 'local' | 'remote' | 'microsoft365';
    this.managementForm.kind.set(kind);
    this.managementForm.transport.set(kind === 'remote' ? 'http' : 'stdio');
  }

  onConnectorAuthChange(event: Event): void {
    this.managementForm.authType.set((event.target as HTMLSelectElement).value as 'none' | 'bearer' | 'oauth');
    this.managementForm.bearerToken.set('');
  }

  async openCurrentProviderUserFile(): Promise<void> {
    const tab = this.activeManagementTab();
    if (!this.isProviderManagementTab(tab)) {
      return;
    }
    await this.runManagementOp(
      () => this.mcpIpc.providerOpenScopeFile({ provider: tab, scope: 'user' }),
      `${tab} user MCP config opened.`,
      'Failed to open provider MCP config.',
    );
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

  private hydrateManagementForm(server?: RedactedMcpServerDto): void {
    const tab = this.activeManagementTab();
    this.managementForm.name.set(server?.name ?? '');
    this.managementForm.description.set(server?.description ?? '');
    this.managementForm.scope.set(
      server?.scope === 'orchestrator-bootstrap' || server?.scope === 'orchestrator-codemem'
        ? server.scope
        : 'orchestrator',
    );
    this.managementForm.transport.set(server?.transport ?? 'stdio');
    this.managementForm.command.set(server?.command ?? '');
    this.managementForm.argsJson.set(server?.args?.length ? JSON.stringify(server.args, null, 2) : '');
    this.managementForm.url.set(server?.url ?? '');
    this.managementForm.headersJson.set(server?.headers ? JSON.stringify(server.headers, null, 2) : '');
    this.managementForm.envJson.set(server?.env ? JSON.stringify(server.env, null, 2) : '');
    this.managementForm.autoConnect.set(server?.autoConnect ?? true);

    if (tab === 'orchestrator' && server) {
      const entry = this.multiProviderStore.orchestrator().find((item) => item.record.id === server.id);
      this.managementForm.injectInto.set(entry?.injectInto ?? [...ORCHESTRATOR_INJECTION_PROVIDERS]);
    } else {
      this.managementForm.injectInto.set([...ORCHESTRATOR_INJECTION_PROVIDERS]);
    }

    this.managementForm.kind.set(server?.kind ?? (server?.transport && server.transport !== 'stdio' ? 'remote' : 'local'));
    this.managementForm.authType.set(server?.authType ?? 'none');
    this.managementForm.clientMetadataUrl.set(server?.clientMetadataUrl ?? '');
    this.managementForm.accountId.set(server?.accountId ?? '');
    this.managementForm.mailEnabled.set(server?.mailEnabled ?? false);
    this.managementForm.bearerToken.set('');
  }

  private buildManagementPayload(tab: ManagementTab): Record<string, unknown> {
    const name = this.managementForm.name().trim();
    if (!name) {
      throw new Error('Name is required.');
    }

    if (tab === 'orchestrator' && !/^[A-Za-z0-9-]{1,64}$/.test(name)) throw new Error('Use up to 64 letters, numbers or hyphens for the connector name.');
    const transport = this.managementForm.transport();
    const payload: Record<string, unknown> = {
      name,
      description: this.optionalText(this.managementForm.description()),
      transport,
      ...(this.managementFormMode() === 'edit' && this.managementFormServerId()
        ? { id: this.managementFormServerId() }
        : {}),
    };

    if (tab === 'orchestrator' && this.managementForm.kind() === 'microsoft365') {
      payload['accountId'] = this.managementForm.accountId();
    } else if (transport === 'stdio') {
      const command = this.managementForm.command().trim();
      if (!command) {
        throw new Error('Enter the command that starts this program.');
      }
      payload['command'] = command;
      const args = parseOptionalStringArray('Arguments', this.managementForm.argsJson());
      if (args && !args.includes(REDACTED_SENTINEL)) payload['args'] = args;
    } else {
      const url = this.managementForm.url().trim();
      if (!url && !this.isEditingManagementServer()) {
        throw new Error('URL is required for HTTP and SSE MCP servers.');
      }
      if (url && !url.includes(REDACTED_SENTINEL)) {
        payload['url'] = url;
      }
    }

    const headers = parseOptionalStringRecord('Headers', this.managementForm.headersJson(), true);
    if (headers) payload['headers'] = headers;
    const env = parseOptionalStringRecord('Environment', this.managementForm.envJson(), true);
    if (env) payload['env'] = env;

    if (tab === 'orchestrator') {
      payload['kind'] = this.managementForm.kind();
      payload['authType'] = this.managementForm.kind() === 'remote' ? this.managementForm.authType() : 'none';
      payload['clientMetadataUrl'] = this.optionalText(this.managementForm.clientMetadataUrl());
      payload['mailEnabled'] = this.managementForm.mailEnabled();
      payload['scope'] = this.managementForm.scope();
      payload['autoConnect'] = this.managementForm.autoConnect();
      payload['injectInto'] = this.managementForm.injectInto();
    } else {
      payload['autoConnect'] = this.managementForm.autoConnect();
    }

    return payload;
  }

  private isEditingManagementServer(): boolean {
    return this.managementFormMode() === 'edit' && Boolean(this.managementFormServerId());
  }

  private optionalText(value: string): string | undefined {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  private async loadAll(): Promise<void> {
    await Promise.all([
      this.loadServers(),
      this.loadTools(),
      this.loadResources(),
      this.loadPrompts(),
      this.loadBrowserHealth(),
      this.multiProviderStore.refresh(),
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

  private async runManagementOp(
    op: () => Promise<IpcResponse>,
    successMessage: string,
    fallbackError: string,
  ): Promise<void> {
    this.working.set(true);
    this.errorMessage.set(null);
    this.errorDetails.set(null);
    this.infoMessage.set(null);
    try {
      const response = await op();
      if (!response.success) {
        this.errorMessage.set(fallbackError);
        this.errorDetails.set(response.error?.message ?? null);
        await this.multiProviderStore.refresh();
        return;
      }
      this.infoMessage.set(successMessage);
      await this.loadAll();
    } catch (error) {
      this.errorMessage.set(fallbackError);
      this.errorDetails.set(error instanceof Error ? error.message : String(error));
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
