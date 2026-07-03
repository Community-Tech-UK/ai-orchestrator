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
import { CLAUDE_MODELS } from '../../../../shared/types/provider.types';

describe('WelcomeCoordinatorService workflow launch', () => {
  let service: WelcomeCoordinatorService;
  let store: {
    createInstanceWithMessage: ReturnType<typeof vi.fn>;
    createInstanceAndReturnId: ReturnType<typeof vi.fn>;
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
    yoloMode: ReturnType<typeof signal<boolean | null>>;
    launchMode: ReturnType<typeof signal<'orchestrated' | 'interactive' | null>>;
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
      createInstanceWithMessage: vi.fn().mockResolvedValue(true),
      createInstanceAndReturnId: vi.fn().mockResolvedValue('inst-new'),
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
      yoloMode: signal<boolean | null>(null),
      launchMode: signal<'orchestrated' | 'interactive' | null>('orchestrated'),
      nodeId: signal<string | null>(null),
      updatedAt: signal(1),
      hasActiveContent: signal(true),
      setNodeId: vi.fn((nodeId: string | null) => {
        newSessionDraft.nodeId.set(nodeId);
      }),
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
            getLaunchModeForProvider: vi.fn(() => 'orchestrated'),
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
      model: CLAUDE_MODELS.OPUS_1M,
      launchMode: 'orchestrated',
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

  it('creates a blank welcome session before starting loop mode', async () => {
    const creatingStates: boolean[] = [];
    const startLoop = vi.fn().mockResolvedValue({ ok: true });

    const launched = await service.onWelcomeStartSessionWithLoop(
      'Please implement this plan',
      {
        initialPrompt: 'Please implement this plan',
        iterationPrompt: 'Continue until done',
        workspaceCwd: '/repo',
        provider: 'claude',
        contextStrategy: 'fresh-child',
      },
      (creating) => creatingStates.push(creating),
      startLoop,
    );

    expect(launched).toBe(true);
    expect(store.createInstanceAndReturnId).toHaveBeenCalledWith({
      workingDirectory: '/repo',
      agentId: 'build',
      provider: 'claude',
      model: CLAUDE_MODELS.OPUS_1M,
      launchMode: 'orchestrated',
      forceNodeId: undefined,
    });
    expect(store.createInstanceWithMessageAndReturnId).not.toHaveBeenCalled();
    expect(startLoop).toHaveBeenCalledWith('inst-new', {
      initialPrompt: 'Folders:\nplans\n\nPlease implement this plan',
      iterationPrompt: 'Folders:\nplans\n\nContinue until done',
      workspaceCwd: '/repo',
      provider: 'claude',
      contextStrategy: 'fresh-child',
    });
    expect(newSessionDraft.clearActiveComposer).toHaveBeenCalled();
    expect(recentDirs.addDirectory).toHaveBeenCalledWith('/repo', undefined);
    expect(creatingStates).toEqual([true]);
  });

  it('passes interactive launch mode through normal welcome session creation', async () => {
    newSessionDraft.launchMode.set('interactive');

    const launched = await service.onWelcomeSendMessage(
      'Open a terminal session',
      vi.fn(),
    );

    expect(launched).toBe(true);
    expect(store.createInstanceWithMessageAndReturnId).not.toHaveBeenCalled();
    expect(store.createInstanceWithMessage).toHaveBeenCalledWith({
      message: 'Folders:\nplans\n\nOpen a terminal session',
      files: [],
      workingDirectory: '/repo',
      agentId: 'build',
      provider: 'claude',
      model: CLAUDE_MODELS.OPUS_1M,
      launchMode: 'interactive',
      forceNodeId: undefined,
    });
  });

  it('passes the explicit draft yolo override through normal welcome session creation', async () => {
    newSessionDraft.yoloMode.set(true);

    const launched = await service.onWelcomeSendMessage(
      'Delete the stale copy',
      vi.fn(),
    );

    expect(launched).toBe(true);
    expect(store.createInstanceWithMessage).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Folders:\nplans\n\nDelete the stale copy',
      workingDirectory: '/repo',
      yoloMode: true,
    }));
  });

  it('syncs welcome node selection from the active draft node', async () => {
    const creatingChange = vi.fn();
    newSessionDraft.nodeId.set('node-stale');
    TestBed.flushEffects();
    newSessionDraft.nodeId.set(null);
    TestBed.flushEffects();

    const launched = await service.onWelcomeSendMessage(
      'Start locally',
      creatingChange,
    );

    expect(launched).toBe(true);
    expect(store.createInstanceWithMessage).toHaveBeenCalledWith({
      message: 'Folders:\nplans\n\nStart locally',
      files: [],
      workingDirectory: '/repo',
      agentId: 'build',
      provider: 'claude',
      model: CLAUDE_MODELS.OPUS_1M,
      launchMode: 'orchestrated',
      forceNodeId: undefined,
    });
  });

  it('blocks workflow orchestration for interactive launch mode', async () => {
    newSessionDraft.launchMode.set('interactive');

    const launched = await service.onWelcomeStartSessionWithWorkflow(
      'Please review this plan',
      'pr-review',
      vi.fn(),
    );

    expect(launched).toBe(false);
    expect(store.createInstanceWithMessageAndReturnId).not.toHaveBeenCalled();
    expect(orchestration.workflowCanTransition).not.toHaveBeenCalled();
    expect(store.setError).toHaveBeenCalledWith(
      'Interactive Claude sessions are human-driven and cannot start workflows. Switch to Orchestrated to use workflows.',
    );
  });

  it('blocks loop orchestration for interactive launch mode', async () => {
    newSessionDraft.launchMode.set('interactive');
    const startLoop = vi.fn().mockResolvedValue({ ok: true });

    const launched = await service.onWelcomeStartSessionWithLoop(
      'Please implement this plan',
      {
        initialPrompt: 'Please implement this plan',
        iterationPrompt: 'Continue until done',
        workspaceCwd: '/repo',
        provider: 'claude',
        contextStrategy: 'fresh-child',
      },
      vi.fn(),
      startLoop,
    );

    expect(launched).toBe(false);
    expect(store.createInstanceAndReturnId).not.toHaveBeenCalled();
    expect(startLoop).not.toHaveBeenCalled();
    expect(store.setError).toHaveBeenCalledWith(
      'Interactive Claude sessions are human-driven and cannot start Loop Mode. Switch to Orchestrated to use Loop Mode.',
    );
  });
});
