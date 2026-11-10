import { describe, it, expect, vi } from 'vitest';
import { InstanceDetailComponent } from './instance-detail.component';

/**
 * The real `InstanceDetailComponent.onResendEdited` fork-and-swap flow, on a
 * live session.
 *
 * The edited text rides along on the fork via initialPrompt — the main
 * process delivers it inside the new instance's background init, so the
 * renderer never has to call sendInput separately. That removed a race
 * where the renderer's status-gated queue would drain before the new
 * fork transitioned to 'idle' and the message would silently land nowhere.
 *
 * There is no busy-guard on edit resend: the main process forks to a new
 * instance, marks the source as superseded, and terminates the source adapter
 * without the renderer issuing a second terminate call.
 *
 * The history-preview path and the typed-by-a-person mark are covered in
 * `instance-detail-history-preview-restore.spec.ts` and
 * `instance-detail-composer-send.spec.ts`.
 */
describe('InstanceDetailComponent.onResendEdited on a live session', () => {
  function createDetail(instanceId: string | null, forkResult?: unknown) {
    const forkSession = vi.fn().mockResolvedValue(forkResult);
    const store = { addInstanceFromData: vi.fn(), setSelectedInstance: vi.fn() };
    const detail = Object.assign(Object.create(InstanceDetailComponent.prototype) as object, {
      instance: () => (instanceId ? { id: instanceId } : null),
      historyPreview: () => null,
      ipc: { forkSession },
      store,
    }) as unknown as InstanceDetailComponent;
    return { detail, forkSession, store };
  }

  it('forks with the edited text as initialPrompt and swaps selection to the fork', async () => {
    const { detail, forkSession, store } = createDetail('old-456', { success: true, data: { id: 'new-123' } });

    await detail.onResendEdited({ messageIndex: 3, messageId: 'user-3', text: 'edited question' });

    expect(forkSession).toHaveBeenCalledExactlyOnceWith(
      'old-456',
      3,
      'Edit resend at message user-3',
      'edited question',
      expect.objectContaining({
        atMessageId: 'user-3',
        sourceMessageId: 'user-3',
        attachments: undefined,
        preserveRuntimeSettings: true,
        supersedeSource: true,
      }),
    );
    expect(store.addInstanceFromData).toHaveBeenCalledWith({ id: 'new-123' });
    expect(store.setSelectedInstance).toHaveBeenCalledWith('new-123');
  });

  it('does nothing when there is neither a session nor a history preview', async () => {
    const { detail, forkSession } = createDetail(null);

    await detail.onResendEdited({ messageIndex: 3, text: 'edited' });

    expect(forkSession).not.toHaveBeenCalled();
  });

  it('does not swap when the fork fails', async () => {
    const { detail, forkSession, store } = createDetail('old-456', { success: false, error: 'Fork failed' });

    await detail.onResendEdited({ messageIndex: 3, text: 'edited' });

    expect(forkSession).toHaveBeenCalledOnce();
    expect(store.addInstanceFromData).not.toHaveBeenCalled();
    expect(store.setSelectedInstance).not.toHaveBeenCalled();
  });

  it('does not swap when the fork returns no id', async () => {
    const { detail, store } = createDetail('old-456', { success: true, data: {} });

    await detail.onResendEdited({ messageIndex: 3, text: 'edited' });

    expect(store.addInstanceFromData).not.toHaveBeenCalled();
    expect(store.setSelectedInstance).not.toHaveBeenCalled();
  });

  it('labels the fork by position when the edited message has no id (first-ever user message)', async () => {
    const { detail, forkSession, store } = createDetail('old-456', { success: true, data: { id: 'new-789' } });

    await detail.onResendEdited({ messageIndex: 0, text: 'revised first message' });

    expect(forkSession).toHaveBeenCalledWith(
      'old-456',
      0,
      'Edit resend at message 0',
      'revised first message',
      expect.objectContaining({ atMessageId: undefined, sourceMessageId: undefined }),
    );
    expect(store.setSelectedInstance).toHaveBeenCalledWith('new-789');
  });
});
