import { By } from '@angular/platform-browser';
import { AioTooltipDirective } from './shared/tooltip/aio-tooltip.directive';
import {
  computed,
  CUSTOM_ELEMENTS_SCHEMA,
  ɵresolveComponentResources as resolveComponentResources,
  signal,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartupCapabilityReport } from '../../shared/types/startup-capability.types';
import { AppComponent } from './app.component';
import { PauseRendererController } from './core/state/pause/pause-renderer-controller.service';
import { PauseStore } from './core/state/pause/pause.store';
import { PromptHistoryStore } from './core/state/prompt-history.store';
import { SettingsStore } from './core/state/settings.store';
import { ModelFavoritesService } from './features/models/model-favorites.service';
import { UsageStore } from './core/state/usage.store';
import { AppUpdateStore } from './core/state/app-update.store';
import { IpcFacadeService } from './core/services/ipc';
import { PerfInstrumentationService } from './core/services/perf-instrumentation.service';
import { StressFixturesService } from './core/services/stress-fixtures.service';
import { WorkspaceBenchService } from './core/services/workspace-bench.service';
import { LocalAiGuardStore } from './core/state/local-ai-guard.store';
import { LocalAiStatusChipComponent } from './features/local-ai-guard/local-ai-status-chip.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './app.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './app.component.scss'), 'utf8');

interface RouterMock {
  events: Subject<unknown>;
  navigate: ReturnType<typeof vi.fn>;
  navigateByUrl: ReturnType<typeof vi.fn>;
  url: string;
}

await resolveComponentResources((url) => {
  if (url.endsWith('app.component.html')) {
    return Promise.resolve(template);
  }
  if (url.endsWith('app.component.scss')) {
    return Promise.resolve(styles);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function makeDegradedReport(summary = 'Multiple codex installs detected.'): StartupCapabilityReport {
  return {
    status: 'degraded',
    generatedAt: 1710000000000,
    checks: [
      {
        id: 'provider.codex',
        label: 'Codex CLI',
        category: 'provider',
        status: 'degraded',
        critical: false,
        summary,
      },
    ],
  };
}

function createRouterMock(url = '/'): RouterMock {
  return {
    events: new Subject<unknown>(),
    navigate: vi.fn(),
    navigateByUrl: vi.fn(),
    url,
  };
}

async function setupAppComponent(
  platform = 'darwin',
  options: { settingsStore?: Record<string, unknown>; router?: RouterMock } = {},
): Promise<{
  fixture: ComponentFixture<AppComponent>;
  component: AppComponent;
}> {
  window.localStorage.clear();

  TestBed.overrideComponent(AppComponent, {
    set: {
      imports: [AioTooltipDirective],
      template,
      templateUrl: undefined,
      styles: [styles],
      styleUrl: undefined,
      styleUrls: [],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    },
  });

  await TestBed.configureTestingModule({
    imports: [AppComponent],
    providers: [
      { provide: Router, useValue: options.router ?? createRouterMock() },
      {
        provide: IpcFacadeService,
        useValue: {
          platform,
          onStartupCapabilities: vi.fn(() => () => void 0),
          on: vi.fn(() => () => void 0),
          appReady: vi.fn(async () => ({ success: true })),
          getStartupCapabilities: vi.fn(async () => null),
        },
      },
      { provide: PerfInstrumentationService, useValue: {} },
      { provide: StressFixturesService, useValue: {} },
      { provide: WorkspaceBenchService, useValue: {} },
      { provide: UsageStore, useValue: { init: vi.fn() } },
      { provide: PromptHistoryStore, useValue: { init: vi.fn() } },
      {
        provide: ModelFavoritesService,
        useValue: { favorites: signal<string[]>([]).asReadonly(), writeFavorites: vi.fn() },
      },
      { provide: AppUpdateStore, useValue: { init: vi.fn(), dispose: vi.fn() } },
      {
        provide: LocalAiGuardStore,
        useValue: { initialize: vi.fn(async () => void 0), destroy: vi.fn() },
      },
      {
        provide: SettingsStore,
        useValue: options.settingsStore ?? {
          initialize: vi.fn(async () => void 0),
          isInitialized: signal(false).asReadonly(),
          get: vi.fn(() => false),
        },
      },
      { provide: PauseStore, useValue: { resumeEvents: signal([]).asReadonly() } },
      { provide: PauseRendererController, useValue: { bindReactive: vi.fn() } },
    ],
    schemas: [CUSTOM_ELEMENTS_SCHEMA],
  })
    .compileComponents();

  const fixture = TestBed.createComponent(AppComponent);
  const component = fixture.componentInstance;
  component.startupCapabilities.set(makeDegradedReport());
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();

  return { fixture, component };
}

describe('AppComponent startup banner', () => {
  let fixture: ComponentFixture<AppComponent>;
  let component: AppComponent;
  let router: RouterMock;
  let menuListeners: Record<string, () => void>;

  beforeEach(async () => {
    window.localStorage.clear();
    menuListeners = {};
    router = createRouterMock();

    TestBed.overrideComponent(AppComponent, {
      set: {
        imports: [AioTooltipDirective],
        template,
        templateUrl: undefined,
        styles: [styles],
        styleUrl: undefined,
        styleUrls: [],
        schemas: [CUSTOM_ELEMENTS_SCHEMA],
      },
    });

    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        { provide: Router, useValue: router },
        {
          provide: IpcFacadeService,
          useValue: {
            platform: 'darwin',
            onStartupCapabilities: vi.fn(() => () => void 0),
            on: vi.fn((channel: string, callback: () => void) => {
              menuListeners[channel] = callback;
              return () => void 0;
            }),
            appReady: vi.fn(async () => ({ success: true })),
            getStartupCapabilities: vi.fn(async () => null),
          },
        },
        { provide: PerfInstrumentationService, useValue: {} },
        { provide: StressFixturesService, useValue: {} },
        { provide: WorkspaceBenchService, useValue: {} },
        { provide: UsageStore, useValue: { init: vi.fn() } },
        { provide: PromptHistoryStore, useValue: { init: vi.fn() } },
        {
          provide: ModelFavoritesService,
          useValue: { favorites: signal<string[]>([]).asReadonly(), writeFavorites: vi.fn() },
        },
        { provide: AppUpdateStore, useValue: { init: vi.fn(), dispose: vi.fn() } },
        {
          provide: LocalAiGuardStore,
          useValue: { initialize: vi.fn(async () => void 0), destroy: vi.fn() },
        },
        {
          provide: SettingsStore,
          useValue: {
            initialize: vi.fn(async () => void 0),
            isInitialized: signal(false).asReadonly(),
            get: vi.fn(() => false),
          },
        },
        { provide: PauseStore, useValue: { resumeEvents: signal([]).asReadonly() } },
        { provide: PauseRendererController, useValue: { bindReactive: vi.fn() } },
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    })
      .compileComponents();

    fixture = TestBed.createComponent(AppComponent);
    component = fixture.componentInstance;
    component.startupCapabilities.set(makeDegradedReport());
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('preserves the startup explanation and the dismiss name with real tooltip directives', () => {
    expect(fixture.nativeElement.querySelectorAll('[title]')).toHaveLength(0);
    const chip = fixture.debugElement.query(By.css('.startup-status-chip'));
    expect(chip.injector.get(AioTooltipDirective).appTooltip()).toBe('Codex CLI: Multiple codex installs detected.');
    const dismiss = fixture.debugElement.query(By.css('.startup-banner-dismiss'));
    expect(dismiss.nativeElement.getAttribute('aria-label')).toBe('Dismiss startup checks banner');
    expect(dismiss.injector.get(AioTooltipDirective).appTooltip()).toBe('Dismiss');
    const element = dismiss.nativeElement as HTMLElement;
    const matches = element.matches.bind(element);
    vi.spyOn(element, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    element.dispatchEvent(new FocusEvent('focus')); fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Dismiss');
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('keeps the resuming-traffic chip short and explains it on hover', () => {
    (component as unknown as { resumeToast: { set(value: { id: number; at: number; queuedTotal: number }): void } }).resumeToast.set({
      id: 1, at: Date.now(), queuedTotal: 3,
    });
    fixture.detectChanges();
    const chip = fixture.debugElement.query(By.css('.title-activity-chip'));
    expect(chip.nativeElement.textContent.trim()).toBe('Sending 3');
    expect(chip.nativeElement.hasAttribute('title')).toBe(false);
    expect(chip.injector.get(AioTooltipDirective).appTooltip()).toBe('Queued paused traffic is resuming');
    // The visible "Sending 3 queued messages" status toast still carries the state.
    expect(fixture.nativeElement.querySelector('.resume-toast').textContent).toContain('Sending 3 queued messages');
  });

  it('renders a dismiss control for degraded startup checks', () => {
    const dismiss = fixture.nativeElement.querySelector('.startup-banner-dismiss') as HTMLButtonElement | null;

    expect(dismiss).not.toBeNull();
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss startup checks banner');
  });

  it.each(['claude', 'codex'])('opens account sign-in settings from the %s startup warning', (provider) => {
    const report = makeDegradedReport(`${provider} CLI is not logged in`);
    report.checks[0].id = `provider.${provider}`;
    component.startupCapabilities.set(report);
    fixture.detectChanges();
    router.navigate.mockClear();

    const action = fixture.nativeElement.querySelector('.startup-banner-cta') as HTMLButtonElement;
    expect(action.textContent).toBe('Open accounts');
    action.click();

    expect(router.navigate).toHaveBeenCalledExactlyOnceWith(['/settings'], { fragment: 'provider-accounts' });
  });

  it('opens the Claude, Codex & MiMo accounts page from a quota reauth banner', () => {
    router.navigate.mockClear();

    component.openProviderAccounts('claude');

    expect(router.navigate).toHaveBeenCalledExactlyOnceWith(['/settings'], { fragment: 'provider-accounts' });
  });

  it('opens the Copilot accounts page from a Copilot quota reauth banner', () => {
    router.navigate.mockClear();

    component.openProviderAccounts('copilot');

    expect(router.navigate).toHaveBeenCalledExactlyOnceWith(['/settings'], { fragment: 'copilot-accounts' });
  });

  it('hides the current degraded startup report after dismissal', () => {
    const dismiss = fixture.nativeElement.querySelector('.startup-banner-dismiss') as HTMLButtonElement;

    dismiss.click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.startup-banner')).toBeNull();
  });

  it('keeps the same degraded report dismissed until the warning contents change', () => {
    const dismiss = fixture.nativeElement.querySelector('.startup-banner-dismiss') as HTMLButtonElement;

    dismiss.click();
    component.startupCapabilities.set({ ...makeDegradedReport(), generatedAt: 1710000005000 });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.startup-banner')).toBeNull();

    component.startupCapabilities.set(makeDegradedReport('Codex binary is missing.'));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.startup-banner')).not.toBeNull();
  });

  it('shows the startup chip only while a startup check needs attention', () => {
    expect(fixture.nativeElement.querySelector('.startup-status-chip')?.textContent).toContain('Startup degraded');

    component.startupCapabilities.set({ ...makeDegradedReport(), status: 'ready', checks: [] });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.startup-status-chip')).toBeNull();
  });

  it('leaves the remote terminal toggle to the workspace rail', () => {
    expect(template).not.toContain('Remote Terminal');
    expect(template.match(/<app-terminal-drawer/g)).toHaveLength(1);
  });

  it('does not show a root-level route fallback back button on the dashboard route', () => {
    expect(fixture.nativeElement.querySelector('[data-testid="route-backstop"]')).toBeNull();
  });

  it('does not show a root-level route fallback back button on non-dashboard routes', () => {
    router.url = '/browser';
    fixture.detectChanges();

    const backstop = fixture.nativeElement.querySelector('[data-testid="route-backstop"]') as HTMLButtonElement | null;
    expect(backstop).toBeNull();
  });

  it('opens Settings from the app menu through the Control Surface registry path', () => {
    menuListeners['menu:open-settings']?.();

    expect(router.navigateByUrl).toHaveBeenCalledWith('/settings');
  });
});

describe('AppComponent title bar layout', () => {
  it('initializes and destroys the Local AI Guard store exactly once with the root shell', async () => {
    const localAiGuardStore = {
      initialize: vi.fn(async () => void 0),
      destroy: vi.fn(),
    };
    TestBed.overrideProvider(LocalAiGuardStore, { useValue: localAiGuardStore });
    const { fixture } = await setupAppComponent();

    expect(localAiGuardStore.initialize).toHaveBeenCalledOnce();

    fixture.destroy();
    expect(localAiGuardStore.destroy).toHaveBeenCalledOnce();
  });

  it('mounts the Local AI status chip in the title cluster and fallback banner near approvals', () => {
    expect(template.match(/<app-local-ai-status-chip/g)).toHaveLength(1);
    expect(template.match(/<app-local-ai-fallback-banner/g)).toHaveLength(1);

    const overlayStart = template.indexOf('class="title-bar-overlay"');
    const overlayEnd = template.indexOf('</div>', overlayStart);
    const chipIndex = template.indexOf('<app-local-ai-status-chip');
    expect(chipIndex).toBeGreaterThan(overlayStart);
    expect(chipIndex).toBeLessThan(overlayEnd);

    const browserBannerIndex = template.indexOf('<app-browser-approvals-banner');
    const fallbackBannerIndex = template.indexOf('<app-local-ai-fallback-banner');
    expect(fallbackBannerIndex).toBeGreaterThan(browserBannerIndex);
    expect(fallbackBannerIndex).toBeLessThan(template.indexOf('<main class="app-main"'));
  });

  it('renders Status unavailable in the root shell when initialization has no snapshot', async () => {
    TestBed.resetTestingModule();
    const isInitialized = signal(true);
    const hasAuthoritativeSnapshot = signal(false);
    const aggregate = signal({
      state: 'not-configured' as const,
      enrolled: 0,
      healthy: 0,
      degraded: 0,
      unavailable: 0,
      paused: 0,
    });
    TestBed.overrideComponent(AppComponent, {
      set: {
        imports: [LocalAiStatusChipComponent, AioTooltipDirective],
        template,
        templateUrl: undefined,
        styles: [styles],
        styleUrl: undefined,
        styleUrls: [],
        schemas: [CUSTOM_ELEMENTS_SCHEMA],
      },
    });
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [
        { provide: Router, useValue: createRouterMock() },
        {
          provide: IpcFacadeService,
          useValue: {
            platform: 'darwin',
            onStartupCapabilities: vi.fn(() => () => void 0),
            on: vi.fn(() => () => void 0),
            appReady: vi.fn(async () => ({ success: true })),
            getStartupCapabilities: vi.fn(async () => null),
          },
        },
        { provide: PerfInstrumentationService, useValue: {} },
        { provide: StressFixturesService, useValue: {} },
        { provide: WorkspaceBenchService, useValue: {} },
        { provide: UsageStore, useValue: { init: vi.fn() } },
        { provide: PromptHistoryStore, useValue: { init: vi.fn() } },
        {
          provide: ModelFavoritesService,
          useValue: { favorites: signal<string[]>([]).asReadonly(), writeFavorites: vi.fn() },
        },
        { provide: AppUpdateStore, useValue: { init: vi.fn(), dispose: vi.fn() } },
        {
          provide: LocalAiGuardStore,
          useValue: {
            initialize: vi.fn(async () => void 0),
            destroy: vi.fn(),
            isInitialized: isInitialized.asReadonly(),
            hasAuthoritativeSnapshot: hasAuthoritativeSnapshot.asReadonly(),
            aggregate: aggregate.asReadonly(),
          },
        },
        {
          provide: SettingsStore,
          useValue: {
            initialize: vi.fn(async () => void 0),
            isInitialized: signal(false).asReadonly(),
            get: vi.fn(() => false),
          },
        },
        { provide: PauseStore, useValue: { resumeEvents: signal([]).asReadonly() } },
        { provide: PauseRendererController, useValue: { bindReactive: vi.fn() } },
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();

    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const chip = fixture.nativeElement.querySelector(
      '[data-testid="local-ai-status-chip"]',
    ) as HTMLButtonElement;
    expect(chip.textContent).toContain('Local AI: Status unavailable');
    expect(chip.getAttribute('aria-label')).toContain('Status unavailable');
  });

  it('mounts the application update banner once at the root', () => {
    expect(template.match(/<app-update-banner/g)).toHaveLength(1);
  });

  it('mounts the Computer Use permission banner once above app-main', () => {
    expect(template.match(/<app-computer-use-permission-banner/g)).toHaveLength(1);
    expect(template.indexOf('<app-computer-use-permission-banner'))
      .toBeLessThan(template.indexOf('<main class="app-main"'));
  });

  it('mounts the Computer Use permission chip once in the title-bar status cluster', () => {
    expect(template.match(/<app-computer-use-permission-chip/g)).toHaveLength(1);
    const overlayStart = template.indexOf('class="title-bar-overlay"');
    const overlayEnd = template.indexOf('</div>', overlayStart);
    const chipIndex = template.indexOf('<app-computer-use-permission-chip');
    expect(chipIndex).toBeGreaterThan(overlayStart);
    expect(chipIndex).toBeLessThan(overlayEnd);
  });

  it('marks Windows shells so content clears the native caption controls', async () => {
    const { fixture } = await setupAppComponent('win32');
    const container = fixture.nativeElement.querySelector('.app-container') as HTMLElement | null;

    expect(container?.classList.contains('windows')).toBe(true);
    expect(container?.classList.contains('macos')).toBe(false);
    expect(styles).toContain('.app-container.windows');
    expect(styles).toContain('padding-top: 40px');
  });
});

describe('AppComponent computer role', () => {
  function settingsWithRole(role: 'unset' | 'coordinator' | 'worker') {
    const workerMode = signal({ role, startWorkerOnLaunch: true, installWorkerService: false });
    return {
      initialize: vi.fn(async () => void 0),
      isInitialized: signal(true).asReadonly(),
      get: vi.fn(() => false),
      workerMode: workerMode.asReadonly(),
      harnessRole: computed(() => workerMode().role),
      set: vi.fn(async (_key: string, value: { role: typeof role }) => {
        workerMode.set({ ...workerMode(), role: value.role });
      }),
    };
  }

  it('keeps the full app for a worker computer instead of a worker-only screen', async () => {
    const { fixture } = await setupAppComponent('win32', { settingsStore: settingsWithRole('worker') });
    const main = fixture.nativeElement.querySelector('main.app-main') as HTMLElement;

    expect(main.querySelector('router-outlet')).not.toBeNull();
    expect(main.querySelector('app-worker-mode')).toBeNull();
    expect(main.querySelector('app-role-choice')).toBeNull();
  });

  it('opens the Worker Mode page after choosing the worker role', async () => {
    const router = createRouterMock();
    const settingsStore = settingsWithRole('unset');
    const { fixture, component } = await setupAppComponent('win32', { settingsStore, router });
    expect(fixture.nativeElement.querySelector('app-role-choice')).not.toBeNull();

    await (component as unknown as {
      selectHarnessRole(role: 'worker'): Promise<void>;
    }).selectHarnessRole('worker');
    fixture.detectChanges();

    expect(settingsStore.set).toHaveBeenCalledWith('workerMode', expect.objectContaining({ role: 'worker' }));
    expect(router.navigateByUrl).toHaveBeenCalledWith('/worker-mode');
    expect(fixture.nativeElement.querySelector('router-outlet')).not.toBeNull();
  });
});
