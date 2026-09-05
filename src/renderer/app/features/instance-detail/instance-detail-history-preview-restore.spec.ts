import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceStore } from '../../core/state/instance.store';
import { HistoryStore } from '../../core/state/history.store';
import { SettingsStore } from '../../core/state/settings.store';
import { IpcFacadeService, RecentDirectoriesIpcService } from '../../core/services/ipc';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import { QuickActionDispatcherService } from '../orchestration/quick-action-dispatcher.service';
import { TodoStore } from '../../core/state/todo.store';
import { WelcomeCoordinatorService } from './welcome-coordinator.service';
import { FileAttachmentService } from './file-attachment.service';
import { HistoryPreviewSessionService } from './history-preview-session.service';
import { InstanceIpcService } from '../../core/services/ipc/instance-ipc.service';
import { DraftService } from '../../core/services/draft.service';
import { InstanceDetailComponent } from './instance-detail.component';
import { OutputStreamComponent } from './output-stream.component';
import { LoopStore } from '../../core/state/loop.store';
import { LoopPromptHistoryService } from '../loop/loop-prompt-history.service';
import type { LoopStartConfigInput } from '../../core/services/ipc/loop-ipc.service';
import type { ConversationData, ConversationHistoryEntry } from '../../../../shared/types/history.types';
import type { Instance, OutputMessage } from '../../core/state/instance/instance.types';

const specDirectory = dirname(fileURLToPath(import.meta.url));
const instanceDetailTemplate = readFileSync(
  resolve(specDirectory, './instance-detail.component.html'),
  'utf8',
);

await resolveComponentResources((url) => {
  if (url.endsWith('.html') || url.endsWith('.scss')) {
    return Promise.resolve('');
  }

  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

describe('InstanceDetailComponent history preview restore send', () => {
  let fixture: ComponentFixture<InstanceDetailComponent>;
  let historyStore: {
    previewConversation: ReturnType<typeof signal<ConversationData | null>>;
    restoreEntry: ReturnType<typeof vi.fn>;
    clearSelection: ReturnType<typeof vi.fn>;
  };
  let instanceStore: {
    selectedInstance: ReturnType<typeof signal<Instance | null>>;
    selectedInstanceIdentity: ReturnType<typeof signal<string | null>>;
    selectedInstanceSessionId: ReturnType<typeof signal<string | null>>;
    selectedInstanceActivity: ReturnType<typeof signal<null>>;
    getSelectedInstanceBusySince: ReturnType<typeof vi.fn>;
    getInstance: ReturnType<typeof vi.fn>;
    sendInput: ReturnType<typeof vi.fn>;
    addInstanceFromData: ReturnType<typeof vi.fn>;
    setInstanceMessages: ReturnType<typeof vi.fn>;
    setInstanceRestoreMode: ReturnType<typeof vi.fn>;
    setSelectedInstance: ReturnType<typeof vi.fn>;
    getQueuedMessageCount: ReturnType<typeof vi.fn>;
    getMessageQueue: ReturnType<typeof vi.fn>;
    isInstanceCompacting: ReturnType<typeof vi.fn>;
  };
  let loopStore: {
    start: ReturnType<typeof vi.fn>;
  };
  let loopPromptHistory: {
    remember: ReturnType<typeof vi.fn>;
  };
  let forkSession: ReturnType<typeof vi.fn>;
  const changeModel = vi.fn();

  beforeEach(async () => {
    changeModel.mockReset();
    historyStore = {
      previewConversation: signal(createConversation()),
      restoreEntry: vi.fn(),
      clearSelection: vi.fn(),
    };
    instanceStore = {
      selectedInstance: signal<Instance | null>(null),
      selectedInstanceIdentity: signal<string | null>(null),
      selectedInstanceSessionId: signal<string | null>(null),
      selectedInstanceActivity: signal(null),
      getSelectedInstanceBusySince: vi.fn(() => null),
      getInstance: vi.fn(() => createInstance()),
      sendInput: vi.fn(),
      addInstanceFromData: vi.fn(),
      setInstanceMessages: vi.fn(),
      setInstanceRestoreMode: vi.fn(),
      setSelectedInstance: vi.fn(),
      getQueuedMessageCount: vi.fn(() => 0),
      getMessageQueue: vi.fn(() => []),
      isInstanceCompacting: vi.fn(() => false),
    };
    loopStore = {
      start: vi.fn(),
    };
    loopPromptHistory = {
      remember: vi.fn(),
    };
    forkSession = vi.fn();

    TestBed.resetTestingModule();
    TestBed.overrideComponent(InstanceDetailComponent, {
      set: {
        template: '',
        templateUrl: undefined,
        styles: [],
        styleUrl: undefined,
        styleUrls: [],
        imports: [],
      },
    });

    await TestBed.configureTestingModule({
      imports: [InstanceDetailComponent],
      providers: [
        { provide: InstanceStore, useValue: instanceStore },
        { provide: InstanceIpcService, useValue: { changeModel } },
        { provide: HistoryStore, useValue: historyStore },
        { provide: SettingsStore, useValue: createSettingsStoreMock() },
        { provide: IpcFacadeService, useValue: { forkSession } },
        { provide: RecentDirectoriesIpcService, useValue: { selectFolderAndTrack: vi.fn() } },
        {
          provide: ProviderIpcService,
          useValue: {
            listModelsForProvider: vi.fn(),
            onModelsCatalogUpdated: vi.fn(() => () => undefined),
          },
        },
        { provide: NewSessionDraftService, useValue: createNewSessionDraftMock() },
        { provide: CrossModelReviewIpcService, useValue: { getReviewForInstance: vi.fn(() => null), dismiss: vi.fn() } },
        { provide: QuickActionDispatcherService, useValue: { dispatch: vi.fn() } },
        { provide: TodoStore, useValue: createTodoStoreMock() },
        { provide: WelcomeCoordinatorService, useValue: createWelcomeCoordinatorMock() },
        { provide: FileAttachmentService, useValue: { prependPendingFolders: (message: string) => message } },
        { provide: LoopStore, useValue: loopStore },
        { provide: LoopPromptHistoryService, useValue: loopPromptHistory },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(InstanceDetailComponent);
    fixture.detectChanges();
  });

  it('shows the queued user message and restore notice while waiting for restore to finish', async () => {
    let resolveRestore: (value: {
      success: boolean;
      instanceId: string;
      restoredMessages: OutputMessage[];
    }) => void = () => undefined;
    const restorePromise = new Promise<{
      success: boolean;
      instanceId: string;
      restoredMessages: OutputMessage[];
    }>((resolve) => {
      resolveRestore = resolve;
    });
    historyStore.restoreEntry.mockReturnValue(restorePromise);

    fixture.componentInstance.onHistoryPreviewDraftStarted();
    const sendPromise = fixture.componentInstance.onHistoryPreviewSendMessage('Continue once restored');

    const previewMessages = fixture.componentInstance.historyPreview()?.messages ?? [];
    expect(previewMessages.slice(-2)).toMatchObject([
      { type: 'user', content: 'Continue once restored' },
      {
        type: 'system',
        content: expect.stringContaining('Restoring this session'),
        metadata: { isRestoreNotice: true },
      },
    ]);
    expect(instanceStore.sendInput).not.toHaveBeenCalled();

    resolveRestore({
      success: true,
      instanceId: 'restored-1',
      restoredMessages: createConversation().messages,
    });
    await sendPromise;

    expect(instanceStore.sendInput).toHaveBeenCalledWith('restored-1', 'Continue once restored', []);
    expect(instanceStore.setSelectedInstance).toHaveBeenCalledWith('restored-1');
  });

  it('waits for the selected model to apply before sending the first restored message', async () => {
    const sessions = TestBed.inject(HistoryPreviewSessionService);
    sessions.select('history-1', { provider: 'codex', model: 'gpt-6-astra', reasoning: 'high' });
    historyStore.restoreEntry.mockResolvedValue({ success: true, instanceId: 'restored-1' });
    let confirm!: (value: unknown) => void;
    changeModel.mockReturnValue(new Promise(resolve => { confirm = resolve; }));
    const send = fixture.componentInstance.onHistoryPreviewSendMessage('Use the new model');
    await vi.waitFor(() => expect(changeModel).toHaveBeenCalled());
    expect(instanceStore.sendInput).not.toHaveBeenCalled();
    expect(changeModel).toHaveBeenCalledWith('restored-1', 'gpt-6-astra', 'high', undefined, 'codex');
    confirm({ success: true, data: { id: 'restored-1', currentModel: 'gpt-6-astra', provider: 'codex' } });
    await send;
    expect(instanceStore.sendInput).toHaveBeenCalledWith('restored-1', 'Use the new model', []);
  });

  it('retains the message and attachments when the selected model fails and retries without another restore', async () => {
    const sessions = TestBed.inject(HistoryPreviewSessionService);
    const drafts = TestBed.inject(DraftService);
    const file = new File(['example'], 'example.txt', { type: 'text/plain' });
    drafts.addPendingFiles('history-preview:history-1', [file]);
    sessions.select('history-1', { provider: 'codex', model: 'gpt-6-astra', reasoning: 'high' });
    historyStore.restoreEntry.mockResolvedValue({ success: true, instanceId: 'restored-1' });
    changeModel.mockResolvedValueOnce({ success: false, error: { message: 'Model unavailable' } });
    await fixture.componentInstance.onHistoryPreviewSendMessage('Retain this message');
    expect(instanceStore.sendInput).not.toHaveBeenCalled();
    expect(drafts.getDraft('history-preview:history-1')).toBe('Retain this message');
    expect(drafts.getPendingFiles('history-preview:history-1')).toEqual([file]);
    expect(fixture.componentInstance.historyPreviewError()).toContain('Model unavailable');
    changeModel.mockResolvedValue({ success: true, data: { id: 'restored-1', currentModel: 'gpt-6-astra', provider: 'codex' } });
    await fixture.componentInstance.onHistoryPreviewSendMessage('Retain this message');
    expect(historyStore.restoreEntry).toHaveBeenCalledOnce();
    expect(instanceStore.sendInput).toHaveBeenCalledWith('restored-1', 'Retain this message', [file]);
  });

  it('does not start a loop or edited resend if its pending model cannot be applied', async () => {
    TestBed.inject(HistoryPreviewSessionService).select('history-1', { provider: 'codex', model: 'gpt-6-astra', reasoning: 'high' });
    historyStore.restoreEntry.mockResolvedValue({ success: true, instanceId: 'restored-1' });
    changeModel.mockResolvedValue({ success: false, error: { message: 'Model unavailable' } });
    const onResolved = vi.fn();
    await fixture.componentInstance.onHistoryPreviewLoopStartRequested({ config: validLoopConfig(), firstMessage: 'Continue', attachments: [], onResolved });
    expect(loopStore.start).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledWith(false, expect.stringContaining('Model unavailable'));
    await fixture.componentInstance.onResendEdited({ messageIndex: 0, text: 'Edited' });
    expect(forkSession).not.toHaveBeenCalled();
  });

  it.each(['loop', 'edited resend'])('holds %s until the pending model is confirmed', async (path) => {
    TestBed.inject(HistoryPreviewSessionService).select('history-1', { provider: 'codex', model: 'gpt-6-astra', reasoning: 'high' });
    historyStore.restoreEntry.mockResolvedValue({ success: true, instanceId: 'restored-1' });
    loopStore.start.mockResolvedValue({ ok: true });
    forkSession.mockResolvedValue({ success: true, data: { id: 'fork-1' } });
    let confirm!: (value: unknown) => void;
    changeModel.mockReturnValue(new Promise(resolve => { confirm = resolve; }));
    const onResolved = vi.fn();
    const pending = path === 'loop'
      ? fixture.componentInstance.onHistoryPreviewLoopStartRequested({ config: validLoopConfig(), firstMessage: 'Continue', attachments: [], onResolved })
      : fixture.componentInstance.onResendEdited({ messageIndex: 0, text: 'Edited' });
    await vi.waitFor(() => expect(changeModel).toHaveBeenCalledOnce());
    expect(loopStore.start).not.toHaveBeenCalled();
    expect(forkSession).not.toHaveBeenCalled();
    confirm({ success: true, data: { id: 'restored-1', provider: 'codex', currentModel: 'gpt-6-astra' } });
    await pending;
    if (path === 'loop') {
      expect(loopStore.start).toHaveBeenCalledWith('restored-1', validLoopConfig(), []);
      expect(onResolved).toHaveBeenCalledWith(true);
    } else {
      expect(forkSession).toHaveBeenCalledWith('restored-1', 0, expect.any(String), 'Edited', expect.objectContaining({ preserveRuntimeSettings: true }));
    }
  });

  it('wires loop starts from the history preview composer', () => {
    expect(instanceDetailTemplate).toContain('(loopStartRequested)="onHistoryPreviewLoopStartRequested($event)"');
  });

  it('retains loop composition for resubmission if the model changes during restore', async () => {
    const sessions = TestBed.inject(HistoryPreviewSessionService);
    sessions.select('history-1', { provider: 'claude', model: 'opus', reasoning: 'max' });
    let restore!: (value: unknown) => void;
    historyStore.restoreEntry.mockReturnValue(new Promise(resolve => { restore = resolve; }));
    changeModel.mockResolvedValue({ success: true, data: { id: 'restored-1', provider: 'codex', currentModel: 'gpt-6-astra' } });
    const onResolved = vi.fn();
    const pending = fixture.componentInstance.onHistoryPreviewLoopStartRequested({ config: validLoopConfig(), firstMessage: 'Continue', attachments: [], onResolved });
    sessions.select('history-1', { provider: 'codex', model: 'gpt-6-astra', reasoning: 'high' });
    restore({ success: true, instanceId: 'restored-1' });
    await pending;
    expect(loopStore.start).not.toHaveBeenCalled();
    expect(onResolved).toHaveBeenCalledWith(false, expect.stringContaining('Start the loop again'));
    expect(historyStore.clearSelection).not.toHaveBeenCalled();
    expect(sessions.selection('history-1')?.provider).toBe('codex');
    loopStore.start.mockResolvedValue({ ok: true });
    await fixture.componentInstance.onHistoryPreviewLoopStartRequested({ config: { ...validLoopConfig(), provider: 'codex' }, firstMessage: 'Continue', attachments: [], onResolved });
    expect(loopStore.start).toHaveBeenCalledWith('restored-1', expect.objectContaining({ provider: 'codex' }), []);
    expect(historyStore.restoreEntry).toHaveBeenCalledOnce();
  });

  it('updates continuation provider defaults while preserving historical transcript metadata', () => {
    expect(fixture.componentInstance.historyPreviewComposerProvider()).toBe('claude');
    TestBed.inject(HistoryPreviewSessionService).select('history-1', { provider: 'codex', model: 'gpt-6-astra', reasoning: 'high' });
    expect(fixture.componentInstance.historyPreviewComposerProvider()).toBe('codex');
    expect(fixture.componentInstance.historyPreview()?.provider).toBe('claude');
    expect(instanceDetailTemplate).toContain('[provider]="historyPreviewComposerProvider()"');
  });

  it('keeps history preview prompt and pagination probes off live instance storage', async () => {
    expect(instanceDetailTemplate).toContain(
      '[olderMessagesProbe]="historyPreviewOlderMessagesProbe"',
    );
    expect(instanceDetailTemplate).toContain('[livePromptIndexEnabled]="false"');
    await expect(
      fixture.componentInstance.historyPreviewOlderMessagesProbe(),
    ).resolves.toEqual({ hasMore: false, totalStored: 1 });

    const liveOlderMessages = vi.fn();
    const customOlderMessagesProbe = vi.fn().mockResolvedValue({
      hasMore: false,
      totalStored: 1,
    });
    const outputStreamInternals = OutputStreamComponent.prototype as unknown as {
      fetchPromptIndex: (instanceId: string) => Promise<void>;
      probeForOlderMessages: (instanceId: string) => Promise<void>;
    };
    await outputStreamInternals.probeForOlderMessages.call({
      olderMessagesProbe: () => customOlderMessagesProbe,
      instanceIpc: { loadOlderMessages: liveOlderMessages },
      hasOlderMessages: signal(false),
      olderMessagesHiddenCount: signal(0),
      messages: () => createConversation().messages,
    }, 'history-preview:history-1');

    const livePromptIndex = vi.fn().mockResolvedValue({ success: false });
    await outputStreamInternals.fetchPromptIndex.call({
      livePromptIndexEnabled: () => false,
      instanceIpc: { getPromptIndex: livePromptIndex },
    }, 'history-preview:history-1');

    expect(customOlderMessagesProbe).toHaveBeenCalledOnce();
    expect(liveOlderMessages).not.toHaveBeenCalled();
    expect(livePromptIndex).not.toHaveBeenCalled();
  });

  it('restores a history preview before starting a loop', async () => {
    historyStore.restoreEntry.mockResolvedValue({
      success: true,
      instanceId: 'restored-1',
      restoredMessages: createConversation().messages,
    });
    loopStore.start.mockResolvedValue({ ok: true });

    const resolved: { ok: boolean; error?: string }[] = [];
    const config = validLoopConfig();

    await fixture.componentInstance.onHistoryPreviewLoopStartRequested({
      config,
      firstMessage: 'Continue once restored',
      attachments: [],
      onResolved: (ok, error) => resolved.push({ ok, error }),
    });

    expect(historyStore.restoreEntry).toHaveBeenCalledWith('history-1', '/tmp/project');
    expect(loopStore.start).toHaveBeenCalledWith('restored-1', config, []);
    expect(loopPromptHistory.remember).toHaveBeenCalledWith('Continue until done');
    expect(resolved).toEqual([{ ok: true, error: undefined }]);
  });

  it('restores a history preview before forking an edited resend', async () => {
    historyStore.restoreEntry.mockResolvedValue({
      success: true,
      instanceId: 'restored-1',
      restoredMessages: createConversation().messages,
    });
    forkSession.mockResolvedValue({ success: true, data: { id: 'fork-1' } });

    await fixture.componentInstance.onResendEdited({
      messageIndex: 0,
      messageId: 'msg-1',
      text: 'Edited first prompt',
      retryMode: 'transcript-only',
    });

    expect(historyStore.restoreEntry).toHaveBeenCalledWith('history-1', '/tmp/project');
    expect(forkSession).toHaveBeenCalledWith(
      'restored-1',
      0,
      'Edit resend at message msg-1',
      'Edited first prompt',
      {
        atMessageId: 'msg-1',
        sourceMessageId: 'msg-1',
        attachments: undefined,
        preserveRuntimeSettings: true,
        supersedeSource: true,
      },
    );
    expect(instanceStore.addInstanceFromData).toHaveBeenCalledWith({ id: 'fork-1' });
    expect(instanceStore.setSelectedInstance).toHaveBeenCalledWith('fork-1');
    expect(historyStore.clearSelection).toHaveBeenCalled();
  });
});

function createConversation(): ConversationData {
  const entry: ConversationHistoryEntry = {
    id: 'history-1',
    displayName: 'Existing session',
    createdAt: 1,
    endedAt: 2,
    workingDirectory: '/tmp/project',
    messageCount: 1,
    firstUserMessage: 'First',
    lastUserMessage: 'First',
    status: 'completed',
    originalInstanceId: 'old-1',
    parentId: null,
    sessionId: 'session-1',
    provider: 'claude',
  };
  return {
    entry,
    messages: [
      {
        id: 'msg-1',
        timestamp: 1,
        type: 'user',
        content: 'First',
      },
    ],
  };
}

function validLoopConfig(): LoopStartConfigInput {
  return {
    initialPrompt: 'Continue once restored',
    iterationPrompt: 'Continue until done',
    workspaceCwd: '/tmp/project',
    provider: 'claude',
    contextStrategy: 'same-session',
  };
}

function createInstance(): Instance {
  return {
    id: 'restored-1',
    displayName: 'Restored',
    createdAt: Date.now(),
    historyThreadId: 'thread-restored-1',
    parentId: null,
    childrenIds: [],
    agentId: 'build',
    agentMode: 'build',
    provider: 'claude',
    status: 'idle',
    contextUsage: {
      used: 0,
      total: 200000,
      percentage: 0,
    },
    lastActivity: Date.now(),
    sessionId: 'session-1',
    providerSessionId: 'provider-session-1',
    restartEpoch: 0,
    workingDirectory: '/tmp/project',
    yoloMode: false,
    launchMode: 'interactive',
    currentModel: undefined,
    outputBuffer: [],
  };
}

function createSettingsStoreMock(): Partial<SettingsStore> {
  return {
    defaultWorkingDirectory: signal('/tmp/project'),
    showThinking: signal(true),
    thinkingDefaultExpanded: signal(false),
    showToolMessages: signal(true),
  } as unknown as Partial<SettingsStore>;
}

function createNewSessionDraftMock(): Partial<NewSessionDraftService> {
  return {
    setWorkingDirectory: vi.fn(),
    activeKey: signal('__default__'),
  } as unknown as Partial<NewSessionDraftService>;
}

function createTodoStoreMock(): Partial<TodoStore> {
  return {
    setSession: vi.fn(),
    hasTodos: signal(false),
    currentSessionId: signal(null),
    stats: signal({ total: 0, completed: 0, pending: 0, inProgress: 0 }),
  } as unknown as Partial<TodoStore>;
}

function createWelcomeCoordinatorMock(): Partial<WelcomeCoordinatorService> {
  return {
    pendingFiles: signal([]),
    pendingFolders: signal([]),
    workingDirectory: signal<string | null>(null),
    welcomeSelectedNodeId: signal<string | null>(null),
    remoteBrowseOpen: signal(false),
    remoteBrowseNodeId: signal<string | null>(null),
    selectedCli: signal('auto'),
    isWelcomeProjectContextLoading: signal(false),
    projectContext: signal(null),
    resetState: vi.fn(),
    loadWelcomeProjectContext: vi.fn(),
  } as unknown as Partial<WelcomeCoordinatorService>;
}
