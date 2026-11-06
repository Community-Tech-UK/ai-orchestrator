import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HybridSearchOptions, HybridSearchResult } from '../../../../shared/types/codebase.types';
import { CodebaseIpcService } from '../../core/services/ipc/codebase-ipc.service';
import { HistoryIpcService } from '../../core/services/ipc/history-ipc.service';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { signal } from '@angular/core';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import { ComposerAutocompleteService } from './composer-autocomplete.service';

describe('ComposerAutocompleteService', () => {
  let service: ComposerAutocompleteService;
  let search: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    search = vi.fn<(options: HybridSearchOptions) => Promise<{
      success: true;
      data: HybridSearchResult[];
    }>>().mockResolvedValue({
      success: true,
      data: [
        result('/repo/src/main/input-panel.component.ts', 20),
        result('/repo/src/renderer/app/shared/utils/focus-trap.ts', 10),
      ],
    });
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        ComposerAutocompleteService,
        { provide: CodebaseIpcService, useValue: { search } },
      ],
    });
    service = TestBed.inject(ComposerAutocompleteService);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces rapid queries and resolves the superseded request empty', async () => {
    const first = service.searchFiles('s', '/repo');
    const second = service.searchFiles('src', '/repo');

    await expect(first).resolves.toEqual([]);
    expect(search).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(120);

    await expect(second).resolves.toEqual([
      expect.objectContaining({ label: 'src/main/input-panel.component.ts' }),
      expect.objectContaining({ label: 'src/renderer/app/shared/utils/focus-trap.ts' }),
    ]);
    expect(search).toHaveBeenCalledOnce();
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      query: 'src',
      workspacePath: '/repo',
      topK: 24,
    }));
  });

  it('cancels a pending debounce without issuing IPC', async () => {
    const pending = service.searchFiles('src', '/repo');

    service.cancelPending();

    await expect(pending).resolves.toEqual([]);
    await vi.advanceTimersByTimeAsync(120);
    expect(search).not.toHaveBeenCalled();
  });

  it.each([false, true])('awaits an in-flight history load when typing quickly (external load: %s)', async (externalLoad) => {
    let finishLoad!: (response: { success: true; data: ConversationHistoryEntry[] }) => void;
    const listHistory = vi.fn(() => new Promise<{ success: true; data: ConversationHistoryEntry[] }>((resolve) => { finishLoad = resolve; }));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [ComposerAutocompleteService,
      { provide: CodebaseIpcService, useValue: { search } },
      { provide: InstanceStore, useValue: { instances: signal([]) } },
      { provide: HistoryIpcService, useValue: { listHistory } },
    ] });
    service = TestBed.inject(ComposerAutocompleteService);
    const store = TestBed.inject(HistoryStore);
    const startedElsewhere = externalLoad ? store.loadHistory() : Promise.resolve();
    const first = service.searchSessions('', '/repo');
    const latest = service.searchSessions('Pa', '/repo');
    finishLoad({ success: true, data: [{ id: 'past', displayName: 'Past session', originalInstanceId: 'old',
      workingDirectory: '/repo' } as ConversationHistoryEntry] });
    await startedElsewhere;
    await expect(first).resolves.toEqual([]);
    await expect(latest).resolves.toEqual([expect.objectContaining({ label: 'Past session', insertText: '[session: Past session · past]' })]);
    expect(listHistory).toHaveBeenCalledOnce();
  });
});

function result(filePath: string, score: number): HybridSearchResult {
  return {
    sectionId: `${filePath}:1:1`,
    filePath,
    content: '',
    startLine: 1,
    endLine: 1,
    score,
    matchType: 'bm25',
    language: 'typescript',
  };
}
