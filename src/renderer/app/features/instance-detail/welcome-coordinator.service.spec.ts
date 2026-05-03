import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceStore } from '../../core/state/instance.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { RecentDirectoriesIpcService, VcsIpcService } from '../../core/services/ipc';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { OrchestrationIpcService } from '../../core/services/ipc';
import { FileAttachmentService } from './file-attachment.service';
import { WelcomeCoordinatorService } from './welcome-coordinator.service';

describe('WelcomeCoordinatorService workflow launch', () => {
  let service: WelcomeCoordinatorService;
  let store: {
    createInstanceWithMessageAndReturnId: ReturnType<typeof vi.fn>;
    setError: ReturnType<typeof vi.fn>;
  };
  let orchestration: {
    workflowCanTransition: ReturnType<typeof vi.fn>;
    workflowStart: ReturnType<typeof vi.fn>;
  };
  let newSessionDraft: {
    pendingFiles: ReturnType<typeof signal<File[]>>;
    pendingFolders: ReturnType<typeof signal<string[]>>;
    workingDirectory: ReturnType<typeof signal<string | null>>;
    provider: ReturnType<typeof signal<'claude' | null>>;
    model: ReturnType<typeof signal<string | null>>;
    agentId: ReturnType<typeof signal<string>>;
    nodeId: ReturnType<typeof signal<string | null>>;
    updatedAt: ReturnType<typeof signal<number>>;
    hasActiveContent: ReturnType<typeof signal<boolean>>;
    setNodeId: ReturnType<typeof vi.fn>;
    clearActiveComposer: ReturnType<typeof vi.fn>;
  };
  let recentDirs: {
    addDirectory: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    store = {
      createInstanceWithMessageAndReturnId: vi.fn().mockResolvedValue('inst-new'),
      setError: vi.fn(),
    };
    orchestration = {
      workflowCanTransition: vi.fn().mockResolvedValue({
        success: true,
        data: {
          policy: { kind: 'allow' },
          activeExecutionId: null,
          requestedTemplateId: 'pr-review',
        },
      }),
      workflowStart: vi.fn().mockResolvedValue({ success: true }),
    };
    newSessionDraft = {
      pendingFiles: signal<File[]>([]),
      pendingFolders: signal<string[]>(['plans']),
      workingDirectory: signal<string | null>('/repo'),
      provider: signal<'claude' | null>('claude'),
      model: signal<string | null>(null),
      agentId: signal('build'),
      nodeId: signal<string | null>(null),
      updatedAt: signal(1),
      hasActiveContent: signal(true),
      setNodeId: vi.fn(),
      clearActiveComposer: vi.fn(),
    };
    recentDirs = {
      addDirectory: vi.fn().mockResolvedValue(undefined),
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        WelcomeCoordinatorService,
        { provide: InstanceStore, useValue: store },
        { provide: RemoteNodeStore, useValue: { nodeById: vi.fn() } },
        { provide: RecentDirectoriesIpcService, useValue: recentDirs },
        { provide: VcsIpcService, useValue: { vcsIsRepo: vi.fn(), vcsGetStatus: vi.fn() } },
        {
          provide: ProviderStateService,
          useValue: {
            getProviderForCreation: vi.fn(() => 'claude'),
            getModelForCreation: vi.fn(() => undefined),
          },
        },
        { provide: NewSessionDraftService, useValue: newSessionDraft },
        { provide: OrchestrationIpcService, useValue: orchestration },
        {
          provide: FileAttachmentService,
          useValue: {
            prependPendingFolders: vi.fn((message: string, folders: string[]) =>
              folders.length > 0 ? `Folders:\n${folders.join('\n')}\n\n${message}` : message,
            ),
          },
        },
      ],
    });

    service = TestBed.inject(WelcomeCoordinatorService);
  });

  it('creates the welcome session before starting the accepted workflow', async () => {
    const creatingStates: boolean[] = [];

    const launched = await service.onWelcomeStartSessionWithWorkflow(
      'Please review this plan',
      'pr-review',
      (creating) => creatingStates.push(creating),
    );

    expect(launched).toBe(true);
    expect(store.createInstanceWithMessageAndReturnId).toHaveBeenCalledWith({
      message: 'Folders:\nplans\n\nPlease review this plan',
      files: [],
      workingDirectory: '/repo',
      agentId: 'build',
      provider: 'claude',
      model: 'opus',
      forceNodeId: undefined,
    });
    expect(orchestration.workflowCanTransition).toHaveBeenCalledWith({
      instanceId: 'inst-new',
      templateId: 'pr-review',
      source: 'nl-suggestion',
    });
    expect(orchestration.workflowStart).toHaveBeenCalledWith({
      instanceId: 'inst-new',
      templateId: 'pr-review',
      source: 'nl-suggestion',
    });
    expect(newSessionDraft.clearActiveComposer).toHaveBeenCalled();
    expect(recentDirs.addDirectory).toHaveBeenCalledWith('/repo', undefined);
    expect(creatingStates).toEqual([true]);
  });
});
