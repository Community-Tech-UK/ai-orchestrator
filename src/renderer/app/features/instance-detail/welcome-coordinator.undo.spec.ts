import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceStore } from '../../core/state/instance.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { RecentDirectoriesIpcService, VcsIpcService, OrchestrationIpcService } from '../../core/services/ipc';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { WorkspaceIpcService } from '../../core/services/ipc/workspace-ipc.service';
import { ScratchDirectoryService } from '../../core/services/scratch-directory.service';
import { ToastService } from '../../core/services/toast.service';
import { UndoService } from '../../core/services/undo.service';
import { FileAttachmentService } from './file-attachment.service';
import { WelcomeCoordinatorService } from './welcome-coordinator.service';

describe('WelcomeCoordinatorService draft discard', () => {
  beforeEach(() => {
    TestBed.resetTestingModule();
    localStorage.removeItem('new-session-drafts:v1');
    vi.useFakeTimers();
    TestBed.configureTestingModule({ providers: [
      { provide: InstanceStore, useValue: {} },
      { provide: RemoteNodeStore, useValue: {} },
      { provide: RecentDirectoriesIpcService, useValue: {} },
      { provide: VcsIpcService, useValue: {} },
      { provide: OrchestrationIpcService, useValue: {} },
      { provide: FileAttachmentService, useValue: {} },
      { provide: ProviderStateService, useValue: { getLastModelForProvider: () => undefined, getLaunchModeForProvider: () => 'orchestrated' } },
      { provide: WorkspaceIpcService, useValue: { hintActive: vi.fn() } },
      { provide: ScratchDirectoryService, useValue: { init: async () => undefined, isScratch: () => false } },
    ] });
  });
  afterEach(() => {
    vi.runOnlyPendingTimers();
    TestBed.resetTestingModule();
    localStorage.removeItem('new-session-drafts:v1');
    vi.useRealTimers();
  });

  it('discards the real draft and registers a five-second Undo that restores its content', async () => {
    const draft = TestBed.inject(NewSessionDraftService);
    const file = new File(['note'], 'note.txt');
    draft.open('/project', 'windows-pc');
    draft.setPrompt('Original prompt');
    draft.setAgentId('plan');
    draft.addPendingFolder('/notes');
    draft.addPendingFiles([file]);
    const coordinator = TestBed.inject(WelcomeCoordinatorService);
    coordinator.onWelcomeDiscardDraft();
    expect(draft.prompt()).toBe('');
    expect(draft.pendingFiles()).toEqual([]);
    expect(draft.pendingFolders()).toEqual([]);
    expect(TestBed.inject(ToastService).toasts()[0]).toMatchObject({
      text: 'Draft discarded', durationMs: 5000, action: { label: 'Undo' },
    });
    draft.setPrompt('Later text');
    await TestBed.inject(UndoService).undoLast();
    expect(draft.prompt()).toBe('Original prompt\n\nLater text');
    expect(draft.pendingFiles()[0]).toBe(file);
    expect(draft.pendingFolders()).toEqual(['/notes']);
    expect(draft.agentId()).toBe('plan');
    expect(draft.nodeId()).toBe('windows-pc');
    expect(TestBed.inject(ToastService).toasts()[0].text).toBe('Restored: Draft discarded');
  });
});
