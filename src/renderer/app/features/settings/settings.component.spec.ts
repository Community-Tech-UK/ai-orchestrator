import {
  CUSTOM_ELEMENTS_SCHEMA,
  ɵresolveComponentResources as resolveComponentResources,
  signal,
  type WritableSignal,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BehaviorSubject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SettingsStore } from '../../core/state/settings.store';
import { AppIpcService } from '../../core/services/ipc/app-ipc.service';
import { CliUpdatePillStore } from '../../core/state/cli-update-pill.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { ProviderQuotaStore } from '../../core/state/provider-quota.store';
import { SettingsComponent } from './settings.component';
import { NAV_COLLAPSED_KEY } from './settings-navigation';
import type {
  StartupCapabilityCheck,
  StartupCapabilityCheckStatus,
  StartupCapabilityOverallStatus,
  StartupCapabilityReport,
} from '../../../../shared/types/startup-capability.types';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';
import type { CliUpdatePillState } from '../../../../shared/types/diagnostics.types';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './settings.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './settings.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('settings.component.scss')) {
    return Promise.resolve(styles);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

/** Build a startup-capability report from a compact `[id, category, status]` spec. */
function makeReport(
  status: StartupCapabilityOverallStatus,
  checks: [string, StartupCapabilityCheck['category'], StartupCapabilityCheckStatus][],
): StartupCapabilityReport {
  return {
    status,
    generatedAt: Date.now(),
    checks: checks.map(([id, category, checkStatus]) => ({
      id,
      label: id,
      category,
      status: checkStatus,
      critical: false,
      summary: '',
    })),
  };
}

/** Minimal remote node — the component only reads connection state for badges. */
function makeNode(
  id: string,
  status: RemoteNodeRosterEntry['status'],
  connected = status === 'connected',
): RemoteNodeRosterEntry {
  return { id, name: id, status, connected } as RemoteNodeRosterEntry;
}

describe('SettingsComponent', () => {
  let fixture: ComponentFixture<SettingsComponent>;
  let component: SettingsComponent;
  let fragment$: BehaviorSubject<string | null>;
  let queryParamMap$: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
  let route: {
    fragment: BehaviorSubject<string | null>;
    queryParamMap: BehaviorSubject<ReturnType<typeof convertToParamMap>>;
    snapshot: {
      fragment: string | null;
      queryParamMap: ReturnType<typeof convertToParamMap>;
    };
  };
  let router: { navigate: ReturnType<typeof vi.fn> };

  let startupCallback: ((report: StartupCapabilityReport) => void) | null;
  let nodes$: WritableSignal<RemoteNodeRosterEntry[]>;
  let cliPillState$: WritableSignal<CliUpdatePillState>;

  beforeEach(async () => {
    localStorage.clear();
    fragment$ = new BehaviorSubject<string | null>(null);
    queryParamMap$ = new BehaviorSubject(convertToParamMap({}));
    route = {
      fragment: fragment$,
      queryParamMap: queryParamMap$,
      snapshot: {
        fragment: null,
        queryParamMap: convertToParamMap({}),
      },
    };
    router = { navigate: vi.fn().mockResolvedValue(true) };

    startupCallback = null;
    nodes$ = signal<RemoteNodeRosterEntry[]>([]);
    cliPillState$ = signal<CliUpdatePillState>({ generatedAt: 0, count: 0, entries: [] });

    TestBed.overrideComponent(SettingsComponent, {
      set: {
        imports: [],
        template: '',
        styles: [styles],
        styleUrl: undefined,
        styleUrls: [],
        schemas: [CUSTOM_ELEMENTS_SCHEMA],
      },
    });

    TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: [
        {
          provide: SettingsStore,
          useValue: {
            loading: signal(false).asReadonly(),
            reset: vi.fn(),
          },
        },
        { provide: ActivatedRoute, useValue: route },
        { provide: Router, useValue: router },
        {
          provide: AppIpcService,
          useValue: {
            getStartupCapabilities: vi.fn().mockResolvedValue(null),
            onStartupCapabilities: vi.fn((cb: (report: StartupCapabilityReport) => void) => {
              startupCallback = cb;
              return () => undefined;
            }),
          },
        },
        {
          provide: CliUpdatePillStore,
          useValue: { init: vi.fn(), state: cliPillState$ },
        },
        {
          provide: RemoteNodeStore,
          useValue: { initialize: vi.fn().mockResolvedValue(undefined), nodes: nodes$ },
        },
        {
          provide: ProviderQuotaStore,
          useValue: {
            initialize: vi.fn().mockResolvedValue(undefined),
            mostConstrainedWindow: signal(null),
          },
        },
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    });
    await TestBed.compileComponents();

    fixture = TestBed.createComponent(SettingsComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('uses the URL fragment as the canonical settings section link', () => {
    fragment$.next('remote-nodes');

    expect(component.activeTab()).toBe('remote-nodes');
  });

  it('keeps legacy tab query params readable', () => {
    queryParamMap$.next(convertToParamMap({ tab: 'display' }));

    expect(component.activeTab()).toBe('display');
  });

  it('keeps the fragment authoritative when a legacy tab query param is also present', () => {
    fragment$.next('remote-nodes');
    queryParamMap$.next(convertToParamMap({ tab: 'display' }));

    expect(component.activeTab()).toBe('remote-nodes');
  });

  it('writes selected settings sections to the fragment and clears legacy tab params', () => {
    component.selectTab('display');

    expect(router.navigate).toHaveBeenCalledWith([], {
      relativeTo: route,
      fragment: 'display',
      queryParams: {
        tab: null,
        section: null,
      },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
    expect(localStorage.getItem('aiorch.settings.lastTab')).toBe('display');
  });

  // ─── Live nav badges (item 12) ─────────────────────────────────────────────

  it('shows a Setup badge for Remote Nodes when no nodes are enrolled', () => {
    expect(component.navBadges()['remote-nodes']).toEqual({ text: 'Setup', status: 'info' });
  });

  it('flags Remote Nodes as degraded when an enrolled node is unhealthy', () => {
    nodes$.set([makeNode('n1', 'degraded'), makeNode('n2', 'connected')]);

    expect(component.navBadges()['remote-nodes']).toEqual({ text: '1 degraded', status: 'warn' });
  });

  it('counts degraded Remote Nodes as online when the socket is still live', () => {
    nodes$.set([makeNode('n1', 'degraded', true)]);

    expect(component.navBadges()['remote-nodes']).toEqual({ text: '1 degraded', status: 'warn' });
    expect(component.remoteNodesHelpStatus()).toEqual({
      variant: 'info',
      text: '1 of 1 enrolled node is connected.',
    });
  });

  it('surfaces a CLI Health badge only when CLI updates are available', () => {
    expect(component.navBadges()['cli-health']).toBeUndefined();

    cliPillState$.set({ generatedAt: Date.now(), count: 2, entries: [] });

    expect(component.navBadges()['cli-health']).toEqual({ text: '2 updates', status: 'warn' });
  });

  it('derives the Doctor badge from degraded startup-capability checks', () => {
    expect(component.navBadges()['doctor']).toBeUndefined();

    startupCallback?.(
      makeReport('degraded', [
        ['native.sqlite', 'native', 'ready'],
        ['subsystem.browser-automation', 'subsystem', 'degraded'],
      ]),
    );

    expect(component.navBadges()['doctor']).toEqual({ text: '1 issue', status: 'warn' });
  });

  it('derives the Models badge from provider CLIs that are not ready', () => {
    startupCallback?.(
      makeReport('degraded', [
        ['provider.any', 'provider', 'ready'],
        ['provider.claude', 'provider', 'ready'],
        ['provider.codex', 'provider', 'degraded'],
      ]),
    );

    expect(component.navBadges()['models']).toEqual({ text: '1 provider', status: 'warn' });
  });

  // ─── Contextual help pane (item 13) ────────────────────────────────────────

  it('defaults the contextual help pane to expanded', () => {
    expect(component.helpCollapsed()).toBe(false);
  });

  it('remembers the help pane collapsed state', () => {
    component.toggleHelp();

    expect(component.helpCollapsed()).toBe(true);
    expect(localStorage.getItem('aiorch.settings.helpCollapsed')).toBe('true');
  });

  it('defaults the settings navigation tree to expanded', () => {
    expect(component.navCollapsed()).toBe(false);
  });

  it('remembers the settings navigation collapsed state', () => {
    component.toggleNav();

    expect(component.navCollapsed()).toBe(true);
    expect(localStorage.getItem(NAV_COLLAPSED_KEY)).toBe('true');
  });

  it('clears search when collapsing the settings navigation so the compact rail stays navigable', () => {
    component.searchQuery.set('zzzz-no-results');

    component.toggleNav();

    expect(component.navCollapsed()).toBe(true);
    expect(component.searchQuery()).toBe('');
    expect(component.hasResults()).toBe(true);
  });

  it('restores the persisted settings navigation collapsed state for a freshly created instance', () => {
    localStorage.setItem(NAV_COLLAPSED_KEY, 'true');

    const restored = TestBed.createComponent(SettingsComponent).componentInstance;

    expect(restored.navCollapsed()).toBe(true);
  });

  it('restores the persisted collapsed state for a freshly created instance', () => {
    localStorage.setItem('aiorch.settings.helpCollapsed', 'true');

    const restored = TestBed.createComponent(SettingsComponent).componentInstance;

    expect(restored.helpCollapsed()).toBe(true);
  });

  it('does not render a route-level Back button in the routed settings template', () => {
    expect(template).not.toContain('class="back-btn"');
    expect(template).not.toContain('aria-label="Back to dashboard"');
  });

  it('keeps the legacy close/navigate path for modal callers', () => {
    const emit = vi.spyOn(component.closeDialog, 'emit');

    component.goBack();

    expect(emit).toHaveBeenCalledOnce();
    expect(router.navigate).toHaveBeenCalledWith(['/']);
  });

  it('closes settings on Escape when focus is outside the search field', () => {
    const emit = vi.spyOn(component.closeDialog, 'emit');

    component.onKeydown(new KeyboardEvent('keydown', { key: 'Escape' }));

    expect(emit).toHaveBeenCalledOnce();
    expect(router.navigate).toHaveBeenCalledWith(['/']);
  });
});
