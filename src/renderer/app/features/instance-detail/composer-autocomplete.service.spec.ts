import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HybridSearchOptions, HybridSearchResult } from '../../../../shared/types/codebase.types';
import { CodebaseIpcService } from '../../core/services/ipc/codebase-ipc.service';
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
