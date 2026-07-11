import { ɵresolveComponentResources as resolveComponentResources, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../../../../shared/types/update.types';
import { AppUpdateStore } from '../../core/state/app-update.store';
import { AppUpdateSettingsComponent } from './app-update-settings.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const settingsCardStyles = readFileSync(
  resolve(specDirectory, './ui/settings-card.component.scss'),
  'utf8',
);

await resolveComponentResources((url) => {
  if (url.endsWith('settings-card.component.scss')) return Promise.resolve(settingsCardStyles);
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

describe('AppUpdateSettingsComponent', () => {
  let fixture: ComponentFixture<AppUpdateSettingsComponent>;
  const status = signal<UpdateStatus>({ state: 'idle', enabled: true, currentVersion: '0.1.0' });
  const error = signal<string | null>(null);
  const store = {
    status: status.asReadonly(),
    loading: signal(false).asReadonly(),
    error: error.asReadonly(),
    check: vi.fn(),
    retryDownload: vi.fn(),
    restartAndInstall: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    status.set({ state: 'idle', enabled: true, currentVersion: '0.1.0' });
    error.set(null);
    await TestBed.configureTestingModule({
      imports: [AppUpdateSettingsComponent],
      providers: [{ provide: AppUpdateStore, useValue: store }],
    }).compileComponents();
    fixture = TestBed.createComponent(AppUpdateSettingsComponent);
    fixture.detectChanges();
  });

  it('shows the current version and checks manually', () => {
    expect(fixture.nativeElement.textContent).toContain('Harness 0.1.0');
    const check = button('Check for updates');
    check.click();
    expect(store.check).toHaveBeenCalledOnce();
  });

  it('offers download retry for retryable download failures', () => {
    status.set({
      state: 'error',
      enabled: true,
      currentVersion: '0.1.0',
      availableVersion: '0.2.0',
      error: 'Download interrupted',
      errorContext: 'download',
    });
    fixture.detectChanges();

    button('Retry download').click();
    expect(store.retryDownload).toHaveBeenCalledOnce();
    expect(fixture.nativeElement.textContent).toContain('Download interrupted');
  });

  it('offers restart when an update is downloaded', () => {
    status.set({
      state: 'downloaded',
      enabled: true,
      currentVersion: '0.1.0',
      availableVersion: '0.2.0',
      percent: 100,
    });
    fixture.detectChanges();

    button('Restart to update').click();
    expect(store.restartAndInstall).toHaveBeenCalledOnce();
  });

  it('explains when updates are unavailable outside a packaged application', () => {
    status.set({ state: 'idle', enabled: false, currentVersion: '0.1.0' });
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('packaged Harness app');
    expect(fixture.nativeElement.querySelector('button')).toBeNull();
  });

  it('shows checking and download progress states', () => {
    status.set({ state: 'checking', enabled: true, currentVersion: '0.1.0' });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Checking for updates');

    status.set({
      state: 'downloading',
      enabled: true,
      currentVersion: '0.1.0',
      availableVersion: '0.2.0',
      percent: 47,
    });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Downloading 0.2.0 · 47%');
  });

  function button(label: string): HTMLButtonElement {
    const match = [...fixture.nativeElement.querySelectorAll('button')]
      .find((candidate: HTMLButtonElement) => candidate.textContent?.includes(label));
    if (!match) throw new Error(`Missing button: ${label}`);
    return match as HTMLButtonElement;
  }
});
