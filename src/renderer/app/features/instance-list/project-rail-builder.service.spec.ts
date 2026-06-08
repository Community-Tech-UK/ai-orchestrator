import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { ScratchDirectoryService } from '../../core/services/scratch-directory.service';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import { ProjectRailBuilderService } from './project-rail-builder.service';

function makeHistoryEntry(
  id: string,
  overrides: Partial<ConversationHistoryEntry> = {},
): ConversationHistoryEntry {
  return {
    id,
    displayName: id,
    createdAt: 1000,
    endedAt: 1000,
    workingDirectory: '/Users/james/work/project',
    messageCount: 2,
    firstUserMessage: id,
    lastUserMessage: id,
    status: 'completed',
    originalInstanceId: `instance-${id}`,
    parentId: null,
    sessionId: `session-${id}`,
    provider: 'codex',
    currentModel: 'gpt-5.5',
    ...overrides,
  };
}

describe('ProjectRailBuilderService', () => {
  let service: ProjectRailBuilderService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ProjectRailBuilderService,
        {
          provide: NewSessionDraftService,
          useValue: {
            hasSavedDraftFor: () => false,
            getDraftUpdatedAt: () => null,
          },
        },
        {
          provide: ScratchDirectoryService,
          useValue: {
            isScratch: () => false,
          },
        },
      ],
    });

    service = TestBed.inject(ProjectRailBuilderService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('does not backfill archived history rows to meet the minimum visible history count', () => {
    const groups = service.buildProjectGroups({
      instances: [],
      historyEntries: [
        makeHistoryEntry('archived-newer', { endedAt: 3000, archivedAt: 4000 }),
        makeHistoryEntry('active-older', { endedAt: 2000, archivedAt: null }),
      ],
      recentDirectories: [],
      filter: '',
      status: 'all',
      location: 'all',
      historyVisibility: 'all',
      historyTimeWindow: 'all',
      selectedId: null,
      selectedHistoryEntryId: null,
      collapsed: new Set<string>(),
      collapsedProjects: new Set<string>(),
      collapsedHistoryParentIds: new Set<string>(),
      historySortMode: 'last-interacted',
      rootInstanceOrder: [],
      showEmptyProjects: false,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.historyItems.map((item) => item.entry.id)).toEqual(['active-older']);
  });
});
