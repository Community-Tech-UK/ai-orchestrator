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
        { provide: SettingsStore, useValue: { get: () => '', settings: signal({}), metadata: [] } },
        { provide: ElectronIpcService, useValue: { getApi } },
        { provide: ActivatedRoute, useValue: { queryParamMap: of({ get: () => null }) } },
        { provide: Router, useValue: { navigate: vi.fn() } },
      ],
    }).compileComponents();
  });

  it('mounts both housekeeping cards in Doctor', () => {
    const fixture = TestBed.createComponent(DoctorSettingsTabComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-storage-usage-card')).not.toBeNull();
    expect(fixture.nativeElement.querySelector('app-leftover-worktrees-card')).not.toBeNull();
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

describe('DoctorSettingsTabComponent startup section', () => {
  const navigate = vi.fn();
  const check = (id: string, status: 'ready' | 'degraded' | 'unavailable' | 'disabled', summary: string) => ({
    id,
    label: id,
    category: id.startsWith('provider.') ? 'provider' : 'native',
    status,
    critical: false,
    summary,
  });
  const report = signal({
    sections: [{ id: 'startup-capabilities', label: 'Startup', severity: 'ok', headline: 'Startup checks ready' }],
    startupCapabilities: {
      status: 'degraded',
      generatedAt: 1,
      checks: [
        check('provider.cursor', 'disabled', "Cursor isn't installed. You only need it to use Cursor."),
        check('provider.codex', 'degraded', "Codex isn't signed in."),
        check('provider.claude', 'ready', 'Claude is ready.'),
        check('native.sqlite', 'unavailable', "Harness couldn't open its local database."),
      ],
    },
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    TestBed.resetTestingModule();
    await TestBed.configureTestingModule({
      imports: [DoctorSettingsTabComponent],
      providers: [
        {
          provide: DoctorStore,
          useValue: {
            load: vi.fn(async () => undefined),
            report: report.asReadonly(),
            loading: signal(false).asReadonly(),
            error: signal(null).asReadonly(),
            activeSection: signal('startup-capabilities').asReadonly(),
            setActiveSection: vi.fn(),
          },
        },
        { provide: SettingsStore, useValue: { get: () => '', settings: signal({}), metadata: [] } },
        { provide: ElectronIpcService, useValue: { getApi: vi.fn(() => ({})) } },
        { provide: ActivatedRoute, useValue: { queryParamMap: of({ get: () => null }) } },
        { provide: Router, useValue: { navigate } },
      ],
    }).compileComponents();
  });

  function render() {
    const fixture = TestBed.createComponent(DoctorSettingsTabComponent);
    fixture.detectChanges();
    return fixture;
  }

  function rowFor(fixture: ReturnType<typeof render>, id: string): HTMLElement {
    const rows = [...fixture.nativeElement.querySelectorAll('.diagnostic-row')] as HTMLElement[];
    const row = rows.find((candidate) => candidate.querySelector('strong')?.textContent?.trim() === id);
    if (!row) throw new Error(`No row for ${id}`);
    return row;
  }

  it('only offers "to fix" on a provider check that actually needs attention', () => {
    const fixture = render();

    expect(rowFor(fixture, 'provider.codex').textContent).toContain('Open Provider Health to fix');
    // A tool nobody set up is switched off, not broken: nothing to fix.
    expect(rowFor(fixture, 'provider.cursor').textContent).not.toContain('Open Provider Health to fix');
    expect(rowFor(fixture, 'provider.claude').textContent).not.toContain('Open Provider Health to fix');
    // The "to fix" link is for provider checks; the database check has no provider page.
    expect(rowFor(fixture, 'native.sqlite').textContent).not.toContain('Open Provider Health to fix');
  });

  it('keeps the Setup page reachable now that the title-bar chip hides when everything is ready', () => {
    const fixture = render();
    const open = [...fixture.nativeElement.querySelectorAll('button')]
      .find((button: HTMLButtonElement) => button.textContent?.trim() === 'Open Setup') as HTMLButtonElement | undefined;

    expect(open).toBeDefined();
    open?.click();

    expect(navigate).toHaveBeenCalledExactlyOnceWith(['/setup']);
  });
});
