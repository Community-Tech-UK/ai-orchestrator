import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../../../../../shared/types/update.types';
import { AppUpdateStore } from '../../../core/state/app-update.store';
import { AppUpdateBannerComponent } from './app-update-banner.component';

describe('AppUpdateBannerComponent', () => {
  let fixture: ComponentFixture<AppUpdateBannerComponent>;
  const status = signal<UpdateStatus | null>({
    state: 'downloaded',
    enabled: true,
    currentVersion: '0.1.0',
    availableVersion: '0.2.0',
    percent: 100,
  });
  const visible = signal(true);
  const store = {
    status: status.asReadonly(),
    visible: visible.asReadonly(),
    loading: signal(false).asReadonly(),
    error: signal<string | null>(null).asReadonly(),
    restartAndInstall: vi.fn(async () => undefined),
    dismissForSession: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    visible.set(true);
    status.set({
      state: 'downloaded',
      enabled: true,
      currentVersion: '0.1.0',
      availableVersion: '0.2.0',
      percent: 100,
    });
    await TestBed.configureTestingModule({
      imports: [AppUpdateBannerComponent],
      providers: [{ provide: AppUpdateStore, useValue: store }],
    }).compileComponents();
    fixture = TestBed.createComponent(AppUpdateBannerComponent);
    fixture.detectChanges();
  });

  it('announces the downloaded version without interrupting active work', () => {
    const banner = fixture.nativeElement.querySelector('[data-testid="app-update-banner"]');

    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.getAttribute('aria-live')).toBe('polite');
    expect(banner?.textContent).toContain('Harness 0.2.0 is ready');
  });

  it('routes Restart to update and Later to the store', () => {
    const buttons = Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    );

    buttons.find((button) => button.textContent?.includes('Restart to update'))?.click();
    buttons.find((button) => button.textContent?.includes('Later'))?.click();

    expect(store.restartAndInstall).toHaveBeenCalledOnce();
    expect(store.dismissForSession).toHaveBeenCalledOnce();
  });

  it('does not render when the current version was dismissed', () => {
    visible.set(false);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="app-update-banner"]')).toBeNull();
  });
});
