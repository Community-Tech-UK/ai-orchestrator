import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLockService } from '../../core/app-lock.service';
import { UsageComponent } from './usage.component';
import { UsageStore, type UsageAccountView, type UsageProviderView } from './usage.store';

await resolveComponentResources(url => Promise.resolve(url.endsWith('usage.component.html')
  ? readFileSync(resolve('src/app/features/usage/usage.component.html'), 'utf8') : ''));

describe('Usage strip and sheet', () => {
  beforeEach(() => {
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true,
      value: function (this: HTMLDialogElement) { this.open = true; } });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true,
      value: function (this: HTMLDialogElement) { this.open = false; } });
  });
  afterEach(() => {
    TestBed.resetTestingModule();
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal');
    Reflect.deleteProperty(HTMLDialogElement.prototype, 'close');
  });
  function render(providers: UsageProviderView[], status = 'loaded', online = true) {
    TestBed.configureTestingModule({ imports: [UsageComponent], providers: [
      { provide: UsageStore, useValue: { providers: signal(providers), hostName: signal('Studio'), online: signal(online), status: signal(status), refresh: vi.fn() } },
      { provide: AppLockService, useValue: { locked: signal(false) } },
    ] });
    const fixture = TestBed.createComponent(UsageComponent); fixture.detectChanges();
    return { fixture, root: fixture.nativeElement as HTMLElement };
  }

  function account(overrides: Partial<UsageAccountView> = {}): UsageAccountView {
    return { id: 'legacy', label: null, freshness: 'fresh', updatedAt: Date.now(), validUntil: Date.now() + 300_000,
      exhausted: false, windows: [], headlinePercent: null, ...overrides };
  }

  function provider(name: string, accounts: UsageAccountView[]): UsageProviderView {
    const first = accounts[0]!;
    return { provider: name, freshness: first.freshness, updatedAt: first.updatedAt, validUntil: first.validUntil,
      exhausted: false, windows: first.windows, accounts };
  }

  it('shows each provider and account at a glance, then opens a real Usage dialog and closes it', async () => {
    const { fixture, root } = render([
      provider('codex', [account({ headlinePercent: 100, exhausted: true, windows: [
        { id: '5h', label: '5 hours', percentUsed: 100, exhausted: true, resetsAt: Date.now() + 3600_000 },
        { id: 'weekly', label: 'Weekly', percentUsed: 30, exhausted: false, resetsAt: null },
      ] })]),
      provider('claude', [
        account({ label: 'Max A', plan: 'max', headlinePercent: 42, windows: [
          { id: 'claude.weekly', label: 'Weekly', percentUsed: 42, exhausted: false, resetsAt: null },
        ] }),
        account({ id: 'b', label: 'Max B', needsReauth: true, freshness: 'unavailable' }),
        account({ id: 'c', label: 'Old (disabled)', disabled: true, headlinePercent: 95 }),
      ]),
      provider('gemini', [account({ freshness: 'stale', updatedAt: 1, validUntil: 2, windows: [
        { id: 'unknown', label: 'Requests', percentUsed: null, exhausted: false, resetsAt: null },
      ] })]),
    ]);
    const opener = root.querySelector<HTMLButtonElement>('button.usage-strip')!;
    expect(opener.textContent).toContain('Codex');
    expect(opener.textContent).toContain('100%');
    expect(opener.textContent).toContain('Claude');
    expect(opener.textContent).toContain('42%');
    expect(opener.textContent).toContain('sign in');
    expect(opener.textContent).not.toContain('95%');
    expect(opener.textContent).not.toContain('Gemini');
    expect(opener.querySelector('[data-band="critical"]')?.textContent).toBe('100%');
    expect(opener.textContent).not.toContain('Last known');
    expect(opener.getAttribute('aria-label')).toBe('Usage: Codex 100%, Claude 42% and sign in. Show details');

    opener.click(); fixture.detectChanges(); await fixture.whenStable();
    expect(root.querySelector('dialog[aria-label="Usage"]')).not.toBeNull();
    expect(root.textContent).toContain('Studio');
    expect(root.textContent).toContain('30%');
    expect(root.textContent).toContain('Max A');
    expect(root.textContent).toContain('Max plan');
    expect(root.textContent).toContain('Signed out. Sign in again on your Mac');
    expect(root.textContent).toContain('Turned off. New sessions do not use this account.');
    expect(root.textContent).toContain('Reset time unknown'); expect(root.textContent).toContain('Stale');
    expect(root.textContent).toContain('Usage unknown');
    root.querySelector<HTMLButtonElement>('[aria-label="Close Usage"]')!.click(); fixture.detectChanges();
    expect(root.querySelector('dialog')).toBeNull();
  });

  it('says in words when a value is last known rather than current', () => {
    const { root } = render([provider('codex', [account({ headlinePercent: 20, freshness: 'stale' })])]);
    const opener = root.querySelector<HTMLButtonElement>('button.usage-strip')!;
    expect(opener.textContent).toContain('Last known');
    expect(opener.getAttribute('aria-label')).toBe('Usage, last known: Codex 20%. Show details');
  });

  it.each([
    ['offline', 'loaded', false, 'Usage offline'],
    ['loading', 'loading', true, 'Checking usage…'],
    ['failed', 'error', true, 'Usage unavailable'],
    ['empty', 'loaded', true, 'No usage measured yet'],
  ] as const)('says plainly when there is nothing to show (%s)', (_label, status, online, text) => {
    const { root } = render([], status, online);
    expect(root.querySelector('button.usage-strip')?.textContent).toContain(text);
  });
});
