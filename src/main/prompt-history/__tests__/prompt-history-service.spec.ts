import { beforeEach, describe, expect, it } from 'vitest';
import type { PromptHistoryStoreV1 } from '../../../shared/types/prompt-history.types';
import {
  PROMPT_HISTORY_MAX,
  createPromptHistoryEntryId,
} from '../../../shared/types/prompt-history.types';
import {
  PromptHistoryService,
  _resetPromptHistoryServiceForTesting,
} from '../prompt-history-service';
import type { PromptHistoryStoreBackend } from '../prompt-history-store';

class MemoryPromptHistoryStore implements PromptHistoryStoreBackend {
  private data: PromptHistoryStoreV1 = {
    schemaVersion: 1,
    byInstance: {},
    byProject: {},
  };

  get<K extends keyof PromptHistoryStoreV1>(key: K): PromptHistoryStoreV1[K] {
    return this.data[key];
  }

  set<K extends keyof PromptHistoryStoreV1>(key: K, value: PromptHistoryStoreV1[K]): void {
    this.data = {
      ...this.data,
      [key]: value,
    };
  }
}

describe('PromptHistoryService', () => {
  beforeEach(() => {
    _resetPromptHistoryServiceForTesting();
  });

  it('records entries most-recent first for an instance', () => {
    const svc = new PromptHistoryService(new MemoryPromptHistoryStore());

    svc.record({
      instanceId: 'inst-1',
      id: createPromptHistoryEntryId(),
      text: 'first',
      createdAt: 1,
    });
    svc.record({
      instanceId: 'inst-1',
      id: createPromptHistoryEntryId(),
      text: 'second',
      createdAt: 2,
    });

    expect(svc.getForInstance('inst-1').entries.map((entry) => entry.text)).toEqual(['second', 'first']);
  });

  it('dedupes repeated prompt text and keeps the latest entry', () => {
    const svc = new PromptHistoryService(new MemoryPromptHistoryStore());

    svc.record({ instanceId: 'inst-1', id: 'old', text: 'same', createdAt: 1 });
    svc.record({ instanceId: 'inst-1', id: 'new', text: 'same', createdAt: 2 });

    expect(svc.getForInstance('inst-1').entries).toMatchObject([{ id: 'new', text: 'same' }]);
  });

  it('caps instance history at PROMPT_HISTORY_MAX', () => {
    const svc = new PromptHistoryService(new MemoryPromptHistoryStore());

    for (let i = 0; i < PROMPT_HISTORY_MAX + 5; i++) {
      svc.record({
        instanceId: 'inst-1',
        id: `entry-${i}`,
        text: `prompt ${i}`,
        createdAt: i,
      });
    }

    const entries = svc.getForInstance('inst-1').entries;
    expect(entries).toHaveLength(PROMPT_HISTORY_MAX);
    expect(entries[0]?.text).toBe(`prompt ${PROMPT_HISTORY_MAX + 4}`);
  });

  it('rebuilds per-project aliases across instances', () => {
    const svc = new PromptHistoryService(new MemoryPromptHistoryStore());

    svc.record({
      instanceId: 'inst-1',
      id: 'a',
      text: 'shared project prompt',
      createdAt: 1,
      projectPath: '/repo',
    });
    svc.record({
      instanceId: 'inst-2',
      id: 'b',
      text: 'newer project prompt',
      createdAt: 2,
      projectPath: '/repo',
    });

    expect(svc.getForProject('/repo').entries.map((entry) => entry.text)).toEqual([
      'newer project prompt',
      'shared project prompt',
    ]);
  });

  it('clears one instance and updates aliases', () => {
    const svc = new PromptHistoryService(new MemoryPromptHistoryStore());

    svc.record({ instanceId: 'inst-1', id: 'a', text: 'remove me', createdAt: 1, projectPath: '/repo' });
    svc.record({ instanceId: 'inst-2', id: 'b', text: 'keep me', createdAt: 2, projectPath: '/repo' });
    svc.clearForInstance('inst-1');

    expect(svc.getForInstance('inst-1').entries).toEqual([]);
    expect(svc.getForProject('/repo').entries.map((entry) => entry.text)).toEqual(['keep me']);
  });

  it('emits deltas when records change', () => {
    const svc = new PromptHistoryService(new MemoryPromptHistoryStore());
    const seen: string[] = [];
    const unsubscribe = svc.onChange((delta) => {
      seen.push(`${delta.instanceId}:${delta.record.entries.length}`);
    });

    svc.record({ instanceId: 'inst-1', id: 'a', text: 'hello', createdAt: 1 });
    svc.clearForInstance('inst-1');
    unsubscribe();
    svc.record({ instanceId: 'inst-1', id: 'b', text: 'world', createdAt: 2 });

    expect(seen).toEqual(['inst-1:1', 'inst-1:0']);
  });
});
