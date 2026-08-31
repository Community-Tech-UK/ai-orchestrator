import { ɵresolveComponentResources as resolveComponentResources, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionRecoveryCandidate } from '../../../../../shared/types/session-recovery.types';
import { SessionRecoveryStore } from '../../../core/state/session-recovery.store';
import { SessionRecoveryBannerComponent } from './session-recovery-banner.component';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const template = readFileSync(resolve(specDirectory, './session-recovery-banner.component.html'), 'utf8');
const styles = readFileSync(resolve(specDirectory, './session-recovery-banner.component.scss'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('session-recovery-banner.component.html')) {
    return Promise.resolve(template);
  }

  if (url.endsWith('session-recovery-banner.component.scss')) {
    return Promise.resolve(styles);
  }

  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }

  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

function candidate(overrides: Partial<SessionRecoveryCandidate> = {}): SessionRecoveryCandidate {
  return {
    recoveryKey: 'recovery:claude:new',
    sourceInstanceId: 'source-1',
    historyThreadId: 'thread-1',
    provider: 'claude',
    modelId: 'sonnet',
    displayName: 'Autosaved auth fix',
    workingDirectory: '/repo',
    lastActivityAt: 1_700_000_000_000,
    historyCoveredThrough: 1_699_999_990_000,
    recoveredMessageCount: 4,
    reason: 'newer-than-history',
    nativeResumeAvailable: true,
    ...overrides,
  };
}

describe('SessionRecoveryBannerComponent', () => {
  let fixture: ComponentFixture<SessionRecoveryBannerComponent>;
  const candidates = signal<SessionRecoveryCandidate[]>([]);
  const loading = signal(false);
  const error = signal<string | null>(null);
  const store = {
    candidates: candidates.asReadonly(),
    loading: loading.asReadonly(),
    error: error.asReadonly(),
    refresh: vi.fn(),
    recover: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    candidates.set([]);
    loading.set(false);
    error.set(null);
    await TestBed.configureTestingModule({
      imports: [SessionRecoveryBannerComponent],
      providers: [{ provide: SessionRecoveryStore, useValue: store }],
    }).compileComponents();
    fixture = TestBed.createComponent(SessionRecoveryBannerComponent);
    fixture.detectChanges();
  });

  it('loads candidates on init but does not recover automatically', () => {
    expect(store.refresh).toHaveBeenCalledOnce();
    expect(store.recover).not.toHaveBeenCalled();
  });

  it('renders a non-modal polite startup notice when candidates exist', () => {
    candidates.set([candidate()]);
    fixture.detectChanges();

    const banner = fixture.nativeElement.querySelector('[data-testid="session-recovery-banner"]') as HTMLElement | null;
    expect(banner).not.toBeNull();
    expect(banner?.getAttribute('role')).toBe('status');
    expect(banner?.getAttribute('aria-live')).toBe('polite');
    expect(banner?.textContent).toContain('Autosaved auth fix');
    expect(banner?.textContent).toContain('4 autosaved messages');
  });

  it('emits a picker request from the primary action without mutating recovery data', () => {
    const item = candidate();
    candidates.set([item]);
    fixture.detectChanges();
    let requested = 0;
    fixture.componentInstance.openRecoveryRequested.subscribe(() => {
      requested += 1;
    });

    const button = findButton('Review autosave');
    button.click();

    expect(requested).toBe(1);
    expect(store.recover).not.toHaveBeenCalled();
    expect(candidates()).toEqual([item]);
  });

  it('dismisses only the current candidate set for the renderer session', () => {
    const first = candidate();
    candidates.set([first]);
    fixture.detectChanges();

    findButton('Dismiss autosave recovery notice').click();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[data-testid="session-recovery-banner"]')).toBeNull();
    expect(candidates()).toEqual([first]);

    candidates.set([candidate({ recoveryKey: 'recovery:claude:next', sourceInstanceId: 'source-2' })]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('[data-testid="session-recovery-banner"]')).not.toBeNull();
  });

  it('keeps the same candidate set dismissed after destroy and remount in the same renderer session', () => {
    const first = candidate();
    candidates.set([first]);
    fixture.detectChanges();

    findButton('Dismiss autosave recovery notice').click();
    fixture.detectChanges();
    expect(banner()).toBeNull();
    fixture.destroy();

    fixture = TestBed.createComponent(SessionRecoveryBannerComponent);
    fixture.detectChanges();
    expect(banner()).toBeNull();
    expect(candidates()).toEqual([first]);
    expect(store.recover).not.toHaveBeenCalled();

    candidates.set([candidate({ recoveryKey: 'recovery:claude:next', sourceInstanceId: 'source-2' })]);
    fixture.detectChanges();
    expect(banner()).not.toBeNull();
  });

  it('keeps banner controls as native buttons in logical tab order with single keyboard activation', () => {
    candidates.set([candidate()]);
    fixture.detectChanges();
    let requested = 0;
    fixture.componentInstance.openRecoveryRequested.subscribe(() => {
      requested += 1;
    });
    const [review, dismiss] = allButtons();

    expect(allButtons().map(button => button.textContent?.trim())).toEqual(['Review autosave', 'Dismiss']);
    expect(review.type).toBe('button');
    expect(dismiss.type).toBe('button');
    dispatchBrowserKeyboardActivation(review, 'Enter');
    dispatchBrowserKeyboardActivation(review, ' ');

    expect(requested).toBe(2);
    expect(store.recover).not.toHaveBeenCalled();
  });

  it('announces errors and disables the primary action while discovery is loading', () => {
    candidates.set([candidate()]);
    loading.set(true);
    error.set('Session recovery candidates could not be loaded');
    fixture.detectChanges();

    const button = findButton('Review autosave');
    const alert = fixture.nativeElement.querySelector('[role="alert"]') as HTMLElement | null;
    expect(button.disabled).toBe(true);
    expect(alert?.getAttribute('aria-live')).toBe('assertive');
    expect(alert?.textContent).toContain('Session recovery candidates could not be loaded');
  });

  it('does not render when no recovery candidates exist', () => {
    expect(fixture.nativeElement.querySelector('[data-testid="session-recovery-banner"]')).toBeNull();
  });

  function findButton(name: string): HTMLButtonElement {
    const match = allButtons().find((button) =>
      button.textContent?.includes(name) || button.getAttribute('aria-label') === name);
    if (!match) {
      throw new Error(`Button not found: ${name}`);
    }
    return match;
  }

  function banner(): HTMLElement | null {
    return fixture.nativeElement.querySelector('[data-testid="session-recovery-banner"]') as HTMLElement | null;
  }

  function allButtons(): HTMLButtonElement[] {
    return Array.from(
      fixture.nativeElement.querySelectorAll('button') as NodeListOf<HTMLButtonElement>,
    );
  }

  function dispatchBrowserKeyboardActivation(button: HTMLButtonElement, key: 'Enter' | ' '): void {
    button.focus();
    button.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    button.click();
    button.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
  }
});
