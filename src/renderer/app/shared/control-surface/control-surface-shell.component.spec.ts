import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ActivatedRoute, provideRouter, Router, RouterOutlet, type Routes } from '@angular/router';
import { RouterTestingHarness, RouterTestingModule } from '@angular/router/testing';
import { By } from '@angular/platform-browser';
import { config } from 'rxjs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ControlSurfaceShellComponent } from './control-surface-shell.component';
import { routes } from '../../app.routes';
import { CONTROL_SURFACE_HELP } from '../help/control-surface-help';
import { HelpPaneComponent } from '../help/help-pane.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));

/** Standalone-component resources loaded from disk for the vitest environment. */
const resources: Record<string, string> = {
  'control-surface-shell.component.html': readFileSync(
    resolve(specDirectory, './control-surface-shell.component.html'),
    'utf8',
  ),
  'control-surface-shell.component.scss': readFileSync(
    resolve(specDirectory, './control-surface-shell.component.scss'),
    'utf8',
  ),
  'help-pane.component.html': readFileSync(
    resolve(specDirectory, '../help/help-pane.component.html'),
    'utf8',
  ),
  'help-pane.component.scss': readFileSync(
    resolve(specDirectory, '../help/help-pane.component.scss'),
    'utf8',
  ),
  'inline-help.component.scss': readFileSync(
    resolve(specDirectory, '../help/inline-help.component.scss'),
    'utf8',
  ),
};

await resolveComponentResources((url) => {
  const match = Object.entries(resources).find(([name]) => url.endsWith(name));
  if (match) {
    return Promise.resolve(match[1]);
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

@Component({
  standalone: true,
  template: '<p>Route content</p>',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class RouteContentComponent {}

describe('ControlSurfaceShellComponent router lifecycle', () => {
  beforeEach(async () => {
    localStorage.clear();
    const shellRoute = routes.find((route) => route.children);
    if (!shellRoute) throw new Error('Control Center shell route is missing');
    const children: Routes = ['settings', 'local-ai', 'automations'].map((path) => {
      const route = shellRoute.children?.find((child) => child.path === path);
      if (!route) throw new Error(`Control Center route is missing: ${path}`);
      return { ...route, loadComponent: async () => RouteContentComponent };
    });
    children.push({
      path: 'nested',
      data: { controlSurfaceId: 'automations' },
      children: [{
        path: 'logs',
        data: { controlSurfaceId: 'logs' },
        children: [{ path: '', component: RouteContentComponent, data: { controlSurfaceId: 'unknown' } }],
      }],
    });
    await TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([
          { path: '', pathMatch: 'full', component: RouteContentComponent },
          { ...shellRoute, children },
        ]),
      ],
    }).compileComponents();
  });

  it.each([
    ['/settings', 'Settings', null],
    ['/local-ai', 'Local AI Health Centre', 'local-ai'],
    ['/automations', 'Automations', 'automations'],
    ['/nested/logs', 'Logs', 'logs'],
  ] as const)('initializes %s before live child snapshots exist', async (url, title, helpId) => {
    const errors: unknown[] = [];
    const previousHandler = config.onUnhandledError;
    config.onUnhandledError = (error) => errors.push(error);
    const activateWith = RouterOutlet.prototype.activateWith;
    let initialChildSnapshot: unknown = 'not observed';
    let recognizedChildSnapshot: unknown;
    const activation = vi.spyOn(RouterOutlet.prototype, 'activateWith').mockImplementation(function (this: RouterOutlet, route, injector) {
      if (route.component === ControlSurfaceShellComponent) {
        initialChildSnapshot = route.firstChild?.snapshot;
        recognizedChildSnapshot = route.snapshot.firstChild;
      }
      return activateWith.call(this, route, injector);
    });
    try {
      const harness = await RouterTestingHarness.create(url);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(initialChildSnapshot).toBeUndefined();
      expect(recognizedChildSnapshot).toBeDefined();
      expect(errors).toEqual([]);
      expect(harness.routeNativeElement?.querySelector('h1')?.textContent).toBe(title);
      const help = harness.routeDebugElement?.query(By.directive(HelpPaneComponent));
      if (helpId) {
        expect(help?.componentInstance.entry()).toBe(CONTROL_SURFACE_HELP[helpId]);
      } else {
        expect(help).toBeNull();
      }
    } finally {
      activation.mockRestore();
      config.onUnhandledError = previousHandler;
    }
  });

  it('updates headings, navigation and help when reusing and recreating the shell', async () => {
    const errors: unknown[] = [];
    const previousHandler = config.onUnhandledError;
    config.onUnhandledError = (error) => errors.push(error);
    try {
      const harness = await RouterTestingHarness.create('/');
      for (const [url, title, helpId] of [
        ['/settings', 'Settings', null],
        ['/local-ai', 'Local AI Health Centre', 'local-ai'],
        ['/settings', 'Settings', null],
        ['/', null, null],
        ['/automations', 'Automations', 'automations'],
        ['/nested/logs', 'Logs', 'logs'],
        ['/', null, null],
        ['/local-ai', 'Local AI Health Centre', 'local-ai'],
      ] as const) {
        await harness.navigateByUrl(url);
        await new Promise<void>((resolve) => setTimeout(resolve, 0));

        expect(errors).toEqual([]);
        expect(harness.routeNativeElement?.querySelector('h1')?.textContent ?? null).toBe(title);
        const help = harness.routeDebugElement?.query(By.directive(HelpPaneComponent));
        if (helpId) {
          expect(help?.componentInstance.entry()).toBe(CONTROL_SURFACE_HELP[helpId]);
        } else {
          expect(help).toBeNull();
        }
        if (title && url !== '/nested/logs') {
          expect(harness.routeNativeElement?.querySelector('.control-nav-item.active')?.getAttribute('href')).toBe(url);
        }
      }
    } finally {
      config.onUnhandledError = previousHandler;
    }
  });
});

describe('ControlSurfaceShellComponent', () => {
  let fixture: ComponentFixture<ControlSurfaceShellComponent>;
  let router: Router;

  beforeEach(async () => {
    localStorage.clear();

    const route = {
      snapshot: {
        data: {},
        firstChild: { data: { controlSurfaceId: 'automations' }, firstChild: null },
      },
      firstChild: {
        snapshot: { data: { controlSurfaceId: 'automations' } },
        firstChild: null,
      },
    };

    await TestBed.configureTestingModule({
      imports: [ControlSurfaceShellComponent, RouterTestingModule.withRoutes([])],
      providers: [
        { provide: ActivatedRoute, useValue: route },
      ],
    }).compileComponents();

    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);

    fixture = TestBed.createComponent(ControlSurfaceShellComponent);
    fixture.detectChanges();
  });

  it('renders a visible text Back button', () => {
    const button = fixture.nativeElement.querySelector('.control-back') as HTMLButtonElement | null;

    expect(button?.textContent?.trim()).toContain('Back');
  });

  it('navigates to the active surface back route or dashboard', () => {
    const button = fixture.nativeElement.querySelector('.control-back') as HTMLButtonElement;

    button.click();

    expect(router.navigateByUrl).toHaveBeenCalledWith('/');
  });

  it('renders title and grouped Control Center navigation from the registry', () => {
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('Control Center');
    expect(text).toContain('Automations');
    expect(text).toContain('Settings');
    expect(text).toContain('Browser Gateway');
    expect(fixture.nativeElement.querySelector('h1')?.textContent).toBe('Automations');
  });

  it('remembers when the Control Center navigation is collapsed', () => {
    const button = fixture.nativeElement.querySelector('.control-nav-toggle') as HTMLButtonElement;

    button.click();
    fixture.detectChanges();

    expect(localStorage.getItem('aiorch.control.navCollapsed')).toBe('true');
    expect(fixture.nativeElement.querySelector('.control-shell')?.classList.contains('nav-collapsed')).toBe(true);
  });

  it('restores the persisted Control Center navigation collapsed state', () => {
    localStorage.setItem('aiorch.control.navCollapsed', 'true');

    const restored = TestBed.createComponent(ControlSurfaceShellComponent);
    restored.detectChanges();

    expect(restored.nativeElement.querySelector('.control-shell')?.classList.contains('nav-collapsed')).toBe(true);
  });
});
