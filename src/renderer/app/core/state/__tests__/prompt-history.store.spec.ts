import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PromptHistoryDelta,
  PromptHistoryEntry,
  PromptHistoryRecord,
  PromptHistorySnapshot,
} from '../../../../../shared/types/prompt-history.types';
import { PromptHistoryIpcService } from '../../services/ipc';
import { PromptHistoryStore } from '../prompt-history.store';

class MockPromptHistoryIpcService {
  snapshot: PromptHistorySnapshot = {
    byInstance: {},
    byProject: {},
  };
  deltaCallback: ((delta: PromptHistoryDelta) => void) | null = null;
  record = vi.fn(async (instanceId: string, entry: PromptHistoryEntry) => ({
    success: true,
    data: {
      instanceId,
      entries: [entry],
      updatedAt: 2,
    } satisfies PromptHistoryRecord,
  }));
  clearInstance = vi.fn(async (instanceId: string) => ({
    success: true,
    data: {
      instanceId,
      entries: [],
      updatedAt: 2,
    } satisfies PromptHistoryRecord,
  }));

  async getSnapshot(): Promise<{ success: boolean; data: PromptHistorySnapshot }> {
    return { success: true, data: this.snapshot };
  }

  onDelta(callback: (delta: PromptHistoryDelta) => void): () => void {
    this.deltaCallback = callback;
    return () => {
      this.deltaCallback = null;
    };
  }
}

describe('PromptHistoryStore', () => {
  let ipc: MockPromptHistoryIpcService;

  beforeEach(() => {
    ipc = new MockPromptHistoryIpcService();
    TestBed.configureTestingModule({
      providers: [
        PromptHistoryStore,
        { provide: PromptHistoryIpcService, useValue: ipc },
      ],
    });
  });

  it('init seeds records and project aliases from IPC', async () => {
    ipc.snapshot = {
      byInstance: {
        'inst-1': {
          instanceId: 'inst-1',
          entries: [{ id: 'entry-1', text: 'hello', createdAt: 1, projectPath: '/repo' }],
          updatedAt: 1,
        },
      },
      byProject: {
        '/repo': {
          projectPath: '/repo',
          entries: [{ id: 'entry-1', text: 'hello', createdAt: 1, projectPath: '/repo' }],
          updatedAt: 1,
        },
      },
    };

    const store = TestBed.inject(PromptHistoryStore);
    await store.init();

    expect(store.getEntriesForInstance('inst-1').map((entry) => entry.text)).toEqual(['hello']);
    expect(store.getEntriesForProject('/repo').map((entry) => entry.text)).toEqual(['hello']);
  });

  it('record optimistically inserts and writes through to IPC', async () => {
    const store = TestBed.inject(PromptHistoryStore);
    await store.init();

    store.record({
      instanceId: 'inst-1',
      id: 'entry-1',
      text: 'hello',
      createdAt: 1,
      projectPath: '/repo',
    });

    expect(store.getEntriesForInstance('inst-1').map((entry) => entry.text)).toEqual(['hello']);
    expect(ipc.record).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({ text: 'hello' }),
    );
  });

  it('applies canonical deltas from IPC', async () => {
    const store = TestBed.inject(PromptHistoryStore);
    await store.init();

    ipc.deltaCallback?.({
      instanceId: 'inst-1',
      record: {
        instanceId: 'inst-1',
        entries: [{ id: 'entry-1', text: 'canonical', createdAt: 3 }],
        updatedAt: 3,
      },
    });

    expect(store.getEntriesForInstance('inst-1').map((entry) => entry.text)).toEqual(['canonical']);
  });

  it('clearForInstance removes local state and calls IPC', async () => {
    const store = TestBed.inject(PromptHistoryStore);
    await store.init();
    store.record({ instanceId: 'inst-1', id: 'entry-1', text: 'hello', createdAt: 1 });

    await store.clearForInstance('inst-1');

    expect(store.getEntriesForInstance('inst-1')).toEqual([]);
    expect(ipc.clearInstance).toHaveBeenCalledWith('inst-1');
  });

  it('returns recall entries for thread, project, and all scopes', async () => {
    ipc.snapshot = {
      byInstance: {
        'inst-1': {
          instanceId: 'inst-1',
          entries: [
            { id: 'thread-current', text: 'current thread prompt', createdAt: 30, projectPath: '/repo' },
            { id: 'shared-current', text: 'shared prompt', createdAt: 20, projectPath: '/repo' },
          ],
          updatedAt: 30,
        },
        'inst-2': {
          instanceId: 'inst-2',
          entries: [
            { id: 'project-other', text: 'other thread same project', createdAt: 25, projectPath: '/repo' },
            { id: 'shared-other', text: 'shared prompt', createdAt: 15, projectPath: '/repo' },
          ],
          updatedAt: 25,
        },
        'inst-3': {
          instanceId: 'inst-3',
          entries: [
            { id: 'other-project', text: 'other project prompt', createdAt: 40, projectPath: '/elsewhere' },
          ],
          updatedAt: 40,
        },
      },
      byProject: {
        '/repo': {
          projectPath: '/repo',
          entries: [
            { id: 'project-other', text: 'other thread same project', createdAt: 25, projectPath: '/repo' },
            { id: 'shared-other', text: 'shared prompt', createdAt: 15, projectPath: '/repo' },
          ],
          updatedAt: 25,
        },
        '/elsewhere': {
          projectPath: '/elsewhere',
          entries: [
            { id: 'other-project', text: 'other project prompt', createdAt: 40, projectPath: '/elsewhere' },
          ],
          updatedAt: 40,
        },
      },
    };

    const store = TestBed.inject(PromptHistoryStore);
    await store.init();

    expect(store.getEntriesForRecall({
      scope: 'thread',
      instanceId: 'inst-1',
      workingDirectory: '/repo',
    }).map((entry) => entry.text)).toEqual([
      'current thread prompt',
      'shared prompt',
    ]);
    expect(store.getEntriesForRecall({
      scope: 'project',
      instanceId: 'inst-1',
      workingDirectory: '/repo',
    }).map((entry) => entry.text)).toEqual([
      'current thread prompt',
      'shared prompt',
      'other thread same project',
    ]);
    expect(store.getEntriesForRecall({
      scope: 'all',
      instanceId: 'inst-1',
      workingDirectory: '/repo',
    }).map((entry) => entry.text)).toEqual([
      'other project prompt',
      'current thread prompt',
      'other thread same project',
      'shared prompt',
    ]);
    expect(store.getEntriesForRecall({
      instanceId: 'inst-1',
      workingDirectory: '/repo',
    }).map((entry) => entry.text)).toEqual([
      'current thread prompt',
      'shared prompt',
      'other thread same project',
    ]);
  });
});
