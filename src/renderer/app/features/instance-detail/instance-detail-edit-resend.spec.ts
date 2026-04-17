import { describe, it, expect, vi } from 'vitest';

/**
 * Unit tests for the onResendEdited fork+swap+terminate flow.
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
    const terminateInstance = vi.fn();
    const addInstanceFromData = vi.fn();

    return {
      ipc: { forkSession },
      store: { setSelectedInstance, terminateInstance, addInstanceFromData },
      forkSession,
      setSelectedInstance,
      terminateInstance,
      addInstanceFromData,
    };
  }

  // Replicates the onResendEdited logic
  async function onResendEdited(
    mocks: ReturnType<typeof createMocks>,
    instanceId: string | null,
    event: { messageIndex: number; text: string },
  ) {
    if (!instanceId) return;

    const result = await mocks.ipc.forkSession(
      instanceId,
      event.messageIndex,
      `Edit resend at message ${event.messageIndex}`,
      event.text,
    );

    if (!result?.success || !result.data) return;
    const data = result.data as { id?: string };
    if (!data.id) return;

    mocks.store.addInstanceFromData(result.data);
    mocks.store.setSelectedInstance(data.id);
    await mocks.store.terminateInstance(instanceId, false);
  }

  it('forks with initialPrompt, swaps selection, terminates old', async () => {
    const mocks = createMocks();
    mocks.forkSession.mockResolvedValue({ success: true, data: { id: 'new-123' } });
    mocks.terminateInstance.mockResolvedValue(undefined);

    await onResendEdited(mocks, 'old-456', { messageIndex: 3, text: 'edited question' });

    expect(mocks.forkSession).toHaveBeenCalledWith(
      'old-456',
      3,
      'Edit resend at message 3',
      'edited question',
    );
    expect(mocks.addInstanceFromData).toHaveBeenCalledWith({ id: 'new-123' });
    expect(mocks.setSelectedInstance).toHaveBeenCalledWith('new-123');
    expect(mocks.terminateInstance).toHaveBeenCalledWith('old-456', false);
  });

  it('does nothing when instanceId is null', async () => {
    const mocks = createMocks();

    await onResendEdited(mocks, null, { messageIndex: 3, text: 'edited' });

    expect(mocks.forkSession).not.toHaveBeenCalled();
  });

  it('does not swap or terminate when fork fails', async () => {
    const mocks = createMocks();
    mocks.forkSession.mockResolvedValue({ success: false, error: 'Fork failed' });

    await onResendEdited(mocks, 'old-456', { messageIndex: 3, text: 'edited' });

    expect(mocks.forkSession).toHaveBeenCalled();
    expect(mocks.addInstanceFromData).not.toHaveBeenCalled();
    expect(mocks.setSelectedInstance).not.toHaveBeenCalled();
    expect(mocks.terminateInstance).not.toHaveBeenCalled();
  });

  it('does not swap or terminate when fork returns no id', async () => {
    const mocks = createMocks();
    mocks.forkSession.mockResolvedValue({ success: true, data: {} });

    await onResendEdited(mocks, 'old-456', { messageIndex: 3, text: 'edited' });

    expect(mocks.addInstanceFromData).not.toHaveBeenCalled();
    expect(mocks.setSelectedInstance).not.toHaveBeenCalled();
    expect(mocks.terminateInstance).not.toHaveBeenCalled();
  });

  it('handles fork at messageIndex 0 (first-ever user message)', async () => {
    const mocks = createMocks();
    mocks.forkSession.mockResolvedValue({ success: true, data: { id: 'new-789' } });
    mocks.terminateInstance.mockResolvedValue(undefined);

    await onResendEdited(mocks, 'old-456', { messageIndex: 0, text: 'revised first message' });

    // Fork at index 0 means the new instance starts with an empty conversation
    expect(mocks.forkSession).toHaveBeenCalledWith(
      'old-456',
      0,
      'Edit resend at message 0',
      'revised first message',
    );
    expect(mocks.addInstanceFromData).toHaveBeenCalledWith({ id: 'new-789' });
    expect(mocks.setSelectedInstance).toHaveBeenCalledWith('new-789');
    expect(mocks.terminateInstance).toHaveBeenCalledWith('old-456', false);
  });
});

/**
 * Note: There is no busy-guard on edit resend. The flow forks to a new
 * instance and force-terminates the old one (graceful=false), so a busy
 * old CLI is killed cleanly without going through the SIGINT → --resume
 * cycle that previously surfaced "Interrupted — session restarted (resume
 * failed)" toasts.
 *
 * The edited text is passed as `initialPrompt` to the fork rather than
 * via a separate sendInput call. The main process delivers it inside the
 * new fork's background init, so it can't race the status-gated queue.
 */
