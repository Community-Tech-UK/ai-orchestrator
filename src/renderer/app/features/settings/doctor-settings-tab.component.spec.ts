/**
 * Unit tests for DoctorSettingsTabComponent's provider sign-in action.
 *
 * Context: a Claude CLI that was signed out at launch showed "Unable to read
 * Claude CLI auth status" with no in-app way to fix it. The tab now offers a
 * one-click sign-in that opens a terminal running the provider's login
 * command, and tells the user to press Refresh once it completes.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActivatedRoute, Router } from '@angular/router';
import { of } from 'rxjs';
import { DoctorSettingsTabComponent } from './doctor-settings-tab.component';
import { DoctorStore } from '../../core/state/doctor.store';
import { SettingsStore } from '../../core/state/settings.store';
import { ElectronIpcService } from '../../core/services/ipc/electron-ipc.service';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const styles = readFileSync(
  resolve(specDirectory, './doctor-settings-tab.component.scss'),
  'utf8',
);

await resolveComponentResources((url) => {
  if (url.endsWith('doctor-settings-tab.component.scss')) {
    return Promise.resolve(styles);
  }
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('DoctorSettingsTabComponent sign-in', () => {
  const load = vi.fn(async () => { /* noop */ });
  const runProviderLogin = vi.fn();
  const getApi = vi.fn(() => ({ runProviderLogin }));

  const store = {
    load,
    report: signal(null).asReadonly(),
    loading: signal(false).asReadonly(),
    error: signal(null).asReadonly(),
    activeSection: signal('provider-health').asReadonly(),
    setActiveSection: vi.fn(),
  };

  function createComponent(): DoctorSettingsTabComponent {
    return TestBed.createComponent(DoctorSettingsTabComponent).componentInstance;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    getApi.mockReturnValue({ runProviderLogin });

    await TestBed.configureTestingModule({
      imports: [DoctorSettingsTabComponent],
      providers: [
        { provide: DoctorStore, useValue: store },
        { provide: SettingsStore, useValue: { get: () => '' } },
        { provide: ElectronIpcService, useValue: { getApi } },
        { provide: ActivatedRoute, useValue: { queryParamMap: of({ get: () => null }) } },
        { provide: Router, useValue: { navigate: vi.fn() } },
      ],
    }).compileComponents();
  });

  it('only offers one-click sign-in for auth repair actions', () => {
    const component = createComponent();

    expect(component.isAuthRepair('auth_missing')).toBe(true);
    expect(component.isAuthRepair('auth_expired')).toBe(true);
    expect(component.isAuthRepair('cli_not_found')).toBe(false);
    expect(component.isAuthRepair('cli_shadow_install')).toBe(false);
  });

  it('hides sign-in for plugin providers, which own their own auth flow', () => {
    const component = createComponent();

    expect(component.canSignIn('claude', 'auth_missing')).toBe(true);
    expect(component.canSignIn('plugin:acme', 'auth_missing')).toBe(false);
    expect(component.canSignIn('claude', 'cli_not_found')).toBe(false);
  });

  it('launches the sign-in terminal and tells the user to press Refresh', async () => {
    runProviderLogin.mockResolvedValue({
      success: true,
      data: { provider: 'claude', command: 'claude auth login', terminal: 'Terminal' },
    });
    const component = createComponent();

    await component.signIn('claude');

    expect(runProviderLogin).toHaveBeenCalledWith('claude');
    expect(component.loginNotice()).toContain('claude auth login');
    expect(component.loginNotice()).toContain('Refresh');
    expect(component.loginError()).toBeNull();
    expect(component.signingInProvider()).toBeNull();
  });

  it('includes the provider hint when the CLI has no login subcommand', async () => {
    runProviderLogin.mockResolvedValue({
      success: true,
      data: {
        provider: 'antigravity',
        command: 'agy',
        terminal: 'Terminal',
        hint: 'Antigravity has no login subcommand.',
      },
    });
    const component = createComponent();

    await component.signIn('antigravity');

    expect(component.loginNotice()).toContain('Antigravity has no login subcommand.');
  });

  it('surfaces a launch failure instead of claiming a terminal opened', async () => {
    runProviderLogin.mockResolvedValue({
      success: false,
      error: { message: 'No supported terminal emulator was found.' },
    });
    const component = createComponent();

    await component.signIn('claude');

    expect(component.loginError()).toBe('No supported terminal emulator was found.');
    expect(component.loginNotice()).toBeNull();
    expect(component.signingInProvider()).toBeNull();
  });

  it('reports an unavailable launcher rather than throwing', async () => {
    getApi.mockReturnValue({} as { runProviderLogin: typeof runProviderLogin });
    const component = createComponent();

    await component.signIn('claude');

    expect(component.loginError()).toBe('Sign-in launcher is unavailable.');
    expect(runProviderLogin).not.toHaveBeenCalled();
  });
});
