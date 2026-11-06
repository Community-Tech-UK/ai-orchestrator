import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { CUSTOM_ELEMENTS_SCHEMA, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { CommonModule } from '@angular/common';
import { By } from '@angular/platform-browser';
import { McpServerCostComponent } from './mcp-server-cost.component';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { McpPageComponent } from './mcp-page.component';
import { McpIpcService } from '../../core/services/ipc/mcp-ipc.service';
import { BrowserAutomationIpcService } from '../../core/services/ipc/browser-automation-ipc.service';
import { McpMultiProviderStore } from './state/mcp-multi-provider.store';
const pageTemplate = readFileSync('src/renderer/app/features/mcp/mcp-page.component.html', 'utf8');
await resolveComponentResources(() => Promise.resolve(''));
afterEach(() => TestBed.resetTestingModule());

describe('McpPageComponent tool costs', () => {
  it('renders unknown, singular, plural and disconnected costs through the page bindings', async () => {
    let resolveTools!: (response: { success: boolean; data: { name: string; serverId: string }[] }) => void;
    const toolResponse = new Promise<{ success: boolean; data: { name: string; serverId: string }[] }>((resolve) => { resolveTools = resolve; });
    const mcpGetTools = vi.fn(() => toolResponse);
    const servers = [{ id: 'server', name: 'Example', transport: 'stdio', status: 'connected' }];
    TestBed.overrideComponent(McpPageComponent, { set: {
      template: pageTemplate, templateUrl: undefined, styles: [], styleUrl: undefined, styleUrls: [],
      imports: [CommonModule, McpServerCostComponent, AioTooltipDirective],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    } });
    TestBed.configureTestingModule({ providers: [
      { provide: McpIpcService, useValue: {
        mcpGetServers: vi.fn(async () => ({ success: true, data: servers })), mcpGetTools,
        mcpGetResources: vi.fn(async () => ({ success: true, data: [] })),
        mcpGetPrompts: vi.fn(async () => ({ success: true, data: [] })),
        onMcpStateChanged: vi.fn(() => () => undefined), onMcpServerStatusChanged: vi.fn(() => () => undefined),
      } },
      { provide: BrowserAutomationIpcService, useValue: { getHealth: vi.fn(async () => ({ success: false })) } },
      { provide: McpMultiProviderStore, useValue: { orchestrator: signal([]), state: signal({ providers: [] }), error: signal(null), refresh: vi.fn() } },
    ] });
    const fixture = TestBed.createComponent(McpPageComponent);
    try {
      fixture.componentInstance.servers.set(servers);
      fixture.detectChanges();
      const costText = () => fixture.nativeElement.querySelector('app-mcp-server-cost').textContent as string;
      expect(costText()).toContain('Tool cost not available yet');
      expect(costText()).not.toContain('0 tokens');
      resolveTools({ success: true, data: [{ name: 'read', serverId: 'server' }, { name: 'other', serverId: 'other-server' }] });
      await fixture.whenStable(); fixture.detectChanges();
      expect(costText()).toContain('1 tool · up to about');
      expect(fixture.debugElement.query(By.css('app-mcp-server-cost .server-cost'))
        .injector.get(AioTooltipDirective).appTooltip()).toContain('Claude');
      fixture.componentInstance.tools.update((tools) => [...tools, { name: 'write', serverId: 'server' }]);
      fixture.detectChanges();
      expect(costText()).toContain('2 tools · up to about');
      mcpGetTools.mockResolvedValueOnce({ success: false, data: [] });
      await fixture.componentInstance.refresh(); fixture.detectChanges();
      expect(costText()).toContain('Tool cost not available yet');
      fixture.componentInstance.servers.set([{ ...servers[0], status: 'disconnected' }]); fixture.detectChanges();
      expect(costText()).toContain('Connect to see the tool cost');
    } finally { fixture.destroy(); }
  });
});
