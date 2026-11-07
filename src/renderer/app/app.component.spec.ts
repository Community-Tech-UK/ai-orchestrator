import { By } from '@angular/platform-browser';
import { ToastService } from './core/services/toast.service';
import { NotificationShellService } from './core/notices/notification-shell.service';
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
import type { ProviderRuntimeEventEnvelope } from '@contracts/types/provider-runtime-events';
import type { StartupCapabilityReport } from '../../shared/types/startup-capability.types';
import { DEFAULT_SETTINGS, type AppSettings } from '../../shared/types/settings.types';
import { ActionDispatchService } from './core/services/action-dispatch.service';
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
import { InstanceEventsService } from './core/services/instance-events.service';
import { IpcEventBusService } from './core/services/ipc/ipc-event-bus.service';
import { LocalAiGuardStore } from './core/state/local-ai-guard.store';
import { RunFailureStateService } from './features/instance-detail/run-failure-state.service';
import { LocalAiStatusChipComponent } from './features/local-ai-guard/local-ai-status-chip.component';
import { AioTooltipDirective } from './shared/tooltip/aio-tooltip.directive';
import { NeedsYouStore } from './features/workboard/needs-you.store';

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

function makeDegradedReport(summary = 'Codex is installed more than once, with different versions.'): StartupCapabilityReport {
  return {
    status: 'degraded',
    generatedAt: 1710000000000,
    checks: [
      {
        id: 'provider.codex',
        label: 'Codex',
        category: 'provider',
        status: 'degraded',
        critical: false,
        summary,
      },
    ],
  };
}

function makeCheck(
  id: string,
  summary: string,
  fix: string,
  overrides: Partial<StartupCapabilityReport['checks'][number]> = {},
): StartupCapabilityReport['checks'][number] {
  return {
    id,
    label: id,
    category: id.startsWith('provider.') ? 'provider' : 'subsystem',
    status: 'degraded',
    critical: false,
    summary,
    details: { fix },
    ...overrides,
  };
}

function makeReport(
  status: StartupCapabilityReport['status'],
  checks: StartupCapabilityReport['checks'],
): StartupCapabilityReport {
  return { status, generatedAt: 1710000000000, checks };
}

function createRouterMock(url = '/'): RouterMock {
  return {
    events: new Subject<unknown>(),
    navigate: vi.fn(),
    navigateByUrl: vi.fn(),
    url,
  };
}

/**
 * Stand-ins for the two streams the root shell's run-failure tracker listens to.
 * Every shell fixture gets them on purpose: the shell now creates that tracker at
 * startup, and it should read these instead of the real Electron event bridge.
 */
function createFailureEventSources() {
  const events$ = new Subject<ProviderRuntimeEventEnvelope>();
  const instanceRemoved$ = new Subject<string>();
  return {
    events$,
    providers: [
      { provide: InstanceEventsService, useValue: { events$ } },
      { provide: IpcEventBusService, useValue: { instanceRemoved$ } },
    ],
  };
}

async function setupAppComponent(
  platform = 'darwin',
  options: {
    settingsStore?: Record<string, unknown>;
    router?: RouterMock;
    beforeInit?: (events: Subject<ProviderRuntimeEventEnvelope>) => void;
  } = {},
): Promise<{
  fixture: ComponentFixture<AppComponent>;
  component: AppComponent;
  failureEvents$: Subject<ProviderRuntimeEventEnvelope>;
}> {
  window.localStorage.clear();
  const failureSources = createFailureEventSources();

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
      { provide: NotificationShellService, useValue: { start: vi.fn(), stop: vi.fn() } },
      { provide: NeedsYouStore, useValue: { init: vi.fn() } },
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
      { provide: ActionDispatchService, useValue: { register: vi.fn(() => () => undefined) } },
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
          settings: signal<AppSettings>({ ...DEFAULT_SETTINGS }),
        },
      },
      { provide: PauseStore, useValue: { resumeEvents: signal([]).asReadonly() } },
      { provide: PauseRendererController, useValue: { bindReactive: vi.fn() } },
      ...failureSources.providers,
    ],
    schemas: [CUSTOM_ELEMENTS_SCHEMA],
  })
    .compileComponents();

  const fixture = TestBed.createComponent(AppComponent);
  const component = fixture.componentInstance;
  options.beforeInit?.(failureSources.events$);
  component.startupCapabilities.set(makeDegradedReport());
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();

  return { fixture, component, failureEvents$: failureSources.events$ };
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
        { provide: NotificationShellService, useValue: { start: vi.fn(), stop: vi.fn() } },
      { provide: NeedsYouStore, useValue: { init: vi.fn() } },
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
        { provide: ActionDispatchService, useValue: { register: vi.fn(() => () => undefined) } },
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
            settings: signal<AppSettings>({ ...DEFAULT_SETTINGS }),
          },
        },
        { provide: PauseStore, useValue: { resumeEvents: signal([]).asReadonly() } },
        { provide: PauseRendererController, useValue: { bindReactive: vi.fn() } },
        ...createFailureEventSources().providers,
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
    expect(chip.injector.get(AioTooltipDirective).appTooltip()).toBe('Codex is installed more than once, with different versions.');
    const dismiss = fixture.debugElement.query(By.css('.startup-banner-dismiss'));
    expect(dismiss.nativeElement.getAttribute('aria-label')).toBe('Dismiss startup checks banner');
    expect(dismiss.injector.get(AioTooltipDirective).appTooltip()).toBe('Dismiss startup checks banner');
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
    expect(fixture.nativeElement.querySelectorAll('.title-activity-chip')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('.resume-toast')).toBeNull();
  });

  it('announces sticky errors as alerts and provides their action and dismiss buttons', () => {
    const toast = TestBed.inject(ToastService); const fix = vi.fn();
    toast.show('Broken', 'error', { action: { label: 'Show session', run: fix } });
    fixture.detectChanges();
    const alert = fixture.nativeElement.querySelector('.toast-item[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('Broken');
    alert.querySelector('button')?.click(); expect(fix).toHaveBeenCalledOnce();
    alert.querySelector<HTMLButtonElement>('[aria-label="Dismiss Broken"]')?.click(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.toast-item')).toBeNull();
  });

  it('dismisses only the shown notices from the "+N more" row, so a hidden error is not lost unread', () => {
    const toast = TestBed.inject(ToastService);
    for (const name of ['One', 'Two', 'Three', 'Four']) toast.show(name, 'error');
    fixture.detectChanges();
    const rows = () => [...fixture.nativeElement.querySelectorAll('.toast-item')].map((row) => (row as HTMLElement).textContent ?? '');
    expect(rows().join('|')).toContain('+1 more');
    expect(rows().join('|')).not.toContain('Four');
    const dismiss = [...fixture.nativeElement.querySelectorAll('.toast-item button')]
      .find((button) => (button as HTMLButtonElement).textContent?.trim() === 'Dismiss these') as HTMLButtonElement;
    dismiss.click(); fixture.detectChanges();
    expect(rows().join('|')).toContain('Four');
    expect(rows().join('|')).not.toContain('more');
  });

  it('renders a dismiss control for degraded startup checks', () => {
    const dismiss = fixture.nativeElement.querySelector('.startup-banner-dismiss') as HTMLButtonElement | null;

    expect(dismiss).not.toBeNull();
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss startup checks banner');
    fixture.debugElement.query(By.css('.startup-banner-dismiss')).injector.get(AioTooltipDirective).show();
    fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('Dismiss startup checks banner');
  });

  it.each(['claude', 'codex'])('opens account sign-in settings from the %s startup warning', (provider) => {
    const report = makeReport('degraded', [
      makeCheck(`provider.${provider}`, `${provider} isn't signed in.`, 'accounts'),
    ]);
    component.startupCapabilities.set(report);
    fixture.detectChanges();
    router.navigate.mockClear();

    const action = fixture.nativeElement.querySelector('.startup-banner-cta') as HTMLButtonElement;
    expect(action.textContent?.trim()).toBe('Accounts');
    action.click();

    expect(router.navigate).toHaveBeenCalledExactlyOnceWith(['/settings'], { fragment: 'provider-accounts' });
  });

  it('opens the Copilot accounts page from a signed-out Copilot warning', () => {
    component.startupCapabilities.set(makeReport('degraded', [
      makeCheck('provider.copilot', "Copilot isn't signed in.", 'accounts'),
    ]));
    fixture.detectChanges();
    router.navigate.mockClear();

    (fixture.nativeElement.querySelector('.startup-banner-cta') as HTMLButtonElement).click();

    expect(router.navigate).toHaveBeenCalledExactlyOnceWith(['/settings'], { fragment: 'copilot-accounts' });
  });

  it('still opens Accounts for a provider check from an older probe that names no fix', () => {
    const report = makeDegradedReport("Codex isn't signed in.");
    component.startupCapabilities.set(report);
    fixture.detectChanges();
    router.navigate.mockClear();

    (fixture.nativeElement.querySelector('.startup-banner-cta') as HTMLButtonElement).click();

    expect(router.navigate).toHaveBeenCalledExactlyOnceWith(['/settings'], { fragment: 'provider-accounts' });
  });

  it('gives every failing check its own plain sentence and its own fix button', () => {
    component.startupCapabilities.set(makeReport('degraded', [
      makeCheck('provider.cursor', "Cursor isn't installed, but you've chosen it as a default.", 'setup'),
      makeCheck(
        'subsystem.remote-nodes',
        "On, but not running yet: Harness isn't listening on 127.0.0.1:4878.",
        'remote-computers',
      ),
      makeCheck(
        'subsystem.browser-automation',
        "On, but not running yet: the browser tool server isn't connected.",
        'browser',
      ),
    ]));
    fixture.detectChanges();

    const rows = [...fixture.nativeElement.querySelectorAll('.startup-banner-check')] as HTMLElement[];
    expect(rows.map((row) => row.querySelector('.startup-banner-body')?.textContent?.trim())).toEqual([
      "Cursor isn't installed, but you've chosen it as a default.",
      "On, but not running yet: Harness isn't listening on 127.0.0.1:4878.",
      "On, but not running yet: the browser tool server isn't connected.",
    ]);
    expect(rows.map((row) => row.querySelector('button')?.textContent?.trim())).toEqual([
      'Setup',
      'Remote computers',
      'Browser',
    ]);

    router.navigate.mockClear();
    rows.forEach((row) => (row.querySelector('button') as HTMLButtonElement).click());

    expect(router.navigate.mock.calls).toEqual([
      [['/setup']],
      [['/remote-nodes']],
      [['/settings'], { queryParams: { tab: 'doctor', section: 'browser-automation' } }],
    ]);
  });

  it('spells out the three worst problems and counts the rest', () => {
    component.startupCapabilities.set(makeReport('failed', [
      makeCheck('provider.codex', "Codex isn't installed, but you've chosen it as a default.", 'setup'),
      makeCheck('provider.copilot', "Copilot isn't signed in.", 'accounts'),
      makeCheck('subsystem.remote-nodes', 'On, but not running yet: it is not listening.', 'remote-computers'),
      makeCheck('subsystem.browser-automation', 'On, but not running yet: nothing is connected.', 'browser'),
      makeCheck('provider.any', 'No AI tool is ready to use yet.', 'setup', {
        status: 'unavailable',
        critical: true,
      }),
    ]));
    fixture.detectChanges();

    const rows = [...fixture.nativeElement.querySelectorAll('.startup-banner-check')] as HTMLElement[];
    expect(rows).toHaveLength(4);
    expect(rows[0].textContent).toContain('No AI tool is ready to use yet.');
    expect(rows[3].textContent).toContain('And 2 more things need attention.');
    expect(rows[3].querySelector('button')?.textContent?.trim()).toBe('Setup');
  });

  it('puts a plain headline on the banner instead of the status word', () => {
    const title = () => fixture.nativeElement.querySelector('.startup-banner-title')?.textContent?.trim();
    expect(title()).toBe('A few things need attention');

    component.startupCapabilities.set(makeReport('failed', [
      makeCheck('provider.any', 'No AI tool is ready to use yet.', 'setup', { status: 'unavailable', critical: true }),
    ]));
    fixture.detectChanges();

    expect(title()).toBe('Setup needs your attention');
    expect(fixture.nativeElement.textContent).not.toMatch(/Startup checks:|degraded/i);
  });

  it('never says everything is ready under a warning, even when the report names nothing to fix', () => {
    component.startupCapabilities.set(makeReport('degraded', []));

    expect(component.startupCapabilitySummary()).toBe('A few things need attention.');
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

  it('shows nothing, banner or chip, once startup is ready again', () => {
    expect(fixture.nativeElement.querySelector('[data-testid="startup-status-chip"]')?.textContent).toContain('Startup needs attention');
    component.startupCapabilities.set(makeReport('ready', [
      makeCheck('provider.cursor', "Cursor isn't installed. You only need it to use Cursor.", 'setup', {
        status: 'disabled',
      }),
    ]));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.startup-banner')).toBeNull();
    expect(fixture.nativeElement.querySelector('[data-testid="startup-status-chip"]')).toBeNull();
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
  it('mounts both global command hosts and initializes the consolidated attention source', async () => {
    const { fixture } = await setupAppComponent();
    expect(fixture.nativeElement.querySelectorAll('app-command-palette-host')).toHaveLength(1);
    expect(fixture.nativeElement.querySelectorAll('app-session-status-host')).toHaveLength(1);
    expect(fixture.nativeElement.querySelectorAll('app-needs-you-strip')).toHaveLength(1);
    expect(fixture.nativeElement.querySelector('app-approval-digest-banner')).toBeNull();
    expect(TestBed.inject(NeedsYouStore).init).toHaveBeenCalledOnce();
  });
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

  it('says it could not check, in the root shell, when initialization has no snapshot', async () => {
    const fixture = await renderRootShellWithLocalModels({ hasSnapshot: false, state: 'not-configured' });

    const chip = fixture.nativeElement.querySelector(
      '[data-testid="local-ai-status-chip"]',
    ) as HTMLButtonElement;
    expect(chip.textContent?.trim()).toBe("Local models: couldn't check");
    expect(chip.textContent).not.toMatch(/Local AI|unavailable/);
  });

  it('does not force the chip host open, so an empty chip leaves no gap in the title bar', () => {
    // The chip hides itself with `:host:empty { display: none }`. A `display` set
    // on its host from here has higher specificity and would keep an empty flex
    // item in the cluster, whose `gap` would still reserve room for it.
    expect(styles).not.toMatch(/app-local-ai-status-chip\s*\{[^}]*display\s*:/);
  });

  it.each(['not-configured', 'healthy'] as const)(
    'leaves the title bar without a local models chip while they are %s',
    async (state) => {
      const fixture = await renderRootShellWithLocalModels({ hasSnapshot: true, state });

      expect(fixture.nativeElement.querySelector('[data-testid="local-ai-status-chip"]')).toBeNull();
      expect(fixture.nativeElement.querySelector('app-local-ai-status-chip')?.children.length).toBe(0);
    },
  );

  it('shows the local models chip in the title bar when they are paused', async () => {
    const fixture = await renderRootShellWithLocalModels({ hasSnapshot: true, state: 'paused' });

    const chip = fixture.nativeElement.querySelector('[data-testid="local-ai-status-chip"]') as HTMLButtonElement;
    expect(chip.textContent?.trim()).toBe('Local models: paused');
  });

  async function renderRootShellWithLocalModels(options: {
    hasSnapshot: boolean;
    state: 'not-configured' | 'healthy' | 'paused';
  }): Promise<ComponentFixture<AppComponent>> {
    TestBed.resetTestingModule();
    const isInitialized = signal(true);
    const hasAuthoritativeSnapshot = signal(options.hasSnapshot);
    const aggregate = signal({
      state: options.state,
      enrolled: options.state === 'not-configured' ? 0 : 1,
      healthy: options.state === 'healthy' ? 1 : 0,
      degraded: 0,
      unavailable: 0,
      paused: options.state === 'paused' ? 1 : 0,
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
        { provide: NotificationShellService, useValue: { start: vi.fn(), stop: vi.fn() } },
      { provide: NeedsYouStore, useValue: { init: vi.fn() } },
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
        { provide: ActionDispatchService, useValue: { register: vi.fn(() => () => undefined) } },
        {
          provide: LocalAiGuardStore,
          useValue: {
            initialize: vi.fn(async () => void 0),
            destroy: vi.fn(),
            isInitialized: isInitialized.asReadonly(),
            hasAuthoritativeSnapshot: hasAuthoritativeSnapshot.asReadonly(),
            aggregate: aggregate.asReadonly(),
            helperBudget: signal(undefined).asReadonly(),
            helperPauses: signal([]).asReadonly(),
            targets: signal([]).asReadonly(),
          },
        },
        {
          provide: SettingsStore,
          useValue: {
            initialize: vi.fn(async () => void 0),
            isInitialized: signal(false).asReadonly(),
            get: vi.fn(() => false),
            settings: signal<AppSettings>({ ...DEFAULT_SETTINGS }),
          },
        },
        { provide: PauseStore, useValue: { resumeEvents: signal([]).asReadonly() } },
        { provide: PauseRendererController, useValue: { bindReactive: vi.fn() } },
        ...createFailureEventSources().providers,
      ],
      schemas: [CUSTOM_ELEMENTS_SCHEMA],
    }).compileComponents();

    const fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture;
  }

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

  it('hides the startup chip when everything is ready, so a normal launch adds nothing to the title bar', async () => {
    const { fixture, component } = await setupAppComponent();
    expect(fixture.nativeElement.querySelector('[data-testid="startup-status-chip"]')).not.toBeNull();

    component.startupCapabilities.set(makeReport('ready', []));
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="startup-status-chip"]')).toBeNull();
    expect(fixture.nativeElement.querySelector('.startup-banner')).toBeNull();
  });

  it('shows a plain-words chip that opens Setup when startup needs attention', async () => {
    const router = createRouterMock();
    const { fixture } = await setupAppComponent('darwin', { router });
    const chip = fixture.nativeElement.querySelector('[data-testid="startup-status-chip"]') as HTMLButtonElement;

    expect(chip.textContent?.trim()).toBe('Startup needs attention');
    expect(chip.textContent).not.toMatch(/degraded/i);
    router.navigate.mockClear();
    chip.click();

    expect(router.navigate).toHaveBeenCalledExactlyOnceWith(['/setup']);
  });

  it('says "Startup failed" when startup cannot work at all', async () => {
    const { fixture, component } = await setupAppComponent();
    component.startupCapabilities.set(makeReport('failed', [
      makeCheck('provider.any', 'No AI tool is ready to use yet.', 'setup', { status: 'unavailable', critical: true }),
    ]));
    fixture.detectChanges();

    const chip = fixture.nativeElement.querySelector('[data-testid="startup-status-chip"]') as HTMLButtonElement;
    expect(chip.textContent?.trim()).toBe('Startup failed');
    expect(chip.classList.contains('failed')).toBe(true);
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

describe('AppComponent run failure tracking', () => {
  it('remembers background failures before settings initialize or any session view mounts', async () => {
    const settingsStore = {
      initialize: vi.fn(async () => void 0),
      isInitialized: signal(false).asReadonly(),
      get: vi.fn(() => false),
    };
    const { fixture } = await setupAppComponent('darwin', {
      settingsStore,
      beforeInit: (events) => {
        expect(settingsStore.initialize).not.toHaveBeenCalled();
        // Only the shell constructor has run. This event cannot be recovered by
        // lazily constructing the tracker later, because this stream is hot.
        events.next({
          eventId: 'event-1', instanceId: 'background-session', provider: 'codex',
          seq: 1, timestamp: 1000, adapterGeneration: 1, turnId: 'turn-1',
          event: { kind: 'complete', turnErrored: true },
        });
      },
    });

    expect(fixture.nativeElement.querySelector('app-instance-detail')).toBeNull();
    expect(TestBed.inject(RunFailureStateService).forInstance('background-session')).toMatchObject({
      id: 'event-1',
      turnId: 'turn-1',
    });
  });
});
