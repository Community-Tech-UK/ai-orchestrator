import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'fs';
import { StorageUsageCardComponent } from './storage-usage-card.component';
import { StorageUsageStore } from '../../core/state/storage-usage.store';
import type { StorageCleanupPreview, StorageUsage } from '../../../../shared/types/storage.types';
await resolveComponentResources(url => Promise.resolve(url.endsWith('.html') ? readFileSync('src/renderer/app/features/settings/storage-usage-card.component.html', 'utf8') : ''));
const preview: StorageCleanupPreview = { previewId: 'fixture', target: 'event-record', items: [], bytes: 1024 ** 3, estimatedCount: 4_900_000, oldestAt: 1, newestAt: 2, consequence: 'This cannot be undone. The conversation file stays the same size until you also choose Shrink the file.', reversible: false };
describe('disk usage card', () => {
  const store = { usage: signal<StorageUsage | null>(null), preview: signal<StorageCleanupPreview | null>(null), busy: signal(false), loading: signal(false), error: signal<string | null>(null), refresh: vi.fn(), review: vi.fn(), run: vi.fn(), cancel: vi.fn(() => store.preview.set(null)), stopPolling: vi.fn() };
  beforeEach(async () => {
    vi.clearAllMocks(); store.preview.set(null); store.usage.set(null); store.busy.set(false);
    await TestBed.configureTestingModule({ imports: [StorageUsageCardComponent], providers: [{ provide: StorageUsageStore, useValue: store }] }).compileComponents();
  });
  function render() { const fixture = TestBed.createComponent(StorageUsageCardComponent); fixture.detectChanges(); return fixture; }
  it('Cancel and Escape run nothing and destructive button does not receive focus', () => {
    store.preview.set(preview);
    const fixture = render();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.textContent).toContain('1.00 GiB');
    expect(element.textContent).toContain('cannot be undone');
    expect(document.activeElement).not.toBe(element.querySelector('[data-confirm]'));
    (element.querySelector('[data-cancel]') as HTMLButtonElement).click();
    expect(store.run).not.toHaveBeenCalled();
    store.preview.set(preview); fixture.detectChanges();
    element.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(store.run).not.toHaveBeenCalled();
    expect(store.cancel).toHaveBeenCalledTimes(2);
    expect(element.querySelector('[title]')).toBeNull();
  });
  it('shows a plain top line only above ten GiB, with the second step and no actions for kept stores', () => {
    store.usage.set({ measuredAt: 1, rows: [{ id: 'history', label: 'Conversation history (kept)', bytes: 100, reclaimableBytes: 0, note: 'Harness keeps this.' }], reclaimableBytes: 11 * 1024 ** 3, progress: null });
    const fixture = render();
    const element = fixture.nativeElement as HTMLElement;
    expect(element.querySelector('.reclaim-summary')?.textContent).toContain('two steps');
    expect(element.querySelector('.usage-row button')).toBeNull();
    store.usage.update(value => ({ ...value!, reclaimableBytes: 10 * 1024 ** 3 })); fixture.detectChanges();
    expect(element.querySelector('.reclaim-summary')).toBeNull();
  });
  it.each(['rlm-backups', 'session-records', 'activity-logs', 'event-record-shrink'] as const)('shows the preview consequence and size for %s', target => {
    store.preview.set({ ...preview, target, consequence: `fixture ${target} consequence` });
    const element = render().nativeElement as HTMLElement;
    expect(element.textContent).toContain(`fixture ${target} consequence`);
    expect(element.textContent).toContain('1.00 GiB');
  });
});
