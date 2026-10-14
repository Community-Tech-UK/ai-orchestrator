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
const store = { rows, preview, busy: signal(false), error: signal<string | null>(null),
  reportErrors: signal([]), load: vi.fn(async () => { /* noop */ }), review, run,
  cancel: () => preview.set(null) };

describe('leftover folder card', () => {
  beforeEach(async () => {
    vi.clearAllMocks(); rows.set([]); preview.set(null);
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
  it('names the file count and requires an unticked discard box', async () => {
    preview.set({ previewId: 'preview', row: row(), action: 'discard-saved-work',
      consequence: 'The saved work is deleted and cannot be brought back.' });
    const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.textContent).toContain('185 files');
    expect(element.querySelector<HTMLInputElement>('input[type=checkbox]')!.checked).toBe(false);
    expect(element.querySelector<HTMLButtonElement>('[data-remove]')!.disabled).toBe(true);
    expect(element.querySelector('[title]')).toBeNull();
  });
  it('shows the reason beside a disabled Review', () => {
    rows.set([row({ inUse: true, removableByHarness: false, reason: 'In use by a loop that is still open' })]);
    const fixture = TestBed.createComponent(LeftoverWorktreesCardComponent); fixture.detectChanges();
    const element: HTMLElement = fixture.nativeElement;
    expect(element.textContent).toContain('In use by a loop that is still open');
    expect(Array.from(element.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'Review')!.disabled).toBe(true);
  });
});
