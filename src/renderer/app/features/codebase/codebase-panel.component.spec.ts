/**
 * Tests for CodebasePanelComponent's auto-index status badge.
 *
 * The badge is a computed signal that maps the coordinator's
 * `CodebaseAutoIndexStatus` shape onto a small `{label, title, tone}` record.
 * We test that mapping directly by exercising the component instance with a
 * fake `CodebaseIpcService`.
 */

import { TestBed } from '@angular/core/testing';
import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CodebasePanelComponent } from './codebase-panel.component';
import { CodebaseIpcService } from '../../core/services/ipc/codebase-ipc.service';
import {
  CLIPBOARD_SERVICE,
  type ClipboardCopyResult,
  type ClipboardService,
} from '../../core/services/clipboard.service';
import type { CodebaseAutoIndexStatus } from '../../../../shared/types/codebase.types';

await resolveComponentResources((url) => {
  if (url.endsWith('codebase-panel.component.html') || url.endsWith('codebase-panel.component.scss')) {
    return Promise.resolve('');
  }
  return Promise.reject(new Error(`Unexpected resource: ${url}`));
});

class FakeCodebaseIpcService {
  readonly indexingProgress = signal(null);
  readonly watcherChanges = signal(null);
  readonly autoStatusByPath = signal<Record<string, CodebaseAutoIndexStatus>>({});
  getIndexStats = vi.fn(async () => {
    return { success: true, data: null } as const;
  });
  getWatcherStatus = vi.fn(async () => {
    return { success: true, data: null } as const;
  });
  getAutoStatus = vi.fn(async () => {
    return { success: true, data: null } as const;
  });
  indexCodebase = vi.fn(async () => {
    return { success: true, data: null } as const;
  });
  cancelIndexing = vi.fn(async () => {
    return { success: true, data: null } as const;
  });
  search = vi.fn(async () => {
    return { success: true, data: [] } as const;
  });
}

const noopCopyResult: ClipboardCopyResult = { ok: true };
const fakeClipboard: ClipboardService = {
  lastResult: signal<ClipboardCopyResult | null>(null).asReadonly(),
  copyText: async () => noopCopyResult,
  copyJSON: async () => noopCopyResult,
  copyImage: async () => noopCopyResult,
  copyMessage: async () => noopCopyResult,
};

describe('CodebasePanelComponent auto-status badge', () => {
  let fakeIpc: FakeCodebaseIpcService;
  let component: CodebasePanelComponent;

  beforeEach(async () => {
    fakeIpc = new FakeCodebaseIpcService();
    await TestBed.configureTestingModule({
      imports: [CodebasePanelComponent],
      providers: [
        { provide: CodebaseIpcService, useValue: fakeIpc },
        { provide: CLIPBOARD_SERVICE, useValue: fakeClipboard },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(CodebasePanelComponent);
    component = fixture.componentInstance;
    // Don't run ngOnInit — its IPC calls aren't relevant to the badge logic.
  });

  function setStatus(rootPath: string, status: Partial<CodebaseAutoIndexStatus>): void {
    component.rootPath.set(rootPath);
    fakeIpc.autoStatusByPath.set({
      [rootPath]: {
        rootPath,
        storeId: 'store_x',
        state: 'idle',
        ...status,
      },
    });
  }

  it('renders Queued for state=queued', () => {
    setStatus('/proj/a', { state: 'queued' });
    const badge = component.autoStatusBadge();
    expect(badge?.label).toBe('Queued');
    expect(badge?.tone).toBe('info');
  });

  it('renders Indexing… for state=running with file count', () => {
    setStatus('/proj/a', { state: 'running', filesProcessed: 42 });
    const badge = component.autoStatusBadge();
    expect(badge?.label).toBe('Indexing…');
    expect(badge?.tone).toBe('progress');
    expect(badge?.title).toContain('42 files');
  });

  it('renders Indexed for state=complete', () => {
    setStatus('/proj/a', { state: 'complete', filesProcessed: 100 });
    const badge = component.autoStatusBadge();
    expect(badge?.label).toBe('Indexed');
    expect(badge?.tone).toBe('success');
  });

  it('renders Too large for state=skipped reason=too_large', () => {
    setStatus('/proj/a', { state: 'skipped', reason: 'too_large' });
    const badge = component.autoStatusBadge();
    expect(badge?.label).toBe('Too large — index manually');
    expect(badge?.tone).toBe('warn');
  });

  it('renders Auto-index off for state=skipped reason=disabled', () => {
    setStatus('/proj/a', { state: 'skipped', reason: 'disabled' });
    const badge = component.autoStatusBadge();
    expect(badge?.label).toBe('Auto-index off');
    expect(badge?.tone).toBe('warn');
  });

  it('renders Excluded for state=skipped reason=excluded', () => {
    setStatus('/proj/a', { state: 'skipped', reason: 'excluded' });
    const badge = component.autoStatusBadge();
    expect(badge?.label).toBe('Excluded');
    expect(badge?.tone).toBe('warn');
  });

  it('renders Remote workspace for state=skipped reason=remote', () => {
    setStatus('/proj/a', { state: 'skipped', reason: 'remote' });
    const badge = component.autoStatusBadge();
    expect(badge?.label).toBe('Remote workspace');
    expect(badge?.tone).toBe('info');
  });

  it('renders Failed with error message tooltip', () => {
    setStatus('/proj/a', {
      state: 'failed',
      reason: 'error',
      errorMessage: 'permission denied',
    });
    const badge = component.autoStatusBadge();
    expect(badge?.label).toBe('Failed');
    expect(badge?.tone).toBe('error');
    expect(badge?.title).toContain('permission denied');
  });

  it('returns null for state=idle', () => {
    setStatus('/proj/a', { state: 'idle' });
    const badge = component.autoStatusBadge();
    expect(badge).toBeNull();
  });

  it('returns null when no status is tracked for the workspace', () => {
    component.rootPath.set('/proj/unknown');
    fakeIpc.autoStatusByPath.set({});
    expect(component.autoStatusBadge()).toBeNull();
  });

  it('falls back to the single tracked status when rootPath is blank', () => {
    component.rootPath.set('');
    fakeIpc.autoStatusByPath.set({
      '/proj/only': {
        rootPath: '/proj/only',
        storeId: 'store_only',
        state: 'complete',
      },
    });
    const badge = component.autoStatusBadge();
    expect(badge?.label).toBe('Indexed');
  });

  it('cancels manual legacy lane indexing for the current workspace path', async () => {
    component.rootPath.set('  /proj/a  ');

    await component.cancelIndexing();

    expect(fakeIpc.cancelIndexing).toHaveBeenCalledWith('/proj/a', 'legacy');
  });

  it('allows search when a workspace path is selected even without legacy stats', () => {
    component.rootPath.set('/proj/a');
    component.indexStats.set(null);

    expect(component.canSearch()).toBe(true);
  });

  it('adds the current workspace path to search options', async () => {
    component.rootPath.set('/proj/a');

    await component.onSearch({
      query: 'issue session token',
      storeId: 'default',
      topK: 10,
    });

    expect(fakeIpc.search).toHaveBeenCalledWith(expect.objectContaining({
      query: 'issue session token',
      storeId: 'default',
      workspacePath: '/proj/a',
      topK: 10,
    }));
  });
});
