import { Component, input, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it, vi } from 'vitest';
import { NodeDetailComponent } from './node-detail.component';
import { NodeServicePanelComponent } from './node-service-panel/node-service-panel.component';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';
import { RemoteNodesStore } from './remote-nodes.store';

await resolveComponentResources((url) => {
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

@Component({
  selector: 'app-node-service-panel',
  standalone: true,
  template: '',
})
class StubNodeServicePanelComponent {
  readonly nodeId = input<string>();
}

function makeNode(): RemoteNodeRosterEntry {
  const capabilities: RemoteNodeRosterEntry['capabilities'] = {
    platform: 'win32',
    arch: 'x64',
    cpuCores: 16,
    totalMemoryMB: 32768,
    availableMemoryMB: 20000,
    supportedClis: ['claude'],
    hasBrowserRuntime: true,
    hasBrowserMcp: false,
    hasAndroidMcp: false,
    hasDocker: false,
    maxConcurrentInstances: 4,
    workingDirectories: ['C:\\work'],
    browsableRoots: ['C:\\work'],
    discoveredProjects: [],
    localModelEndpoints: [
      {
        provider: 'ollama',
        endpointId: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        models: ['qwen2.5-coder:14b'],
        healthy: true,
      },
      {
        provider: 'openai-compatible',
        endpointId: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1234',
        models: ['qwen2.5-coder-32b-instruct'],
        loadedModels: [{ id: 'qwen2.5-coder-32b-instruct', contextLength: 32768 }],
        healthy: true,
      },
    ],
  };
  return {
    id: 'node-win',
    name: 'windows-pc',
    status: 'connected',
    connected: true,
    platform: 'win32',
    address: '100.64.0.2',
    supportedClis: ['claude'],
    hasBrowserRuntime: true,
    hasBrowserMcp: false,
    hasAndroidMcp: false,
    hasDocker: false,
    activeInstances: 0,
    maxConcurrentInstances: 4,
    workingDirectories: ['C:\\work'],
    capabilities,
  };
}

describe('NodeDetailComponent', () => {
  let fixture: ComponentFixture<NodeDetailComponent>;

  it('renders local model endpoint inventory with loaded context', async () => {
    const node = makeNode();
    await TestBed.configureTestingModule({
      imports: [NodeDetailComponent],
      providers: [{
        provide: RemoteNodesStore,
        useValue: {
          serviceStatuses: vi.fn(() => ({})),
          refreshServiceStatus: vi.fn(),
          restartService: vi.fn(),
          stopService: vi.fn(),
          uninstallService: vi.fn(),
        },
      }],
    })
      .overrideComponent(NodeDetailComponent, {
        remove: { imports: [NodeServicePanelComponent] },
        add: { imports: [StubNodeServicePanelComponent] },
      })
      .compileComponents();
    fixture = TestBed.createComponent(NodeDetailComponent);
    Object.defineProperty(fixture.componentInstance, 'node', { value: () => node });
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Ollama');
    expect(text).toContain('LM Studio');
    expect(text).toContain('qwen2.5-coder-32b-instruct');
    expect(text).toContain('32768 ctx');
  });

  it('labels unhealthy advertised local model endpoints as installed but not running', async () => {
    const node = makeNode();
    node.capabilities.localModelEndpoints = [{
      provider: 'ollama',
      endpointId: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      models: [],
      healthy: false,
    }];
    await TestBed.configureTestingModule({
      imports: [NodeDetailComponent],
      providers: [{
        provide: RemoteNodesStore,
        useValue: {
          serviceStatuses: vi.fn(() => ({})),
          refreshServiceStatus: vi.fn(),
          restartService: vi.fn(),
          stopService: vi.fn(),
          uninstallService: vi.fn(),
        },
      }],
    })
      .overrideComponent(NodeDetailComponent, {
        remove: { imports: [NodeServicePanelComponent] },
        add: { imports: [StubNodeServicePanelComponent] },
      })
      .compileComponents();
    fixture = TestBed.createComponent(NodeDetailComponent);
    Object.defineProperty(fixture.componentInstance, 'node', { value: () => node });
    fixture.detectChanges();

    const text = (fixture.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('Ollama');
    expect(text).toContain('Installed but not running');
  });

  it('labels local model endpoints on disconnected nodes as unavailable', async () => {
    const node = makeNode();
    node.status = 'disconnected';
    node.connected = false;
    await TestBed.configureTestingModule({
      imports: [NodeDetailComponent],
      providers: [{
        provide: RemoteNodesStore,
        useValue: {
          serviceStatuses: vi.fn(() => ({})),
          refreshServiceStatus: vi.fn(),
          restartService: vi.fn(),
          stopService: vi.fn(),
          uninstallService: vi.fn(),
        },
      }],
    })
      .overrideComponent(NodeDetailComponent, {
        remove: { imports: [NodeServicePanelComponent] },
        add: { imports: [StubNodeServicePanelComponent] },
      })
      .compileComponents();
    fixture = TestBed.createComponent(NodeDetailComponent);
    Object.defineProperty(fixture.componentInstance, 'node', { value: () => node });
    fixture.detectChanges();

    const headings = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('.local-model-endpoint h5'))
      .map((heading) => heading.textContent ?? '');
    expect(headings.some((heading) => heading.includes('Ollama') && heading.includes('Unavailable'))).toBe(true);
  });
});
