import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { ActivatedRoute, NavigationEnd, provideRouter, Router, RouterOutlet, type Routes } from '@angular/router';
import { RouterTestingHarness, RouterTestingModule } from '@angular/router/testing';
import { By } from '@angular/platform-browser';
import { config, filter, firstValueFrom } from 'rxjs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ControlSurfaceShellComponent } from './control-surface-shell.component';
import { routes } from '../../app.routes';
import { navigationHubs } from './navigation-hubs';
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
    ['/local-ai', 'Local models', 'local-ai'],
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
        ['/local-ai', 'Local models', 'local-ai'],
        ['/settings', 'Settings', null],
        ['/', null, null],
        ['/automations', 'Automations', 'automations'],
        ['/nested/logs', 'Logs', 'logs'],
        ['/', null, null],
        ['/local-ai', 'Local models', 'local-ai'],
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
        if (url === '/settings') {
          expect(harness.routeNativeElement?.querySelector('#control-center-navigation')).toBeNull();
        } else if (title && url !== '/nested/logs') {
          expect(harness.routeNativeElement?.querySelector('.hub-tab.active')?.getAttribute('href')).toBe(url);
        }
      }
    } finally {
      config.onUnhandledError = previousHandler;
    }
  });

  it('follows the rendered Settings, Automations and Back controls without route errors', async () => {
    const errors: unknown[] = [];
    const previousHandler = config.onUnhandledError;
    config.onUnhandledError = (error) => errors.push(error);
    try {
      const harness = await RouterTestingHarness.create('/automations');
      const router = TestBed.inject(Router);
      for (let visit = 0; visit < 2; visit++) {
        if (visit > 0) await harness.navigateByUrl('/automations');

        for (const [selector, url, title] of [
          ['a[href="/settings"]', '/settings', 'Settings'],
          ['a[href="/automations"]', '/automations', 'Automations'],
          ['.control-back', '/', null],
        ] as const) {
          const control = harness.routeNativeElement?.querySelector<HTMLElement>(selector);
          if (!control && router.url === '/settings' && selector !== '.control-back') {
            // Settings has its own menu and hides the Control Center navigation, so leave it by address.
            await harness.navigateByUrl(url);
          } else {
            expect(control).toBeTruthy();
            const navigation = firstValueFrom(router.events.pipe(filter((event) => event instanceof NavigationEnd)));
            control!.click();
            await navigation;
          }
          await harness.fixture.whenStable();
          harness.detectChanges();
          await new Promise<void>((resolve) => setTimeout(resolve, 0));

          expect(errors).toEqual([]);
          expect(router.url).toBe(url);
          expect(harness.routeNativeElement?.querySelector('h1')?.textContent ?? null).toBe(title);
          expect(harness.routeNativeElement?.querySelector('.control-nav-item.active')?.getAttribute('href') ?? null)
            .toBe(title && url !== '/settings' ? url : null);
          const help = harness.routeDebugElement?.query(By.directive(HelpPaneComponent));
          if (title === 'Automations') {
            expect(help?.componentInstance.entry()).toBe(CONTROL_SURFACE_HELP['automations']);
          } else {
            expect(help).toBeNull();
          }
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

  it('lists one menu entry per hub instead of every page', () => {
    const entries = [...fixture.nativeElement.querySelectorAll('.control-nav-item')] as HTMLAnchorElement[];
    expect(entries).toHaveLength(navigationHubs(false).length);
    expect(entries.map(entry => entry.getAttribute('aria-label'))).toContain('Reviews');
    expect(fixture.nativeElement.querySelector('.control-nav a[href="/plugins"]')).toBeNull();
    expect(fixture.nativeElement.textContent).not.toContain('More tools');
  });

  it('shows the open hub as the current entry, with its pages as tabs', () => {
    const current = fixture.nativeElement.querySelector('.control-nav-item[aria-current="true"]') as HTMLAnchorElement;
    expect(current.getAttribute('aria-label')).toBe('Automations');
    const tabs = fixture.nativeElement.querySelector('nav.hub-tabs') as HTMLElement;
    expect(tabs.getAttribute('aria-label')).toBe('Automations pages');
    expect([...tabs.querySelectorAll('a')].map(tab => tab.textContent?.trim())).toEqual(['Automations', 'Workflows', 'Hooks']);
    expect(tabs.querySelector('a[aria-current="page"]')?.textContent?.trim()).toBe('Automations');
  });

  it('reaches a page that only has a tab through its hub', () => {
    const route = TestBed.inject(ActivatedRoute);
    route.snapshot.firstChild!.data['controlSurfaceId'] = 'plugins';
    const other = TestBed.createComponent(ControlSurfaceShellComponent); other.detectChanges();
    const root = other.nativeElement as HTMLElement;
    expect(root.querySelector('.control-nav-item[aria-current="true"]')?.getAttribute('aria-label')).toBe('Agents & models');
    expect(root.querySelector('nav.hub-tabs a[href="/plugins"]')?.getAttribute('aria-current')).toBe('page');
    expect(root.querySelector('nav.hub-tabs a[href="/models"]')).toBeTruthy();
  });

  it('adds the open page as a tab when its hub does not list it', () => {
    const route = TestBed.inject(ActivatedRoute);
    route.snapshot.firstChild!.data['controlSurfaceId'] = 'training';
    const other = TestBed.createComponent(ControlSurfaceShellComponent); other.detectChanges();
    const root = other.nativeElement as HTMLElement;
    expect(root.querySelector('nav.hub-tabs a[href="/training"]')?.getAttribute('aria-current')).toBe('page');
    expect(root.querySelector('nav.hub-tabs a[href="/memory-review"]')).toBeTruthy();
  });

  it('shows no tab strip for a hub with a single page', () => {
    const route = TestBed.inject(ActivatedRoute);
    route.snapshot.firstChild!.data['controlSurfaceId'] = 'browser';
    const other = TestBed.createComponent(ControlSurfaceShellComponent); other.detectChanges();
    expect(other.nativeElement.querySelector('nav.hub-tabs')).toBeNull();
  });

  it('scrolls the open hub and its tab into view, for the sideways strip on a narrow window', () => {
    // jsdom has no scrollIntoView, so record calls through a stand-in for this test only.
    const scrolled: [string, unknown][] = [];
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement, options?: unknown) {
      scrolled.push([this.getAttribute('aria-label') ?? this.textContent?.trim() ?? '', options]);
    };
    try {
      TestBed.inject(ActivatedRoute).snapshot.firstChild!.data['controlSurfaceId'] = 'cost';
      const other = TestBed.createComponent(ControlSurfaceShellComponent); other.detectChanges();
      const nearest = { inline: 'nearest', block: 'nearest' };
      expect(scrolled).toEqual([['Usage & health', nearest], ['Costs & Usage', nearest]]);

      // Collapsing and expanding the menu, or clearing a search, redraws the strip, so the open hub comes back.
      const toggle = () => {
        (other.nativeElement.querySelector('.control-nav-toggle') as HTMLButtonElement).click();
        other.detectChanges();
      };
      scrolled.length = 0;
      toggle();
      toggle();
      expect(scrolled.filter(([name]) => name === 'Usage & health')).toHaveLength(2);
      const search = other.nativeElement.querySelector('.control-nav-search-input') as HTMLInputElement;
      search.value = 'cost';
      search.dispatchEvent(new Event('input'));
      other.detectChanges();
      scrolled.length = 0;
      search.value = '';
      search.dispatchEvent(new Event('input'));
      other.detectChanges();
      expect(scrolled[0]).toEqual(['Usage & health', nearest]);
    } finally {
      delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
    }
  });

  it('hides the shell navigation on Settings, even with a stored collapsed menu', () => {
    localStorage.setItem('aiorch.control.navCollapsed', 'true');
    TestBed.inject(ActivatedRoute).snapshot.firstChild!.data['controlSurfaceId'] = 'settings';
    const settings = TestBed.createComponent(ControlSurfaceShellComponent); settings.detectChanges();
    expect(settings.nativeElement.querySelector('#control-center-navigation')).toBeNull();
    expect(settings.nativeElement.querySelector('.control-shell.no-nav.nav-collapsed')).toBeTruthy();
    expect(fixture.nativeElement.querySelector('#control-center-navigation')).toBeTruthy();
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

  it('renders title and hub navigation from the registry', () => {
    const text = fixture.nativeElement.textContent as string;

    expect(text).toContain('Control Center');
    expect(text).toContain('Automations');
    expect(text).toContain('Settings');
    expect(text).toContain('Connections');
    expect(fixture.nativeElement.querySelector('h1')?.textContent).toBe('Automations');
    const connections = fixture.nativeElement.querySelector('a[href="/mcp"]') as HTMLAnchorElement;
    expect(connections.textContent?.trim()).toBe('Connections');
    expect(connections.getAttribute('aria-label')).toBe('Connections');
  });

  it('names a page by its registry label on the tab', () => {
    const route = TestBed.inject(ActivatedRoute);
    route.snapshot.firstChild!.data['controlSurfaceId'] = 'remote-nodes';
    const other = TestBed.createComponent(ControlSurfaceShellComponent); other.detectChanges();
    expect(other.nativeElement.querySelector('nav.hub-tabs a[href="/remote-nodes"]')?.textContent?.trim()).toBe('Other computers');
  });

  it('remembers when the Control Center navigation is collapsed', () => {
    const button = fixture.nativeElement.querySelector('.control-nav-toggle') as HTMLButtonElement;

    button.click();
    fixture.detectChanges();

    expect(localStorage.getItem('aiorch.control.navCollapsed')).toBe('true');
    expect(fixture.nativeElement.querySelector('.control-shell')?.classList.contains('nav-collapsed')).toBe(true);
  });

  describe('navigation search', () => {
    const type = (value: string) => {
      const input = fixture.nativeElement.querySelector('.control-nav-search-input') as HTMLInputElement;
      input.value = value;
      input.dispatchEvent(new Event('input'));
      fixture.detectChanges();
      return input;
    };
    const labels = () => Array.from(fixture.nativeElement.querySelectorAll('.control-nav-item'), (node) => (node as Element).textContent?.trim());

    it('draws every page icon', () => {
      const icons = Array.from(fixture.nativeElement.querySelectorAll('.control-nav-icon')) as SVGElement[];
      expect(icons.length).toBeGreaterThan(0);
      expect(icons.filter(icon => !icon.innerHTML)).toEqual([]);
    });

    it('narrows the column to matching pages and settings, then restores it', () => {
      const all = labels().length;
      type('plan queue');
      expect(labels()[0]).toBe('Plan Queue');
      expect(labels().length).toBeLessThan(all);
      type('');
      expect(labels()).toHaveLength(all);
    });

    it('finds a single setting and links straight to it', () => {
      type('Context-full warning at');
      const link = fixture.nativeElement.querySelector('.control-nav-result') as HTMLAnchorElement;
      expect(link.textContent).toContain('Context-full warning at');
      expect(link.getAttribute('href')).toBe('/settings?setting=contextWarningThreshold');
    });

    it('clears the results and keeps focus in the search box when a result is chosen', () => {
      const input = type('plan queue');
      (fixture.nativeElement.querySelector('.control-nav-result') as HTMLAnchorElement).click();
      fixture.detectChanges();
      expect(input.value).toBe('');
      expect(document.activeElement).toBe(input);
    });

    it('says when nothing matches', () => {
      type('zzzz-no-such-thing');
      expect(fixture.nativeElement.querySelector('.control-nav-empty')?.textContent).toContain('zzzz-no-such-thing');
    });

    it('opens the best match on Enter and clears on Escape', () => {
      const navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
      const input = type('plan queue');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      fixture.detectChanges();
      expect(navigate).toHaveBeenCalledWith(['/plan-queue'], { queryParams: null, fragment: undefined });
      expect(input.value).toBe('');
      type('logs').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      fixture.detectChanges();
      expect(input.value).toBe('');
    });

    it('hides the search box and clears it when the column collapses', () => {
      type('logs');
      (fixture.nativeElement.querySelector('.control-nav-toggle') as HTMLButtonElement).click();
      fixture.detectChanges();
      expect(fixture.nativeElement.querySelector('.control-nav-search-input')).toBeNull();
      expect(labels().length).toBeGreaterThan(10);
    });
  });

  it('restores the persisted Control Center navigation collapsed state', () => {
    localStorage.setItem('aiorch.control.navCollapsed', 'true');

    const restored = TestBed.createComponent(ControlSurfaceShellComponent);
    restored.detectChanges();

    expect(restored.nativeElement.querySelector('.control-shell')?.classList.contains('nav-collapsed')).toBe(true);
  });
});
