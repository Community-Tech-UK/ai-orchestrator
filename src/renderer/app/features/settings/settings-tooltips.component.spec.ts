import { CUSTOM_ELEMENTS_SCHEMA, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { of } from 'rxjs';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsComponent } from './settings.component';
import { SettingsStore } from '../../core/state/settings.store';
import { AppIpcService } from '../../core/services/ipc/app-ipc.service';
import { CliUpdatePillStore } from '../../core/state/cli-update-pill.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { ProviderQuotaStore } from '../../core/state/provider-quota.store';
import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';

const template = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), './settings.component.html'), 'utf8');
await resolveComponentResources(() => Promise.resolve(''));

describe('Settings navigation tooltip DOM', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.overrideComponent(SettingsComponent, { set: {
      imports: [AioTooltipDirective], template, templateUrl: undefined,
      styles: [], styleUrl: undefined, styleUrls: [], schemas: [CUSTOM_ELEMENTS_SCHEMA],
    } });
    TestBed.configureTestingModule({ providers: [
      { provide: Router, useValue: { navigate: vi.fn() } },
      { provide: ActivatedRoute, useValue: { fragment: of(null), queryParamMap: of(convertToParamMap({})),
        snapshot: { fragment: null, queryParamMap: convertToParamMap({}) } } },
      { provide: SettingsStore, useValue: { loading: signal(false), error: signal(null) } },
      { provide: AppIpcService, useValue: { getStartupCapabilities: async () => null, onStartupCapabilities: () => () => undefined } },
      { provide: CliUpdatePillStore, useValue: { init: vi.fn(), state: signal({ count: 2 }) } },
      { provide: RemoteNodeStore, useValue: { initialize: vi.fn(), nodes: signal([]) } },
      { provide: ProviderQuotaStore, useValue: { initialize: vi.fn(), mostConstrainedWindow: signal(null) } },
    ] });
  });
  afterEach(() => TestBed.resetTestingModule());

  it('has no native titles and combines name and badge in the collapsed tooltip and spoken name', () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.componentInstance.navCollapsed.set(true);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('[title]')).toHaveLength(0);
    const nav = fixture.debugElement.queryAll(By.css('.nav-item'));
    expect(nav.length).toBeGreaterThan(20);
    for (const item of nav) {
      const label = item.nativeElement.querySelector('.nav-item-label').textContent.trim();
      const status = item.nativeElement.querySelector('.nav-badge, .nav-recommended')?.textContent.trim();
      const expected = label + (status ? ', ' + status : '');
      expect(item.nativeElement.getAttribute('aria-label')).toBe(expected);
      expect(item.injector.get(AioTooltipDirective).appTooltip()).toBe(expected);
      expect(item.injector.get(AioTooltipDirective).appTooltipPosition()).toBe('after');
    }
  });
  it('suppresses expanded menu hints including badged items, and keeps status spoken', () => {
    const fixture = TestBed.createComponent(SettingsComponent); fixture.detectChanges();
    const nav = fixture.debugElement.queryAll(By.css('.nav-item'));
    for (const item of nav) expect(item.injector.get(AioTooltipDirective).appTooltip()).toBeNull();
    expect(nav.some(item => item.nativeElement.getAttribute('aria-label')?.includes(', 2 updates'))).toBe(true);
    expect(nav.some(item => item.nativeElement.getAttribute('aria-label')?.includes(', Recommended'))).toBe(true);
  });
  it('suppresses compact overlay hints while retaining the expanded toggle hint', () => {
    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.componentInstance.compactViewport.set(true); fixture.componentInstance.compactNavOpen.set(true); fixture.detectChanges();
    for (const item of fixture.debugElement.queryAll(By.css('.nav-item'))) {
      expect(item.injector.get(AioTooltipDirective).appTooltip()).toBeNull();
    }
    const toggle = fixture.debugElement.query(By.css('.settings-nav-toggle'));
    expect(toggle.nativeElement.getAttribute('aria-expanded')).toBe('true');
    expect(toggle.injector.get(AioTooltipDirective).appTooltipShowWhenExpanded()).toBe(true);
    const element = toggle.nativeElement as HTMLElement;
    const matches = element.matches.bind(element);
    vi.spyOn(element, 'matches').mockImplementation(selector => selector === ':focus-visible' || matches(selector));
    element.dispatchEvent(new FocusEvent('focus')); fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('Close settings navigation');
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); fixture.detectChanges();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();
  });
});
