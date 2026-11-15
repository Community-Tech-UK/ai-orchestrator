import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSideChatHarness, type SideChatHarness } from '../../main/chats/side-chat.test-helpers';
import { isHiddenFromMobile, isOperatorSession } from '../../main/mobile-gateway/mobile-gateway-session-visibility';
import { instanceToContinuityState } from '../../main/session/session-continuity-instance-state';
import { buildContinuityRecoveryMetadata } from '../../main/session/continuity-recovery-metadata';
import { SessionRecoveryCandidateService } from '../../main/session/session-recovery-candidate-service';
import { InstanceStore } from '../../renderer/app/core/state/instance.store';
import { HistoryStore } from '../../renderer/app/core/state/history.store';
import { UsageStore } from '../../renderer/app/core/state/usage.store';
import { NewSessionDraftService } from '../../renderer/app/core/services/new-session-draft.service';
import { ScratchDirectoryService } from '../../renderer/app/core/services/scratch-directory.service';
import { ProjectRailBuilderService, type ProjectRailBuildInput } from '../../renderer/app/features/instance-list/project-rail-builder.service';
import { SessionAttentionTabsComponent } from '../../renderer/app/features/instance-list/session-attention-tabs.component';
import { SessionPickerController } from '../../renderer/app/features/sessions/session-picker.controller';
import { NeedsYouStore } from '../../renderer/app/features/workboard/needs-you.store';
import { requestEntries } from '../../renderer/app/features/workboard/needs-you-sources';
import type { Instance } from '../../shared/types/instance.types';
import type { SideChatParentRef } from '../../shared/types/side-chat.types';

vi.mock('../../main/core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ defaultModelByProvider: {} }) }),
}));

const parent: SideChatParentRef = { kind: 'session', historyThreadId: 'parent-thread', originNodeId: null };

function railInput(instances: Instance[]): ProjectRailBuildInput {
  return {
    instances: instances as ProjectRailBuildInput['instances'], historyEntries: [], recentDirectories: [],
    filter: '', status: 'all', location: 'all', historyVisibility: 'all', historyTimeWindow: 'all',
    selectedId: null, selectedHistoryEntryId: null, collapsed: new Set(), collapsedProjects: new Set(),
    collapsedHistoryParentIds: new Set(), historySortMode: 'last-interacted', rootInstanceOrder: [],
    showEmptyProjects: false, showHiddenAutomations: false,
  };
}

describe('a real sidechat runtime stays out of ordinary session surfaces', () => {
  let h: SideChatHarness;
  let runtime: Instance;

  beforeEach(async () => {
    h = createSideChatHarness();
    await h.service.whenReady();
    h.runtimes.addSession({ historyThreadId: 'parent-thread', workingDirectory: '/work', displayName: 'Parent' });
    const detail = await h.service.sideChats.create({ parent, selection: { provider: 'claude', model: 'sonnet' }, currentCwd: '/work' });
    const sent = await h.service.sideChats.send({ chatId: detail.chat.id, text: 'What changed?' });
    expect(sent.ok).toBe(true);
    runtime = h.runtimes.getInstance((await h.service.getChat(detail.chat.id)).chat.currentInstanceId!)!;
    runtime.outputBuffer = [{ id: 'question', type: 'user', content: 'What changed?', timestamp: Date.now() }];
    TestBed.configureTestingModule({ providers: [
      { provide: InstanceStore, useValue: { instances: signal(h.runtimes.getAllInstances()) } },
      { provide: HistoryStore, useValue: { entries: signal([]) } },
      { provide: UsageStore, useValue: { frecency: () => 0 } },
      { provide: NeedsYouStore, useValue: { sessionIds: () => new Set(), entries: () => [], reasonBySession: () => new Map() } },
      { provide: NewSessionDraftService, useValue: { hasSavedDraftFor: () => false, getDraftUpdatedAt: () => null } },
      { provide: ScratchDirectoryService, useValue: { isScratch: () => false } },
    ] });
  });

  afterEach(async () => { TestBed.resetTestingModule(); await h.dispose(); });

  it('excludes it from desktop rows and project counts even if selected', () => {
    const input = railInput(h.runtimes.getAllInstances());
    input.selectedId = runtime.id;
    const groups = TestBed.inject(ProjectRailBuilderService).buildProjectGroups(input);
    expect(groups.flatMap(group => group.liveItems.map(item => item.instance.id))).toEqual([h.runtimes.getAllInstances()[0].id]);
    expect(groups.reduce((count, group) => count + group.sessionCount, 0)).toBe(1);
  });

  it('excludes it from Working, Idle and All tab counts', () => {
    const component = TestBed.runInInjectionContext(() => new SessionAttentionTabsComponent());
    expect(component.tabs().map(tab => tab.count)).toEqual([0, 1, 0, 1]);
  });

  it('excludes it from the session switcher', () => {
    const items = TestBed.inject(SessionPickerController).groups().flatMap(group => group.items);
    expect(items.map(item => item.value.id)).toEqual([h.runtimes.getAllInstances()[0].id]);
  });

  it('excludes it from the phone session list and operator notifications', () => {
    expect(isHiddenFromMobile(runtime)).toBe(true);
    expect(isOperatorSession(runtime)).toBe(false);
  });

  it('carries its hidden state through continuity metadata and excludes crash restore offers', async () => {
    const state = instanceToContinuityState(runtime, { persistSessionContent: true, redactToolOutputs: false });
    expect(state.hideFromProjectRail).toBe(true);
    const metadata = buildContinuityRecoveryMetadata(state, Date.now());
    const recovery = new SessionRecoveryCandidateService({
      getSnapshot: () => null, waitForContinuityReady: async () => undefined,
      listContinuityMetadata: async () => [metadata], loadContinuityState: async () => state,
      waitForHistoryReady: async () => undefined, getHistoryCoverage: async () => new Map(),
      loadHistoryConversation: async () => null, isSuppressedByHistory: () => false,
      getLiveRecoveryKeys: () => new Set(), now: () => Date.now(),
    });
    await expect(recovery.listCandidates()).resolves.toEqual([]);
  });

  it('still reports its approval through the parent Needs you entry', async () => {
    expect(runtime.metadata?.['hideFromProjectRail']).toBe(true);
    h.runtimes.setStatus(runtime.id, 'waiting_for_permission');
    const attention = await h.service.sideChats.attention(parent);
    const entries = requestEntries({
      permissions: [], browsers: [], fallbacks: [], plans: [], documents: [], memories: [],
      sidechats: [attention], outstanding: [], toolLoops: [], sessionQuestions: [],
    }, Date.now());
    expect(entries).toEqual([expect.objectContaining({ source: 'sidechat', key: 'sidechat:session:parent-thread' })]);
    expect(attention.targetChatId).toBe(runtime.metadata?.['sideChatId']);
  });
});
