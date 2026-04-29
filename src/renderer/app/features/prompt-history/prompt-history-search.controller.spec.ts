import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceStore } from '../../core/state/instance.store';
import { PromptHistoryStore } from '../../core/state/prompt-history.store';
import { PromptHistorySearchController } from './prompt-history-search.controller';

describe('PromptHistorySearchController', () => {
  const selectedInstance = signal({
    id: 'inst-1',
    workingDirectory: '/repo',
  });
  const entries = [
    {
      id: 'entry-1',
      text: 'write tests for prompt recall',
      createdAt: 1,
      projectPath: '/repo',
    },
  ];
  const promptHistoryStore = {
    getEntriesForRecall: vi.fn(() => entries),
    requestRecallEntry: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        PromptHistorySearchController,
        { provide: InstanceStore, useValue: { selectedInstance } },
        { provide: PromptHistoryStore, useValue: promptHistoryStore },
      ],
    });
  });

  it('lists prompt history for the selected instance and project', () => {
    const controller = TestBed.inject(PromptHistorySearchController);

    expect(controller.groups()[0].items[0].label).toContain('write tests');
    expect(promptHistoryStore.getEntriesForRecall).toHaveBeenCalledWith('inst-1', '/repo');
  });

  it('requests recall when an entry is selected', () => {
    const controller = TestBed.inject(PromptHistorySearchController);
    const item = controller.groups()[0].items[0];

    expect(controller.run(item)).toBe(true);
    expect(promptHistoryStore.requestRecallEntry).toHaveBeenCalledWith(entries[0]);
  });
});
