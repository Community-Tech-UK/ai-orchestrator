import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { NodeCardComponent } from './node-card.component';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';

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

describe('NodeCardComponent', () => {
  let fixture: ComponentFixture<NodeCardComponent>;

  it('renders the advertised local model count', async () => {
    const node = makeNode();
    await TestBed.configureTestingModule({ imports: [NodeCardComponent] }).compileComponents();
    fixture = TestBed.createComponent(NodeCardComponent);
    Object.defineProperty(fixture.componentInstance, 'node', { value: () => node });
    fixture.detectChanges();

    expect((fixture.nativeElement as HTMLElement).textContent).toContain('2 local models');
  });
});
