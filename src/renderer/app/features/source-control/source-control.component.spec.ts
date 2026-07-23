/**
 * SourceControlComponent JIT-render spec — asserts the VS Code–style SCM
 * markup: file-type icons per row, trailing status letters, struck-through
 * deleted files, "Staged Changes"/"Changes" headers with count pills, untracked
 * files merged into Changes with a trash-discard, full-path row tooltips, and
 * section collapse.
 *
 * Uses the real SourceControlStore seeded via its public signals (no IPC), with
 * a stub VcsIpcService to satisfy injection. Child components render for real —
 * only FileIconComponent output is asserted.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SourceControlComponent } from './source-control.component';
import { SourceControlStore } from '../../core/state/source-control.store';
import { VcsIpcService } from '../../core/services/ipc/vcs-ipc.service';
import type { GitStatusResponse, RepoState } from './source-control.types';

// Vitest does not run Angular CLI's resource inliner, so resolve the
// component's external templateUrl/styleUrl before TestBed compiles it.
const specDirectory = dirname(fileURLToPath(import.meta.url));
const componentTemplate = readFileSync(
  resolve(specDirectory, './source-control.component.html'),
  'utf8',
);
const componentStyles = readFileSync(
  resolve(specDirectory, './source-control.component.scss'),
  'utf8',
);

await resolveComponentResources((url) => {
  if (url.endsWith('source-control.component.html')) return Promise.resolve(componentTemplate);
  if (url.endsWith('source-control.component.scss')) return Promise.resolve(componentStyles);
  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

const REPO = '/repo/project';

function seededStatus(): GitStatusResponse {
  return {
    branch: 'main',
    ahead: 0,
    behind: 0,
    staged: [
      { path: 'src/alpha.ts', status: 'modified', staged: true },
      { path: 'src/old-thing.ts', status: 'deleted', staged: true },
    ],
    unstaged: [{ path: 'src/beta.ts', status: 'modified', staged: false }],
    untracked: ['src/newfile.ts'],
    hasChanges: true,
    isClean: false,
  };
}

function repoState(status: GitStatusResponse | null = seededStatus()): RepoState {
  return { absolutePath: REPO, name: 'project', relativePath: '', status, error: null, loading: false };
}

describe('SourceControlComponent (VS Code SCM restyle)', () => {
  let store: SourceControlStore;

  function seed(status: GitStatusResponse | null = seededStatus()): void {
    store._resetForTesting();
    store.activeRoot.set(REPO);
    store.repos.set([repoState(status)]);
    store.expandedRepos.set(new Set([REPO]));
    store.initialLoad.set(false);
    store.isRefreshing.set(false);
    store.loadError.set(null);
  }

  async function render() {
    await TestBed.compileComponents();
    const fixture = TestBed.createComponent(SourceControlComponent);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [SourceControlComponent],
      providers: [{ provide: VcsIpcService, useValue: {} as VcsIpcService }],
    });
    store = TestBed.inject(SourceControlStore);
    seed();
  });

  it('renders a file-type icon for every change row', async () => {
    const fixture = await render();
    // 2 staged + 2 merged changes (beta + untracked newfile) = 4 rows.
    const icons = fixture.nativeElement.querySelectorAll('app-file-icon .file-icon');
    expect(icons.length).toBe(4);
    // Each icon carries a glyph and a colour.
    for (const el of Array.from(icons) as HTMLElement[]) {
      expect(el.textContent?.length).toBeGreaterThan(0);
      expect(el.style.color).toBeTruthy();
    }
  });

  it('shows "Staged Changes" / "Changes" headers with count pills, no "Untracked" group', async () => {
    const fixture = await render();
    const titles = Array.from(fixture.nativeElement.querySelectorAll('.group-title')).map((el) =>
      (el as HTMLElement).textContent?.trim(),
    );
    expect(titles).toEqual(['Staged Changes', 'Changes']);
    expect(titles).not.toContain('Untracked');

    const badges = Array.from(fixture.nativeElement.querySelectorAll('.group-badge')).map((el) =>
      (el as HTMLElement).textContent?.trim(),
    );
    // Staged = 2; Changes = unstaged(1) + untracked(1) = 2.
    expect(badges).toEqual(['2', '2']);
  });

  it('renders trailing status letters (M / D / U) with per-status classes', async () => {
    const fixture = await render();
    const letters = Array.from(fixture.nativeElement.querySelectorAll('.status-letter')).map((el) =>
      (el as HTMLElement).textContent?.trim(),
    );
    // staged: alpha M, old-thing D; changes: beta M, newfile U (name-sorted).
    expect(letters).toEqual(['M', 'D', 'M', 'U']);
    expect(fixture.nativeElement.querySelector('.status-letter.status-untracked')?.textContent?.trim()).toBe('U');
    expect(fixture.nativeElement.querySelector('.status-letter.status-deleted')?.textContent?.trim()).toBe('D');
  });

  it('strikes through the deleted filename', async () => {
    const fixture = await render();
    const struck = fixture.nativeElement.querySelector('.file-name.deleted');
    expect(struck).toBeTruthy();
    expect((struck as HTMLElement).textContent?.trim()).toBe('old-thing.ts');
  });

  it('merges the untracked file into Changes with a trash-discard button', async () => {
    const fixture = await render();
    const trash = fixture.nativeElement.querySelector('[aria-label="Trash src/newfile.ts"]');
    expect(trash).toBeTruthy();
    expect((trash as HTMLElement).getAttribute('title')).toBe('Move to Trash (recoverable)');
    // Its "Stage all" absorbs untracked (single button per group, no separate
    // "Stage all untracked").
    const stageAll = Array.from(fixture.nativeElement.querySelectorAll('.group-action')).map((el) =>
      (el as HTMLElement).textContent?.trim(),
    );
    expect(stageAll).toContain('Stage all');
    expect(stageAll).toContain('Unstage all');
  });

  it('gives every file row a title beginning with the full repo-relative path', async () => {
    const fixture = await render();
    const rows = Array.from(fixture.nativeElement.querySelectorAll('.file-row')) as HTMLElement[];
    expect(rows.length).toBe(4);
    for (const row of rows) {
      const title = row.getAttribute('title') ?? '';
      expect(title.startsWith('src/')).toBe(true);
    }
    // Untracked row title omits the diff hint but still leads with the path.
    const untrackedRow = rows.find((r) => r.getAttribute('title')?.startsWith('src/newfile.ts'));
    expect(untrackedRow?.getAttribute('title')).toBe(
      'src/newfile.ts — ⌘/⇧-click to multi-select · drag to attach',
    );
  });

  it('collapses a section on header click, hiding its rows', async () => {
    const fixture = await render();
    const changesHeader = (Array.from(fixture.nativeElement.querySelectorAll('.group-header')) as HTMLElement[]).find(
      (h) => h.querySelector('.group-title')?.textContent?.trim() === 'Changes',
    ) as HTMLButtonElement;
    expect(changesHeader).toBeTruthy();

    // Before: 4 rows (2 staged + 2 changes).
    expect(fixture.nativeElement.querySelectorAll('.file-row').length).toBe(4);

    changesHeader.click();
    fixture.detectChanges();

    // After collapsing Changes: only the 2 staged rows remain.
    expect(fixture.nativeElement.querySelectorAll('.file-row').length).toBe(2);
    expect(changesHeader.getAttribute('aria-expanded')).toBe('false');
  });

  it('routes an untracked row click to no diff (openDiff not called)', async () => {
    const openDiff = vi.spyOn(store, 'openDiff');
    const fixture = await render();
    const untrackedRow = (Array.from(fixture.nativeElement.querySelectorAll('.file-row')) as HTMLElement[]).find(
      (r) => r.getAttribute('title')?.startsWith('src/newfile.ts'),
    ) as HTMLButtonElement;
    untrackedRow.click();
    expect(openDiff).not.toHaveBeenCalled();
  });
});
