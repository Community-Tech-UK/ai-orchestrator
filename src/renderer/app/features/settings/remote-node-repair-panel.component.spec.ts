import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteNodeRepairPanelComponent } from './remote-node-repair-panel.component';
import { RemoteNodeIpcService } from '../../core/services/ipc/remote-node-ipc.service';
import { CLIPBOARD_SERVICE } from '../../core/services/clipboard.service';
import type { NodeHealthEntry } from './remote-nodes-browser-automation';

await resolveComponentResources((url) => {
  // resolveComponentResources is global within the shared Vitest worker.
  // Tolerate unrelated pending component resources from other specs.
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('RemoteNodeRepairPanelComponent', () => {
  const entry: NodeHealthEntry = {
    id: 'node-1',
    name: 'Windows PC',
    status: 'disconnected',
    platform: 'win32',
    supportsBrowser: false,
    browserAutomationReady: false,
    extensionRelayReady: false,
    androidAutomationReady: false,
    supportsGpu: false,
    hasDocker: false,
    activeInstances: 0,
    maxConcurrentInstances: 0,
    workingDirectories: [],
    supportedClis: [],
  };

  const ipc = {
    diagnoseRepair: vi.fn(),
    generateRepairCommand: vi.fn(),
    getServiceStatus: vi.fn(),
  };
  const clipboard = {
    copyText: vi.fn(async () => ({ ok: true as const })),
  };

  let fixture: ComponentFixture<RemoteNodeRepairPanelComponent>;
  let component: RemoteNodeRepairPanelComponent;

  async function settle(): Promise<void> {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    ipc.diagnoseRepair.mockResolvedValue({
      nodeId: 'node-1',
      nodeName: 'Windows PC',
      status: 'depaired',
      trustedPlatform: 'win32',
      coordinatorUrls: ['ws://host:4878'],
      hasCoordinatorRecoveryToken: true,
      recommendedAction: 'copy_windows_command',
      availableActions: [],
      summary: 'Registered node is disconnected.',
      lastRejectedRegistration: {
        nodeId: 'node-1',
        reason: 'Invalid or expired pairing token',
        firstSeenAt: Date.now() - 1000,
        lastSeenAt: Date.now() - 1000,
        count: 2,
      },
    });
    ipc.generateRepairCommand.mockResolvedValue({
      nodeId: 'node-1',
      nodeName: 'Windows PC',
      platform: 'win32',
      expiresAt: Date.now() + 60_000,
      serviceId: 'ai-orchestrator-worker',
      configPath: 'C:\\ProgramData\\Orchestrator\\worker-node.json',
      primaryCoordinatorUrl: 'ws://host:4878',
      coordinatorUrls: ['ws://host:4878'],
      command: 'powershell placeholder-command',
      redactedPreview: 'redacted',
    });

    await TestBed.configureTestingModule({
      imports: [RemoteNodeRepairPanelComponent],
      providers: [
        { provide: RemoteNodeIpcService, useValue: ipc },
        { provide: CLIPBOARD_SERVICE, useValue: clipboard },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(RemoteNodeRepairPanelComponent);
    component = fixture.componentInstance;
    fixture.componentRef.setInput('entry', entry);
    fixture.detectChanges();
    await settle();
  });

  it('shows only safe repair metadata before explicit command generation', () => {
    expect(fixture.nativeElement.textContent).toContain('Registered node is disconnected.');
    expect(fixture.nativeElement.textContent).not.toContain('powershell placeholder-command');
  });

  it('lists host problems with their fix for a healthy node and marks admin ones', async () => {
    ipc.diagnoseRepair.mockResolvedValue({
      nodeId: 'node-1', nodeName: 'Mac', status: 'healthy', coordinatorUrls: ['ws://host:4878'],
      hasCoordinatorRecoveryToken: true, recommendedAction: 'none', availableActions: ['check_service_status'],
      summary: 'Node is connected.',
      hostReadiness: {
        checkedAt: 1,
        checks: [
          { id: 'sleep_on_power', status: 'problem', summary: 'This Mac sleeps after 1 minute on power, so jobs stop.', fix: 'sudo pmset -c sleep 0', needsAdmin: true },
          { id: 'tailscale_running', status: 'problem', summary: 'Tailscale is installed but not running.', fix: 'Open Tailscale and sign in.', needsAdmin: false },
          { id: 'filevault', status: 'note', summary: 'FileVault is on.', needsAdmin: false },
        ],
      },
    });
    await (component as unknown as { refreshDiagnostic: () => Promise<void> }).refreshDiagnostic();
    await settle();

    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('This Mac sleeps after 1 minute on power');
    expect(text).toContain('sudo pmset -c sleep 0');
    expect(text).toContain('Open Tailscale and sign in.');
    expect(text.match(/Needs an admin password/g)).toHaveLength(1);
    expect(text).not.toContain('FileVault is on.');
    expect(text).not.toContain('Node is connected.');
  });

  it('stays hidden for a healthy node with no host problems', async () => {
    ipc.diagnoseRepair.mockResolvedValue({
      nodeId: 'node-1', nodeName: 'Mac', status: 'healthy', coordinatorUrls: [], hasCoordinatorRecoveryToken: true,
      recommendedAction: 'none', availableActions: [], summary: 'Node is connected.',
      hostReadiness: { checkedAt: 1, checks: [{ id: 'filevault', status: 'note', summary: 'FileVault is on.', needsAdmin: false }] },
    });
    await (component as unknown as { refreshDiagnostic: () => Promise<void> }).refreshDiagnostic();
    await settle();
    expect(fixture.nativeElement.querySelector('.repair-panel')).toBeNull();
  });

  it('generates and copies the repair command only after explicit generation', async () => {
    await (component as unknown as { generateRepairCommand: () => Promise<void> }).generateRepairCommand();
    await settle();

    expect(fixture.nativeElement.textContent).toContain('Windows Repair Command');
    await (component as unknown as { copyRepairCommand: (command: string) => Promise<void> })
      .copyRepairCommand('powershell placeholder-command');

    expect(clipboard.copyText).toHaveBeenCalledWith(
      'powershell placeholder-command',
      { label: 'remote worker repair command' },
    );
  });

  it('clears generated commands when diagnostics refresh', async () => {
    ipc.getServiceStatus.mockResolvedValue({ state: 'running' });
    await (component as unknown as { checkServiceStatus: () => Promise<void> }).checkServiceStatus();
    await (component as unknown as { generateRepairCommand: () => Promise<void> }).generateRepairCommand();
    expect((component as unknown as { command: () => unknown }).command()).toBeTruthy();
    expect((component as unknown as { serviceConfigDetail: () => string }).serviceConfigDetail())
      .toBe('config path unavailable');

    await (component as unknown as { refreshDiagnostic: () => Promise<void> }).refreshDiagnostic();

    expect((component as unknown as { command: () => unknown }).command()).toBeNull();
    expect((component as unknown as { serviceConfigDetail: () => string }).serviceConfigDetail()).toBe('');
  });

  it('keeps the generated command when the parent passes an equivalent entry object', async () => {
    await (component as unknown as { generateRepairCommand: () => Promise<void> }).generateRepairCommand();
    expect((component as unknown as { command: () => unknown }).command()).toBeTruthy();
    expect(ipc.diagnoseRepair).toHaveBeenCalledTimes(1);

    fixture.componentRef.setInput('entry', { ...entry });
    fixture.detectChanges();
    await settle();

    expect(ipc.diagnoseRepair).toHaveBeenCalledTimes(1);
    expect((component as unknown as { command: () => unknown }).command()).toBeTruthy();
  });

  it('treats missing service configPath as inconclusive', async () => {
    ipc.getServiceStatus.mockResolvedValue({ state: 'running' });

    await (component as unknown as { checkServiceStatus: () => Promise<void> }).checkServiceStatus();

    expect((component as unknown as { serviceConfigDetail: () => string }).serviceConfigDetail())
      .toBe('config path unavailable');
  });
});
