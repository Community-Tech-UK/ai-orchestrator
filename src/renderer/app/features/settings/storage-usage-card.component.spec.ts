import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'fs';
import { basename } from 'path';
import { StorageUsageCardComponent } from './storage-usage-card.component';
import { StorageUsageStore } from '../../core/state/storage-usage.store';
import { SettingsStore } from '../../core/state/settings.store';
import type { StorageCleanupPreview, StorageUsage } from '../../../../shared/types/storage.types';
await resolveComponentResources(url => Promise.resolve(url.endsWith('.html') ? readFileSync(`src/renderer/app/features/settings/${basename(url)}`, 'utf8') : ''));
const preview: StorageCleanupPreview = { previewId: 'fixture', target: 'event-record', items: [], bytes: 1024 ** 3, estimatedCount: 4_900_000, oldestAt: 1, newestAt: 2, consequence: 'This cannot be undone. The conversation file stays the same size until you also choose Shrink the file.', reversible: false };
describe('disk usage card', () => {
  const store = { usage: signal<StorageUsage | null>(null), preview: signal<StorageCleanupPreview | null>(null), busy: signal(false), loading: signal(false), error: signal<string | null>(null), refresh: vi.fn(), review: vi.fn(), run: vi.fn(), cancel: vi.fn(() => store.preview.set(null)), stopPolling: vi.fn() };
  const settings = { settings: signal({ codexBackupKeepThree: false }), set: vi.fn(), error: signal<string | null>(null) };
  beforeEach(async () => {
    vi.clearAllMocks(); store.preview.set(null); store.usage.set(null); store.busy.set(false);
    await TestBed.configureTestingModule({ imports: [StorageUsageCardComponent], providers: [{ provide: StorageUsageStore, useValue: store }, { provide: SettingsStore, useValue: settings }] }).compileComponents();
  });
  function render() { const fixture = TestBed.createComponent(StorageUsageCardComponent); fixture.detectChanges(); return fixture; }
  it('shows the opt-in Codex backup control and saves its checked value', () => {
    const element = render().nativeElement as HTMLElement;
    const checkbox = element.querySelector('[data-codex-retention]') as HTMLInputElement;
    expect(element.textContent).toContain('Keep only the newest 3 Codex backups');
    expect(checkbox.checked).toBe(false);
    checkbox.checked = true; checkbox.dispatchEvent(new Event('change'));
    expect(settings.set).toHaveBeenCalledWith('codexBackupKeepThree', true);
  });
  it('tells the user in plain words when the backup setting could not be saved, without the raw error', () => {
    settings.error.set('EACCES: raw detail');
    const text = (render().nativeElement as HTMLElement).textContent!;
    settings.error.set(null);
    expect(text).toContain('Harness could not save that setting. Try again.');
    expect(text).not.toContain('EACCES');
  });
  it('shows total size, measured weekly change and a confirmed shrink offer with its size', () => {
    store.usage.set({ measuredAt: 1, totalBytes: 8 * 1024 ** 3, weeklyGrowthBytes: 1024 ** 3, rows: [{ id: 'event-record', label: 'Debug record', bytes: 10, reclaimableBytes: 0, diskReclaimableBytes: 4 * 1024 ** 3, target: 'event-record', shrinkAvailable: true, note: 'Fixture' }], reclaimableBytes: 0, progress: null });
    const element = render().nativeElement as HTMLElement;
    expect(element.textContent).toContain('Total: 8.00 GiB');
    expect(element.textContent).toContain('+1.00 GiB');
    const shrink = [...element.querySelectorAll('button')].find(button => button.textContent?.includes('Shrink now'))!;
    expect(shrink.textContent).toContain('4.00 GiB');
    shrink.click();
    expect(store.review).toHaveBeenCalledExactlyOnceWith('event-record-shrink');
    expect(store.run).not.toHaveBeenCalled();
  });
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
    const parentKeydown = vi.fn();
    element.addEventListener('keydown', parentKeydown);
    element.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(store.run).not.toHaveBeenCalled();
    expect(store.cancel).toHaveBeenCalledTimes(2);
    expect(parentKeydown).not.toHaveBeenCalled();
    expect(element.querySelector('[title]')).toBeNull();
  });
  it('does not mount its own leftover work folder card (Doctor mounts the single one)', () => {
    expect((render().nativeElement as HTMLElement).querySelector('app-leftover-worktrees-card')).toBeNull();
  });
  it.each([
    ['event-record', 1, '1 entry'], ['event-record', 0, '0 entries'], ['event-record', 2, '2 entries'],
    ['rlm-backups', 1, '1 item'], ['rlm-backups', 0, '0 items'], ['rlm-backups', 2, '2 items'],
    ['session-records', 1, '1 file'], ['activity-logs', 2, '2 files'],
  ] as const)('formats %s preview count %s', (target, estimatedCount, text) => {
    store.preview.set({ ...preview, target, estimatedCount });
    const element = render().nativeElement as HTMLElement;
    expect(element.querySelector('[role="dialog"]')?.textContent).toContain(`About ${text} ·`);
  });
  it.each([
    ['event-record', 1, '1 entry'], ['event-record', 2, '2 entries'],
    ['session-records', 1, '1 file'], ['session-records', 2, '2 files'],
    ['activity-logs', 1, '1 file'], ['activity-logs', 2, '2 files'],
  ] as const)('formats progress for %s at count %s', (target, estimatedTotal, text) => {
    store.usage.set({ measuredAt: 1, rows: [], reclaimableBytes: 0, progress: { target, removed: estimatedTotal, estimatedTotal, running: true } });
    const element = render().nativeElement as HTMLElement;
    expect(element.querySelector('[role="status"]')?.textContent).toContain(`of about ${text}.`);
  });
  it('keeps the confirmed removed count visible after a partial cleanup error', () => {
    store.usage.set({ measuredAt: 1, rows: [], reclaimableBytes: 0, progress: { target: 'session-records', removed: 1, estimatedTotal: 2, running: false } });
    store.error.set('The list changed. Review again.');
    try {
      const element = render().nativeElement as HTMLElement;
      expect(element.querySelector('[role="alert"]')?.textContent).toContain('The list changed');
      expect(element.querySelector('[role="status"]')?.textContent).toContain('Last clean-up removed 1 file.');
      expect(store.run).not.toHaveBeenCalled();
    } finally { store.error.set(null); }
  });
  it('labels a complete backup copy without claiming its group name is an exact file list', () => {
    store.preview.set({ ...preview, target: 'rlm-backups', estimatedCount: 1, items: [{ name: 'old.db', bytes: 1, createdAt: 1 }] });
    const element = render().nativeElement as HTMLElement;
    expect(element.querySelector('details summary')?.textContent).toContain('Backup copies to remove (1)');
    expect(element.querySelector('details li')?.textContent).toContain('old.db');
    expect(store.run).not.toHaveBeenCalled();
  });
  it('describes a rebuild without claiming to remove entries', () => {
    store.usage.set({ measuredAt: 1, rows: [], reclaimableBytes: 0, progress: { target: 'event-record-shrink', removed: 0, estimatedTotal: 0, running: true } });
    const element = render().nativeElement as HTMLElement;
    expect(element.querySelector('[role="status"]')?.textContent).toContain('Rebuilding the conversation file');
    expect(element.querySelector('[role="status"]')?.textContent).not.toContain('Removed');
  });
  it('allows pointer defaults inside the dialog and suppresses only backdrop focus', () => {
    store.preview.set(preview); const element = render().nativeElement as HTMLElement;
    const textPress = new Event('pointerdown', { bubbles: true, cancelable: true });
    element.querySelector('h3#disk-cleanup-heading')!.dispatchEvent(textPress);
    expect(textPress.defaultPrevented).toBe(false);
    const backdropPress = new Event('pointerdown', { bubbles: true, cancelable: true });
    element.querySelector('.dialog-overlay')!.dispatchEvent(backdropPress);
    expect(backdropPress.defaultPrevented).toBe(true);
    expect(store.preview()).not.toBeNull(); expect(store.run).not.toHaveBeenCalled();
  });
  it('does not dismiss a text drag ending on the backdrop', () => {
    store.preview.set(preview); const fixture = render(); const element = fixture.nativeElement as HTMLElement;
    element.querySelector('h3#disk-cleanup-heading')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    element.querySelector<HTMLElement>('.dialog-overlay')!.dispatchEvent(new Event('pointerup', { bubbles: true }));
    element.querySelector<HTMLElement>('.dialog-overlay')!.click(); fixture.detectChanges();
    expect(store.preview()).not.toBeNull(); expect(store.run).not.toHaveBeenCalled();
    const overlay = element.querySelector<HTMLElement>('.dialog-overlay')!;
    overlay.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true })); overlay.dispatchEvent(new Event('pointerup', { bubbles: true })); overlay.click(); fixture.detectChanges();
    expect(store.preview()).toBeNull();
  });
  it('shows only the size for rebuilding rather than a meaningless item count', () => {
    store.preview.set({ ...preview, target: 'event-record-shrink', estimatedCount: 0 });
    const text = (render().nativeElement as HTMLElement).querySelector('[role="dialog"]')!.textContent;
    expect(text).toContain('Frees about 1.00 GiB'); expect(text).not.toContain('0 items'); expect(text).not.toContain('About');
  });
  it('keeps a drag starting on the backdrop and ending on dialog text open', () => {
    store.preview.set(preview); const element = render().nativeElement as HTMLElement;
    const overlay = element.querySelector<HTMLElement>('.dialog-overlay')!;
    overlay.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    element.querySelector('h3')!.dispatchEvent(new Event('pointerup', { bubbles: true })); overlay.click();
    expect(store.preview()).not.toBeNull(); expect(store.run).not.toHaveBeenCalled();
  });
  it('restores Review after a failed preview request', async () => {
    store.usage.set({ measuredAt: 1, rows: [{ id: 'rlm-backups', label: 'Backups', bytes: 1, reclaimableBytes: 1, target: 'rlm-backups', note: 'Fixture' }], reclaimableBytes: 1, progress: null });
    let release!: () => void;
    store.review.mockImplementationOnce(async () => { store.busy.set(true); await new Promise<void>(resolve => { release = resolve; }); store.error.set('Fixture preview failed'); store.busy.set(false); });
    const fixture = render(); const element = fixture.nativeElement as HTMLElement;
    const opener = element.querySelector<HTMLButtonElement>('.usage-row button')!;
    opener.focus(); opener.click(); fixture.detectChanges(); opener.blur(); release(); await fixture.whenStable(); fixture.detectChanges();
    expect(element.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(opener);
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('Fixture preview failed');
    store.error.set(null);
  });
  it('keeps a later user focus when the initial preview fails', async () => {
    store.usage.set({ measuredAt: 1, rows: [{ id: 'rlm-backups', label: 'Backups', bytes: 1, reclaimableBytes: 1, target: 'rlm-backups', note: 'Fixture' }], reclaimableBytes: 1, progress: null });
    let release!: () => void;
    store.review.mockImplementationOnce(async () => { store.busy.set(true); await new Promise<void>(resolve => { release = resolve; }); store.error.set('Fixture preview failed'); store.busy.set(false); });
    const fixture = render(); const element = fixture.nativeElement as HTMLElement;
    const other = document.createElement('button'); document.body.append(other);
    try {
      element.querySelector<HTMLButtonElement>('.usage-row button')!.click(); fixture.detectChanges(); other.focus();
      release(); await fixture.whenStable(); fixture.detectChanges();
      expect(document.activeElement).toBe(other); expect(element.querySelector('[role="dialog"]')).toBeNull();
    } finally { other.remove(); store.error.set(null); }
  });
  it('deactivates the trap without restoring an old page focus during destruction', () => {
    const fixture = render(); const element = fixture.nativeElement as HTMLElement;
    const opener = element.querySelector<HTMLButtonElement>('button')!;
    opener.focus(); store.preview.set(preview); fixture.detectChanges();
    const focus = vi.spyOn(opener, 'focus'); fixture.destroy();
    expect(focus).not.toHaveBeenCalled();
    expect(store.stopPolling).toHaveBeenCalledOnce(); expect(store.cancel).toHaveBeenCalledOnce();
  });
  it('restores the opener after an asynchronous preview disables and blurs it', async () => {
    store.usage.set({ measuredAt: 1, rows: [{ id: 'rlm-backups', label: 'Learning database backups', bytes: 10, reclaimableBytes: 10, target: 'rlm-backups', note: 'Fixture' }], reclaimableBytes: 10, progress: null });
    let release!: () => void;
    store.review.mockImplementationOnce(async () => {
      store.busy.set(true);
      await new Promise<void>(resolve => { release = resolve; });
      store.preview.set({ ...preview, target: 'rlm-backups' }); store.busy.set(false);
    });
    const fixture = render(); const element = fixture.nativeElement as HTMLElement;
    const opener = element.querySelector<HTMLButtonElement>('.usage-row button')!;
    opener.focus(); opener.click(); fixture.detectChanges();
    expect(opener.disabled).toBe(true);
    // Chrome blurs a focused button when it is disabled; jsdom does not.
    opener.blur(); release(); await fixture.whenStable(); fixture.detectChanges();
    const dialog = element.querySelector<HTMLElement>('[role="dialog"]')!;
    dialog.focus(); expect(document.activeElement).toBe(dialog);
    dialog.querySelector('h3')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges(); await fixture.whenStable();
    expect(document.activeElement).toBe(opener);
    expect(store.run).not.toHaveBeenCalled();
  });
  // Settings closes itself on Escape; a dialog open inside it must take that key for itself.
  it('keeps Escape inside the dialog so Settings stays open', () => {
    store.preview.set(preview);
    const fixture = render();
    const element = fixture.nativeElement as HTMLElement;
    const reachedSettings = vi.fn();
    element.addEventListener('keydown', reachedSettings);
    element.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(store.cancel).toHaveBeenCalledTimes(1);
    expect(reachedSettings).not.toHaveBeenCalled();
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
  it('explains the shrink in plain words, with no developer measurement', () => {
    store.preview.set({
      ...preview,
      target: 'event-record-shrink',
      liveBytes: 3 * 1024 ** 3,
      requiredDiskBytes: 4 * 1024 ** 3,
      availableDiskBytes: 90 * 1024 ** 3,
    });
    const text = (render().nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('This can take a while on a large file, so pick a quiet moment.');
    expect(text).toContain('Data in use: 3.00 GiB.');
    expect(text).toContain('Free disk space needed for a moment: 4.00 GiB.');
    expect(text).toContain('Free now: 90.0 GiB.');
    expect(text).not.toMatch(/scratch trial|249 MB|live data/i);
  });

  it.each(['rlm-backups', 'session-records', 'activity-logs', 'event-record-shrink'] as const)('shows the preview consequence and size for %s', target => {
    store.preview.set({ ...preview, target, consequence: `fixture ${target} consequence` });
    const element = render().nativeElement as HTMLElement;
    expect(element.textContent).toContain(`fixture ${target} consequence`);
    expect(element.textContent).toContain('1.00 GiB');
  });
});
