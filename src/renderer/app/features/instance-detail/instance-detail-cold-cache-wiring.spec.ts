import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Component,
  input,
  output,
  signal,
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../../shared/types/settings.types';
import { DraftService } from '../../core/services/draft.service';
import { CrossModelReviewIpcService } from '../../core/services/ipc/cross-model-review-ipc.service';
import { IpcFacadeService, RecentDirectoriesIpcService } from '../../core/services/ipc';
import { ProviderIpcService } from '../../core/services/ipc/provider-ipc.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { InstanceMessagingStore } from '../../core/state/instance/instance-messaging.store';
import type { Instance } from '../../core/state/instance/instance.types';
import { SettingsStore } from '../../core/state/settings.store';
import { TodoStore } from '../../core/state/todo.store';
import { QuickActionDispatcherService } from '../orchestration/quick-action-dispatcher.service';
import { COLD_CACHE_IDLE_MS } from './cold-cache-resume';
import { ColdCacheResumeService } from './cold-cache-resume.service';
import { InstanceDetailComponent } from './instance-detail.component';
import { WelcomeCoordinatorService } from './welcome-coordinator.service';
import { FileAttachmentService } from './file-attachment.service';

const specDirectory = dirname(fileURLToPath(import.meta.url));
// The REAL template, so the (sendMessage) binding itself is what is under test.
const instanceDetailTemplate = readFileSync(resolve(specDirectory, './instance-detail.component.html'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

/** Stands in for the composer: same selector and output name, nothing else. */
@Component({ selector: 'app-input-panel', standalone: true, template: '' })
class InputPanelStubComponent {
  readonly instanceId = input<string>('');
  readonly sendMessage = output<string>();
}

@Component({ selector: 'app-drop-zone', standalone: true, template: '<ng-content />' })
class DropZoneStubComponent {
  readonly pasteOwner = input<unknown>();
}

describe('InstanceDetailComponent template wiring for compact-then-send', () => {
  let fixture: ComponentFixture<InstanceDetailComponent>;
  let instance: Instance;
  const compactInstance = vi.fn();
  const sendInput = vi.fn();

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    compactInstance.mockReset();
    sendInput.mockReset();
    instance = {
      id: 'session-1', displayName: 'Session', createdAt: Date.now(), historyThreadId: 'thread-1', parentId: null,
      childrenIds: [], agentId: 'build', agentMode: 'build', provider: 'claude', status: 'idle',
      contextUsage: { used: 150_000, total: 200_000, percentage: 75, occupancyReported: true },
      lastActivity: Date.now(), sessionId: 'session-1', providerSessionId: 'provider-1', restartEpoch: 0,
      workingDirectory: '/tmp/project', yoloMode: false, launchMode: 'interactive', currentModel: undefined,
      outputBuffer: [{ id: 'a1', type: 'assistant', content: 'earlier answer', timestamp: Date.now() - COLD_CACHE_IDLE_MS - 60_000 }],
    } as unknown as Instance;
    const instanceStore = {
      selectedInstance: signal<Instance | null>(instance),
      selectedInstanceIdentity: signal<string | null>(instance.id),
      selectedInstanceSessionId: signal<string | null>(instance.sessionId),
      selectedInstanceActivity: signal(null),
      getSelectedInstanceBusySince: vi.fn(() => null),
      getInstance: vi.fn(() => instance),
      sendInput, compactInstance,
      setSelectedInstance: vi.fn(),
      getQueuedMessageCount: vi.fn(() => 0),
      getMessageQueue: vi.fn(() => []),
      isInstanceCompacting: vi.fn(() => false),
    };

    TestBed.resetTestingModule();
    TestBed.overrideComponent(InstanceDetailComponent, {
      set: {
        template: instanceDetailTemplate, templateUrl: undefined, styles: [], styleUrl: undefined, styleUrls: [],
        imports: [DropZoneStubComponent, InputPanelStubComponent],
      },
    });

    await TestBed.configureTestingModule({
      imports: [InstanceDetailComponent],
      providers: [
        ColdCacheResumeService,
        DraftService,
        { provide: InstanceStore, useValue: instanceStore },
        { provide: InstanceMessagingStore, useValue: { getQueuedMessageCount: vi.fn(() => 0) } },
        { provide: HistoryStore, useValue: { previewConversation: signal(null), restoreEntry: vi.fn(), clearSelection: vi.fn() } },
        { provide: SettingsStore, useValue: {
          settings: signal({ ...DEFAULT_SETTINGS, coldCacheCompactFirst: true }), isInitialized: signal(true),
          defaultWorkingDirectory: signal('/tmp/project'), showThinking: signal(true),
          thinkingDefaultExpanded: signal(false), showToolMessages: signal(true),
        } },
        { provide: IpcFacadeService, useValue: { forkSession: vi.fn() } },
        { provide: RecentDirectoriesIpcService, useValue: { selectFolderAndTrack: vi.fn() } },
        { provide: ProviderIpcService, useValue: { listModelsForProvider: vi.fn(), onModelsCatalogUpdated: vi.fn(() => () => undefined) } },
        { provide: NewSessionDraftService, useValue: { setWorkingDirectory: vi.fn(), activeKey: signal('__default__') } },
        { provide: CrossModelReviewIpcService, useValue: { getReviewForInstance: vi.fn(() => null), dismiss: vi.fn() } },
        { provide: QuickActionDispatcherService, useValue: { dispatch: vi.fn() } },
        { provide: TodoStore, useValue: {
          setSession: vi.fn(), hasTodos: signal(false), currentSessionId: signal(null),
          stats: signal({ total: 0, completed: 0, pending: 0, inProgress: 0 }),
        } },
        { provide: WelcomeCoordinatorService, useValue: {
          pendingFiles: signal([]), pendingFolders: signal([]), workingDirectory: signal<string | null>(null),
          welcomeSelectedNodeId: signal<string | null>(null), remoteBrowseOpen: signal(false),
          remoteBrowseNodeId: signal<string | null>(null), selectedCli: signal('auto'),
          isWelcomeProjectContextLoading: signal(false), projectContext: signal(null),
          resetState: vi.fn(), loadWelcomeProjectContext: vi.fn(),
        } },
        { provide: FileAttachmentService, useValue: { prependPendingFolders: (message: string) => message } },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(InstanceDetailComponent);
    fixture.detectChanges();
  });

  afterEach(() => {
    fixture.destroy();
    vi.restoreAllMocks();
  });

  function composer(): InputPanelStubComponent {
    // The live composer is the one inside the drop zone; the history-preview one only renders in preview mode.
    const stub = fixture.debugElement.query(By.directive(InputPanelStubComponent));
    expect(stub, 'the live composer is mounted').toBeTruthy();
    return stub.componentInstance as InputPanelStubComponent;
  }

  it('routes the composer send through the cold-cache compact-first path', async () => {
    let finish: (value: boolean) => void = () => undefined;
    compactInstance.mockImplementation(() => new Promise<boolean>(resolve => { finish = resolve; }));

    composer().sendMessage.emit('hello after a break');

    // Compaction is requested first and nothing is sent while it is in flight.
    expect(compactInstance).toHaveBeenCalledWith('session-1');
    expect(sendInput).not.toHaveBeenCalled();
    finish(true);
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledWith('session-1', 'hello after a break', [], { typedByPerson: true }));
    expect(compactInstance).toHaveBeenCalledOnce();
  });

  it('sends straight away when no cold-cache offer applies', async () => {
    instance.outputBuffer = [{ id: 'a1', type: 'assistant', content: 'fresh', timestamp: Date.now() } as never];
    composer().sendMessage.emit('still warm');
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalledWith('session-1', 'still warm', [], { typedByPerson: true }));
    expect(compactInstance).not.toHaveBeenCalled();
  });
});
