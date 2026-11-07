/**
 * LT-719: when the first `state:resync` keeps failing, the rail used to look empty. The store put the failure in
 * `InstanceStore.error`, which no template renders, so running sessions were missing with no hint and no retry.
 *
 * The first block checks the notice on its own; the second drives the real instance store through the real rail
 * template, because the defect lived in the join between them.
 */
import { signal, type WritableSignal, ɵresolveComponentResources as resolveComponentResources } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NeedsYouStore } from '../workboard/needs-you.store';
import { InstanceIpcService, IpcEventBusService, IpcFacadeService } from '../../core/services/ipc';
import { StatsIpcService } from '../../core/services/ipc/stats-ipc.service';
import { RecentDirectoriesIpcService } from '../../core/services/ipc/recent-directories-ipc.service';
import { FileIpcService } from '../../core/services/ipc/file-ipc.service';
import { HistoryIpcService } from '../../core/services/ipc/history-ipc.service';
import { NewSessionDraftService } from '../../core/services/new-session-draft.service';
import { ProviderStateService } from '../../core/services/provider-state.service';
import { ScratchDirectoryService } from '../../core/services/scratch-directory.service';
import { ToastService } from '../../core/services/toast.service';
import { VisibleInstanceResolver } from '../../core/services/visible-instance-resolver.service';
import { AutomationStore } from '../../core/state/automation.store';
import { HistoryStore } from '../../core/state/history.store';
import { InstanceStore } from '../../core/state/instance.store';
import { InstanceMessagingStore } from '../../core/state/instance/instance-messaging.store';
import { InstanceOutputStore } from '../../core/state/instance/instance-output.store';
import { InstanceSelectionStore } from '../../core/state/instance/instance-selection.store';
import { InstanceStateService } from '../../core/state/instance/instance-state.service';
import type { InstanceListLoadFailure } from '../../core/state/instance/instance.types';
import { CrossSessionMessagingStore } from '../../core/state/instance/cross-session-messaging.store';
import { LoopStore } from '../../core/state/loop.store';
import { RemoteNodeStore } from '../../core/state/remote-node.store';
import { TerminateConfirmStore } from '../../shared/terminate-confirm/terminate-confirm.store';
import { HistoryRailService } from './history-rail.service';
import { InstanceListComponent } from './instance-list.component';
import { InstanceListLoadFailureComponent } from './instance-list-load-failure.component';
import { ProjectRailBuilderService } from './project-rail-builder.service';

// The rail and the row use `templateUrl`; an empty resolver would render nothing and every assertion would be hollow.
await resolveComponentResources(async (url: string) =>
  (url.endsWith('.html') ? readFileSync(new URL(basename(url), import.meta.url), 'utf8') : ''));

const RAW_DETAIL = 'IPC_AUTH_FAILED: Missing or invalid auth token for state:resync';
// The shape main returns on a refused snapshot: an object, never a string.
const REFUSED = { success: false, error: { code: 'IPC_AUTH_FAILED', message: 'Missing or invalid auth token for state:resync' } };

const alertOf = (host: HTMLElement) => host.querySelector<HTMLElement>('[role="alert"]');
const retryOf = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('.load-failure-retry');
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('InstanceListLoadFailureComponent', () => {
  let listLoadFailure: WritableSignal<InstanceListLoadFailure | null>;
  let refreshInstances: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    listLoadFailure = signal<InstanceListLoadFailure | null>(null);
    refreshInstances = vi.fn(async () => undefined);
    TestBed.configureTestingModule({
      providers: [
        { provide: InstanceStore, useValue: { listLoadFailure: listLoadFailure.asReadonly(), refreshInstances } },
      ],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  function mount() {
    const fixture = TestBed.createComponent(InstanceListLoadFailureComponent);
    fixture.detectChanges();
    return { fixture, host: fixture.nativeElement as HTMLElement };
  }

  it('shows nothing while the session list is loaded', () => {
    const { host } = mount();

    expect(host.textContent?.trim()).toBe('');
    expect(alertOf(host)).toBeNull();
  });

  it('announces a plain-English problem and keeps the raw reason behind Details', () => {
    const { fixture, host } = mount();

    listLoadFailure.set({ detail: RAW_DETAIL });
    fixture.detectChanges();

    const alert = alertOf(host)!;
    expect(alert.textContent).toContain('Could not load sessions');
    expect(alert.textContent).toContain('Running sessions may be missing from this list.');
    expect(alert.textContent).not.toContain('IPC_AUTH_FAILED');

    const details = host.querySelector<HTMLDetailsElement>('details')!;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent?.trim()).toBe('Details');
    expect(details.querySelector('pre')?.textContent).toBe(RAW_DETAIL);
    // The raw reason appears nowhere outside the disclosure.
    expect(host.textContent?.replace(details.textContent ?? '', '')).not.toContain('IPC_AUTH_FAILED');
  });

  it('retries from a native button and keeps keyboard focus on it while it works', async () => {
    let finish!: () => void;
    refreshInstances.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const { fixture, host } = mount();
    listLoadFailure.set({ detail: RAW_DETAIL });
    fixture.detectChanges();

    const button = retryOf(host)!;
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button.textContent?.trim()).toBe('Try again');
    button.focus();
    button.click();
    fixture.detectChanges();

    expect(refreshInstances).toHaveBeenCalledOnce();
    expect(button.textContent?.trim()).toBe('Trying again…');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    // Native `disabled` would drop keyboard focus; aria-disabled keeps it.
    expect(button.disabled).toBe(false);
    expect(document.activeElement).toBe(button);

    button.click();
    expect(refreshInstances).toHaveBeenCalledOnce();

    finish();
    await flush();
    fixture.detectChanges();
    expect(button.textContent?.trim()).toBe('Try again');
    expect(button.hasAttribute('aria-disabled')).toBe(false);
  });

  it('says so when a retry fails again, and only for that failure', async () => {
    const { fixture, host } = mount();
    listLoadFailure.set({ detail: RAW_DETAIL });
    fixture.detectChanges();
    refreshInstances.mockImplementation(async () => { listLoadFailure.set({ detail: 'still refused' }); });

    retryOf(host)!.click();
    await flush();
    fixture.detectChanges();

    expect(alertOf(host)!.textContent).toContain('Still could not load sessions');
    expect(host.querySelector('pre')?.textContent).toBe('still refused');

    // A later success clears it, and a brand-new failure is not described as a repeat.
    listLoadFailure.set(null);
    fixture.detectChanges();
    expect(alertOf(host)).toBeNull();
    listLoadFailure.set({ detail: 'refused again, much later' });
    fixture.detectChanges();
    expect(alertOf(host)!.textContent).toContain('Could not load sessions');
    expect(alertOf(host)!.textContent).not.toContain('Still');
  });
});

describe('session rail after the first state resync keeps failing', () => {
  const sessionPayload = {
    id: 'restored-1',
    displayName: 'Restored session',
    createdAt: 1,
    historyThreadId: 'thread-restored-1',
    parentId: null,
    childrenIds: [],
    status: 'idle',
    lastActivity: 2,
    sessionId: 'session-restored-1',
    workingDirectory: '/tmp/project',
    yoloMode: false,
    provider: 'claude',
    outputBuffer: [],
  };
  let stateResync: ReturnType<typeof vi.fn>;
  let appReady: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stateResync = vi.fn();
    appReady = vi.fn().mockResolvedValue({ success: true, data: {} });
    const streams = [
      'batchUpdate$', 'compactStatus$', 'fastToggled$', 'inputRequired$', 'inputRequiredResolved$', 'inputContextDelivered$',
      'instanceCreated$', 'instanceOutput$', 'instanceRemoved$', 'instanceStateUpdate$',
      'instanceTranscriptChunk$', 'orchestrationActivity$', 'yoloToggled$',
    ];
    const eventBus = Object.fromEntries(streams.map((name) => [name, new Subject<unknown>()]));
    TestBed.configureTestingModule({
      providers: [
        // The real InstanceStore and InstanceListStore run; only the IPC edge and unrelated stores are faked.
        { provide: IpcFacadeService, useValue: { stateResync, appReady, on: vi.fn(() => () => undefined) } },
        { provide: IpcEventBusService, useValue: eventBus },
        { provide: NeedsYouStore, useValue: { sessionIds: () => new Set<string>(), entries: () => [] } },
        { provide: InstanceIpcService, useValue: {} },
        { provide: StatsIpcService, useValue: {} },
        { provide: ToastService, useValue: { show: vi.fn() } },
        { provide: ProviderStateService, useValue: {} },
        { provide: AutomationStore, useValue: {} },
        { provide: InstanceSelectionStore, useValue: {} },
        { provide: InstanceOutputStore, useValue: { cleanupAll: vi.fn() } },
        { provide: InstanceMessagingStore, useValue: {} },
        { provide: CrossSessionMessagingStore, useValue: {} },
        { provide: TerminateConfirmStore, useValue: {} },
        { provide: HistoryStore, useValue: { entries: signal([]), previewEntryId: signal(null), loadHistory: vi.fn() } },
        { provide: LoopStore, useValue: { runningChatIds: signal(new Set()), ensureWired: vi.fn() } },
        { provide: RemoteNodeStore, useValue: { hasNodes: signal(false) } },
        { provide: NewSessionDraftService, useValue: { revision: signal(0) } },
        { provide: VisibleInstanceResolver, useValue: { setProjectGroupsSource: vi.fn(), clearProjectGroupsSource: vi.fn() } },
        { provide: RecentDirectoriesIpcService, useValue: { getDirectories: async () => [], addDirectory: vi.fn(async () => true) } },
        { provide: FileIpcService, useValue: {} },
        { provide: HistoryIpcService, useValue: {} },
        { provide: ProjectRailBuilderService, useValue: { buildProjectGroups: () => [] } },
        // Real path service: once a session loads, the rail reads its project path.
        { provide: ScratchDirectoryService, useValue: { isScratch: () => false } },
        { provide: HistoryRailService, useValue: { historyDisplayLimit: 5 } },
      ],
    });
  });

  afterEach(() => TestBed.resetTestingModule());

  async function mountRail() {
    // Creating the rail creates the real InstanceStore, whose constructor starts the first load.
    const fixture = TestBed.createComponent(InstanceListComponent);
    const host = fixture.nativeElement as HTMLElement;
    const settle = async (assertion: () => void) => {
      await vi.waitFor(() => {
        fixture.detectChanges();
        assertion();
      });
    };
    return { fixture, host, settle };
  }

  it('keeps a plain error with a retry on screen, and clears it after a successful retry', async () => {
    stateResync.mockResolvedValue(REFUSED);
    const { host, settle } = await mountRail();

    await settle(() => expect(alertOf(host)).not.toBeNull());
    expect(alertOf(host)!.textContent).toContain('Could not load sessions');
    expect(alertOf(host)!.textContent).not.toContain('IPC_AUTH_FAILED');
    expect(host.querySelector('.load-failure-detail')?.textContent).toBe(RAW_DETAIL);
    // The failed first load retried through appReady once, then gave up; the error did not leak into the shared sink.
    expect(appReady).toHaveBeenCalledOnce();
    expect(TestBed.inject(InstanceStateService).state().error).toBeNull();
    expect(TestBed.inject(InstanceStateService).state().loading).toBe(false);

    stateResync.mockResolvedValue({ success: true, data: { instances: [sessionPayload] } });
    retryOf(host)!.focus();
    retryOf(host)!.click();

    await settle(() => expect(alertOf(host), `notice still showing: ${host.textContent?.replace(/\s+/g, ' ')}`).toBeNull());
    expect(TestBed.inject(InstanceStateService).getInstance('restored-1')?.displayName).toBe('Restored session');
    expect(host.querySelector('[data-testid="instance-list-load-failure"]')).toBeNull();
    expect(document.activeElement).toBe(host.querySelector('.filter-input'));
  });

  it('keeps the error, and says it is repeating, while retries keep failing', async () => {
    stateResync.mockResolvedValue(REFUSED);
    const { host, settle } = await mountRail();
    await settle(() => expect(alertOf(host)).not.toBeNull());

    retryOf(host)!.click();

    await settle(() => expect(alertOf(host)!.textContent).toContain('Still could not load sessions'));
    expect(retryOf(host)!.textContent?.trim()).toBe('Try again');
  });

  it('shows nothing on a normal startup, including when the first attempt is refused and the second accepted', async () => {
    stateResync
      .mockResolvedValueOnce(REFUSED)
      .mockResolvedValue({ success: true, data: { instances: [sessionPayload] } });
    const { host, settle } = await mountRail();

    await settle(() => expect(TestBed.inject(InstanceStateService).getInstance('restored-1')).toBeDefined());
    expect(alertOf(host)).toBeNull();
    expect(host.querySelector('app-instance-list-load-failure')?.textContent?.trim()).toBe('');
  });
});
