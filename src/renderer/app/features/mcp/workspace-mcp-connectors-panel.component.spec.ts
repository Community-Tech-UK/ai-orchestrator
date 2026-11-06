import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { McpIpcService } from '../../core/services/ipc/mcp-ipc.service';
import { WorkspaceMcpConnectorsPanelComponent } from './workspace-mcp-connectors-panel.component';

await resolveComponentResources(url => Promise.resolve(readFileSync(
  fileURLToPath(new URL(url, import.meta.url)), 'utf8')));

describe('workspace connector action hints', () => {
  const ipc = {
    workspaceConnectorList: vi.fn(async () => ({ success: true, data: [] })),
    workspaceConnectorUpsert: vi.fn(async () => ({ success: true })),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    await TestBed.configureTestingModule({ imports: [WorkspaceMcpConnectorsPanelComponent],
      providers: [{ provide: McpIpcService, useValue: ipc }] }).compileComponents();
  });

  it('keeps refresh focusable, explains the missing folder, blocks activation and recovers', async () => {
    const fixture = TestBed.createComponent(WorkspaceMcpConnectorsPanelComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    const button = fixture.nativeElement.querySelector('[aria-label="Refresh workspace MCP connectors"]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    const matches = button.matches.bind(button);
    vi.spyOn(button, 'matches').mockImplementation(value => value === ':focus-visible' || matches(value));
    button.focus();
    fixture.detectChanges();
    expect(document.activeElement).toBe(button);
    expect(document.getElementById(button.getAttribute('aria-describedby')!)?.textContent)
      .toContain('Enter the working directory to refresh its connectors.');
    button.click();
    expect(ipc.workspaceConnectorList).not.toHaveBeenCalled();
    fixture.componentInstance.workingDirectory.set('/workspace');
    fixture.detectChanges();
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    button.click();
    await fixture.whenStable();
    expect(ipc.workspaceConnectorList).toHaveBeenCalledExactlyOnceWith({ workingDirectory: '/workspace', provider: 'claude' });
  });

  it('lets Save show its existing required-fields error and accepts corrected values', async () => {
    const fixture = TestBed.createComponent(WorkspaceMcpConnectorsPanelComponent);
    fixture.detectChanges();
    const button = fixture.nativeElement.querySelector('[aria-label="Save workspace MCP connector"]') as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    button.click();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[role="alert"]')?.textContent)
      .toContain('Working directory, name, and command are required.');
    expect(ipc.workspaceConnectorUpsert).not.toHaveBeenCalled();
    const component = fixture.componentInstance;
    component.workingDirectory.set('/workspace');
    component.name.set('example');
    component.command.set('example-command');
    component.envJson.set('{}');
    fixture.detectChanges();
    button.click();
    await fixture.whenStable();
    expect(ipc.workspaceConnectorUpsert).toHaveBeenCalledExactlyOnceWith({
      workingDirectory: '/workspace', provider: 'claude', name: 'example', command: 'example-command', transport: 'stdio', env: {},
    });
  });
});
