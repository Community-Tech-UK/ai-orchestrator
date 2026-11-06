import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NewSessionDraftService } from './new-session-draft.service';
import { ProviderStateService } from './provider-state.service';
import { WorkspaceIpcService } from './ipc/workspace-ipc.service';
import { ScratchDirectoryService } from './scratch-directory.service';
import { snapshotActiveComposer, restoreComposerSnapshot } from './new-session-draft-undo';
describe('discarded new-session draft', () => {
  let draft: NewSessionDraftService;
  beforeEach(() => {
    localStorage.clear(); TestBed.configureTestingModule({ providers: [
      { provide: ProviderStateService, useValue: { getLastModelForProvider: () => undefined, getLaunchModeForProvider: () => 'orchestrated' } },
      { provide: WorkspaceIpcService, useValue: { hintActive: vi.fn() } },
      { provide: ScratchDirectoryService, useValue: { init: async () => undefined, isScratch: () => false } },
    ] }); draft = TestBed.inject(NewSessionDraftService);
  });
  it('restores text, folders, agent and File identities through public setters', () => {
    const file = new File(['note'], 'note.txt'); draft.open('/project', 'node'); draft.setPrompt('Original');
    draft.setAgentId('plan'); draft.addPendingFolder('/other'); draft.addPendingFiles([file]);
    const snap = snapshotActiveComposer(draft); draft.clearActiveComposer();
    expect(restoreComposerSnapshot(draft, snap)).toBe(true);
    expect(draft.prompt()).toBe('Original'); expect(draft.pendingFolders()).toEqual(['/other']);
    expect(draft.agentId()).toBe('plan'); expect(draft.pendingFiles()).toEqual([file]);
    expect(draft.nodeId()).toBe('node');
  });
  it('keeps later text and another project draft when returning to the original project', () => {
    draft.open('/project'); draft.setPrompt('Original'); const snap = snapshotActiveComposer(draft);
    draft.clearActiveComposer(); draft.setPrompt('Later'); draft.open('/second'); draft.setPrompt('Other project');
    expect(restoreComposerSnapshot(draft, snap)).toBe(true); expect(draft.prompt()).toBe('Original\n\nLater');
    draft.open('/second'); expect(draft.prompt()).toBe('Other project');
  });
});
