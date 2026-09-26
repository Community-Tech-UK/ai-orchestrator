import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppLockService } from '../../core/app-lock.service';
import type { MobileQuotaProviderDto } from '../../core/models';
import { UsageComponent } from './usage.component';
import { UsageStore } from './usage.store';

await resolveComponentResources(url => Promise.resolve(url.endsWith('usage.component.html')
  ? readFileSync(resolve('src/app/features/usage/usage.component.html'), 'utf8') : ''));

describe('Usage row and sheet', () => {
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
  it('opens a real Usage dialog with percentages, resets and unknown/stale labels, then closes', async () => {
    const providers = signal<MobileQuotaProviderDto[]>([
      { provider: 'codex', freshness: 'fresh', updatedAt: Date.now(), validUntil: Date.now() + 300_000, exhausted: true, windows: [
        { id: '5h', label: '5 hours', percentUsed: 100, exhausted: true, resetsAt: Date.now() + 3600_000 },
        { id: 'weekly', label: 'Weekly', percentUsed: 30, exhausted: false, resetsAt: null },
      ] },
      { provider: 'claude', freshness: 'stale', updatedAt: 1, validUntil: 2, exhausted: false, windows: [
        { id: 'unknown', label: 'Requests', percentUsed: null, exhausted: false, resetsAt: null },
      ] },
    ]);
    TestBed.configureTestingModule({ imports: [UsageComponent], providers: [
      { provide: UsageStore, useValue: { providers, hostName: signal('Studio'), online: signal(true), status: signal('loaded'), refresh: vi.fn() } },
      { provide: AppLockService, useValue: { locked: signal(false) } },
    ] });
    const fixture = TestBed.createComponent(UsageComponent); fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const opener = root.querySelector<HTMLButtonElement>('button');
    expect(opener?.textContent).toContain('Usage');
    expect(opener?.textContent).toContain('1 limit reached');
    opener!.click(); fixture.detectChanges(); await fixture.whenStable();
    expect(root.querySelector('dialog[aria-label="Usage"]')).not.toBeNull();
    expect(root.textContent).toContain('Studio');
    expect(root.textContent).toContain('100%'); expect(root.textContent).toContain('30%');
    expect(root.textContent).toContain('Reset time unknown'); expect(root.textContent).toContain('Stale');
    expect(root.textContent).toContain('Usage unknown');
    root.querySelector<HTMLButtonElement>('[aria-label="Close Usage"]')!.click(); fixture.detectChanges();
    expect(root.querySelector('dialog')).toBeNull();
  });
});
