import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { signal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceStore } from '../../core/state/instance.store';
import { HistoryStore } from '../../core/state/history.store';
import { SettingsStore } from '../../core/state/settings.store';
import { ElectronIpcService, RecentDirectoriesIpcService } from '../../core/services/ipc';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import { QuickActionDispatcherService } from '../orchestration/quick-action-dispatcher.service';
import { TodoStore } from '../../core/state/todo.store';
import { WelcomeCoordinatorService } from './welcome-coordinator.service';
import { FileAttachmentService } from './file-attachment.service';
import { InstanceDetailComponent } from './instance-detail.component';
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
    selectedInstanceActivity: ReturnType<typeof signal<null>>;
    getSelectedInstanceBusySince: ReturnType<typeof vi.fn>;
    getInstance: ReturnType<typeof vi.fn>;
    sendInput: ReturnType<typeof vi.fn>;
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

  beforeEach(async () => {
    historyStore = {
      previewConversation: signal(createConversation()),
      restoreEntry: vi.fn(),
      clearSelection: vi.fn(),
    };
    instanceStore = {
      selectedInstance: signal<Instance | null>(null),
      selectedInstanceActivity: signal(null),
      getSelectedInstanceBusySince: vi.fn(() => null),
      getInstance: vi.fn(() => createInstance()),
      sendInput: vi.fn(),
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
        { provide: HistoryStore, useValue: historyStore },
        { provide: SettingsStore, useValue: createSettingsStoreMock() },
        { provide: ElectronIpcService, useValue: { forkSession: vi.fn() } },
        { provide: RecentDirectoriesIpcService, useValue: { selectFolderAndTrack: vi.fn() } },
        { provide: ProviderIpcService, useValue: { listModelsForProvider: vi.fn() } },
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

  it('wires loop starts from the history preview composer', () => {
    expect(instanceDetailTemplate).toContain('(loopStartRequested)="onHistoryPreviewLoopStartRequested($event)"');
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
    workingDirectory: '/tmp/project',
    yoloMode: false,
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
  };
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
