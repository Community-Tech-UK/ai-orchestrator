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
import type { ModelRuntimeTarget } from '../../../../shared/types/local-model-runtime.types';
import type { ReasoningEffort } from '../../../../shared/types/provider.types';
import type { RemoteNodeRosterEntry } from '../../../../shared/types/worker-node.types';

function makeRemoteNode(
  status: RemoteNodeRosterEntry['status'],
  connected: boolean,
): RemoteNodeRosterEntry {
  const capabilities: RemoteNodeRosterEntry['capabilities'] = {
    platform: 'linux',
    arch: 'x64',
    cpuCores: 8,
    totalMemoryMB: 16384,
    availableMemoryMB: 8192,
    supportedClis: ['claude'],
    hasBrowserRuntime: false,
    hasBrowserMcp: false,
    hasAndroidMcp: false,
    hasDocker: false,
    maxConcurrentInstances: 4,
    workingDirectories: ['/repo'],
    browsableRoots: [],
    discoveredProjects: [],
  };

  return {
    id: 'node-1',
    name: 'Remote worker',
    status,
    connected,
    platform: 'linux',
    address: '100.64.1.3',
    supportedClis: capabilities.supportedClis,
    hasBrowserRuntime: false,
    hasBrowserMcp: false,
    hasAndroidMcp: false,
    hasDocker: false,
    activeInstances: 0,
    maxConcurrentInstances: 4,
    workingDirectories: ['/repo'],
    capabilities,
  };
}

describe('WelcomeCoordinatorService workflow launch', () => {
  let service: WelcomeCoordinatorService;
  let store: {
    createInstanceWithMessageResult: ReturnType<typeof vi.fn>;
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
    modelRuntimeTarget: ReturnType<typeof signal<ModelRuntimeTarget | null>>;
    reasoningEffort: ReturnType<typeof signal<ReasoningEffort | null>>;
    agentId: ReturnType<typeof signal<string>>;
    yoloMode: ReturnType<typeof signal<boolean | null>>;
    hardened: ReturnType<typeof signal<boolean | null>>;
    copilotAccountProfileId: ReturnType<typeof signal<string | null>>;
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
  let remoteNodeStore: {
    nodeById: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    store = {
      createInstanceWithMessageResult: vi.fn().mockResolvedValue({ ok: true, instanceId: 'inst-new' }),
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
      modelRuntimeTarget: signal<ModelRuntimeTarget | null>(null),
      reasoningEffort: signal<ReasoningEffort | null>('high'),
      agentId: signal('build'),
      yoloMode: signal<boolean | null>(null),
      hardened: signal<boolean | null>(null),
      copilotAccountProfileId: signal<string | null>(null),
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
    remoteNodeStore = {
      nodeById: vi.fn(),
    };

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        WelcomeCoordinatorService,
        { provide: InstanceStore, useValue: store },
        { provide: RemoteNodeStore, useValue: remoteNodeStore },
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
      reasoningEffort: 'high',
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
      reasoningEffort: 'high',
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

    const launched = (await service.submitWelcomeMessage(
      'Open a terminal session',
      vi.fn(),
    )).ok;

    expect(launched).toBe(true);
    expect(store.createInstanceWithMessageAndReturnId).not.toHaveBeenCalled();
    expect(store.createInstanceWithMessageResult).toHaveBeenCalledWith({
      message: 'Folders:\nplans\n\nOpen a terminal session',
      files: [],
      workingDirectory: '/repo',
      agentId: 'build',
      provider: 'claude',
      model: CLAUDE_MODELS.OPUS_1M,
      reasoningEffort: 'high',
      launchMode: 'interactive',
      forceNodeId: undefined,
    });
  });

  it('passes the explicit draft yolo override through normal welcome session creation', async () => {
    newSessionDraft.yoloMode.set(true);

    const launched = (await service.submitWelcomeMessage(
      'Delete the stale copy',
      vi.fn(),
    )).ok;

    expect(launched).toBe(true);
    expect(store.createInstanceWithMessageResult).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Folders:\nplans\n\nDelete the stale copy',
      workingDirectory: '/repo',
      yoloMode: true,
    }));
  });

  it('passes the draft hardened toggle through normal welcome session creation', async () => {
    newSessionDraft.hardened.set(true);

    const launched = (await service.submitWelcomeMessage(
      'Investigate the flaky spec',
      vi.fn(),
    )).ok;

    expect(launched).toBe(true);
    expect(store.createInstanceWithMessageResult).toHaveBeenCalledWith(expect.objectContaining({
      workingDirectory: '/repo',
      hardened: true,
    }));
  });

  it('forwards an explicit provider-decide effort instead of collapsing it to the default', async () => {
    // The picker's "Provider — let the provider decide" row stores null. Once a
    // provider has been chosen the draft's effort is authoritative, so null must
    // reach the backend as null rather than being dropped (which would re-apply
    // the app default and make the control do the opposite of its label).
    newSessionDraft.reasoningEffort.set(null);

    const launched = (await service.submitWelcomeMessage('Provider decides', vi.fn())).ok;

    expect(launched).toBe(true);
    expect(store.createInstanceWithMessageResult).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: null }),
    );
  });

  it('omits reasoning effort entirely for a pristine draft', async () => {
    // A draft that never had a provider picked carries a meaningless null, so
    // the field is omitted and the spawn path applies the app default.
    newSessionDraft.provider.set(null);
    newSessionDraft.reasoningEffort.set(null);

    const launched = (await service.submitWelcomeMessage('Untouched draft', vi.fn())).ok;

    expect(launched).toBe(true);
    const payload = store.createInstanceWithMessageResult.mock.calls[0][0] as Record<string, unknown>;
    expect('reasoningEffort' in payload).toBe(false);
  });

  it('passes local model runtime targets through normal welcome session creation', async () => {
    const modelRuntimeTarget: ModelRuntimeTarget = {
      kind: 'local-model',
      source: 'worker-node',
      selectorId: 'lm://worker-node/node-1/ollama/ollama/qwen',
      nodeId: 'node-1',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen',
    };
    newSessionDraft.provider.set(null);
    newSessionDraft.model.set('qwen');
    newSessionDraft.modelRuntimeTarget.set(modelRuntimeTarget);
    remoteNodeStore.nodeById.mockReturnValue(makeRemoteNode('connected', true));

    const launched = (await service.submitWelcomeMessage(
      'Use the worker model',
      vi.fn(),
    )).ok;

    expect(launched).toBe(true);
    expect(store.createInstanceWithMessageResult).toHaveBeenCalledWith({
      message: 'Folders:\nplans\n\nUse the worker model',
      files: [],
      workingDirectory: '/repo',
      agentId: 'build',
      provider: undefined,
      model: 'qwen',
      modelRuntimeTarget,
      launchMode: undefined,
      forceNodeId: 'node-1',
    });
  });

  it('syncs welcome node selection from the active draft node', async () => {
    const creatingChange = vi.fn();
    newSessionDraft.nodeId.set('node-stale');
    TestBed.flushEffects();
    newSessionDraft.nodeId.set(null);
    TestBed.flushEffects();

    const launched = (await service.submitWelcomeMessage(
      'Start locally',
      creatingChange,
    )).ok;

    expect(launched).toBe(true);
    expect(store.createInstanceWithMessageResult).toHaveBeenCalledWith({
      message: 'Folders:\nplans\n\nStart locally',
      files: [],
      workingDirectory: '/repo',
      agentId: 'build',
      provider: 'claude',
      model: CLAUDE_MODELS.OPUS_1M,
      reasoningEffort: 'high',
      launchMode: 'orchestrated',
      forceNodeId: undefined,
    });
  });

  it('blocks launch when the selected node has stale connected status but no live socket', async () => {
    remoteNodeStore.nodeById.mockReturnValue(makeRemoteNode('connected', false));
    service.onWelcomeNodeChange('node-1');
    const creatingChange = vi.fn();

    const launched = (await service.submitWelcomeMessage(
      'Run on the selected node',
      creatingChange,
    )).ok;

    expect(launched).toBe(false);
    expect(store.setError).toHaveBeenCalledWith(
      'Selected remote node is no longer connected. Please choose another node or use Local.',
    );
    expect(store.createInstanceWithMessageResult).not.toHaveBeenCalled();
    expect(creatingChange).not.toHaveBeenCalled();
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

  it('uses the submission-supplied attachments rather than the live draft', async () => {
    // A retry of a composition recovered after a restart has an empty live
    // draft — `pendingFilesByKey` is in-memory only. Reading the draft here
    // would send a text-only message and then delete the images as "accepted".
    newSessionDraft.pendingFiles.set([]);
    newSessionDraft.pendingFolders.set([]);
    const journalled = new File([new Uint8Array(16)], 'pasted-image-1.png', { type: 'image/png' });

    const result = await service.submitWelcomeMessage(
      'recovered prompt',
      vi.fn(),
      'sub-42',
      { files: [journalled], pendingFolders: ['plans'] },
    );

    expect(result.ok).toBe(true);
    expect(store.createInstanceWithMessageResult).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [journalled],
        message: 'Folders:\nplans\n\nrecovered prompt',
        idempotencyKey: 'sub-42',
      }),
    );
  });

  it('keeps the selected remote node after a failure so a retry still targets it', async () => {
    remoteNodeStore.nodeById.mockReturnValue(makeRemoteNode('connected', true));
    service.onWelcomeNodeChange('node-1');
    store.createInstanceWithMessageResult.mockResolvedValue({ ok: false, error: 'spawn failed' });

    const result = await service.submitWelcomeMessage('try this', vi.fn(), 'sub-1');

    expect(result).toEqual({ ok: false, error: 'spawn failed' });
    // Clearing it here would make the retry silently launch on the local
    // machine instead of the node the user picked.
    expect(service.welcomeSelectedNodeId()).toBe('node-1');
    expect(newSessionDraft.nodeId()).toBe('node-1');
  });

  it('reports the preparation failure reason instead of a bare false', async () => {
    remoteNodeStore.nodeById.mockReturnValue(makeRemoteNode('disconnected', false));
    service.onWelcomeNodeChange('node-1');

    const result = await service.submitWelcomeMessage('go', vi.fn(), 'sub-2');

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('no longer connected');
    expect(store.createInstanceWithMessageResult).not.toHaveBeenCalled();
  });
});
