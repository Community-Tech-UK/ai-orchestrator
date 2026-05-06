import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import type { Instance } from '../../core/state/instance.store';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import { ProjectGroupComputationService } from './project-group-computation.service';

function makeInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    displayName: 'Refactor settings panel',
    createdAt: 1,
    historyThreadId: 'thread-1',
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
    lastActivity: 2,
    providerSessionId: 'provider-session-1',
    sessionId: 'session-1',
    restartEpoch: 0,
    workingDirectory: '/Users/me/work/ai-orchestrator',
    yoloMode: false,
    currentModel: 'gpt-5.2-codex',
    outputBuffer: [],
    ...overrides,
  };
}

function makeHistoryEntry(overrides: Partial<ConversationHistoryEntry> = {}): ConversationHistoryEntry {
  return {
    id: 'history-1',
    displayName: 'Auth follow-up',
    createdAt: 1,
    endedAt: 2,
    workingDirectory: '/Users/me/work/ai-orchestrator',
    messageCount: 2,
    firstUserMessage: 'Tighten auth middleware checks',
    lastUserMessage: 'Ship the tests',
    status: 'completed',
    originalInstanceId: 'inst-1',
    parentId: null,
    sessionId: 'session-1',
    provider: 'claude',
    currentModel: 'claude-sonnet-4.5',
    ...overrides,
  };
}

describe('ProjectGroupComputationService filtering', () => {
  let service: ProjectGroupComputationService;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        ProjectGroupComputationService,
        {
          provide: NewSessionDraftService,
          useValue: {
            hasSavedDraftFor: () => false,
            getDraftUpdatedAt: () => null,
          },
        },
      ],
    });

    service = TestBed.inject(ProjectGroupComputationService);
  });

  afterEach(() => {
    TestBed.resetTestingModule();
  });

  it('matches project queries by terms across title and path', () => {
    expect(
      service.matchesProjectText(
        'AI Orchestrator',
        '/Users/me/work/ai-orchestrator',
        'ai work'
      )
    ).toBe(true);
  });

  it('matches live sessions by provider, model, and project fields', () => {
    const root = makeInstance();
    const items = service.buildVisibleItems(
      root,
      {
        filter: 'codex gpt-5 orchestrator',
        status: 'all',
        location: 'all',
        projectMatches: false,
        collapsed: new Set<string>(),
        childrenByParent: new Map<string, string[]>(),
        instanceMap: new Map([[root.id, root]]),
        activityCutoff: null,
      },
      0,
      [],
      true
    );

    expect(items.map((item) => item.instance.id)).toEqual(['inst-1']);
  });

  it('filters live sessions older than the activity cutoff', () => {
    const root = makeInstance({
      createdAt: 100,
      lastActivity: 200,
    });
    const context = {
      filter: '',
      status: 'all',
      location: 'all' as const,
      projectMatches: false,
      collapsed: new Set<string>(),
      childrenByParent: new Map<string, string[]>(),
      instanceMap: new Map([[root.id, root]]),
      activityCutoff: 500,
    };

    const items = service.buildVisibleItems(root, context, 0, [], true);

    expect(items).toEqual([]);
  });

  it('hides a superseded edit source when its replacement is present', () => {
    const source = makeInstance({
      id: 'source-1',
      status: 'superseded',
      supersededBy: 'replacement-1',
      cancelledForEdit: true,
    });
    const replacement = makeInstance({
      id: 'replacement-1',
      displayName: 'Edited continuation',
      createdAt: 3,
      lastActivity: 4,
    });
    const context = {
      filter: '',
      status: 'all',
      location: 'all' as const,
      projectMatches: false,
      collapsed: new Set<string>(),
      childrenByParent: new Map<string, string[]>(),
      instanceMap: new Map([
        [source.id, source],
        [replacement.id, replacement],
      ]),
      activityCutoff: null,
    };

    expect(service.buildVisibleItems(source, context, 0, [], true)).toEqual([]);
    expect(service.countSessionsInTree(source, context.childrenByParent, context.instanceMap)).toBe(0);
  });

  it('matches history queries by provider, model, prompt text, and project fields', () => {
    expect(
      service.matchesHistoryText(
        makeHistoryEntry(),
        'claude sonnet auth orchestrator'
      )
    ).toBe(true);
  });
});
