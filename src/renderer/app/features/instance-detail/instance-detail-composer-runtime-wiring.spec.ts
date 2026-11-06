import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Component,
  input,
  signal,
  ɵresolveComponentResources as resolveComponentResources,
} from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { ColdCacheResumeService } from './cold-cache-resume.service';
import { InstanceDetailComponent } from './instance-detail.component';
import { WelcomeCoordinatorService } from './welcome-coordinator.service';
import { FileAttachmentService } from './file-attachment.service';

/**
 * Plan 12a/14d: the composer's "switches in place" line is chosen from two
 * flags the detail page derives from the live instance
 * (`residentClaude === true`, `executionLocation.type === 'remote'`). The
 * toolbar and picker specs set those inputs directly, so nothing else proves
 * the template feeds them from the instance. This renders the REAL
 * instance-detail template against a stub composer that declares the inputs.
 */
const specDirectory = dirname(fileURLToPath(import.meta.url));
const instanceDetailTemplate = readFileSync(resolve(specDirectory, './instance-detail.component.html'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

/** Same selector as the real composer, with only the two inputs under test (plus the id, to find the live one). */
@Component({ selector: 'app-input-panel', standalone: true, template: '' })
class InputPanelStubComponent {
  readonly instanceId = input<string>('');
  readonly residentClaude = input<boolean>(false);
  readonly remoteExecution = input<boolean>(false);
}

@Component({ selector: 'app-drop-zone', standalone: true, template: '<ng-content />' })
class DropZoneStubComponent {
  readonly pasteOwner = input<unknown>();
}

function makeInstance(overrides: Record<string, unknown>): Instance {
  return {
    id: 'session-1', displayName: 'Session', createdAt: Date.now(), historyThreadId: 'thread-1', parentId: null,
    childrenIds: [], agentId: 'build', agentMode: 'build', provider: 'claude', status: 'idle',
    contextUsage: { used: 1_000, total: 200_000, percentage: 0.5, occupancyReported: true },
    lastActivity: Date.now(), sessionId: 'session-1', providerSessionId: 'provider-1', restartEpoch: 0,
    workingDirectory: '/tmp/project', yoloMode: false, launchMode: 'interactive', currentModel: undefined,
    outputBuffer: [{ id: 'a1', type: 'assistant', content: 'hello', timestamp: Date.now() }],
    ...overrides,
  } as unknown as Instance;
}

describe('InstanceDetailComponent feeds the composer its runtime flags (R4K4 V8)', () => {
  let fixture: ComponentFixture<InstanceDetailComponent> | undefined;
  let selected: ReturnType<typeof signal<Instance | null>>;

  async function mount(instance: Instance): Promise<void> {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    selected = signal<Instance | null>(instance);
    const instanceStore = {
      selectedInstance: selected,
      selectedInstanceIdentity: signal<string | null>(instance.id),
      selectedInstanceSessionId: signal<string | null>(instance.sessionId),
      selectedInstanceActivity: signal(null),
      getSelectedInstanceBusySince: vi.fn(() => null),
      getInstance: vi.fn(() => instance),
      sendInput: vi.fn(), compactInstance: vi.fn(),
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
          settings: signal({ ...DEFAULT_SETTINGS }), isInitialized: signal(true),
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
  }

  afterEach(() => {
    fixture?.destroy();
    fixture = undefined;
    vi.restoreAllMocks();
  });

  function composer(): InputPanelStubComponent {
    const stub = fixture!.debugElement.query(By.directive(InputPanelStubComponent));
    expect(stub, 'the live composer is mounted').toBeTruthy();
    const panel = stub.componentInstance as InputPanelStubComponent;
    expect(panel.instanceId()).toBe('session-1');
    return panel;
  }

  it('passes residentClaude=true only when the instance reports a resident Claude process', async () => {
    await mount(makeInstance({ residentClaude: true }));
    expect(composer().residentClaude()).toBe(true);
  });

  it('passes residentClaude=false when the flag is false, absent or not exactly true', async () => {
    await mount(makeInstance({ residentClaude: false }));
    expect(composer().residentClaude()).toBe(false);
    fixture!.destroy();

    await mount(makeInstance({}));
    expect(composer().residentClaude()).toBe(false);
    fixture!.destroy();

    await mount(makeInstance({ residentClaude: 'yes' }));
    expect(composer().residentClaude()).toBe(false);
  });

  it('passes remoteExecution=true for a remote instance and false for local or unset', async () => {
    await mount(makeInstance({ executionLocation: { type: 'remote', nodeId: 'node-1' } }));
    expect(composer().remoteExecution()).toBe(true);
    fixture!.destroy();

    await mount(makeInstance({ executionLocation: { type: 'local' } }));
    expect(composer().remoteExecution()).toBe(false);
    fixture!.destroy();

    await mount(makeInstance({}));
    expect(composer().remoteExecution()).toBe(false);
  });

  it('keeps the two flags independent (resident and remote together, resident and local together)', async () => {
    await mount(makeInstance({ residentClaude: true, executionLocation: { type: 'remote', nodeId: 'node-1' } }));
    expect(composer().residentClaude()).toBe(true);
    expect(composer().remoteExecution()).toBe(true);
    fixture!.destroy();

    await mount(makeInstance({ residentClaude: false, executionLocation: { type: 'remote', nodeId: 'node-1' } }));
    expect(composer().residentClaude()).toBe(false);
    expect(composer().remoteExecution()).toBe(true);
    fixture!.destroy();

    await mount(makeInstance({ residentClaude: true, executionLocation: { type: 'local' } }));
    expect(composer().residentClaude()).toBe(true);
    expect(composer().remoteExecution()).toBe(false);
  });

  it('follows the instance when it changes after the page is mounted', async () => {
    await mount(makeInstance({ residentClaude: false }));
    expect(composer().residentClaude()).toBe(false);
    expect(composer().remoteExecution()).toBe(false);

    selected.set(makeInstance({ residentClaude: true, executionLocation: { type: 'remote', nodeId: 'node-1' } }));
    fixture!.detectChanges();
    expect(composer().residentClaude()).toBe(true);
    expect(composer().remoteExecution()).toBe(true);
  });
});
