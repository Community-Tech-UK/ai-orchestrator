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
