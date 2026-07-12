import {
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
import { UsageStore } from './core/state/usage.store';
import { AppUpdateStore } from './core/state/app-update.store';
import { IpcFacadeService } from './core/services/ipc';
import { PerfInstrumentationService } from './core/services/perf-instrumentation.service';
import { StressFixturesService } from './core/services/stress-fixtures.service';
import { WorkspaceBenchService } from './core/services/workspace-bench.service';

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

async function setupAppComponent(platform = 'darwin'): Promise<{
  fixture: ComponentFixture<AppComponent>;
  component: AppComponent;
}> {
  window.localStorage.clear();

  TestBed.overrideComponent(AppComponent, {
    set: {
      imports: [],
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
      { provide: AppUpdateStore, useValue: { init: vi.fn(), dispose: vi.fn() } },
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
        imports: [],
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
        { provide: AppUpdateStore, useValue: { init: vi.fn(), dispose: vi.fn() } },
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

  it('renders a dismiss control for degraded startup checks', () => {
    const dismiss = fixture.nativeElement.querySelector('.startup-banner-dismiss') as HTMLButtonElement | null;

    expect(dismiss).not.toBeNull();
    expect(dismiss?.getAttribute('aria-label')).toBe('Dismiss startup checks banner');
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
  it('mounts the application update banner once at the root', () => {
    expect(template.match(/<app-update-banner/g)).toHaveLength(1);
  });

  it('mounts the Computer Use permission banner once above app-main', () => {
    expect(template.match(/<app-computer-use-permission-banner/g)).toHaveLength(1);
    expect(template.indexOf('<app-computer-use-permission-banner'))
      .toBeLessThan(template.indexOf('<main class="app-main">'));
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
