import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { ScratchDirectoryService } from '../../core/services/scratch-directory.service';
import type { Instance } from '../../core/state/instance.store';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import { ProjectRailBuilderService, type ProjectRailBuildInput } from './project-rail-builder.service';

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

function makeInstance(
  id: string,
  overrides: Partial<Instance> = {},
): Instance {
  return {
    id,
    displayName: id,
    createdAt: 1000,
    historyThreadId: `thread-${id}`,
    parentId: null,
    childrenIds: [],
    agentId: 'build',
    agentMode: 'build',
    provider: 'codex',
    status: 'idle',
    contextUsage: {
      used: 0,
      total: 200000,
      percentage: 0,
    },
    lastActivity: 1000,
    providerSessionId: `session-${id}`,
    sessionId: `session-${id}`,
    restartEpoch: 0,
    workingDirectory: '/Users/james/work/project',
    yoloMode: false,
    launchMode: 'orchestrated',
    outputBuffer: [],
    ...overrides,
  };
}

function buildInput(overrides: Partial<ProjectRailBuildInput> = {}): ProjectRailBuildInput {
  return {
    instances: [],
    historyEntries: [],
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
    const groups = service.buildProjectGroups(buildInput({
      historyEntries: [
        makeHistoryEntry('archived-newer', { endedAt: 3000, archivedAt: 4000 }),
        makeHistoryEntry('active-older', { endedAt: 2000, archivedAt: null }),
      ],
    }));

    expect(groups).toHaveLength(1);
    expect(groups[0]?.historyItems.map((item) => item.entry.id)).toEqual(['active-older']);
  });

  it('hides live run_on_node worker instances from project folders', () => {
    const groups = service.buildProjectGroups(buildInput({
      instances: [
        makeInstance('remote-worker', {
          metadata: { spawnDepth: 1, spawnParentInstanceId: 'parent-1' },
          executionLocation: { type: 'remote', nodeId: 'windows-pc' },
        }),
        makeInstance('normal-remote', {
          executionLocation: { type: 'remote', nodeId: 'windows-pc' },
        }),
      ],
    }));

    expect(groups).toHaveLength(1);
    expect(groups[0]?.liveItems.map((item) => item.instance.id)).toEqual(['normal-remote']);
    expect(groups[0]?.sessionCount).toBe(1);
  });

  it('hides superseded edit sources from project folders and counts only the replacement', () => {
    const groups = service.buildProjectGroups(buildInput({
      instances: [
        makeInstance('edited-source', {
          status: 'terminated',
          supersededBy: 'edited-replacement',
          cancelledForEdit: true,
        }),
        makeInstance('edited-replacement', {
          displayName: 'Edited replacement',
          lastActivity: 2000,
        }),
      ],
    }));

    expect(groups).toHaveLength(1);
    expect(groups[0]?.liveItems.map((item) => item.instance.id)).toEqual(['edited-replacement']);
    expect(groups[0]?.sessionCount).toBe(1);
  });

  it('hides archived worker calls marked hidden from project folders', () => {
    const groups = service.buildProjectGroups(buildInput({
      historyEntries: [
        makeHistoryEntry('hidden-worker', { hideFromProjectRail: true, endedAt: 3000 }),
        makeHistoryEntry('visible-thread', { endedAt: 2000 }),
      ],
    }));

    expect(groups).toHaveLength(1);
    expect(groups[0]?.historyItems.map((item) => item.entry.id)).toEqual(['visible-thread']);
    expect(groups[0]?.sessionCount).toBe(1);
  });
});
