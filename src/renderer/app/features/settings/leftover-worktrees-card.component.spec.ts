import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { LeftoverWorktreesCardComponent } from './leftover-worktrees-card.component';
import { LeftoverWorktreesStore } from '../../core/state/leftover-worktrees.store';
import type { LeftoverRemovalPreview, LeftoverWorktreeRow } from '@contracts/schemas/workspace-tools';

function row(patch: Partial<LeftoverWorktreeRow> = {}): LeftoverWorktreeRow {
  return { repoRoot: '/repo', path: '/repo/.worktrees/old', branch: 'saved', tip: 'fixture-tip',
    createdBy: 'harness', owner: null, inUse: false, leftover: true, category: 'saved-work',
    removableByHarness: true, reason: null, dirtyCount: 0, ahead: 1, behind: 0,
    patchCount: 1, fileCount: 185, mergedIntoMain: false, lastCommitAt: 0, ageDays: 30, bytes: 1024,
    sentence: 'Holds 1 saved change (185 files) that your main copy does not have.', ...patch };
}
const preview = signal<LeftoverRemovalPreview | null>(null);
const rows = signal<LeftoverWorktreeRow[]>([]);
const run = vi.fn(async () => { /* noop */ });
const review = vi.fn(async (r: LeftoverWorktreeRow, action: LeftoverRemovalPreview['action']) => {
  preview.set({ previewId: 'preview', row: r, action, consequence: 'The saved work stays on its branch.' });
});
const store = { rows, preview, archives: signal([]), busy: signal(false), error: signal<string | null>(null),
  reportErrors: signal([]), load: vi.fn(async () => { /* noop */ }), review, run,
  cancel: () => preview.set(null) };

describe('leftover folder card', () => {
  beforeEach(async () => {
    vi.clearAllMocks(); rows.set([]); preview.set(null); store.busy.set(false);
    await resolveComponentResources((url) => Promise.resolve(readFileSync(
      fileURLToPath(new URL(url, import.meta.url)), 'utf8')));
    await TestBed.configureTestingModule({ imports: [LeftoverWorktreesCardComponent],
      providers: [{ provide: LeftoverWorktreesStore, useValue: store }] }).compileComponents();
  });
  it('shows Claude Code folders without a remove or review button', () => {
    rows.set([row({ createdBy: 'claude-code', removableByHarness: false,
      reason: 'Made by Claude Code. Harness will not remove it.' })]);
    const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.textContent).toContain('Made by Claude Code');
    expect(Array.from(element.querySelectorAll('button')).some((b) => /Remove|Review/.test(b.textContent ?? ''))).toBe(false);
    expect(element.textContent).toContain('Copy the commands');
  });
  it('Cancel runs nothing and returns focus to Review', async () => {
    rows.set([row()]);
    const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const button = Array.from(element.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Review')!;
    button.focus(); button.click(); await fixture.whenStable(); fixture.detectChanges();
    const cancel = element.querySelector<HTMLButtonElement>('[data-cancel]')!;
    expect(document.activeElement).toBe(cancel);
    cancel.click(); fixture.detectChanges();
    expect(preview()).toBeNull(); expect(run).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(button);
  });
  it('Escape cancels the preview and does not reach Settings', async () => {
    preview.set({ previewId: 'preview', row: row(), action: 'remove-folder', consequence: 'The saved work stays on its branch.' });
    const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const outer = vi.fn();
    (fixture.nativeElement as HTMLElement).addEventListener('keydown', outer);
    fixture.nativeElement.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(preview()).toBeNull(); expect(run).not.toHaveBeenCalled();
    expect(outer).not.toHaveBeenCalled();
  });
  // Settings closes itself on Escape; a dialog open inside it must take that key for itself.
  it('keeps Escape inside the dialog so Settings stays open', async () => {
    preview.set({ previewId: 'preview', row: row(), action: 'discard-saved-work', consequence: 'The saved work is deleted.' });
    const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const reachedSettings = vi.fn();
    element.addEventListener('keydown', reachedSettings);
    element.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges();
    expect(preview()).toBeNull();
    expect(reachedSettings).not.toHaveBeenCalled();
  });
  it('names the file count and requires an unticked discard box', async () => {
    preview.set({ previewId: 'preview', row: row(), action: 'discard-saved-work',
      consequence: 'The saved work is deleted and cannot be brought back.' });
    const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.textContent).toContain('185 files');
    expect(element.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
    const remove = element.querySelector<HTMLButtonElement>('[data-remove]')!;
    expect(remove.disabled).toBe(false);
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    remove.focus();
    expect(document.activeElement).toBe(remove);
    remove.click();
    expect(run).not.toHaveBeenCalled();
    const checkbox = element.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    checkbox.click(); fixture.detectChanges();
    expect(remove.hasAttribute('aria-disabled')).toBe(false);
    remove.click();
    expect(run).toHaveBeenCalledExactlyOnceWith(true, undefined);
    expect(element.querySelector('[title]')).toBeNull();
  });
  it('shows the reason beside a disabled Review', () => {
    rows.set([row({ inUse: true, removableByHarness: false, reason: 'In use by a loop that is still open' })]);
    const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.textContent).toContain('In use by a loop that is still open');
    const button = Array.from(element.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Review')!;
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-disabled')).toBe('true');
    button.focus();
    expect(document.activeElement).toBe(button);
    button.click();
    expect(review).not.toHaveBeenCalled();
    rows.set([row()]); fixture.detectChanges();
    expect(button.hasAttribute('aria-disabled')).toBe(false);
    button.click();
    expect(review).toHaveBeenCalled();
  });
  it('uses singular file wording in the discard confirmation', () => {
    preview.set({ previewId: 'preview', row: row({ fileCount: 1 }), action: 'discard-saved-work', consequence: 'Cannot be undone.' });
    const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.querySelector('input[type="checkbox"]')?.closest('label')?.textContent).toContain('in 1 file.');
    const remove = element.querySelector<HTMLButtonElement>('[data-remove]')!;
    expect(remove.disabled).toBe(false);
    expect(remove.getAttribute('aria-disabled')).toBe('true');
  });
  it('uses singular wording for one day, unsaved file and unpushed commit', () => {
    rows.set([row({ ageDays: 1, dirtyCount: 1, unpushedCount: 1 })]);
    const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const text = (fixture.nativeElement as HTMLElement).textContent;
    expect(text).toContain('1 day since'); expect(text).toContain('1 unsaved file · 1 unpushed commit');
  });
  it.each(['h3', 'select'])('allows pointer defaults on dialog %s and suppresses only backdrop focus', selector => {
    preview.set({ previewId: 'preview', row: row(), action: 'remove-folder', consequence: 'Saved work stays.' });
    const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const press = new Event('pointerdown', { bubbles: true, cancelable: true });
    element.querySelector(`.removal-dialog ${selector}`)!.dispatchEvent(press);
    expect(press.defaultPrevented).toBe(false);
    const backdropPress = new Event('pointerdown', { bubbles: true, cancelable: true });
    element.querySelector('.dialog-overlay')!.dispatchEvent(backdropPress);
    expect(backdropPress.defaultPrevented).toBe(true);
    expect(preview()).not.toBeNull(); expect(run).not.toHaveBeenCalled();
  });
  it('keeps dialog clicks inside and dismisses a backdrop click without removing anything', async () => {
    rows.set([row()]);
    const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const opener = [...element.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Review')!;
    opener.focus(); opener.click(); await fixture.whenStable(); fixture.detectChanges();
    element.querySelector<HTMLElement>('.removal-dialog h3')!.click();
    expect(preview()).not.toBeNull();
    element.querySelector<HTMLElement>('.removal-dialog h3')!.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    element.querySelector<HTMLElement>('.dialog-overlay')!.dispatchEvent(new Event('pointerup', { bubbles: true }));
    element.querySelector<HTMLElement>('.dialog-overlay')!.click(); expect(preview()).not.toBeNull();
    const overlay = element.querySelector<HTMLElement>('.dialog-overlay')!;
    overlay.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true })); overlay.dispatchEvent(new Event('pointerup', { bubbles: true })); overlay.click();
    fixture.detectChanges(); await fixture.whenStable();
    expect(preview()).toBeNull(); expect(document.activeElement).toBe(opener); expect(run).not.toHaveBeenCalled();
  });
  it.each(['archive-and-remove', 'remove-folder', 'remove-folder-and-branch', 'discard-saved-work'] as const)('shows the actual loaded %s action selected', action => {
    preview.set({ previewId: 'preview', row: row({ archivableByHarness: true, mergedIntoMain: true }), action, consequence: 'Fixture consequence.' });
    const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector<HTMLSelectElement>('select')!.value).toBe(action);
  });
  it('keeps a drag starting on the backdrop and ending on dialog text open', () => {
    preview.set({ previewId: 'preview', row: row(), action: 'remove-folder', consequence: 'Saved work stays.' });
    const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement; const overlay = element.querySelector<HTMLElement>('.dialog-overlay')!;
    overlay.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
    element.querySelector('h3')!.dispatchEvent(new Event('pointerup', { bubbles: true })); overlay.click();
    expect(preview()).not.toBeNull(); expect(run).not.toHaveBeenCalled();
  });
  it('restores the opener when a replacement preview fails', async () => {
    rows.set([row()]); const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const opener = [...element.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Review')!;
    opener.focus(); opener.click(); await fixture.whenStable(); fixture.detectChanges();
    let release!: () => void;
    review.mockImplementationOnce(async () => { store.busy.set(true); preview.set(null); await new Promise<void>(resolve => { release = resolve; }); store.error.set('Fixture replacement failed'); store.busy.set(false); });
    const select = element.querySelector<HTMLSelectElement>('select')!;
    select.value = 'discard-saved-work'; select.dispatchEvent(new Event('change')); fixture.detectChanges();
    release(); await fixture.whenStable(); fixture.detectChanges();
    expect(element.querySelector('[role="dialog"]')).toBeNull(); expect(document.activeElement).toBe(opener);
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('Fixture replacement failed'); store.error.set(null);
  });
  it('keeps a later user focus when the initial preview fails', async () => {
    rows.set([row()]); let release!: () => void;
    review.mockImplementationOnce(async () => { store.busy.set(true); await new Promise<void>(resolve => { release = resolve; }); store.error.set('Fixture preview failed'); store.busy.set(false); });
    const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const other = document.createElement('button'); document.body.append(other);
    try {
      element.querySelector<HTMLButtonElement>('.folder-row button')!.click(); fixture.detectChanges(); other.focus();
      release(); await fixture.whenStable(); fixture.detectChanges();
      expect(document.activeElement).toBe(other); expect(preview()).toBeNull();
    } finally { other.remove(); store.error.set(null); }
  });
  it('deactivates the trap without focusing a page that is being destroyed', async () => {
    rows.set([row()]); const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const opener = [...element.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Review')!;
    opener.focus(); opener.click(); await fixture.whenStable(); fixture.detectChanges();
    const focus = vi.spyOn(opener, 'focus'); fixture.destroy(); expect(focus).not.toHaveBeenCalled();
  });
  it('retains the opener through an asynchronous action change', async () => {
    rows.set([row()]);
    const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const opener = [...element.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Review')!;
    opener.focus(); opener.click(); await fixture.whenStable(); fixture.detectChanges();
    let release!: () => void;
    review.mockImplementationOnce(async (r, action) => {
      store.busy.set(true); preview.set(null);
      await new Promise<void>(resolve => { release = resolve; });
      preview.set({ previewId: 'replacement', row: r, action, consequence: 'Cannot be undone.' }); store.busy.set(false);
    });
    const select = element.querySelector<HTMLSelectElement>('select')!;
    select.value = 'discard-saved-work'; select.dispatchEvent(new Event('change')); fixture.detectChanges();
    expect(preview()).toBeNull();
    release(); await fixture.whenStable(); fixture.detectChanges();
    element.querySelector<HTMLButtonElement>('[data-cancel]')!.click(); fixture.detectChanges(); await fixture.whenStable();
    expect(document.activeElement).toBe(opener); expect(run).not.toHaveBeenCalled();
  });
  it('restores Review focus after loading disables and blurs the opener', async () => {
    rows.set([row()]); let release!: () => void;
    review.mockImplementationOnce(async (r, action) => {
      store.busy.set(true);
      await new Promise<void>(resolve => { release = resolve; });
      preview.set({ previewId: 'preview', row: r, action, consequence: 'Saved work stays on its branch.' });
      store.busy.set(false);
    });
    const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const opener = [...element.querySelectorAll('button')].find(button => button.textContent?.trim() === 'Review')!;
    opener.focus(); opener.click(); fixture.detectChanges(); expect(opener.disabled).toBe(true);
    opener.blur(); release(); await fixture.whenStable(); fixture.detectChanges();
    const dialog = element.querySelector<HTMLElement>('[role="dialog"]')!;
    dialog.focus(); expect(document.activeElement).toBe(dialog);
    dialog.querySelector('h3')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    fixture.detectChanges(); await fixture.whenStable();
    expect(document.activeElement).toBe(opener); expect(run).not.toHaveBeenCalled();
  });
  it('Escape closes only the preview and formats a single saved change and file', () => {
    preview.set({ previewId: 'preview', row: row({ fileCount: 1 }), action: 'remove-folder',
      consequence: 'The saved work stays on its branch.' });
    const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    const parentKeydown = vi.fn();
    element.addEventListener('keydown', parentKeydown);
    const dialog = element.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('1 saved change · 1 file');
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(preview()).toBeNull();
    expect(parentKeydown).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
});
