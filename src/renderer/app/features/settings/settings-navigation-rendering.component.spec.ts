import { AioTooltipDirective } from '../../shared/tooltip/aio-tooltip.directive';
import { CUSTOM_ELEMENTS_SCHEMA, signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { BehaviorSubject } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { SettingsStore } from '../../core/state/settings.store';
import { AppIpcService } from '../../core/services/ipc/app-ipc.service';
import { CliUpdatePillStore } from '../../core/state/cli-update-pill.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { ProviderQuotaStore } from '../../core/state/provider-quota.store';
import { SettingsSectionTabsComponent } from './ui/settings-section-tabs.component';
import { SettingsComponent } from './settings.component';

const template = readFileSync(resolve(__dirname, 'settings.component.html'), 'utf8');
await resolveComponentResources(() => Promise.resolve(''));

describe('Settings page navigation rendering', () => {
  it('renders twelve pages and changes legacy tabs through the real section strip', () => {
    localStorage.clear();
    TestBed.overrideComponent(SettingsComponent, { set: {
      imports: [SettingsSectionTabsComponent, AioTooltipDirective], template, templateUrl: undefined,
      styles: [], styleUrl: undefined, styleUrls: [], schemas: [CUSTOM_ELEMENTS_SCHEMA],
    } });
    const fragment = new BehaviorSubject<string | null>('cli-health');
    const navigate = vi.fn().mockResolvedValue(true);
    TestBed.configureTestingModule({ providers: [
      { provide: SettingsStore, useValue: { loading: signal(false), error: signal(null) } },
      { provide: ActivatedRoute, useValue: {
        fragment, queryParamMap: new BehaviorSubject(convertToParamMap({})),
        snapshot: { fragment: 'cli-health', queryParamMap: convertToParamMap({}) },
      } },
      { provide: Router, useValue: { navigate } },
      { provide: AppIpcService, useValue: {
        getStartupCapabilities: vi.fn().mockResolvedValue(null), onStartupCapabilities: () => () => undefined,
      } },
      { provide: CliUpdatePillStore, useValue: { init: vi.fn(), state: signal({ count: 2 }) } },
      { provide: RemoteNodeStore, useValue: { initialize: vi.fn(), nodes: signal([]) } },
      { provide: ProviderQuotaStore, useValue: { initialize: vi.fn(), mostConstrainedWindow: signal(null) } },
    ] });
    const fixture = TestBed.createComponent(SettingsComponent); fixture.detectChanges();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll('.settings-nav > button.nav-item')).toHaveLength(12);
    const activeHealth = host.querySelector('.nav-item.active');
    expect(activeHealth?.textContent).toContain('Health');
    expect(activeHealth?.textContent).toContain('2 updates');
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('CLI Health');

    expect([...host.querySelectorAll('.nav-item-label')].map(label => label.textContent?.trim())).toContain('Phone & remote');
    const phonePage = [...host.querySelectorAll<HTMLButtonElement>('.nav-item')]
      .find(button => button.querySelector('.nav-item-label')?.textContent?.trim() === 'Phone & remote');
    expect(phonePage).toBeTruthy();
    expect(phonePage!.getAttribute('aria-label')).toContain('Phone & remote');
    phonePage!.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.activeTab()).toBe('connections');
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(5);
    host.querySelector<HTMLButtonElement>('button[role="tab"][id="mobile"]')!.click();
    fixture.detectChanges();
    expect(fixture.componentInstance.activeTab()).toBe('mobile');
    expect(navigate.mock.lastCall?.[1]).toMatchObject({ fragment: 'mobile' });
    expect(host.querySelector('[data-setting-key="section:mobile.phone"]')).toBeTruthy();

    fixture.componentInstance.searchQuery.set('discord'); fixture.detectChanges();
    expect([...host.querySelectorAll('.nav-item-label')].some(label => label.textContent?.trim() === 'Phone & remote')).toBe(true);
    expect(host.querySelector('.search-jump')?.textContent).toContain('Discord');
    fixture.destroy();
  });
});
