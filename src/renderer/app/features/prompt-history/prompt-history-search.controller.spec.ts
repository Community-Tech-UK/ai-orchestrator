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
  const projectEntries = [
    {
      id: 'entry-1',
      text: 'write tests for prompt recall',
      createdAt: 1,
      projectPath: '/repo',
    },
  ];
  const allEntries = [
    {
      id: 'entry-2',
      text: 'reuse prompt from another project',
      createdAt: 2,
      projectPath: '/elsewhere',
      attachmentCount: 2,
      attachments: [{ name: 'notes.md' }],
    },
  ];
  const promptHistoryStore = {
    getEntriesForRecall: vi.fn((options: { scope?: string }) =>
      options.scope === 'all' ? allEntries : projectEntries
    ),
    requestRecallEntry: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
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
    expect(promptHistoryStore.getEntriesForRecall).toHaveBeenCalledWith({
      scope: 'project',
      instanceId: 'inst-1',
      workingDirectory: '/repo',
    });
  });

  it('requests recall when an entry is selected', () => {
    const controller = TestBed.inject(PromptHistorySearchController);
    const item = controller.groups()[0].items[0];

    expect(controller.run(item)).toBe(true);
    expect(promptHistoryStore.requestRecallEntry).toHaveBeenCalledWith(projectEntries[0]);
  });

  it('switches scopes and labels all-project entries with their source project', () => {
    const controller = TestBed.inject(PromptHistorySearchController);

    controller.setScope('all');
    const item = controller.groups()[0].items[0];

    expect(window.localStorage.getItem('prompt-history-recall-scope')).toBe('all');
    expect(promptHistoryStore.getEntriesForRecall).toHaveBeenLastCalledWith({
      scope: 'all',
      instanceId: 'inst-1',
      workingDirectory: '/repo',
    });
    expect(item.description).toContain('/elsewhere');
    expect(item.keywords).toContain('/elsewhere');
  });

  it('recalls only text fields for all-project entries', () => {
    const controller = TestBed.inject(PromptHistorySearchController);

    controller.setScope('all');
    const item = controller.groups()[0].items[0];

    expect(controller.run(item)).toBe(true);
    expect(promptHistoryStore.requestRecallEntry).toHaveBeenCalledWith({
      id: 'entry-2',
      text: 'reuse prompt from another project',
      createdAt: 2,
      projectPath: '/elsewhere',
      provider: undefined,
      model: undefined,
      wasSlashCommand: undefined,
    });
  });
});
