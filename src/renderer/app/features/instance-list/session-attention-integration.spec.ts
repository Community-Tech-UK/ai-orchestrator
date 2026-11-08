import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NeedsYouStore } from '../workboard/needs-you.store';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { ScratchDirectoryService } from '../../core/services/scratch-directory.service';
import type { Instance } from '../../core/state/instance/instance.types';
import type { ConversationHistoryEntry } from '../../../../shared/types/history.types';
import { ProjectGroupComputationService } from './project-group-computation.service';
import { ProjectRailBuilderService, type ProjectRailBuildInput } from './project-rail-builder.service';

describe('session attention projection integration', () => {
  const needs = signal(new Set(['child']));
  const entries = signal([{ instanceId: 'child', title: 'Fix login', kind: 'answer', since: 1 }]);
  const instance = (id: string, status: Instance['status'] = 'idle', parentId: string | null = null): Instance => ({
    id, status, parentId, displayName: id === 'child' ? 'Fix login' : id, childrenIds: [], workingDirectory: '/project',
    provider: 'claude', createdAt: 1, lastActivity: 2, historyThreadId: id, sessionId: id,
    agentId: 'build', agentMode: 'build', contextUsage: { used: 0, total: 200000, percentage: 0 },
    providerSessionId: id, restartEpoch: 0, yoloMode: false, launchMode: 'interactive', outputBuffer: [],
  });
  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [
      { provide: NeedsYouStore, useValue: { sessionIds: needs, entries, reasonBySession: () => new Map([['child', 'Wants permission to use Bash']]) } },
      { provide: NewSessionDraftService, useValue: { hasSavedDraftFor: () => false, getDraftUpdatedAt: () => null } },
      { provide: ScratchDirectoryService, useValue: { isScratch: () => false } },
    ] });
  });
  afterEach(() => TestBed.resetTestingModule());
  const input = (instances: Instance[], status = 'all'): ProjectRailBuildInput => ({
    instances, status, historyEntries: [], recentDirectories: [], filter: '', location: 'all', historyVisibility: 'all',
    historyTimeWindow: 'all', selectedId: null, selectedHistoryEntryId: null, collapsed: new Set(['parent']),
    collapsedProjects: new Set(['/project']), collapsedHistoryParentIds: new Set(), historySortMode: 'created',
    rootInstanceOrder: [], showEmptyProjects: false, showHiddenAutomations: false,
  });
  it('counts a descendant once even when the tree is flattened, and names its session in the collapsed project', () => {
    const group = TestBed.inject(ProjectRailBuilderService).buildProjectGroups(input([instance('parent'), instance('child', 'waiting_for_permission', 'parent')]))[0];
    expect(group.needsYouCount).toBe(1); expect(group.mostUrgentTitle).toBe('Fix login');
    expect(group.liveItems[0].descendantNeedsYou).toBe(1); expect(group.isExpanded).toBe(false);
    const flat = [group.liveItems[0], ...group.liveItems[0].children.filter((item) => item.kind === 'live')];
    expect(TestBed.inject(ProjectGroupComputationService).getProjectStateSummary(flat, [], false).needsYouCount).toBe(1);
  });
  it.each([
    ['attn:needs-you', ['child']], ['attn:working', ['working']], ['attn:idle', ['idle', 'asleep']],
  ])('filters %s using the root needs-you membership and shared attention scale', (status, ids) => {
    const groups = TestBed.inject(ProjectRailBuilderService).buildProjectGroups(input([
      instance('child', 'waiting_for_permission'), instance('working', 'processing'), instance('idle'), instance('asleep', 'hibernated'),
    ], status));
    expect(groups.flatMap((g) => g.liveItems.map((i) => i.instance.id))).toEqual(ids);
  });
  it('carries why a session needs you onto its row in the Needs you filter', () => {
    const groups = TestBed.inject(ProjectRailBuilderService).buildProjectGroups(input([instance('child', 'waiting_for_permission'), instance('idle')], 'attn:needs-you'));
    expect(groups.flatMap((g) => g.liveItems.map((i) => i.needsYouReason))).toEqual(['Wants permission to use Bash']);
  });
  it('hides history under all attention tabs', () => {
    const history = { id: 'h', originalInstanceId: 'old', sessionId: 'old', displayName: 'old', status: 'completed', workingDirectory: '/project', createdAt: 1, endedAt: 2, provider: 'claude', parentId: null } as ConversationHistoryEntry;
    for (const status of ['attn:needs-you', 'attn:working', 'attn:idle']) {
      const groups = TestBed.inject(ProjectRailBuilderService).buildProjectGroups({ ...input([instance('idle')], status), historyEntries: [history] });
      expect(groups.flatMap((g) => g.historyItems)).toEqual([]);
    }
  });
});
