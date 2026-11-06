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

// A 1M window, so the ceilings below (not the window) decide the summary trigger.
const WINDOW = 1_000_000;
const MACHINE_CEILING = 300_000;
const OWN_CHAT_CEILING = 500_000;

function claudeInstance(overrides: Record<string, unknown>): Instance {
  return {
    id: 'session-1', displayName: 'Session', createdAt: Date.now(), historyThreadId: 'thread-1', parentId: null,
    childrenIds: [], agentId: 'build', agentMode: 'build', provider: 'claude', status: 'idle',
    selfManagesAutoCompaction: true,
    contextUsage: { used: 100_000, total: WINDOW, percentage: 10, occupancyReported: true },
    lastActivity: Date.now(), sessionId: 'session-1', providerSessionId: 'provider-1', restartEpoch: 0,
    workingDirectory: '/tmp/project', yoloMode: false, launchMode: 'interactive', currentModel: undefined,
    outputBuffer: [],
    ...overrides,
  } as unknown as Instance;
}

function usage(used: number) {
  return { used, total: WINDOW, percentage: Math.round((used / WINDOW) * 100), occupancyReported: true };
}

describe('InstanceDetailComponent quiet near-limit note (rendered)', () => {
  let fixture: ComponentFixture<InstanceDetailComponent>;
  const selected = signal<Instance | null>(null);
  const settings = signal<AppSettings>({ ...DEFAULT_SETTINGS });

  async function render(instance: Instance, ceilings: Partial<AppSettings>): Promise<void> {
    selected.set(instance);
    settings.set({ ...DEFAULT_SETTINGS, ...ceilings });
    fixture = TestBed.createComponent(InstanceDetailComponent);
    fixture.detectChanges();
    await fixture.whenStable();
  }

  function noteText(): string | null {
    const el = (fixture.nativeElement as HTMLElement).querySelector('.context-near-limit-note');
    return el ? (el.textContent ?? '').trim() : null;
  }

  beforeEach(async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const instanceStore = {
      selectedInstance: selected,
      selectedInstanceIdentity: signal<string | null>('session-1'),
      selectedInstanceSessionId: signal<string | null>('session-1'),
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
  });

  afterEach(() => {
    fixture?.destroy();
    selected.set(null);
    vi.restoreAllMocks();
  });

  const ceilings = { machineContextCeilingTokens: MACHINE_CEILING, ownChatContextCeilingTokens: OWN_CHAT_CEILING };

  it('shows the countdown for a machine session using the machine ceiling', async () => {
    // Machine trigger is 300K - 33K = 267K, so 250K leaves 17K. The own-chat ceiling would leave 217K (no note).
    await render(claudeInstance({ parentId: 'parent-1', contextUsage: usage(250_000) }), ceilings);
    expect(noteText()).toBe('Claude will summarise this conversation in about 17K tokens.');
  });

  it('shows the countdown for an own chat using the own-chat ceiling', async () => {
    // Own-chat trigger is 500K - 33K = 467K, so 450K leaves 17K. The machine ceiling would be already past (no note).
    await render(claudeInstance({ contextUsage: usage(450_000) }), ceilings);
    expect(noteText()).toBe('Claude will summarise this conversation in about 17K tokens.');
  });

  it('does not borrow the other kind of session\'s ceiling', async () => {
    await render(claudeInstance({ contextUsage: usage(250_000) }), ceilings);
    expect(noteText(), 'own chat at 250K is 217K from its 467K trigger').toBeNull();
    fixture.destroy();
    await render(claudeInstance({ parentId: 'parent-1', contextUsage: usage(450_000) }), ceilings);
    expect(noteText(), 'machine session at 450K is past its 267K trigger').toBeNull();
  });

  it('treats a session with automation metadata as a machine session', async () => {
    await render(claudeInstance({ metadata: { automationId: 'auto-1' }, contextUsage: usage(250_000) }), ceilings);
    expect(noteText()).toBe('Claude will summarise this conversation in about 17K tokens.');
  });

  it('shows no note when the ceiling for that kind of session is 0', async () => {
    await render(claudeInstance({ parentId: 'parent-1', contextUsage: usage(250_000) }),
      { machineContextCeilingTokens: 0, ownChatContextCeilingTokens: OWN_CHAT_CEILING });
    expect(noteText()).toBeNull();
    fixture.destroy();
    await render(claudeInstance({ contextUsage: usage(450_000) }),
      { machineContextCeilingTokens: MACHINE_CEILING, ownChatContextCeilingTokens: 0 });
    expect(noteText()).toBeNull();
  });

  it('shows no note far from the ceiling, for a non-Claude session, or for an aggregate reading', async () => {
    await render(claudeInstance({ contextUsage: usage(100_000) }), ceilings);
    expect(noteText()).toBeNull();
    fixture.destroy();
    await render(claudeInstance({ provider: 'codex', contextUsage: usage(450_000) }), ceilings);
    expect(noteText()).toBeNull();
    fixture.destroy();
    await render(claudeInstance({ contextUsage: { ...usage(450_000), occupancyIsAggregate: true } }), ceilings);
    expect(noteText()).toBeNull();
  });

  it('updates when the reading moves, with no other trigger', async () => {
    await render(claudeInstance({ contextUsage: usage(100_000) }), ceilings);
    expect(noteText()).toBeNull();
    selected.set(claudeInstance({ contextUsage: usage(450_000) }));
    fixture.detectChanges();
    expect(noteText()).toBe('Claude will summarise this conversation in about 17K tokens.');
  });
});
