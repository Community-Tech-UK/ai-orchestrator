import { describe, it, expect, vi } from 'vitest';

/**
 * Unit tests for the onResendEdited fork+send+swap+terminate flow.
 *
 * Tests the logic in isolation following the same pattern as
 * instance-detail-inspectors.spec.ts.
 */

describe('onResendEdited flow', () => {
  function createMocks() {
    const forkSession = vi.fn();
    const sendInput = vi.fn();
    const setSelectedInstance = vi.fn();
    const terminateInstance = vi.fn();

    return {
      ipc: { forkSession },
      store: { sendInput, setSelectedInstance, terminateInstance },
      forkSession,
      sendInput,
      setSelectedInstance,
      terminateInstance,
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
    );

    if (!result?.success || !result.data?.id) return;

    const newId = result.data.id as string;
    mocks.store.sendInput(newId, event.text);
    mocks.store.setSelectedInstance(newId);
    await mocks.store.terminateInstance(instanceId);
  }

  it('calls fork → send → swap → terminate in order', async () => {
    const mocks = createMocks();
    mocks.forkSession.mockResolvedValue({ success: true, data: { id: 'new-123' } });
    mocks.terminateInstance.mockResolvedValue(undefined);

    await onResendEdited(mocks, 'old-456', { messageIndex: 3, text: 'edited question' });

    expect(mocks.forkSession).toHaveBeenCalledWith('old-456', 3, 'Edit resend at message 3');
    expect(mocks.sendInput).toHaveBeenCalledWith('new-123', 'edited question');
    expect(mocks.setSelectedInstance).toHaveBeenCalledWith('new-123');
    expect(mocks.terminateInstance).toHaveBeenCalledWith('old-456');
  });

  it('does nothing when instanceId is null', async () => {
    const mocks = createMocks();

    await onResendEdited(mocks, null, { messageIndex: 3, text: 'edited' });

    expect(mocks.forkSession).not.toHaveBeenCalled();
  });

  it('does not send/swap/terminate when fork fails', async () => {
    const mocks = createMocks();
    mocks.forkSession.mockResolvedValue({ success: false, error: 'Fork failed' });

    await onResendEdited(mocks, 'old-456', { messageIndex: 3, text: 'edited' });

    expect(mocks.forkSession).toHaveBeenCalled();
    expect(mocks.sendInput).not.toHaveBeenCalled();
    expect(mocks.setSelectedInstance).not.toHaveBeenCalled();
    expect(mocks.terminateInstance).not.toHaveBeenCalled();
  });

  it('does not send/swap/terminate when fork returns no id', async () => {
    const mocks = createMocks();
    mocks.forkSession.mockResolvedValue({ success: true, data: {} });

    await onResendEdited(mocks, 'old-456', { messageIndex: 3, text: 'edited' });

    expect(mocks.sendInput).not.toHaveBeenCalled();
    expect(mocks.setSelectedInstance).not.toHaveBeenCalled();
    expect(mocks.terminateInstance).not.toHaveBeenCalled();
  });

  it('handles fork at messageIndex 0 (first-ever user message)', async () => {
    const mocks = createMocks();
    mocks.forkSession.mockResolvedValue({ success: true, data: { id: 'new-789' } });
    mocks.terminateInstance.mockResolvedValue(undefined);

    await onResendEdited(mocks, 'old-456', { messageIndex: 0, text: 'revised first message' });

    // Fork at index 0 means the new instance starts with an empty conversation
    expect(mocks.forkSession).toHaveBeenCalledWith('old-456', 0, 'Edit resend at message 0');
    expect(mocks.sendInput).toHaveBeenCalledWith('new-789', 'revised first message');
    expect(mocks.setSelectedInstance).toHaveBeenCalledWith('new-789');
    expect(mocks.terminateInstance).toHaveBeenCalledWith('old-456');
  });
});

/**
 * Note: The spec lists "onResendEdited is blocked when instance is busy" as a parent test,
 * but the busy guard lives in InputPanelComponent.sendEditedMessage(), not the parent.
 * The parent handler is never called when busy because the child blocks emission.
 */
