import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComputerUsePermissionBannerComponent } from './computer-use-permission-banner.component';
import { ComputerUsePermissionStore } from './computer-use-permission.store';
import type { DesktopSystemPermission } from '../../../../shared/types/desktop-gateway.types';

function makeStore() {
  const bannerVisible = signal(true);
  const missingPermissions = signal<DesktopSystemPermission[]>(['screen-recording', 'accessibility']);
  const unavailable = signal(false);
  const requesting = signal<DesktopSystemPermission | null>(null);
  const error = signal<string | null>(null);
  const health = signal<{ setupActions: string[] } | null>(null);
  const repairing = signal(false);
  const repairReady = signal(false);
  return {
    bannerVisible,
    missingPermissions,
    unavailable,
    requesting,
    error,
    health,
    repairing,
    repairReady,
    requestPermission: vi.fn(async () => undefined),
    repairPermissions: vi.fn(async () => undefined),
    relaunchApplication: vi.fn(async () => undefined),
    dismissBanner: vi.fn(() => bannerVisible.set(false)),
  };
}

describe('ComputerUsePermissionBannerComponent', () => {
  let store: ReturnType<typeof makeStore>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    store = makeStore();
    TestBed.configureTestingModule({
      imports: [ComputerUsePermissionBannerComponent],
      providers: [{ provide: ComputerUsePermissionStore, useValue: store }],
    });
  });

  function render() {
    const fixture = TestBed.createComponent(ComputerUsePermissionBannerComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('announces politely and names each missing permission with one action apiece', () => {
    const fixture = render();
    const element: HTMLElement = fixture.nativeElement;

    const banner = element.querySelector('.cu-permission-banner');
    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.getAttribute('aria-live')).toBe('polite');
    expect(banner?.textContent).toContain('Screen Recording and Accessibility are not granted');

    const actions = element.querySelectorAll<HTMLButtonElement>('.banner-btn.primary');
    expect(actions).toHaveLength(2);
    expect(actions[0].getAttribute('aria-label')).toBe('Open Screen Recording settings');
    expect(actions[1].getAttribute('aria-label')).toBe('Open Accessibility settings');
  });

  it('requests only the permission James clicked', () => {
    const fixture = render();
    const actions = (fixture.nativeElement as HTMLElement)
      .querySelectorAll<HTMLButtonElement>('.banner-btn.primary');

    actions[1].click();

    expect(store.requestPermission).toHaveBeenCalledExactlyOnceWith('accessibility');
  });

  it('disables actions and shows progress while a request is in flight', () => {
    store.requesting.set('screen-recording');
    const fixture = render();
    const actions = (fixture.nativeElement as HTMLElement)
      .querySelectorAll<HTMLButtonElement>('.banner-btn.primary');

    expect(actions[0].disabled).toBe(true);
    expect(actions[1].disabled).toBe(true);
    expect(actions[0].textContent).toContain('Opening…');
  });

  it('shows the safe error copy from the store', () => {
    store.error.set('Could not open System Settings. Open Privacy & Security manually.');
    const fixture = render();

    expect(fixture.nativeElement.querySelector('.banner-error')?.textContent)
      .toContain('Open Privacy & Security manually');
  });

  it('offers an in-app repair action for stale macOS registrations', () => {
    const fixture = render();
    const repair = (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[aria-label="Repair macOS permissions"]');

    repair?.click();

    expect(store.repairPermissions).toHaveBeenCalledOnce();
  });

  it('offers an in-app relaunch after permission registrations were repaired', () => {
    store.repairReady.set(true);
    const fixture = render();
    const restart = (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[aria-label="Restart AIO"]');

    expect(fixture.nativeElement.textContent).toContain(
      'Registrations reset. Enable both permissions, then restart AIO.',
    );
    restart?.click();
    expect(store.relaunchApplication).toHaveBeenCalledOnce();
  });

  it('uses the error tone and setup actions when the driver is unavailable', () => {
    store.unavailable.set(true);
    store.missingPermissions.set([]);
    store.health.set({ setupActions: ['Reinstall Harness.'] });
    const fixture = render();

    const banner = fixture.nativeElement.querySelector('.cu-permission-banner');
    expect(banner?.classList.contains('error')).toBe(true);
    expect(banner?.textContent).toContain('Computer Use is unavailable');
    expect(banner?.textContent).toContain('Reinstall Harness.');
  });

  it('dismisses through the store and renders nothing once hidden', () => {
    const fixture = render();
    const dismiss = (fixture.nativeElement as HTMLElement)
      .querySelector<HTMLButtonElement>('[aria-label="Dismiss Computer Use permission banner"]');

    dismiss?.click();
    fixture.detectChanges();

    expect(store.dismissBanner).toHaveBeenCalledOnce();
    expect(fixture.nativeElement.querySelector('.cu-permission-banner')).toBeNull();
  });
});
