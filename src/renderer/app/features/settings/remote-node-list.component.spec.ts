import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteNodeListComponent } from './remote-node-list.component';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';

await resolveComponentResources((url) => {
  if (url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function makeNode(overrides: Partial<RemoteNodeRosterEntry> & { id: string }): RemoteNodeRosterEntry {
  return {
    name: overrides.id,
    status: 'connected',
    address: '100.64.1.2',
    connected: true,
    supportedClis: [],
    hasBrowserRuntime: false,
    hasBrowserMcp: false,
    hasAndroidMcp: false,
    hasDocker: false,
    activeInstances: 0,
    maxConcurrentInstances: 4,
    workingDirectories: [],
    capabilities: {
      platform: 'win32',
      arch: 'x64',
      cpuCores: 8,
      totalMemoryMB: 16384,
      availableMemoryMB: 8192,
      supportedClis: [],
      hasBrowserRuntime: false,
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

describe('RemoteNodeListComponent', () => {
  let fixture: ComponentFixture<RemoteNodeListComponent>;

  async function render(nodes: RemoteNodeRosterEntry[], selectedNodeId: string | null = null): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [RemoteNodeListComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(RemoteNodeListComponent);
    fixture.componentRef.setInput('nodes', nodes);
    fixture.componentRef.setInput('selectedNodeId', selectedNodeId);
    fixture.detectChanges();
  }

  beforeEach(() => {
    TestBed.resetTestingModule();
  });

  it('shows an empty-roster message when there are no nodes', async () => {
    await render([]);
    expect(fixture.nativeElement.textContent).toContain('No computers have connected yet');
    expect(fixture.nativeElement.querySelectorAll('[role="listitem"]')).toHaveLength(0);
  });

  it('renders status, name/address/platform, and capacity for each node', async () => {
    await render([
      makeNode({ id: 'node-a', name: 'Studio Mac', status: 'connected', address: '100.64.1.2' }),
      makeNode({ id: 'node-b', name: 'windows-pc', status: 'disconnected', address: undefined }),
    ]);

    const rows = fixture.nativeElement.querySelectorAll('[role="listitem"]');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('Studio Mac');
    expect(rows[0].textContent).toContain('connected');
    expect(rows[0].textContent).toContain('100.64.1.2');
    expect(rows[0].textContent).toContain('0/4 capacity');
  });

  it('marks the selected node with aria-current and a selected class', async () => {
    await render(
      [makeNode({ id: 'node-a' }), makeNode({ id: 'node-b' })],
      'node-b',
    );

    const rows = fixture.nativeElement.querySelectorAll('[role="listitem"]') as NodeListOf<HTMLButtonElement>;
    expect(rows[0].getAttribute('aria-current')).toBeNull();
    expect(rows[0].classList.contains('selected')).toBe(false);
    expect(rows[1].getAttribute('aria-current')).toBe('true');
    expect(rows[1].classList.contains('selected')).toBe(true);
  });

  it('emits nodeSelected on click, and rows are native buttons (Enter/Space activation for free)', async () => {
    await render([makeNode({ id: 'node-a' }), makeNode({ id: 'node-b' })]);
    const emit = vi.spyOn(fixture.componentInstance.nodeSelected, 'emit');
    const rows = fixture.nativeElement.querySelectorAll('[role="listitem"]') as NodeListOf<HTMLButtonElement>;

    expect(rows[0].tagName).toBe('BUTTON');
    rows[1].click();

    expect(emit).toHaveBeenCalledWith('node-b');
  });
});
