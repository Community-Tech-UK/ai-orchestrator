import { TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WindowManager } from '../../main/window-manager';
import { ElectronIpcService } from '../../renderer/app/core/services/ipc/electron-ipc.service';
import { Microsoft365ConnectorFormComponent } from '../../renderer/app/features/mcp/microsoft365-connector-form.component';

const state = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>(),
  connectAccount: vi.fn(), upsert: vi.fn(),
}));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => state.handlers.set(name, handler) } }));
vi.mock('../../main/mcp/mcp-manager', () => ({ getMcpManager: () => ({ on: vi.fn() }) }));
vi.mock('../../main/mcp/mcp-lifecycle-manager', () => ({ getMcpLifecycleManager: () => ({}) }));
vi.mock('../../main/mcp/connector-auth-service', () => ({ getConnectorAuthService: () => ({}) }));
vi.mock('../../main/graph/graph-connector-service', () => ({ getGraphConnectorService: () => ({ connectAccount: state.connectAccount, isWritable: async () => false }) }));
vi.mock('../../main/mcp/mcp-multi-provider-singletons', () => ({
  getOrchestratorMcpRepository: () => ({ list: () => [] }),
  getCliMcpConfigService: () => ({ orchestratorUpsert: state.upsert, getMultiProviderState: async () => ({ orchestrator: [], providers: [], stateVersion: 1 }) }),
}));
import { registerMcpHandlers } from '../../main/ipc/handlers/mcp-handlers';

await resolveComponentResources(url => Promise.resolve(readFileSync(`src/renderer/app/features/mcp/${url}`, 'utf8')));

describe('Microsoft account setup through the real app handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.handlers.clear();
    state.connectAccount.mockResolvedValue({ accountKey: 'PLACEHOLDER_ACCOUNT', username: 'reader@example.test', tenant: 'PLACEHOLDER_TENANT' });
    state.upsert.mockReturnValue({ record: { id: 'example', name: 'm365-example' } });
    registerMcpHandlers({ windowManager: { sendToRenderer: vi.fn() } as unknown as WindowManager });
    TestBed.configureTestingModule({ providers: [{
      provide: ElectronIpcService, useValue: { getApi: () => ({
        mcpConnectorAddMicrosoft365: (payload: unknown) => state.handlers.get('mcp:connector:add-microsoft365')!({}, payload),
      }) },
    }] });
  });

  it('reports the saved mailbox instead of showing a failure after a successful sign-in', async () => {
    const fixture = TestBed.createComponent(Microsoft365ConnectorFormComponent);
    const added = vi.fn();
    fixture.componentInstance.added.subscribe(added);
    await fixture.componentInstance.connect(new Event('submit'));
    fixture.detectChanges();
    expect(state.connectAccount).toHaveBeenCalledExactlyOnceWith(true);
    expect(state.upsert).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ name: 'm365-account', description: 'reader@example.test', mailEnabled: true }));
    expect(added).toHaveBeenCalledExactlyOnceWith('reader@example.test');
    expect(fixture.componentInstance.error()).toBeNull();
    expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
  });
});
