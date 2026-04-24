import { describe, it, expect, vi } from 'vitest';

/**
 * Unit tests for the onResendEdited fork+swap flow.
 *
 * The edited text rides along on the fork via initialPrompt — the main
 * process delivers it inside the new instance's background init, so the
 * renderer never has to call sendInput separately. That removed a race
 * where the renderer's status-gated queue would drain before the new
 * fork transitioned to 'idle' and the message would silently land nowhere.
 */

describe('onResendEdited flow', () => {
  function createMocks() {
    const forkSession = vi.fn();
    const setSelectedInstance = vi.fn();
    const addInstanceFromData = vi.fn();

    return {
      ipc: { forkSession },
      store: { setSelectedInstance, addInstanceFromData },
      forkSession,
      setSelectedInstance,
      addInstanceFromData,
    };
  }

  // Replicates the onResendEdited logic
  async function onResendEdited(
    mocks: ReturnType<typeof createMocks>,
    instanceId: string | null,
    event: { messageIndex: number; messageId?: string; text: string },
  ) {
    if (!instanceId) return;

    const result = await mocks.ipc.forkSession(
      instanceId,
      event.messageIndex,
      `Edit resend at message ${event.messageId ?? event.messageIndex}`,
      event.text,
      {
        atMessageId: event.messageId,
        sourceMessageId: event.messageId,
        attachments: undefined,
        preserveRuntimeSettings: true,
        supersedeSource: true,
      },
    );

    if (!result?.success || !result.data) return;
    const data = result.data as { id?: string };
    if (!data.id) return;

    mocks.store.addInstanceFromData(result.data);
    mocks.store.setSelectedInstance(data.id);
  }

  it('forks with initialPrompt and swaps selection', async () => {
    const mocks = createMocks();
    mocks.forkSession.mockResolvedValue({ success: true, data: { id: 'new-123' } });

    await onResendEdited(mocks, 'old-456', { messageIndex: 3, messageId: 'user-3', text: 'edited question' });

    expect(mocks.forkSession).toHaveBeenCalledWith(
      'old-456',
      3,
      'Edit resend at message user-3',
      'edited question',
      {
        atMessageId: 'user-3',
        sourceMessageId: 'user-3',
        attachments: undefined,
        preserveRuntimeSettings: true,
        supersedeSource: true,
      },
    );
    expect(mocks.addInstanceFromData).toHaveBeenCalledWith({ id: 'new-123' });
    expect(mocks.setSelectedInstance).toHaveBeenCalledWith('new-123');
  });

  it('does nothing when instanceId is null', async () => {
    const mocks = createMocks();

    await onResendEdited(mocks, null, { messageIndex: 3, text: 'edited' });

    expect(mocks.forkSession).not.toHaveBeenCalled();
  });

  it('does not swap when fork fails', async () => {
    const mocks = createMocks();
    mocks.forkSession.mockResolvedValue({ success: false, error: 'Fork failed' });

    await onResendEdited(mocks, 'old-456', { messageIndex: 3, text: 'edited' });

    expect(mocks.forkSession).toHaveBeenCalled();
    expect(mocks.addInstanceFromData).not.toHaveBeenCalled();
    expect(mocks.setSelectedInstance).not.toHaveBeenCalled();
  });

  it('does not swap when fork returns no id', async () => {
    const mocks = createMocks();
    mocks.forkSession.mockResolvedValue({ success: true, data: {} });

    await onResendEdited(mocks, 'old-456', { messageIndex: 3, text: 'edited' });

    expect(mocks.addInstanceFromData).not.toHaveBeenCalled();
    expect(mocks.setSelectedInstance).not.toHaveBeenCalled();
  });

  it('handles fork at messageIndex 0 (first-ever user message)', async () => {
    const mocks = createMocks();
    mocks.forkSession.mockResolvedValue({ success: true, data: { id: 'new-789' } });

    await onResendEdited(mocks, 'old-456', { messageIndex: 0, text: 'revised first message' });

    // Fork at index 0 means the new instance starts with an empty conversation
    expect(mocks.forkSession).toHaveBeenCalledWith(
      'old-456',
      0,
      'Edit resend at message 0',
      'revised first message',
      {
        atMessageId: undefined,
        sourceMessageId: undefined,
        attachments: undefined,
        preserveRuntimeSettings: true,
        supersedeSource: true,
      },
    );
    expect(mocks.addInstanceFromData).toHaveBeenCalledWith({ id: 'new-789' });
    expect(mocks.setSelectedInstance).toHaveBeenCalledWith('new-789');
  });
});

/**
 * Note: There is no busy-guard on edit resend. The main process forks to a new
 * instance, marks the source as superseded, and terminates the source adapter
 * without the renderer issuing a second terminate call.
 *
 * The edited text is passed as `initialPrompt` to the fork rather than
 * via a separate sendInput call. The main process delivers it inside the
 * new fork's background init, so it can't race the status-gated queue.
 */
