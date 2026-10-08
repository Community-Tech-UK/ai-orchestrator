import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserComputerOfflineBannerComponent } from './browser-computer-offline-banner.component';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { SettingsStore } from '../../core/state/settings.store';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';

function makeEntry(overrides: Partial<RemoteNodeRosterEntry>): RemoteNodeRosterEntry {
  return {
    id: 'windows-node',
    name: 'windows-pc',
    status: 'disconnected',
    address: '',
    connected: false,
    supportedClis: [],
    hasBrowserRuntime: false,
    hasBrowserMcp: false,
    hasAndroidMcp: false,
    hasDocker: false,
    activeInstances: 0,
    maxConcurrentInstances: 0,
    workingDirectories: [],
    browserComputer: true,
    capabilities: {
      platform: 'win32',
      arch: '',
      cpuCores: 0,
      totalMemoryMB: 0,
      availableMemoryMB: 0,
      supportedClis: [],
      hasBrowserRuntime: false,
      hasBrowserMcp: false,
      hasAndroidMcp: false,
      hasDocker: false,
      maxConcurrentInstances: 0,
      workingDirectories: [],
      browsableRoots: [],
      discoveredProjects: [],
    },
    ...overrides,
  };
}

describe('BrowserComputerOfflineBannerComponent', () => {
  const nodes = signal<RemoteNodeRosterEntry[]>([]);
  const settings = signal<Record<string, unknown>>({});

  beforeEach(() => {
    TestBed.resetTestingModule();
    nodes.set([]);
    settings.set({ remoteNodesEnabled: true, remoteNodesAutoOffloadBrowser: true });
    TestBed.configureTestingModule({
      imports: [BrowserComputerOfflineBannerComponent],
      providers: [
        { provide: RemoteNodeStore, useValue: { nodes } },
        {
          provide: SettingsStore,
          useValue: { isInitialized: () => true, get: (key: string) => settings()[key] },
        },
      ],
    });
  });

  function render(): HTMLElement {
    const fixture = TestBed.createComponent(BrowserComputerOfflineBannerComponent);
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  it('warns while the browser computer is offline, with when it was last seen', () => {
    const lastSeen = new Date();
    lastSeen.setHours(9, 59, 0, 0);
    nodes.set([
      makeEntry({ lastAuthenticatedAt: lastSeen.getTime(), connectivityHint: "This Mac's Tailscale is off." }),
    ]);

    const banner = render().querySelector('.browser-offline-banner');

    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.getAttribute('aria-live')).toBe('polite');
    expect(banner?.textContent).toContain('windows-pc is offline (last seen 09:59)');
    expect(banner?.textContent).toContain('Agents will ask you before using this Mac’s browser.');
    expect(banner?.textContent).toContain("This Mac's Tailscale is off.");
    expect(banner?.querySelector('button')).toBeNull();
  });

  it('stays hidden when the browser computer is connected', () => {
    nodes.set([makeEntry({ status: 'connected', connected: true, hasBrowserMcp: true })]);

    expect(render().querySelector('.browser-offline-banner')).toBeNull();
  });

  it('ignores offline nodes that are not browser computers', () => {
    nodes.set([makeEntry({ id: 'noah', name: 'noahlaptop', browserComputer: false })]);

    expect(render().querySelector('.browser-offline-banner')).toBeNull();
  });

  it('stays hidden when remote nodes are switched off', () => {
    settings.set({ remoteNodesEnabled: false, remoteNodesAutoOffloadBrowser: true });
    nodes.set([makeEntry({})]);

    expect(render().querySelector('.browser-offline-banner')).toBeNull();
  });

  it('makes no promise about this Mac when browser offload is off', () => {
    settings.set({ remoteNodesEnabled: true, remoteNodesAutoOffloadBrowser: false });
    nodes.set([makeEntry({})]);

    const text = render().querySelector('.browser-offline-banner')?.textContent ?? '';
    expect(text).toContain('windows-pc is offline');
    expect(text).toContain('will not run until it reconnects');
    expect(text).not.toContain('this Mac');
  });

  it('names every offline browser computer', () => {
    nodes.set([makeEntry({}), makeEntry({ id: 'studio', name: 'studio-pc' })]);

    expect(render().querySelector('.browser-offline-banner')?.textContent)
      .toContain('windows-pc is offline; studio-pc is offline');
  });

  it('stays hidden while another browser computer is healthy', () => {
    nodes.set([
      makeEntry({}),
      makeEntry({ id: 'studio', name: 'studio-pc', status: 'connected', connected: true, hasBrowserMcp: true }),
    ]);

    expect(render().querySelector('.browser-offline-banner')).toBeNull();
  });

  it('warns about a browser computer that is connected but not ready for browser work', () => {
    nodes.set([makeEntry({ status: 'connected', connected: true, hasBrowserMcp: false })]);

    expect(render().querySelector('.browser-offline-banner')?.textContent)
      .toContain('windows-pc is not ready for browser work');
  });

  it('warns about a browser computer that is connected but not responding', () => {
    nodes.set([makeEntry({ status: 'degraded', connected: true })]);

    expect(render().querySelector('.browser-offline-banner')?.textContent).toContain('windows-pc is not responding');
  });

  it('appears and clears as the roster changes', () => {
    nodes.set([makeEntry({ status: 'connected', connected: true, hasBrowserMcp: true })]);
    const fixture = TestBed.createComponent(BrowserComputerOfflineBannerComponent);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.browser-offline-banner')).toBeNull();

    nodes.set([makeEntry({})]);
    fixture.detectChanges();
    expect(element.querySelector('.browser-offline-banner')).not.toBeNull();

    nodes.set([makeEntry({ status: 'connected', connected: true, hasBrowserMcp: true })]);
    fixture.detectChanges();
    expect(element.querySelector('.browser-offline-banner')).toBeNull();
  });
});
