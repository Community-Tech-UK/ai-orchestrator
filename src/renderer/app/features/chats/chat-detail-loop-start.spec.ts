import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftService } from '../../core/services/draft.service';
import { ChatDetailComponent } from './chat-detail.component';

describe('ChatDetailComponent loop start', () => {
  afterEach(() => TestBed.resetTestingModule());

  function setup(result: { ok: boolean; error?: string }) {
    TestBed.configureTestingModule({ providers: [DraftService] });
    const drafts = TestBed.inject(DraftService);
    let liveSession = 'instance-1';
    const chat = Object.assign(Object.create(ChatDetailComponent.prototype) as object, {
      detail: () => ({ chat: { id: 'chat-1' } }),
      streamInstanceId: () => liveSession,
      chatDraftKey: () => 'chat:chat-1',
      draftService: drafts,
      loopStore: {
        start: vi.fn(async () => {
          // A model change while the start is in flight gives the chat a new live session.
          liveSession = 'instance-2';
          return result;
        }),
      },
      loopPromptHistory: { remember: vi.fn() },
      chatStore: { setError: vi.fn() },
    }) as unknown as ChatDetailComponent;
    const photo = new File(['jpeg'], 'IMG_1531.jpg', { type: 'image/jpeg' });
    drafts.setDraft('instance-1', 'Look at this photo');
    drafts.addPendingFiles('chat:chat-1', [photo]);
    const onResolved = vi.fn();
    const request = {
      config: { initialPrompt: 'Continue', workspaceCwd: '/repo' } as never,
      firstMessage: 'Look at this photo', attachments: [], stagedFiles: [photo], onResolved,
    };
    return { chat, drafts, photo, onResolved, request };
  }

  it('clears the goal and photos the started loop took', async () => {
    const test = setup({ ok: true });

    await test.chat.onLoopStartRequested(test.request);

    expect(test.onResolved).toHaveBeenCalledWith(true);
    expect(test.drafts.getDraft('instance-1')).toBe('');
    expect(test.drafts.getPendingFiles('chat:chat-1')).toEqual([]);
  });

  it('keeps a photo added while another was being prepared, which the composer never sent', async () => {
    const test = setup({ ok: true });
    const duringPreparation = new File(['gif'], 'during.gif', { type: 'image/gif' });
    test.drafts.addPendingFiles('chat:chat-1', [duringPreparation]);

    await test.chat.onLoopStartRequested(test.request);

    expect(test.drafts.getPendingFiles('chat:chat-1')).toEqual([duringPreparation]);
  });

  it('keeps a photo added while the loop was starting, which the loop never received', async () => {
    const test = setup({ ok: true });
    const lateFile = new File(['png'], 'late.png', { type: 'image/png' });
    const start = (test.chat as unknown as { loopStore: { start: ReturnType<typeof vi.fn> } }).loopStore.start;
    start.mockImplementationOnce(async () => {
      test.drafts.addPendingFiles('chat:chat-1', [lateFile]);
      return { ok: true };
    });

    await test.chat.onLoopStartRequested(test.request);

    expect(test.drafts.getPendingFiles('chat:chat-1')).toEqual([lateFile]);
  });

  it('keeps them when the loop does not start', async () => {
    const test = setup({ ok: false, error: 'busy' });

    await test.chat.onLoopStartRequested(test.request);

    expect(test.onResolved).toHaveBeenCalledWith(false, 'busy');
    expect(test.drafts.getDraft('instance-1')).toBe('Look at this photo');
    expect(test.drafts.getPendingFiles('chat:chat-1')).toEqual([test.photo]);
  });
});
