import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SettingsStore } from '../../core/state/settings.store';
import { InstanceQueries } from '../../core/state/instance/instance.queries';
import { IpcFacadeService } from '../../core/services/ipc';
import { ToastService } from '../../core/services/toast.service';
import { CrossSessionMessagingSettingsTabComponent } from './cross-session-messaging-settings-tab.component';

const template = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), './cross-session-messaging-settings-tab.component.html'), 'utf8');
await resolveComponentResources(() => Promise.resolve(''));

describe('Cross-session messaging Settings explanation', () => {
  afterEach(() => TestBed.resetTestingModule());

  it.each([false, true])('explains reading and the off-state exceptions with the switch set to %s', async (enabled) => {
    const settings = signal({ enabled, allowCrossProject: false, maxHops: 3, rateLimitPerMinute: 5 });
    await TestBed.configureTestingModule({
      imports: [CrossSessionMessagingSettingsTabComponent],
      providers: [
        { provide: SettingsStore, useValue: { get: () => settings() } },
        { provide: InstanceQueries, useValue: { instances: signal([]) } },
        { provide: IpcFacadeService, useValue: {} },
        { provide: ToastService, useValue: { show: vi.fn() } },
      ],
    }).overrideComponent(CrossSessionMessagingSettingsTabComponent, {
      set: { templateUrl: undefined, template, styleUrl: undefined, styles: [] },
    }).compileComponents();
    const fixture = TestBed.createComponent(CrossSessionMessagingSettingsTabComponent);
    fixture.detectChanges();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.card-description')?.textContent)
      .toContain("The same switch lets agents read other sessions' conversations.");
    expect(element.querySelector('.setting-hint')?.textContent)
      .toContain('Off by default. When off, no session can send or receive relayed messages');
    expect(element.querySelector('.setting-hint')?.textContent)
      .toContain('an agent can read only its own earlier conversation or a session you point at with @session.');
    expect(element.querySelector<HTMLInputElement>('.toggle-input')?.checked).toBe(enabled);
  });
});
