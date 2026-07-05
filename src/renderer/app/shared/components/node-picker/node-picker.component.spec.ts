import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RemoteNodeRosterEntry } from '../../../../../shared/types/worker-node.types';
import { RemoteNodeStore } from '../../../core/state/remote-node.store';
import { SettingsStore } from '../../../core/state/settings.store';
import { NodePickerComponent } from './node-picker.component';

function makeNode(
  status: RemoteNodeRosterEntry['status'],
  connected: boolean,
): RemoteNodeRosterEntry {
  const capabilities: RemoteNodeRosterEntry['capabilities'] = {
    platform: 'win32',
    arch: 'x64',
    cpuCores: 8,
    totalMemoryMB: 16384,
    availableMemoryMB: 8192,
    supportedClis: ['claude'],
    hasBrowserRuntime: false,
    hasBrowserMcp: false,
    hasAndroidMcp: false,
    hasDocker: false,
    maxConcurrentInstances: 4,
    workingDirectories: ['C:\\repo'],
    browsableRoots: [],
    discoveredProjects: [],
  };

  return {
    id: 'node-1',
    name: 'Windows worker',
    status,
    connected,
    platform: 'win32',
    address: '100.64.1.2',
    supportedClis: capabilities.supportedClis,
    hasBrowserRuntime: false,
    hasBrowserMcp: false,
    hasAndroidMcp: false,
    hasDocker: false,
    activeInstances: 0,
    maxConcurrentInstances: 4,
    workingDirectories: ['C:\\repo'],
    capabilities,
  };
}

describe('NodePickerComponent', () => {
  let component: NodePickerComponent;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [NodePickerComponent],
      providers: [
        {
          provide: RemoteNodeStore,
          useValue: {
            nodes: signal<RemoteNodeRosterEntry[]>([]),
            hasNodes: signal(true),
            nodeById: vi.fn(),
          },
        },
        {
          provide: SettingsStore,
          useValue: {
            remoteNodesEnabled: signal(true),
          },
        },
      ],
    });

    component = TestBed.createComponent(NodePickerComponent).componentInstance;
  });

  it('does not allow stale connected-status nodes without a live socket', () => {
    const node = makeNode('connected', false);

    expect(component.isNodeSelectable(node)).toBe(false);
    expect(component.nodeDisabledReason(node)).toBe('Node is disconnected');
  });

  it('allows degraded nodes when the live socket is still connected', () => {
    const node = makeNode('degraded', true);

    expect(component.isNodeSelectable(node)).toBe(true);
    expect(component.nodeDisabledReason(node)).toBe('');
  });
});
