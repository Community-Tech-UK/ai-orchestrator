import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteNodeDetailComponent } from './remote-node-detail.component';
import { RemoteNodeIpcService } from '../../core/services/ipc/remote-node-ipc.service';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './remote-node-detail.component.html'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('remote-node-detail.component.html')) {
    return Promise.resolve(template);
  }
  if (url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function makeNode(overrides: Partial<RemoteNodeRosterEntry> = {}): RemoteNodeRosterEntry {
  return {
    id: 'node-a',
    name: 'Studio Mac',
    status: 'connected',
    address: '100.64.1.2',
    connected: true,
    supportedClis: [],
    hasBrowserRuntime: true,
    hasBrowserMcp: false,
    hasAndroidMcp: false,
    hasDocker: false,
    activeInstances: 0,
    maxConcurrentInstances: 4,
    workingDirectories: [],
    capabilities: {
      platform: 'darwin',
      arch: 'arm64',
      cpuCores: 8,
      totalMemoryMB: 16384,
      availableMemoryMB: 8192,
      supportedClis: [],
      hasBrowserRuntime: true,
      hasBrowserMcp: false,
      hasAndroidMcp: false,
      hasDocker: false,
      maxConcurrentInstances: 4,
      workingDirectories: [],
      browsableRoots: [],
      discoveredProjects: [],
    },
    ...overrides,
  };
}

describe('RemoteNodeDetailComponent', () => {
  const ipc = { diagnoseRepair: vi.fn(async () => null) };
  let fixture: ComponentFixture<RemoteNodeDetailComponent>;

  beforeEach(async () => {
    vi.clearAllMocks();
    await TestBed.configureTestingModule({
      imports: [RemoteNodeDetailComponent],
      providers: [{ provide: RemoteNodeIpcService, useValue: ipc }],
    }).compileComponents();

    fixture = TestBed.createComponent(RemoteNodeDetailComponent);
    fixture.componentRef.setInput('node', makeNode());
    fixture.detectChanges();
  });

  it('shows a narrow-layout Back action that emits backRequested', () => {
    const backSpy = vi.spyOn(fixture.componentInstance.backRequested, 'emit');
    const back = fixture.nativeElement.querySelector('.back-button') as HTMLButtonElement;

    expect(back).not.toBeNull();
    back.click();

    expect(backSpy).toHaveBeenCalled();
  });

  it('emits a revoke action with the current node id', () => {
    const emit = vi.spyOn(fixture.componentInstance.actionRequested, 'emit');
    const revoke = fixture.nativeElement.querySelector('.btn-danger') as HTMLButtonElement;

    revoke.click();

    expect(emit).toHaveBeenCalledWith({ type: 'revoke', nodeId: 'node-a' });
  });

  it('emits a reset-connection action only when the node is not disconnected', () => {
    const emit = vi.spyOn(fixture.componentInstance.actionRequested, 'emit');
    const resetButton = Array.from(fixture.nativeElement.querySelectorAll('button')).find(
      (button) => (button as HTMLButtonElement).textContent?.includes('Reset connection'),
    ) as HTMLButtonElement | undefined;

    expect(resetButton).toBeDefined();
    resetButton?.click();

    expect(emit).toHaveBeenCalledWith({ type: 'reset-connection', nodeId: 'node-a' });
  });

  it('does not offer Reset connection for a disconnected node', () => {
    fixture.componentRef.setInput('node', makeNode({ status: 'disconnected' }));
    fixture.detectChanges();

    const resetButton = Array.from(fixture.nativeElement.querySelectorAll('button')).find(
      (button) => (button as HTMLButtonElement).textContent?.includes('Reset connection'),
    );

    expect(resetButton).toBeUndefined();
  });

  it('opens the browser-automation drafting form seeded from the node, then emits configure-browser on Apply', () => {
    const emit = vi.spyOn(fixture.componentInstance.actionRequested, 'emit');
    const openButton = Array.from(fixture.nativeElement.querySelectorAll('button')).find(
      (button) => (button as HTMLButtonElement).textContent?.includes('Configure browser automation'),
    ) as HTMLButtonElement;
    openButton.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.ba-config-form')).not.toBeNull();

    const applyButton = Array.from(fixture.nativeElement.querySelectorAll('.ba-actions button')).find(
      (button) => (button as HTMLButtonElement).textContent?.includes('Apply'),
    ) as HTMLButtonElement;
    applyButton.click();

    expect(emit).toHaveBeenCalledWith({
      type: 'configure-browser',
      nodeId: 'node-a',
      config: { enabled: false, headless: false },
      extensionRelayEnabled: false,
    });
  });

  it('emits a copy action with the node diagnostics JSON', () => {
    const emit = vi.spyOn(fixture.componentInstance.actionRequested, 'emit');
    const copyButton = Array.from(fixture.nativeElement.querySelectorAll('button')).find(
      (button) => (button as HTMLButtonElement).textContent?.includes('Copy diagnostics'),
    ) as HTMLButtonElement;

    copyButton.click();

    expect(emit).toHaveBeenCalledTimes(1);
    const [call] = emit.mock.calls;
    expect(call[0]).toMatchObject({ type: 'copy', description: 'remote node diagnostics' });
    expect(() => JSON.parse((call[0] as { value: string }).value)).not.toThrow();
  });

  it('closes any open drafting panel when the selected node changes', () => {
    const openButton = Array.from(fixture.nativeElement.querySelectorAll('button')).find(
      (button) => (button as HTMLButtonElement).textContent?.includes('Configure browser automation'),
    ) as HTMLButtonElement;
    openButton.click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.ba-config-form')).not.toBeNull();

    fixture.componentRef.setInput('node', makeNode({ id: 'node-b', name: 'windows-pc' }));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.ba-config-form')).toBeNull();
  });
});
