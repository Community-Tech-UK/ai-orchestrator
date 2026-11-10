import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftService } from '../../core/services/draft.service';
import { ToastService } from '../../core/services/toast.service';
import { InstanceStore } from '../../core/state/instance.store';
import { InstanceMessagingStore } from '../../core/state/instance/instance-messaging.store';
import { SettingsStore } from '../../core/state/settings.store';
import { ColdCacheResumeService } from './cold-cache-resume.service';
import { InstanceDetailComponent } from './instance-detail.component';

describe('InstanceDetailComponent compact then send', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('marks a message sent from the message box as typed by a person, with its attachments', async () => {
    const file = new File(['image'], 'screenshot.png', { type: 'image/png' });
    const instance = { id: 'session', provider: 'claude', status: 'idle', outputBuffer: [] };
    const sendInput = vi.fn();
    TestBed.configureTestingModule({ providers: [
      DraftService,
      ColdCacheResumeService,
      { provide: ToastService, useValue: { show: vi.fn() } },
      { provide: InstanceStore, useValue: { getInstance: () => instance, isInstanceCompacting: () => false } },
      { provide: InstanceMessagingStore, useValue: { getQueuedMessageCount: () => 0 } },
      { provide: SettingsStore, useValue: { settings: () => ({ coldCacheCompactFirst: false }) } },
    ] });
    const drafts = TestBed.inject(DraftService);
    drafts.addPendingFiles(instance.id, [file]);
    const detail = Object.assign(Object.create(InstanceDetailComponent.prototype) as object, {
      instance: () => instance,
      pendingFiles: () => drafts.getPendingFiles(instance.id),
      pendingFolders: () => [],
      fileAttachment: { prependPendingFolders: (message: string) => message },
      coldCache: TestBed.inject(ColdCacheResumeService),
      store: { sendInput },
      draftService: drafts,
      inputPanel: () => undefined,
    }) as unknown as InstanceDetailComponent;

    detail.onComposerSend('land it anyway');
    await vi.waitFor(() => expect(sendInput).toHaveBeenCalled());

    expect(sendInput).toHaveBeenCalledExactlyOnceWith(instance.id, 'land it anyway', [file], { typedByPerson: true });
    expect(drafts.getPendingFiles(instance.id)).toEqual([]);
  });

  it('asks for the typed mark on an edited resend (main keeps it only for a typed source message)', async () => {
    const forkSession = vi.fn().mockResolvedValue({ success: true, data: { id: 'fork' } });
    const detail = Object.assign(Object.create(InstanceDetailComponent.prototype) as object, {
      instance: () => ({ id: 'session' }),
      ipc: { forkSession },
      store: { addInstanceFromData: vi.fn(), setSelectedInstance: vi.fn() },
    }) as unknown as InstanceDetailComponent;

    await detail.onResendEdited({ messageIndex: 2, messageId: 'user-2', text: 'edited [session: Other · other]' });

    expect(forkSession).toHaveBeenCalledOnce();
    expect(forkSession.mock.calls[0][4]).toMatchObject({ initialPromptOrigin: { kind: 'person', typedAt: expect.any(Number) } });
  });

  it('marks a loop goal as typed by a person only when it came from the message box', async () => {
    const start = vi.fn().mockResolvedValue({ ok: true });
    const detail = Object.assign(Object.create(InstanceDetailComponent.prototype) as object, {
      store: { selectedInstance: () => ({ id: 'session' }), setError: vi.fn() },
      loopStore: { start },
      loopPromptHistory: { remember: vi.fn() },
    }) as unknown as InstanceDetailComponent;
    const config = { initialPrompt: 'goal', workspaceCwd: '/repo' };
    const onResolved = vi.fn();

    await detail.onLoopStartRequested({ config: config as never, firstMessage: 'goal', attachments: [], onResolved });
    // An empty message box means the goal is the loop panel's prompt, which may be Harness's default or an old goal.
    await detail.onLoopStartRequested({ config: config as never, firstMessage: '  ', attachments: [], onResolved });

    expect(start).toHaveBeenNthCalledWith(1, 'session', config, [], { typedByPerson: true });
    expect(start).toHaveBeenNthCalledWith(2, 'session', config, [], { typedByPerson: false });
    expect(onResolved).toHaveBeenCalledWith(true);
  });

  it('keeps pending attachments and restores text when compaction fails', async () => {
    const file = new File(['image'], 'screenshot.png', { type: 'image/png' });
    const instance = { id: 'session', provider: 'claude', status: 'idle',
      contextUsage: { used: 150_000, occupancyReported: true },
      outputBuffer: [{ type: 'assistant', timestamp: Date.now() - 80 * 60_000 }] };
    const compactInstance = vi.fn().mockResolvedValue(false);
    const sendInput = vi.fn();
    const restoreTextToComposer = vi.fn();
    TestBed.configureTestingModule({ providers: [
      DraftService,
      ColdCacheResumeService,
      { provide: ToastService, useValue: { show: vi.fn() } },
      { provide: InstanceStore, useValue: { getInstance: () => instance, isInstanceCompacting: () => false,
        compactInstance } },
      { provide: InstanceMessagingStore, useValue: { getQueuedMessageCount: () => 0 } },
      { provide: SettingsStore, useValue: { settings: () => ({ coldCacheCompactFirst: true }) } },
    ] });
    const drafts = TestBed.inject(DraftService);
    drafts.addPendingFiles(instance.id, [file]);
    const detail = Object.assign(Object.create(InstanceDetailComponent.prototype) as object, {
      instance: () => instance,
      pendingFiles: () => drafts.getPendingFiles(instance.id),
      pendingFolders: () => [],
      fileAttachment: { prependPendingFolders: (message: string) => message },
      coldCache: TestBed.inject(ColdCacheResumeService),
      store: { sendInput },
      draftService: drafts,
      inputPanel: () => ({ restoreTextToComposer }),
    }) as unknown as InstanceDetailComponent;

    detail.onComposerSend('keep this message');
    await vi.waitFor(() => expect(restoreTextToComposer).toHaveBeenCalledWith('keep this message'));

    expect(compactInstance).toHaveBeenCalledWith(instance.id);
    expect(sendInput).not.toHaveBeenCalled();
    expect(drafts.getPendingFiles(instance.id)).toEqual([file]);
  });
});
