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
        collapsedHistoryParentIds: new Set<string>(),
        historySortMode: 'last-interacted',
        childrenByParent: new Map<string, string[]>(),
        instanceMap: new Map([[root.id, root]]),
        activityCutoff: null,
      }
    );

    expect(items?.instance.id).toBe('inst-1');
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
      collapsedHistoryParentIds: new Set<string>(),
      historySortMode: 'last-interacted' as const,
      childrenByParent: new Map<string, string[]>(),
      instanceMap: new Map([[root.id, root]]),
      activityCutoff: 500,
    };

    const items = service.buildVisibleItems(root, context);

    expect(items).toBeNull();
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
      collapsedHistoryParentIds: new Set<string>(),
      historySortMode: 'last-interacted' as const,
      childrenByParent: new Map<string, string[]>(),
      instanceMap: new Map([
        [source.id, source],
        [replacement.id, replacement],
      ]),
      activityCutoff: null,
    };

    expect(service.buildVisibleItems(source, context)).toBeNull();
    expect(service.countSessionsInTree(source, context.childrenByParent, context.instanceMap)).toBe(0);
  });

  it('treats live non-hibernated statuses as active and archived statuses as inactive', () => {
    const activeStatuses: Instance['status'][] = [
      'initializing',
      'ready',
      'idle',
      'busy',
      'processing',
      'thinking_deeply',
      'waiting_for_input',
      'waiting_for_permission',
      'interrupting',
      'cancelling',
      'interrupt-escalating',
      'respawning',
      'hibernating',
      'waking',
      'degraded',
    ];
    const inactiveStatuses: Instance['status'][] = [
      'cancelled',
      'superseded',
      'hibernated',
      'error',
      'failed',
      'terminated',
    ];

    for (const status of activeStatuses) {
      expect(service.isActiveStatus(status), status).toBe(true);
    }
    for (const status of inactiveStatuses) {
      expect(service.isActiveStatus(status), status).toBe(false);
    }
  });

  it('includes idle sessions and excludes hibernated sessions under the active state filter', () => {
    const baseContext = {
      filter: '',
      location: 'all' as const,
      projectMatches: false,
      collapsed: new Set<string>(),
      collapsedHistoryParentIds: new Set<string>(),
      historySortMode: 'last-interacted' as const,
      childrenByParent: new Map<string, string[]>(),
      activityCutoff: null,
    };

    const busy = makeInstance({ id: 'busy-1', status: 'busy' });
    const busyItems = service.buildVisibleItems(
      busy,
      { ...baseContext, status: 'active', instanceMap: new Map([[busy.id, busy]]) }
    );
    expect(busyItems?.instance.id).toBe('busy-1');

    const idle = makeInstance({ id: 'idle-1', status: 'idle' });
    const idleItems = service.buildVisibleItems(
      idle,
      { ...baseContext, status: 'active', instanceMap: new Map([[idle.id, idle]]) }
    );
    expect(idleItems?.instance.id).toBe('idle-1');

    const hibernated = makeInstance({ id: 'hibernated-1', status: 'hibernated' });
    const hibernatedItems = service.buildVisibleItems(
      hibernated,
      { ...baseContext, status: 'active', instanceMap: new Map([[hibernated.id, hibernated]]) }
    );
    expect(hibernatedItems).toBeNull();
  });

  it('keeps an idle parent visible when a child is active under the active filter', () => {
    const parent = makeInstance({ id: 'parent-1', status: 'idle' });
    const child = makeInstance({ id: 'child-1', status: 'busy', parentId: 'parent-1', createdAt: 2 });
    const context = {
      filter: '',
      status: 'active',
      location: 'all' as const,
      projectMatches: false,
      collapsed: new Set<string>(),
      collapsedHistoryParentIds: new Set<string>(),
      historySortMode: 'last-interacted' as const,
      childrenByParent: new Map<string, string[]>([['parent-1', ['child-1']]]),
      instanceMap: new Map([
        [parent.id, parent],
        [child.id, child],
      ]),
      activityCutoff: null,
    };

    const items = service.buildVisibleItems(parent, context);
    expect(items?.instance.id).toBe('parent-1');
    expect(items?.children).toHaveLength(1);
    expect(items?.children[0]?.kind).toBe('live');
    if (items?.children[0]?.kind === 'live') {
      expect(items.children[0].instance.id).toBe('child-1');
    }
  });

  it('keeps a parent visible and expandable when a matching completed child is nested under it', () => {
    const parent = makeInstance({ id: 'parent-1', status: 'idle' });
    const childHistory = makeHistoryEntry({
      id: 'child-history-1',
      originalInstanceId: 'child-1',
      parentId: 'parent-1',
      firstUserMessage: 'Run Windows PowerShell diagnostics',
      sessionId: 'child-session-1',
    });
    const context = {
      filter: 'powershell',
      status: 'all',
      location: 'all' as const,
      projectMatches: false,
      collapsed: new Set<string>(),
      collapsedHistoryParentIds: new Set<string>(),
      historySortMode: 'last-interacted' as const,
      childrenByParent: new Map<string, string[]>(),
      historyEntriesByParent: new Map<string, ConversationHistoryEntry[]>([
        ['parent-1', [childHistory]],
      ]),
      instanceMap: new Map([[parent.id, parent]]),
      activityCutoff: null,
    };

    const items = service.buildVisibleItems(parent, context);

    expect(items?.instance.id).toBe('parent-1');
    expect(items?.hasChildren).toBe(true);
    expect(items?.childrenCount).toBe(1);
    expect(items?.children).toHaveLength(1);
    expect(items?.children[0]?.kind).toBe('history');
    if (items?.children[0]?.kind === 'history') {
      expect(items.children[0].entry.id).toBe('child-history-1');
    }
  });

  it('keeps nested history descendants attached to a live parent', () => {
    const parent = makeInstance({ id: 'parent-1', status: 'idle' });
    const childHistory = makeHistoryEntry({
      id: 'child-history-1',
      originalInstanceId: 'child-original-1',
      parentId: 'parent-1',
      sessionId: 'child-session-1',
    });
    const grandchildHistory = makeHistoryEntry({
      id: 'grandchild-history-1',
      originalInstanceId: 'grandchild-original-1',
      parentId: 'child-original-1',
      sessionId: 'grandchild-session-1',
    });
    const context = {
      filter: '',
      status: 'all',
      location: 'all' as const,
      projectMatches: false,
      collapsed: new Set<string>(),
      collapsedHistoryParentIds: new Set<string>(),
      historySortMode: 'last-interacted' as const,
      childrenByParent: new Map<string, string[]>(),
      historyEntriesByParent: new Map<string, ConversationHistoryEntry[]>([
        ['parent-1', [childHistory]],
        ['child-original-1', [grandchildHistory]],
      ]),
      instanceMap: new Map([[parent.id, parent]]),
      activityCutoff: null,
    };

    const items = service.buildVisibleItems(parent, context);

    expect(items?.childrenCount).toBe(1);
    expect(items?.children).toHaveLength(1);
    expect(items?.children[0]?.kind).toBe('history');
    if (items?.children[0]?.kind === 'history') {
      expect(items.children[0].entry.id).toBe('child-history-1');
      expect(items.children[0].children.map((entry) => entry.entry.id)).toEqual(['grandchild-history-1']);
    }
  });

  it('partitions history children by live/history parent and groups unresolved children as orphaned', () => {
    const liveParent = makeInstance({ id: 'parent-1' });
    const rootHistory = makeHistoryEntry({
      id: 'root-history-1',
      parentId: null,
      originalInstanceId: 'root-1',
      sessionId: 'root-session-1',
    });
    const nestedChild = makeHistoryEntry({
      id: 'nested-child-history-1',
      parentId: 'parent-1',
      originalInstanceId: 'child-1',
      sessionId: 'child-session-1',
    });
    const historyParent = makeHistoryEntry({
      id: 'history-parent-1',
      parentId: null,
      originalInstanceId: 'history-parent-original-1',
      sessionId: 'history-parent-session-1',
    });
    const historyChild = makeHistoryEntry({
      id: 'history-child-1',
      parentId: 'history-parent-original-1',
      originalInstanceId: 'history-child-original-1',
      sessionId: 'history-child-session-1',
    });
    const orphanedChild = makeHistoryEntry({
      id: 'orphaned-child-history-1',
      parentId: 'missing-parent',
      originalInstanceId: 'child-2',
      sessionId: 'child-session-2',
    });

    const partition = service.partitionHistoryEntriesByParent(
      [rootHistory, nestedChild, historyParent, historyChild, orphanedChild],
      new Map([[liveParent.id, liveParent]])
    );

    expect(partition.rootEntries.map((entry) => entry.id)).toEqual(['root-history-1', 'history-parent-1']);
    expect(partition.childEntriesByLiveParent.get('parent-1')?.map((entry) => entry.id)).toEqual([
      'nested-child-history-1',
    ]);
    expect(partition.childEntriesByHistoryParent.get('history-parent-original-1')?.map((entry) => entry.id)).toEqual([
      'history-child-1',
    ]);
    expect(partition.orphanedChildEntries.map((entry) => entry.id)).toEqual([
      'orphaned-child-history-1',
    ]);
  });

  it('collects nested history descendants under the visible root parent', () => {
    const rootHistory = makeHistoryEntry({
      id: 'root-history-1',
      originalInstanceId: 'root-original-1',
      parentId: null,
      sessionId: 'root-session-1',
    });
    const childHistory = makeHistoryEntry({
      id: 'child-history-1',
      originalInstanceId: 'child-original-1',
      parentId: 'root-original-1',
      sessionId: 'child-session-1',
    });
    const grandchildHistory = makeHistoryEntry({
      id: 'grandchild-history-1',
      originalInstanceId: 'grandchild-original-1',
      parentId: 'child-original-1',
      sessionId: 'grandchild-session-1',
    });

    const collected = service.collectVisibleHistoryChildrenByParent(
      [rootHistory],
      new Map<string, ConversationHistoryEntry[]>([
        ['root-original-1', [childHistory]],
        ['child-original-1', [grandchildHistory]],
      ])
    );

    expect(collected.get('root-original-1')?.map((entry) => entry.id)).toEqual([
      'child-history-1',
      'grandchild-history-1',
    ]);
  });

  it('does not re-add an ancestor when history metadata contains a cycle', () => {
    const rootHistory = makeHistoryEntry({
      id: 'root-history-1',
      originalInstanceId: 'root-original-1',
      parentId: null,
      sessionId: 'root-session-1',
    });
    const childHistory = makeHistoryEntry({
      id: 'child-history-1',
      originalInstanceId: 'child-original-1',
      parentId: 'root-original-1',
      sessionId: 'child-session-1',
    });
    const cyclicRootHistory = makeHistoryEntry({
      id: 'root-cycle-history-1',
      originalInstanceId: 'root-original-1',
      parentId: 'child-original-1',
      sessionId: 'root-cycle-session-1',
    });

    const collected = service.collectVisibleHistoryChildrenByParent(
      [rootHistory],
      new Map<string, ConversationHistoryEntry[]>([
        ['root-original-1', [childHistory]],
        ['child-original-1', [cyclicRootHistory]],
      ])
    );

    expect(collected.get('root-original-1')?.map((entry) => entry.id)).toEqual([
      'child-history-1',
    ]);
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
