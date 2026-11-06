import { readFileSync } from 'node:fs';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { McpPageComponent } from './mcp-page.component';
import { McpIpcService } from '../../core/services/ipc/mcp-ipc.service';
import { BrowserAutomationIpcService } from '../../core/services/ipc/browser-automation-ipc.service';
import { McpMultiProviderStore } from './state/mcp-multi-provider.store';
import type { OrchestratorMcpDto } from '../../../../shared/types/mcp-dtos.types';

/** The page class on its own: its constructor only reads three services, none of which these checks call. */
function createPage(): McpPageComponent {
  TestBed.configureTestingModule({
    providers: [
      { provide: McpIpcService, useValue: {} },
      { provide: BrowserAutomationIpcService, useValue: {} },
      { provide: McpMultiProviderStore, useValue: {} },
    ],
  });
  return TestBed.runInInjectionContext(() => new McpPageComponent());
}

describe('McpPageComponent template', () => {
  it('labels direct Chrome DevTools MCP as legacy raw browser automation', () => {
    const template = readFileSync(
      'src/renderer/app/features/mcp/mcp-page.component.html',
      'utf-8',
    );

    expect(template).toContain('Legacy raw browser automation');
    expect(template).toContain('/browser');
  });

  it('renders the multi-provider management tabs, naming each provider the shared way', () => {
    const page = createPage();

    expect(page.managementTabs.map((tab) => tab.label)).toEqual([
      'Connectors', 'Workspace', 'Claude', 'Codex', 'Gemini', 'Copilot', 'Grok', 'OpenCode',
    ]);
    expect(page.managementTabs.map((tab) => tab.label)).not.toContain('Shared');
  });

  it('says "Codex" in the empty message, form title and checkbox labels, never the raw id', () => {
    const page = createPage();
    page.setManagementTab('codex');

    expect(page.managementEmptyMessage()).toBe('No Codex MCP servers discovered.');
    expect(page.managementFormTitle()).toBe('Add Codex User MCP');
    expect(page.providerLabel('opencode')).toBe('OpenCode');

    const template = readFileSync('src/renderer/app/features/mcp/mcp-page.component.html', 'utf-8');
    expect(template).not.toMatch(/\{\{\s*provider\s*\}\}/);
    expect(template).toContain('{{ providerLabel(provider) }}');
  });

  it('wires connector management without shared fan-out', () => {
    const template = readFileSync(
      'src/renderer/app/features/mcp/mcp-page.component.html',
      'utf-8',
    );

    expect(template).toContain('beginCreateManagementServer()');
    expect(template).toContain('submitManagementServer()');
    expect(template).toContain('deleteManagementServer(server)');
    expect(template).not.toContain('fanOutSharedServer(server)');
    expect(template).toContain('openCurrentProviderUserFile()');
    expect(template).toContain('app-workspace-mcp-connectors-panel');
  });

  it('does not submit redacted URL or arg placeholders as real values', () => {
    const source = readFileSync(
      'src/renderer/app/features/mcp/mcp-page.component.ts',
      'utf-8',
    );

    expect(source).toContain('!args.includes(REDACTED_SENTINEL)');
    expect(source).toContain('!url.includes(REDACTED_SENTINEL)');
    expect(source).toContain('orchestratorInjectionProviders');
  });
});

describe('McpPageComponent connector forms', () => {
  const connectors = signal<OrchestratorMcpDto[]>([]);
  const ipc = {
    orchestratorUpsert: vi.fn(), connectorAuth: vi.fn(), connectorAddMicrosoft365: vi.fn(),
    mcpGetServers: vi.fn(), mcpGetTools: vi.fn(), mcpGetResources: vi.fn(), mcpGetPrompts: vi.fn(),
  };
  let component: McpPageComponent;
  beforeEach(() => {
    vi.clearAllMocks();
    connectors.set([]);
    ipc.orchestratorUpsert.mockResolvedValue({ success: true, data: { id: 'saved-connector' } });
    ipc.connectorAuth.mockResolvedValue({ success: true });
    ipc.connectorAddMicrosoft365.mockResolvedValue({ success: true });
    for (const method of [ipc.mcpGetServers, ipc.mcpGetTools, ipc.mcpGetResources, ipc.mcpGetPrompts]) method.mockResolvedValue({ success: true, data: [] });
    TestBed.configureTestingModule({ providers: [
      { provide: McpIpcService, useValue: ipc },
      { provide: BrowserAutomationIpcService, useValue: { getHealth: vi.fn().mockResolvedValue({ success: false }) } },
      { provide: McpMultiProviderStore, useValue: { orchestrator: connectors, state: signal({ providers: [], stateVersion: 0 }), refresh: vi.fn() } },
    ] });
    component = TestBed.runInInjectionContext(() => new McpPageComponent());
    component.beginCreateManagementServer();
  });

  it('uses the shared provider names in the connector summary', () => {
    connectors.set([{
      record: {
        id: 'example', name: 'Example', scope: 'orchestrator', transport: 'stdio',
        autoConnect: true, readOnly: false, createdAt: 0, updatedAt: 0,
      },
      injectInto: ['claude', 'codex', 'gemini', 'copilot', 'cursor', 'grok', 'opencode'],
    }]);
    expect(component.connectorSummary('example')).toBe('Used by: Claude, Codex, Gemini, Copilot, Cursor, Grok, OpenCode');
  });

  it('stores a bearer through auth only and clears it after saving', async () => {
    component.managementForm.name.set('remote-example');
    component.managementForm.kind.set('remote');
    component.managementForm.transport.set('http');
    component.managementForm.url.set('https://example.test/mcp');
    component.managementForm.authType.set('bearer');
    component.managementForm.bearerToken.set('PLACEHOLDER_TOKEN');
    await component.submitManagementServer();
    expect(ipc.orchestratorUpsert).toHaveBeenCalledWith(expect.objectContaining({ kind: 'remote', authType: 'bearer' }));
    expect(JSON.stringify(ipc.orchestratorUpsert.mock.calls)).not.toContain('PLACEHOLDER_TOKEN');
    expect(ipc.connectorAuth).toHaveBeenCalledWith({ serverId: 'saved-connector', action: 'set-bearer', bearerToken: 'PLACEHOLDER_TOKEN' });
    expect(component.managementForm.bearerToken()).toBe('');
  });

  it('signs in before adding a Microsoft 365 connector', async () => {
    component.managementForm.name.set('m365-example');
    component.managementForm.kind.set('microsoft365');
    await component.submitManagementServer();
    expect(ipc.connectorAddMicrosoft365).toHaveBeenCalledWith(expect.objectContaining({ name: 'm365-example', mailEnabled: false }));
    expect(ipc.orchestratorUpsert).not.toHaveBeenCalled();
  });
});
