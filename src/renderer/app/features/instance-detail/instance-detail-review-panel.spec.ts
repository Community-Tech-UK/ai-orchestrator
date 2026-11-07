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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../../../shared/types/settings.types';
import type { AppSettings } from '../../../../shared/types/settings.types';
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

const specDirectory = dirname(fileURLToPath(import.meta.url));
// The REAL template, so the `@if (claudeContextNote(); as note)` block itself is under test.
const instanceDetailTemplate = readFileSync(resolve(specDirectory, './instance-detail.component.html'), 'utf8');

await resolveComponentResources((url) => {
  if (url.endsWith('.html') || url.endsWith('.scss')) return Promise.resolve('');
  return Promise.reject(new Error(`Unexpected component resource: ${url}`));
});

@Component({ selector: 'app-input-panel', standalone: true, template: '' })
class InputPanelStubComponent {
  readonly instanceId = input<string>('');
}

@Component({ selector: 'app-drop-zone', standalone: true, template: '<ng-content />' })
class DropZoneStubComponent {
  readonly pasteOwner = input<unknown>();
}

const instance = (id: string): Instance => ({
  id, displayName: 'Session', createdAt: Date.now(), historyThreadId: `thread-${id}`, parentId: null,
  childrenIds: [], agentId: 'build', agentMode: 'build', provider: 'claude', status: 'idle',
  contextUsage: { used: 1_000, total: 1_000_000, percentage: 0, occupancyReported: true },
  lastActivity: Date.now(), sessionId: id, providerSessionId: `provider-${id}`, restartEpoch: 0,
  workingDirectory: '/tmp/project', yoloMode: false, launchMode: 'interactive', currentModel: undefined,
  outputBuffer: [],
} as unknown as Instance);

describe('InstanceDetailComponent cross-model review panel', () => {
  let fixture: ComponentFixture<InstanceDetailComponent>;
  const selected = signal<Instance | null>(null);
  const identity = signal<string | null>('session-1');
  const sessionId = signal<string | null>('session-1');
  const settings = signal<AppSettings>({ ...DEFAULT_SETTINGS });
  const dismiss = vi.fn();

  beforeEach(async () => {
    dismiss.mockClear(); identity.set('session-1'); sessionId.set('session-1'); selected.set(instance('session-1'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const instanceStore = {
      selectedInstance: selected,
      selectedInstanceIdentity: identity,
      selectedInstanceSessionId: sessionId,
      selectedInstanceActivity: signal(null),
      getSelectedInstanceBusySince: vi.fn(() => null),
      getInstance: vi.fn(() => selected()),
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
          settings, isInitialized: signal(true),
          defaultWorkingDirectory: signal('/tmp/project'), showThinking: signal(true),
          thinkingDefaultExpanded: signal(false), showToolMessages: signal(true),
        } },
        { provide: IpcFacadeService, useValue: { forkSession: vi.fn() } },
        { provide: RecentDirectoriesIpcService, useValue: { selectFolderAndTrack: vi.fn() } },
        { provide: ProviderIpcService, useValue: { listModelsForProvider: vi.fn(), onModelsCatalogUpdated: vi.fn(() => () => undefined) } },
        { provide: NewSessionDraftService, useValue: { setWorkingDirectory: vi.fn(), activeKey: signal('__default__') } },
        { provide: CrossModelReviewIpcService, useValue: { getReviewForInstance: vi.fn(() => ({ id: 'review-1', reviews: [] })), dismiss } },
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
  });

  afterEach(() => {
    fixture?.destroy();
    selected.set(null);
    vi.restoreAllMocks();
  });

  async function render(): Promise<InstanceDetailComponent> {
    fixture = TestBed.createComponent(InstanceDetailComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    return fixture.componentInstance;
  }

  it.each(['dismiss', 'ask-primary'])('closes the panel after the %s action, not only the stored review', async (action) => {
    const component = await render();
    component.toggleCrossModelReviewPanel();
    expect(component.showCrossModelReviewPanel()).toBe(true);

    component.onReviewAction({ reviewId: 'review-1', instanceId: 'session-1', action });

    expect(dismiss).toHaveBeenCalledWith({ reviewId: 'review-1', instanceId: 'session-1' });
    expect(component.showCrossModelReviewPanel()).toBe(false);
  });

  it('closes the panel when the visible session changes, and again when its provider session restarts', async () => {
    const component = await render();
    component.toggleCrossModelReviewPanel();
    identity.set('session-2'); selected.set(instance('session-2'));
    fixture.detectChanges();
    expect(component.showCrossModelReviewPanel()).toBe(false);

    component.toggleCrossModelReviewPanel();
    expect(component.showCrossModelReviewPanel()).toBe(true);
    sessionId.set('session-2-restarted');
    fixture.detectChanges();
    expect(component.showCrossModelReviewPanel()).toBe(false);
  });
});
