import {
  CUSTOM_ELEMENTS_SCHEMA,
  signal,
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BehaviorSubject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { SettingsStore } from '../../core/state/settings.store';
import { AppIpcService } from '../../core/services/ipc/app-ipc.service';
import { CliUpdatePillStore } from '../../core/state/cli-update-pill.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { ProviderQuotaStore } from '../../core/state/provider-quota.store';
import { SettingsComponent } from './settings.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './settings.component.html'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('settings.component.html')) {
    return Promise.resolve(template);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('Settings overlay focus', () => {
  it('manages focus for Help and compact navigation overlays', async () => {
    TestBed.overrideComponent(SettingsComponent, {
      set: {
        imports: [],
        template,
        templateUrl: undefined,
        styles: [],
        styleUrl: undefined,
        styleUrls: [],
        schemas: [CUSTOM_ELEMENTS_SCHEMA],
      },
    });
    TestBed.configureTestingModule({
      imports: [SettingsComponent],
      providers: [
        { provide: SettingsStore, useValue: {
          loading: signal(false), error: signal(null), clearError: vi.fn(),
        } },
        { provide: ActivatedRoute, useValue: {
          fragment: new BehaviorSubject<string | null>(null),
          queryParamMap: new BehaviorSubject(convertToParamMap({})),
          snapshot: { fragment: null, queryParamMap: convertToParamMap({}) },
        } },
        { provide: Router, useValue: { navigate: vi.fn() } },
        { provide: AppIpcService, useValue: {
          getStartupCapabilities: vi.fn().mockResolvedValue(null),
          onStartupCapabilities: vi.fn(() => () => undefined),
        } },
        { provide: CliUpdatePillStore, useValue: { init: vi.fn(), state: signal({ count: 0 }) } },
        { provide: RemoteNodeStore, useValue: {
          initialize: vi.fn(), nodes: signal([]),
        } },
        { provide: ProviderQuotaStore, useValue: {
          initialize: vi.fn(), mostConstrainedWindow: signal(null),
        } },
      ],
    });

    const fixture = TestBed.createComponent(SettingsComponent);
    fixture.componentInstance.helpDrawerMode.set(true);
    fixture.detectChanges();
    const opener = (fixture.nativeElement as HTMLElement).querySelector('.help-drawer-trigger') as HTMLButtonElement;
    opener.focus();
    opener.click();
    fixture.detectChanges();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const dialog = (fixture.nativeElement as HTMLElement).querySelector('#settings-help-drawer') as HTMLElement;
    expect(dialog.contains(document.activeElement)).toBe(true);

    const last = document.createElement('button');
    last.textContent = 'Last control';
    dialog.append(last);
    last.focus();
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(dialog.querySelector('button'));

    (document.activeElement as HTMLElement).dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
    );
    fixture.detectChanges();
    expect(document.activeElement).toBe(opener);

    fixture.componentInstance.compactViewport.set(true);
    fixture.detectChanges();
    const navToggle = (fixture.nativeElement as HTMLElement).querySelector('.settings-nav-toggle') as HTMLButtonElement;
    navToggle.focus();
    navToggle.click();
    fixture.detectChanges();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const nav = (fixture.nativeElement as HTMLElement).querySelector('.settings-sidebar') as HTMLElement;
    expect(nav.contains(document.activeElement)).toBe(true);
    const navLast = document.createElement('button');
    nav.append(navLast);
    navLast.focus();
    const tab = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    navLast.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(navToggle);

    fixture.componentInstance.helpDrawerMode.set(true);
    fixture.componentInstance.helpDrawerOpen.set(true);
    fixture.detectChanges();
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const nestedHelp = (fixture.nativeElement as HTMLElement).querySelector('#settings-help-drawer') as HTMLElement;
    const nestedLast = document.createElement('button');
    nestedHelp.append(nestedLast);
    nestedLast.focus();
    nestedLast.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(nestedHelp.contains(document.activeElement)).toBe(true);
    fixture.componentInstance.closeHelpDrawer();
    fixture.detectChanges();

    navToggle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.compactNavOpen()).toBe(false);
    expect(document.activeElement).toBe(navToggle);
  });
});
